import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Office } from "../src/office.js";
import { say } from "../src/chat/session.js";
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

  await saveConfig(join(root, "office.config.json"), { ...defaultConfig("max5x"), driver: "fake", orchestrator: "michelle" });
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
    assert.deepEqual(call?.allowedTools, ["Read", "Grep", "Glob"]);
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
