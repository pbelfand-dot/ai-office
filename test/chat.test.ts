import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Office } from "../src/office.js";
import { say } from "../src/chat/session.js";
import { serve } from "../src/server/serve.js";
import { mentionsIn, parseRouting } from "../src/chat/router.js";
import { FakeDriver, type TurnRequest } from "../src/runner/driver.js";
import { saveConfig, defaultConfig } from "../src/config.js";
import { HUMAN, SYSTEM } from "../src/types.js";

const exec = promisify(execFile);

async function makeFloor(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "office-chat-"));
  await exec("git", ["init", "-q", "-b", "main"], { cwd: root });
  await exec("git", ["config", "user.email", "o@e.com"], { cwd: root });
  await exec("git", ["config", "user.name", "O"], { cwd: root });
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "index.ts"), "export const a = 1;\n", "utf8");
  await exec("git", ["add", "-A"], { cwd: root });
  await exec("git", ["commit", "-qm", "init"], { cwd: root });

  await saveConfig(join(root, "office.config.json"), { ...defaultConfig("max5x"), driver: "fake", orchestrator: "michelle", chat: { ...defaultConfig("max5x").chat, autoRun: 0 } });
  const roles = join(root, "office", "agents");
  await mkdir(roles, { recursive: true });
  await writeFile(join(roles, "michelle.md"), "---\nname: Michelle\ntitle: Head of Floor\ntier: large\nautonomy: trusted\n---\n\nYou run the floor.\n", "utf8");
  await writeFile(join(roles, "ada.md"), "---\nname: Ada\ntitle: Implementation\ntier: large\nautonomy: scoped\nscope:\n  - src/\n---\n\nYou implement.\n", "utf8");
  await writeFile(join(roles, "switchboard.md"), "---\nname: Switchboard\ntitle: Routing\ntier: small\nautonomy: trusted\nhidden: true\n---\n\nYou route.\n", "utf8");
  return root;
}

/** Answers as the switchboard with a routing block, as anyone else with talk. */
function room(pick: string[], line = "Looks fine to me.") {
  return (req: TurnRequest) =>
    req.agent === "switchboard"
      ? { text: '```json\n{"reply":' + JSON.stringify(pick) + ',"why":"they own it"}\n```' }
      : { text: line };
}

describe("routing a message", () => {
  test("an @mention outranks the router", () => {
    assert.deepEqual(mentionsIn("@ada can you look at @kevin's thing", ["ada", "rex"]), ["ada"]);
    assert.deepEqual(mentionsIn("no mentions here", ["ada"]), []);
    assert.deepEqual(mentionsIn("@ada @ada twice", ["ada"]), ["ada"]);
  });

  test("the routing block is read, and unknown desks are dropped from it", () => {
    const known = ["ada", "rex"];
    assert.deepEqual(parseRouting('```json\n{"reply":["ada"],"why":"owns src"}\n```', known)?.recipients, ["ada"]);
    assert.deepEqual(parseRouting('{"reply":["ada","kevin"]}', known)?.recipients, ["ada"]);
    assert.deepEqual(parseRouting('{"reply":[]}', known)?.recipients, []);
  });

  test("a reply that is not a routing block is a miss, not a guess", () => {
    assert.equal(parseRouting("I think Ada should take this one.", ["ada"]), null);
    assert.equal(parseRouting('{"reply":"ada"}', ["ada"]), null);
  });
});

describe("the channel", () => {
  test("the hidden desk routes but is not on the floor", async () => {
    const office = await Office.open(await makeFloor(), new FakeDriver());
    assert.deepEqual(office.agentIds().sort(), ["ada", "michelle"]);
    assert.equal(office.role("switchboard").hidden, true);
  });

  test("a message is answered by whoever the switchboard picked", async () => {
    const root = await makeFloor();
    const office = await Office.open(root, new FakeDriver(room(["ada"], "The pricing page is mine, I'll look.")));

    const { posted, routing, replies } = await say(office, "the pricing page feels off");

    assert.equal(posted.from, HUMAN);
    assert.deepEqual(routing.recipients, ["ada"]);
    assert.equal(replies.length, 1);
    assert.equal(replies[0]?.from, "ada");
    assert.match(replies[0]?.body ?? "", /pricing page is mine/);

    const history = await office.chat.history("floor");
    assert.deepEqual(history.map((m) => m.from), [HUMAN, "ada"]);
    assert.equal(history[1]?.replyTo, posted.id);
  });

  test("an empty pick is a valid answer and costs nobody a turn", async () => {
    const root = await makeFloor();
    const driver = new FakeDriver(room([]));
    const office = await Office.open(root, driver);

    const { replies } = await say(office, "cool, thanks");
    assert.deepEqual(replies, []);
    assert.deepEqual(driver.calls.map((c) => c.agent), ["switchboard"], "only the router ran");
  });

  test("chat runs read-only, on its own thread, and off the work session", async () => {
    const root = await makeFloor();
    const driver = new FakeDriver(room(["ada"]));
    const office = await Office.open(root, driver);

    await say(office, "@ada what does src/index.ts export?");
    const call = driver.calls.find((c) => c.agent === "ada");
    assert.ok(call, "ada answered");
    assert.deepEqual(call?.allowedTools, ["Read", "Grep", "Glob", "WebSearch", "WebFetch"]);
    assert.ok(call?.disallowedTools.includes("Write") && call.disallowedTools.includes("Bash"));
    // The desk runs its work at "large"; chat is capped so talk cannot spend
    // the allowance the building is for.
    assert.equal(call?.tier, "mid");

    const state = await office.state("ada");
    assert.equal(state.chatSessionId, "fake-session-ada");
    assert.equal(state.sessionId, undefined, "the work thread is untouched by chat");
  });

  test("a desk talking all afternoon is not parked for it", async () => {
    const root = await makeFloor();
    const office = await Office.open(root, new FakeDriver(room(["ada"], "Same answer as before.")));

    for (let i = 0; i < 6; i++) await say(office, "@ada still thinking about the pricing page");

    const state = await office.state("ada");
    assert.equal(state.idleTurns, 0);
    assert.equal(state.breakerStage, 0);
    assert.notEqual(state.status, "parked");
  });

  test("a desk that cannot answer says so in the channel", async () => {
    const root = await makeFloor();
    const office = await Office.open(root, new FakeDriver(room(["ada"])));
    await office.saveState({ ...(await office.state("ada")), status: "parked", breakerStage: 3 });

    const { replies } = await say(office, "@ada you there?");
    assert.equal(replies[0]?.from, SYSTEM);
    assert.match(replies[0]?.body ?? "", /Ada did not answer: .*parked/);
  });

  test("every turn the channel spends is on the ledger", async () => {
    const root = await makeFloor();
    const office = await Office.open(root, new FakeDriver(room(["ada"])));

    await say(office, "who owns pricing?");
    const spent = (await office.ledger.entries()).map((e) => e.agent);
    assert.deepEqual(spent, ["switchboard", "ada"]);
  });

  test("a session the CLI will not resume is forgotten, not retried forever", async () => {
    const root = await makeFloor();
    const office = await Office.open(root, new FakeDriver((req) =>
      req.agent === "switchboard"
        ? { text: '```json\n{"reply":["ada"]}\n```' }
        // What the real CLI does with an id it does not recognise: exit 1, no
        // parseable result, and the same failure on every turn after it.
        : { ok: false, text: "", sessionLost: true, error: "--resume requires a valid session ID" },
    ));
    await office.saveState({ ...(await office.state("ada")), chatSessionId: "not-a-real-session" });

    await say(office, "@ada you there?");
    assert.equal((await office.state("ada")).chatSessionId, undefined, "the bad id is dropped");
  });

  test("two desks posting at once both land in the transcript", async () => {
    const office = await Office.open(await makeFloor(), new FakeDriver());
    await Promise.all([
      office.chat.post({ channel: "floor", from: "ada", body: "first" }),
      office.chat.post({ channel: "floor", from: "michelle", body: "second" }),
    ]);
    const history = await office.chat.history("floor");
    assert.equal(history.length, 2);
    assert.deepEqual(history.map((m) => m.body).sort(), ["first", "second"]);
  });
});

describe("an admin who routes in the open", () => {
  /** A floor whose router is a visible desk, the way the photography floor is. */
  async function bossFloor(): Promise<string> {
    const root = await makeFloor();
    const roles = join(root, "office", "agents");
    await writeFile(join(roles, "paul.md"), "---\nname: Paul\ntitle: Admin\ntier: large\nautonomy: trusted\n---\n\nYou run the floor.\n", "utf8");
    await writeFile(join(roles, "rex.md"), "---\nname: Rex\ntitle: Money\ntier: mid\nautonomy: trusted\n---\n\nYou own pricing.\n", "utf8");
    await saveConfig(join(root, "office.config.json"), { ...defaultConfig("max5x"), driver: "fake", orchestrator: "paul", router: "paul", chat: { ...defaultConfig("max5x").chat, autoRun: 0 } });
    return root;
  }

  test("the admin never routes to itself", async () => {
    const root = await bossFloor();
    const driver = new FakeDriver((req) =>
      req.agent === "paul" ? { text: '{"reply":["paul","ada"],"why":"tried to take it"}' } : { text: "On it." });
    const { routing } = await say(await Office.open(root, driver), "who owns pricing?");
    assert.deepEqual(routing.recipients, ["ada"], "paul is the router, not a recipient");
  });

  test("the admin speaks only when the decision needs saying", async () => {
    const root = await bossFloor();
    const spoken = await say(
      await Office.open(root, new FakeDriver((req) =>
        req.agent !== "paul" ? { text: "Quoted." }
          : req.prompt.includes("Your call") ? { text: '{"assign":[]}' }
          : { text: '{"reply":["ada"],"why":"hers","say":"Ada, quote the twilight package."}' })),
      "client wants a price",
    );
    assert.deepEqual(spoken.replies.map((m) => m.from), ["paul", "ada"], "the assignment lands before the work");

    const quiet = await say(
      await Office.open(await bossFloor(), new FakeDriver((req) =>
        req.agent !== "paul" ? { text: "Quoted." }
          : req.prompt.includes("Your call") ? { text: '{"assign":[]}' }
          : { text: '{"reply":["ada"],"why":"hers"}' })),
      "client wants a price",
    );
    assert.deepEqual(quiet.replies.map((m) => m.from), ["ada"], "no line from paul when he has nothing to decide");
  });

  test("a nominated desk may jump in, or pass and cost the room nothing", async () => {
    const root = await bossFloor();
    const speaks = new FakeDriver((req) =>
      req.agent === "paul" ? { text: '{"reply":["ada"],"maybe":["rex"],"why":"hers"}' }
        : req.agent === "rex" ? { text: "That price loses money on drive time." }
        : { text: "Quoted at 250." });
    const loud = await say(await Office.open(root, speaks), "what do we charge for the Maple St shoot?");
    assert.deepEqual(loud.replies.map((m) => m.from), ["ada", "rex"], "the volunteer speaks last");

    const passes = new FakeDriver((req) =>
      req.agent === "paul" ? { text: '{"reply":["ada"],"maybe":["rex"],"why":"hers"}' }
        : req.agent === "rex" ? { text: "PASS" }
        : { text: "Quoted at 250." });
    const calm = await say(await Office.open(await bossFloor(), passes), "what do we charge?");
    assert.deepEqual(calm.replies.map((m) => m.from), ["ada"], "a pass never reaches the channel");
  });
});

describe("a question never reaches nobody", () => {
  async function bossOnly(): Promise<string> {
    const root = await makeFloor();
    await writeFile(join(root, "office", "agents", "paul.md"), "---\nname: Paul\ntitle: Admin\ntier: large\nautonomy: trusted\n---\n\nYou run the floor.\n", "utf8");
    await saveConfig(join(root, "office.config.json"), { ...defaultConfig("max5x"), driver: "fake", orchestrator: "paul", router: "paul", chat: { ...defaultConfig("max5x").chat, autoRun: 0 } });
    return root;
  }

  test("naming a desk in the line routes to them, so the question is not left hanging", () => {
    // The exact shape that produced silence: Paul asked Marco something and
    // routed to nobody, so Marco never got a turn to answer it.
    const routing = parseRouting('{"reply":[],"why":"not scale yet","say":"Marco, what is blocking the first outreach?"}', ["marco", "ada"]);
    assert.deepEqual(routing?.recipients, ["marco"]);
  });

  test("an empty pick on a real question falls to a desk, not to nobody", async () => {
    const root = await bossOnly();
    const office = await Office.open(root, new FakeDriver((req) =>
      req.agent === "paul" && req.prompt.includes("Answer format")
        ? { text: '{"reply":[],"why":"nobody"}' }
        : { text: "Bookings first." }));

    const { routing, replies } = await say(office, "what should i do to scale my real estate brand?");
    assert.notDeepEqual(routing.recipients, [], "somebody holds the question");
    assert.ok(replies.length > 0, "the room answered");
  });

  test("an acknowledgement is still allowed to land on nobody", async () => {
    const root = await bossOnly();
    const office = await Office.open(root, new FakeDriver(() => ({ text: '{"reply":[],"why":"just thanks"}' })));
    const { replies } = await say(office, "cool thanks");
    assert.deepEqual(replies, [], "small talk costs one routing turn and nothing else");
  });
});

describe("assigning work from the chat", () => {
  test("an assignment becomes a real task on the queue", async () => {
    const root = await makeFloor();
    const office = await Office.open(root, new FakeDriver((req) =>
      req.agent === "switchboard"
        ? { text: '{"reply":["ada"],"why":"hers","assign":[{"to":"ada","task":"Write five cold emails into outbound/"}]}' }
        : { text: "On it." }));

    const { queued } = await say(office, "write me five cold emails");
    assert.equal(queued.length, 1);
    assert.equal(queued[0]?.assignee, "ada");
    assert.equal(queued[0]?.state, "pending");

    const onQueue = await office.tasks();
    assert.equal(onQueue.length, 1, "the scheduler can see it");
    assert.match(onQueue[0]?.instruction ?? "", /cold emails/);

    const history = await office.chat.history("floor");
    assert.match(history.at(-1)?.body ?? "", /On the queue now/);
  });

  test("assignments to desks that do not exist are dropped, not queued", async () => {
    const root = await makeFloor();
    const office = await Office.open(root, new FakeDriver((req) =>
      req.agent === "switchboard"
        ? { text: '{"reply":[],"why":"x","assign":[{"to":"kevin","task":"do a thing"},{"to":"ada","task":"real work"}]}' }
        : { text: "ok" }));

    const { queued } = await say(office, "get someone on this please, whoever owns it");
    assert.deepEqual(queued.map((t) => t.assignee), ["ada"]);
  });
});

describe("the boss assigns after hearing the answer", () => {
  test("a blocker named in a reply becomes somebody's task", async () => {
    const root = await makeFloor();
    await writeFile(join(root, "office", "agents", "paul.md"), "---\nname: Paul\ntitle: Admin\ntier: large\nautonomy: trusted\n---\n\nYou run the floor.\n", "utf8");
    await writeFile(join(root, "office", "agents", "victor.md"), "---\nname: Victor\ntitle: Finance\ntier: mid\nautonomy: trusted\n---\n\nYou own money.\n", "utf8");
    await saveConfig(join(root, "office.config.json"), { ...defaultConfig("max5x"), driver: "fake", orchestrator: "paul", router: "paul", chat: { ...defaultConfig("max5x").chat, autoRun: 0 } });

    // Routing cannot know about the blocker: it happens before ada speaks.
    const office = await Office.open(root, new FakeDriver((req) =>
      req.agent !== "paul" ? { text: "I am blocked: nobody has set the price." }
        : req.prompt.includes("Your call")
          ? { text: '{"assign":[{"to":"victor","task":"Set the shoot price and write it to finance/pricing.md"}],"say":"Victor, price it today."}' }
          : { text: '{"reply":["ada"],"why":"hers"}' }));

    const { queued, replies } = await say(office, "what should i do to scale?");
    assert.deepEqual(queued.map((t) => t.assignee), ["victor"], "the boss assigned off what was said");
    assert.match(queued[0]?.instruction ?? "", /pricing\.md/);
    assert.equal(replies.at(-1)?.from, "paul", "and said so");
    assert.equal((await office.tasks()).length, 1);
  });

  test("a hidden switchboard hands out no work, because it is a classifier", async () => {
    const root = await makeFloor();
    const driver = new FakeDriver((req) =>
      req.agent === "switchboard" ? { text: '{"reply":["ada"],"why":"hers"}' } : { text: "Blocked on pricing." });
    const office = await Office.open(root, driver);

    const { queued } = await say(office, "what should we do about the pricing page?");
    assert.deepEqual(queued, []);
    assert.equal(driver.calls.filter((c) => c.agent === "switchboard").length, 1, "no second pass for a hidden desk");
  });
});

describe("serving the room", () => {
  test("a port already in use is a sentence, not a stack trace", async () => {
    const root = await makeFloor();
    const first = await serve({ root, port: 0, host: "127.0.0.1" });
    try {
      await assert.rejects(
        serve({ root, port: Number(new URL(first.url).port), host: "127.0.0.1" }),
        /already in use/,
      );
    } finally {
      await first.close();
    }
  });
});

describe("the queue works itself", () => {
  /** A switchboard that assigns, and a desk that finishes and says so. */
  const assigns = (req: TurnRequest) =>
    req.agent === "switchboard"
      ? { text: '{"reply":[],"why":"work, not talk","assign":[{"to":"ada","task":"Write the sequence into outbound/"}]}' }
      : { text: "Wrote it.\n\nOFFICE-DONE: wrote the sequence into outbound/" };

  test("work assigned in the chat is done without a second command", async () => {
    const root = await makeFloor();
    await saveConfig(join(root, "office.config.json"), {
      ...defaultConfig("max5x"), driver: "fake", orchestrator: "michelle",
      chat: { ...defaultConfig("max5x").chat, autoRun: 4 },
    });
    const office = await Office.open(root, new FakeDriver(assigns));

    const { queued, worked, replies } = await say(office, "we need the outreach sequence written up today please");
    assert.equal(queued.length, 1);
    assert.equal(worked?.completed.length, 1, "the floor worked it there and then");

    const stored = await office.tasks();
    assert.equal(stored[0]?.state, "done");
    assert.match(stored[0]?.result ?? "", /wrote the sequence/);

    // And the room is told by the desk that did it, not by a status line.
    const history = await office.chat.history("floor");
    assert.equal(history.at(-1)?.from, "ada");
    assert.match(history.at(-1)?.body ?? "", /wrote the sequence/);

    // The outcome has to come back with the exchange too, or the terminal
    // prints the assignment, swallows the result, and looks like nothing ran.
    assert.equal(replies.at(-1)?.from, "ada");
    assert.match(replies.at(-1)?.body ?? "", /wrote the sequence/);
  });

  test("autoRun 0 assigns and waits, for anyone who wants the second command", async () => {
    const root = await makeFloor();
    await saveConfig(join(root, "office.config.json"), {
      ...defaultConfig("max5x"), driver: "fake", orchestrator: "michelle",
      chat: { ...defaultConfig("max5x").chat, autoRun: 0 },
    });
    const office = await Office.open(root, new FakeDriver(assigns));

    const { queued, worked } = await say(office, "we need the outreach sequence written up today please");
    assert.equal(queued.length, 1);
    assert.equal(worked, null);
    assert.equal((await office.tasks())[0]?.state, "pending", "still waiting to be run");
  });

  test("the ceiling is what stops one sentence buying an afternoon", async () => {
    const root = await makeFloor();
    await saveConfig(join(root, "office.config.json"), {
      ...defaultConfig("max5x"), driver: "fake", orchestrator: "michelle",
      chat: { ...defaultConfig("max5x").chat, autoRun: 2 },
    });
    // A desk that never signals completion is the expensive case: without a
    // ceiling the scheduler would retry it to the attempt limit.
    const office = await Office.open(root, new FakeDriver((req) =>
      req.agent === "switchboard"
        ? { text: '{"reply":[],"why":"work","assign":[{"to":"ada","task":"An endless task"}]}' }
        : { text: "Still going." }));

    const { worked } = await say(office, "please get someone started on the endless thing");
    assert.equal(worked?.turns, 2, "stopped at the ceiling");
    assert.equal((await office.tasks())[0]?.state, "assigned", "and left it on the queue");
  });
});
