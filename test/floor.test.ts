import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

import { Office } from "../src/office.js";
import { Scheduler } from "../src/orchestrator/scheduler.js";
import { runTurn } from "../src/orchestrator/turn.js";
import { FakeDriver, type TurnRequest } from "../src/runner/driver.js";
import { saveConfig, defaultConfig } from "../src/config.js";
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
  await saveConfig(join(root, "office.config.json"), {
    ...defaultConfig("max5x"),
    driver: "fake",
    orchestrator: "michelle",
    budget: { ...defaultConfig("max5x").budget, maxConcurrentAgents: 2 },
  });
  const roles = join(root, "office", "agents");
  await mkdir(roles, { recursive: true });
  await writeFile(join(roles, "michelle.md"), "---\nname: Michelle\ntitle: Head of Floor\ntier: opus\nautonomy: trusted\n---\n\nYou run the floor.\n", "utf8");
  await writeFile(join(roles, "ada.md"), "---\nname: Ada\ntitle: Implementation\ntier: sonnet\nautonomy: scoped\nscope:\n  - src/\n---\n\nYou implement.\n", "utf8");
  await writeFile(join(roles, "rex.md"), "---\nname: Rex\ntitle: Review\ntier: sonnet\nautonomy: scoped\nscope:\n  - test/\n---\n\nYou review.\n", "utf8");
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
    await saveConfig(join(repo, "office.config.json"), {
      ...defaultConfig("max5x"), driver: "fake", orchestrator: "michelle",
      budget: { ...defaultConfig("max5x").budget, windowTokenBudget: 1, weeklyTokenBudget: 1 },
    });
    const office = await Office.open(repo, new FakeDriver(workingAgent(repo)));
    await office.ledger.record({
      at: nowIso(), agent: "ada", model: "sonnet", tier: "sonnet", costUsd: 1,
      inputTokens: 10_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
      durationMs: 1, turns: 1, ok: true,
    });
    await office.saveTasks([task()]);

    const summary = await new Scheduler(office).run({ maxTurns: 5 });
    assert.equal(summary.turns, 0, "no turn should have been spawned");
    assert.match(summary.stoppedBecause, /budget spent/);
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
