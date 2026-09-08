import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, readFile, rm, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

import { Office } from "../src/office.js";
import { Scheduler } from "../src/orchestrator/scheduler.js";
import { runTurn } from "../src/orchestrator/turn.js";
import { FakeDriver, type TurnRequest } from "../src/runner/driver.js";
import { saveConfig, defaultConfig } from "../src/config.js";
import { init } from "../src/commands/setup.js";
import { writeJsonAtomic, nowIso, shortId } from "../src/util.js";
import type { Task } from "../src/types.js";

const exec = promisify(execFile);

/** A throwaway repo with one commit, which is all a worktree needs. */
async function makeRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "office-floor-"));
  await exec("git", ["init", "-q", "-b", "main"], { cwd: root });
  await exec("git", ["config", "user.email", "office@example.com"], { cwd: root });
  await exec("git", ["config", "user.name", "The Office"], { cwd: root });
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "index.ts"), "export const answer = 41;\n", "utf8");
  await exec("git", ["add", "-A"], { cwd: root });
  await exec("git", ["commit", "-qm", "initial"], { cwd: root });
  return root;
}

async function seedFloor(root: string): Promise<void> {
  await saveConfig(join(root, "office.config.json"), { ...defaultConfig("max5x", "plus"), driver: "fake", orchestrator: "michelle" });
  const roles = join(root, "office", "agents");
  await mkdir(roles, { recursive: true });
  await writeFile(join(roles, "michelle.md"), "---\nname: Michelle\ntitle: Head of Floor\ntier: large\nautonomy: trusted\n---\n\nYou run the floor.\n", "utf8");
  await writeFile(join(roles, "ada.md"), "---\nname: Ada\ntitle: Implementation\ntier: mid\nautonomy: scoped\nscope:\n  - src/\n---\n\nYou implement.\n", "utf8");
  await writeFile(join(roles, "rex.md"), "---\nname: Rex\ntitle: Review\ntier: mid\nautonomy: scoped\nscope:\n  - test/\n---\n\nYou review.\n", "utf8");
}

function task(over: Partial<Task> = {}): Task {
  return {
    id: shortId("task"), briefId: "b", title: "do a thing", instruction: "do a thing",
    assignee: "ada", state: "pending", dependsOn: [], createdAt: nowIso(), attempts: 0, ...over,
  };
}

/** A fake agent that writes a file and then marks itself done, like a real one would. */
function workingAgent(root: string, opts: { file?: string | false; declareDone?: boolean } = {}) {
  return async (req: TurnRequest) => {
    if (opts.file !== false) {
      const path = join(req.cwd, opts.file || "src/added.ts");
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `// by ${req.agent}\n`, "utf8");
    }
    if (opts.declareDone !== false) {
      const state = JSON.parse(await readFile(join(root, ".office", "agents", req.agent, "state.json"), "utf8")) as { currentTaskId?: string };
      await writeJsonAtomic(join(root, ".office", "agents", req.agent, `done-${state.currentTaskId}.json`), {
        taskId: state.currentTaskId, agent: req.agent, summary: "wrote the file", at: nowIso(),
      });
    }
    return {};
  };
}

describe("the floor, end to end", () => {
  let root: string;

  before(async () => {
    root = await makeRepo();
    await seedFloor(root);
  });

  test("each agent gets its own worktree on its own branch", async () => {
    const office = await Office.open(root, new FakeDriver());
    await office.worktrees.assertRepo();
    const a = await office.worktrees.ensure("ada");
    const b = await office.worktrees.ensure("rex");

    assert.notEqual(a, b);
    assert.equal((await office.worktrees.info("ada"))?.branch, "office/ada");
    assert.equal((await office.worktrees.info("rex"))?.branch, "office/rex");

    // Calling twice must not blow up or make a second worktree.
    assert.equal(await office.worktrees.ensure("ada"), a);
  });

  test("a turn runs, bills the ledger, and leaves the change on the agent's branch", async () => {
    const repo = await makeRepo();
    await seedFloor(repo);
    const office = await Office.open(repo, new FakeDriver(workingAgent(repo)));

    const t = task();
    await office.upsertTask(t);
    await office.saveState({ ...(await office.state("ada")), currentTaskId: t.id });

    const outcome = await runTurn(office, "ada", t, "add a file");
    assert.equal(outcome.ran, true);
    assert.deepEqual(outcome.touchedFiles, ["src/added.ts"]);

    const ledger = await office.ledger.entries();
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0]?.agent, "ada");
    assert.ok(ledger[0]!.cacheReadTokens > 0);

    // The main checkout must be untouched: containment is the worktree.
    await assert.rejects(readFile(join(repo, "src", "added.ts"), "utf8"));
  });

  test("the session id is captured on turn one and resumed on turn two", async () => {
    const repo = await makeRepo();
    await seedFloor(repo);
    const driver = new FakeDriver(workingAgent(repo, { declareDone: false }));
    const office = await Office.open(repo, driver);

    await runTurn(office, "ada", null, "first");
    await runTurn(office, "ada", null, "second");

    assert.equal(driver.calls[0]?.sessionId, undefined);
    assert.equal(driver.calls[1]?.sessionId, "fake-session-ada");
  });

  test("writing outside scope is caught after the fact and held for a human", async () => {
    const repo = await makeRepo();
    await seedFloor(repo);
    const office = await Office.open(repo, new FakeDriver(workingAgent(repo, { file: "infra/main.tf", declareDone: false })));

    const outcome = await runTurn(office, "ada", null, "touch infra");
    assert.ok(outcome.escalationId, "an out-of-scope write must raise an escalation");
    assert.equal((await office.state("ada")).status, "blocked");

    const open = await office.escalations.list({ openOnly: true });
    assert.equal(open[0]?.kind, "out-of-scope");
    assert.match(open[0]?.detail ?? "", /infra\/main\.tf/);
  });

  test("a blocked agent is released only when its last escalation is decided", async () => {
    const repo = await makeRepo();
    await seedFloor(repo);
    const office = await Office.open(repo, new FakeDriver());

    const first = await office.escalations.raise({ agent: "ada", kind: "explicit", summary: "one", detail: "d" });
    const second = await office.escalations.raise({ agent: "ada", kind: "explicit", summary: "two", detail: "d" });
    await office.saveState({ ...(await office.state("ada")), status: "blocked" });

    const { decide } = await import("../src/commands/gate.js");
    await decide(office, first.id, "approve", "fine");
    assert.equal((await office.state("ada")).status, "blocked", "still blocked by the second one");

    await decide(office, second.id, "deny", "no");
    assert.equal((await office.state("ada")).status, "idle");

    // A denial the agent cannot see is a denial it will repeat.
    const brief = await office.memory.brief("ada");
    assert.match(brief, /Denied: two/);
  });

  test("the scheduler respects dependencies and the concurrency cap", async () => {
    const repo = await makeRepo();
    await seedFloor(repo);
    const driver = new FakeDriver(workingAgent(repo));
    const office = await Office.open(repo, driver);

    const first = task({ assignee: "ada", title: "implement" });
    const second = task({ assignee: "rex", title: "test it", dependsOn: [first.id] });
    await office.saveTasks([first, second]);

    const order: string[] = [];
    const summary = await new Scheduler(office).run({
      maxTurns: 10,
      onEvent: (e) => { if (e.type === "turn" && e.agent) order.push(e.agent); },
    });

    assert.deepEqual(order, ["ada", "rex"], "the dependent task must not start early");
    assert.equal(summary.completed.length, 2);
    assert.equal((await office.tasks()).every((t) => t.state === "done"), true);
  });

  test("a task the agent never declares done is given up on, not retried forever", async () => {
    const repo = await makeRepo();
    await seedFloor(repo);
    const office = await Office.open(repo, new FakeDriver(workingAgent(repo, { declareDone: false })));
    await office.saveTasks([task({ title: "never finishes" })]);

    const summary = await new Scheduler(office).run({ maxTurns: 20, maxAttemptsPerTask: 3 });
    const [stored] = await office.tasks();
    assert.equal(stored?.state, "failed");
    assert.equal(stored?.attempts, 3);
    assert.equal(summary.failed.length, 1);
  });

  test("the scheduler stops rather than burning a spent budget", async () => {
    const repo = await makeRepo();
    await seedFloor(repo);
    const base = defaultConfig("max5x");
    await saveConfig(join(repo, "office.config.json"), {
      ...base, driver: "fake", orchestrator: "michelle",
      providers: { ...base.providers, claude: { ...base.providers.claude, windowTokenBudget: 1, weeklyTokenBudget: 1 } },
    });
    const office = await Office.open(repo, new FakeDriver(workingAgent(repo)));
    await office.ledger.record({
      at: nowIso(), agent: "ada", model: "sonnet", tier: "mid", costUsd: 1,
      inputTokens: 10_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
      durationMs: 1, turns: 1, ok: true,
    });
    await office.saveTasks([task()]);

    const summary = await new Scheduler(office).run({ maxTurns: 5 });
    assert.equal(summary.turns, 0, "no turn should have been spawned");
    assert.match(summary.stoppedBecause, /every provider's budget is spent \(claude\)/);
  });

  test("mail an agent sends is delivered on the next tick and shows up in its prompt", async () => {
    const repo = await makeRepo();
    await seedFloor(repo);
    const driver = new FakeDriver(workingAgent(repo, { declareDone: false }));
    const office = await Office.open(repo, driver);

    await office.mail.send({ from: "rex", to: "ada", subject: "retry signature", body: "does retry take an AbortSignal?" });
    await office.router.deliverAll(new Set(office.agentIds()));
    await runTurn(office, "ada", null, "carry on");

    const prompt = driver.calls.at(-1)?.systemPrompt ?? "";
    assert.match(prompt, /Unread mail \(1\)/);
    assert.match(prompt, /AbortSignal/);
  });

  test("a parked agent is not given more work until it is revived", async () => {
    const repo = await makeRepo();
    await seedFloor(repo);
    const office = await Office.open(repo, new FakeDriver(workingAgent(repo)));
    await office.saveState({ ...(await office.state("ada")), status: "parked", breakerStage: 3 });

    const outcome = await runTurn(office, "ada", null, "do something");
    assert.equal(outcome.ran, false);
    assert.match(outcome.blockedBy ?? "", /parked/);

    const { revive } = await import("../src/commands/agent.js");
    await revive(office, "ada");
    assert.equal((await office.state("ada")).status, "idle");
    assert.equal((await runTurn(office, "ada", null, "again")).ran, true);
  });

  test("an unknown agent fails with the roster, not a stack trace", async () => {
    const office = await Office.open(root, new FakeDriver());
    assert.throws(() => office.role("kevin"), /no agent named "kevin". On the floor: /);
  });

  test("a repo with no commits is refused before a worktree is attempted", async () => {
    const bare = await mkdtemp(join(tmpdir(), "office-empty-"));
    await exec("git", ["init", "-q", "-b", "main"], { cwd: bare });
    await seedFloor(bare);
    const office = await Office.open(bare, new FakeDriver());
    await assert.rejects(office.worktrees.assertRepo(), /no commits yet/);
  });
});

describe("reviewing what an agent did", () => {
  test("the diff shows files the agent created, not just ones it edited", async () => {
    const repo = await makeRepo();
    await seedFloor(repo);
    const office = await Office.open(repo, new FakeDriver(workingAgent(repo, { file: "src/brand-new.ts" })));
    await runTurn(office, "ada", null, "add a module");

    const patch = await office.worktrees.diff("ada");
    assert.match(patch, /brand-new\.ts/, "a newly created file must appear in the review pane");
    assert.match(patch, /\+\/\/ by ada/, "with its contents, as additions");
  });

  test("an edit to an existing tracked file still shows", async () => {
    const repo = await makeRepo();
    await seedFloor(repo);
    const office = await Office.open(repo, new FakeDriver(workingAgent(repo, { file: "src/index.ts" })));
    await runTurn(office, "ada", null, "edit the entry point");

    const patch = await office.worktrees.diff("ada");
    assert.match(patch, /src\/index\.ts/);
    assert.match(patch, /-export const answer = 41;/);
  });
});

describe("two providers, two pools", () => {
  async function twoProviderFloor(): Promise<string> {
    const root = await makeRepo();
    await saveConfig(join(root, "office.config.json"), { ...defaultConfig("max5x", "plus"), driver: "fake" });
    const roles = join(root, "office", "agents");
    await mkdir(roles, { recursive: true });
    await writeFile(join(roles, "michelle.md"), "---\nname: Michelle\ntitle: Head of Floor\nprovider: claude\ntier: large\nautonomy: trusted\n---\n\nYou run the floor.\n", "utf8");
    await writeFile(join(roles, "ada.md"), "---\nname: Ada\ntitle: Implementation\nprovider: claude\ntier: mid\nautonomy: scoped\nscope:\n  - src/\n---\n\nYou implement.\n", "utf8");
    await writeFile(join(roles, "rex.md"), "---\nname: Rex\ntitle: Review\nprovider: codex\ntier: mid\nautonomy: scoped\nscope:\n  - test/\n---\n\nYou review.\n", "utf8");
    await writeFile(join(roles, "doc.md"), "---\nname: Doc\ntitle: Docs\nprovider: codex\ntier: small\nautonomy: scoped\nscope:\n  - docs/\n---\n\nYou write docs.\n", "utf8");
    return root;
  }

  const spend = (root: string, provider: "claude" | "codex", tokens: number) => async () => {
    const office = await Office.open(root, new FakeDriver());
    await office.ledger.record({
      at: nowIso(), agent: "x", provider, model: "m", tier: "mid", costUsd: 0,
      inputTokens: tokens, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
      durationMs: 1, turns: 1, ok: true,
    });
  };

  test("a spent claude pool stops the claude desks and leaves codex running", async () => {
    const root = await twoProviderFloor();
    await spend(root, "claude", 500_000_000)();

    const office = await Office.open(root, new FakeDriver(workingAgent(root)));
    await office.saveTasks([
      task({ assignee: "ada", title: "claude work" }),
      task({ assignee: "rex", title: "codex work" }),
    ]);

    const ran: string[] = [];
    const summary = await new Scheduler(office).run({
      maxTurns: 6,
      onEvent: (e) => { if (e.type === "turn" && e.agent) ran.push(e.agent); },
    });

    assert.deepEqual(ran, ["rex"], "only the desk on the untouched subscription should run");
    assert.deepEqual(summary.completed.length, 1);
    const stored = await office.tasks();
    assert.equal(stored.find((t) => t.assignee === "ada")?.state, "pending", "the claude task waits, it does not fail");
    assert.equal(stored.find((t) => t.assignee === "rex")?.state, "done");
  });

  test("concurrency caps are per provider, not shared", async () => {
    const root = await twoProviderFloor();
    const office = await Office.open(root, new FakeDriver(workingAgent(root)));
    await office.saveTasks([
      task({ assignee: "ada", title: "a" }),
      task({ assignee: "michelle", title: "b" }),
      task({ assignee: "rex", title: "c" }),
      task({ assignee: "doc", title: "d" }),
    ]);

    // claude max 2 + codex max 2, so all four are eligible in one batch.
    const batches: string[][] = [];
    let current: string[] = [];
    await new Scheduler(office).run({
      maxTurns: 8,
      onEvent: (e) => {
        if (e.type !== "turn" || !e.agent) return;
        current.push(e.agent);
        if (current.length === 4) { batches.push(current); current = []; }
      },
    });

    assert.equal(batches.length, 1, "one global cap of 2 would have split these across two batches");
    assert.deepEqual(batches[0]?.sort(), ["ada", "doc", "michelle", "rex"]);
  });

  test("both pools spent stops the floor, and says so", async () => {
    const root = await twoProviderFloor();
    await spend(root, "claude", 500_000_000)();
    await spend(root, "codex", 500_000_000)();

    const office = await Office.open(root, new FakeDriver(workingAgent(root)));
    await office.saveTasks([task({ assignee: "ada" }), task({ assignee: "rex" })]);

    const summary = await new Scheduler(office).run({ maxTurns: 4 });
    assert.equal(summary.turns, 0);
    assert.match(summary.stoppedBecause, /every provider's budget is spent/);
    assert.match(summary.stoppedBecause, /claude/);
    assert.match(summary.stoppedBecause, /codex/);
  });

  test("each provider's turns are billed to its own pool", async () => {
    const root = await twoProviderFloor();
    const office = await Office.open(root, new FakeDriver(workingAgent(root)));
    await office.saveTasks([task({ assignee: "ada" }), task({ assignee: "rex" })]);
    await new Scheduler(office).run({ maxTurns: 6 });

    const claude = await office.ledger.entries("claude");
    const codex = await office.ledger.entries("codex");
    assert.deepEqual(claude.map((e) => e.agent), ["ada"]);
    assert.deepEqual(codex.map((e) => e.agent), ["rex"]);
  });

  test("a desk on a disabled provider is never handed work", async () => {
    const root = await twoProviderFloor();
    // The user cancels ChatGPT; the codex desks should idle, not fail.
    const base = defaultConfig("max5x", "plus");
    await saveConfig(join(root, "office.config.json"), {
      ...base, driver: "fake",
      providers: { ...base.providers, codex: { ...base.providers.codex, enabled: false } },
    });

    const office = await Office.open(root, new FakeDriver(workingAgent(root)));
    await office.saveTasks([task({ assignee: "rex", title: "codex work" })]);

    const summary = await new Scheduler(office).run({ maxTurns: 4 });
    assert.equal(summary.turns, 0);
    assert.match(summary.stoppedBecause, /codex, which is disabled/);
  });

  test("each provider gets its own driver, and a forced one overrides both", async () => {
    const root = await twoProviderFloor();
    await saveConfig(join(root, "office.config.json"), { ...defaultConfig("max5x", "plus"), driver: "real" });
    const real = await Office.open(root);
    assert.equal(real.driverFor("claude").name, "claude");
    assert.equal(real.driverFor("codex").name, "codex");

    const faked = await Office.open(root, new FakeDriver());
    assert.equal(faked.driverFor("codex").name, "fake", "a driver passed to open overrides every provider");
  });

  test("the tier a desk asks for resolves to that provider's model name", async () => {
    const root = await twoProviderFloor();
    const driver = new FakeDriver(workingAgent(root, { declareDone: false }));
    const office = await Office.open(root, driver);

    await runTurn(office, "ada", null, "go");
    assert.equal(driver.calls.at(-1)?.model, "sonnet", "claude tier mid maps to the sonnet alias");

    await runTurn(office, "rex", null, "go");
    assert.equal(driver.calls.at(-1)?.model, undefined, "codex names no models, so the CLI default stands");
  });
});

test("a worktree directory deleted behind git's back is recovered, not fatal", async () => {
  const root = await makeRepo();
  await seedFloor(root);
  const office = await Office.open(root, new FakeDriver());
  const first = await office.worktrees.ensure("ada");

  // What deleting .office/, moving the repo, or restoring a backup leaves:
  // git still has the worktree registered, the directory is gone.
  await rm(first, { recursive: true, force: true });

  const again = await office.worktrees.ensure("ada");
  assert.equal(again, first);
  assert.ok(await stat(again).then(() => true, () => false), "the desk has somewhere to work again");
});

describe("init keeps its own state out of your history", () => {
  test(".office is gitignored, and an existing .gitignore is added to, not replaced", async () => {
    const root = await makeRepo();
    await writeFile(join(root, ".gitignore"), "node_modules\n", "utf8");
    await init({ root, plan: "max5x", codexPlan: "none", force: true, seed: false, floor: "code" });

    const ignored = await readFile(join(root, ".gitignore"), "utf8");
    assert.match(ignored, /^node_modules$/m, "what was already there survives");
    assert.match(ignored, /^\.office\/$/m);
  });

  test("running init twice does not stack the entry", async () => {
    const root = await makeRepo();
    const opts = { root, plan: "max5x" as const, codexPlan: "none" as const, force: true, seed: false, floor: "code" };
    await init(opts);
    await init(opts);

    const ignored = await readFile(join(root, ".gitignore"), "utf8");
    assert.equal(ignored.split("\n").filter((l) => l.trim() === ".office/").length, 1);
  });
});

describe("what a session is allowed to accumulate", () => {
  test("a work thread continues within a task and starts fresh for the next", async () => {
    const root = await makeRepo();
    await seedFloor(root);
    const driver = new FakeDriver();
    const office = await Office.open(root, driver);

    const first = { id: "task_a", briefId: "b", title: "t", instruction: "i", assignee: "ada",
      state: "pending" as const, dependsOn: [], createdAt: nowIso(), attempts: 0 };
    await runTurn(office, "ada", first, "do it");
    await runTurn(office, "ada", first, "keep going");
    assert.equal(driver.calls[1]?.sessionId, "fake-session-ada", "same task, same thread");

    // A new task is a new context. Carrying the old one over is how a desk
    // ends up re-reading an afternoon of unrelated work on every turn.
    await runTurn(office, "ada", { ...first, id: "task_b" }, "different work");
    assert.equal(driver.calls[2]?.sessionId, undefined, "new task, new thread");
  });
});

test("--force replaces the desks but never the owner's own answers", async () => {
  const root = await makeRepo();
  const opts = { root, plan: "max5x" as const, codexPlan: "none" as const, force: true, seed: true, floor: "photography" };
  await init(opts);
  await writeFile(join(root, "business.md"), "# mine\n\nMarket: my street. No car.\n", "utf8");

  await init(opts);
  assert.match(await readFile(join(root, "business.md"), "utf8"), /No car/, "re-running setup is not consent to wipe this");
});

test("the business brief reaches the desks before it reaches git", async () => {
  const root = await makeRepo();
  await seedFloor(root);
  await saveConfig(join(root, "office.config.json"), { ...defaultConfig("max5x"), driver: "fake", orchestrator: "michelle", brief: "business.md" });
  // Written, deliberately never committed: this is the normal state of a file
  // you are still editing, and the desks work from a checkout of HEAD.
  await writeFile(join(root, "business.md"), "# mine\n\nNo car. Walkable jobs only.\n", "utf8");

  const office = await Office.open(root, new FakeDriver());
  await runTurn(office, "ada", null, "what do you know about the business?");

  const seen = await readFile(join(office.paths.worktree("ada"), "business.md"), "utf8");
  assert.match(seen, /No car/, "the desk can read what was never committed");
});

test("a desk the tool stops shipping is let go, unless you edited it", async () => {
  const root = await makeRepo();
  const opts = { root, plan: "max5x" as const, codexPlan: "none" as const, force: true, seed: true, floor: "photography" };
  await init(opts);

  // Stand in for a rename: a desk we seeded last time and no longer ship.
  const seeded = join(root, "office", "agents", "retired.md");
  await writeFile(seeded, "---\nname: Retired\nautonomy: trusted\n---\n\nOld desk.\n", "utf8");
  const config = JSON.parse(await readFile(join(root, "office.config.json"), "utf8"));
  const { createHash } = await import("node:crypto");
  config.seeded.retired = createHash("sha256").update(await readFile(seeded, "utf8")).digest("hex").slice(0, 16);
  config.seeded.mine = "0000000000000000";
  await writeFile(join(root, "office.config.json"), JSON.stringify(config), "utf8");
  await writeFile(join(root, "office", "agents", "mine.md"), "---\nname: Mine\nautonomy: trusted\n---\n\nI wrote this.\n", "utf8");

  await init(opts);
  assert.equal(await readFile(seeded, "utf8").then(() => true, () => false), false, "untouched, so retired");
  assert.match(await readFile(join(root, "office", "agents", "mine.md"), "utf8"), /I wrote this/, "edited, so kept");
});
