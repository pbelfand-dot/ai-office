import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { serve } from "../src/server/serve.js";
import { snapshot } from "../src/server/snapshot.js";
import { Office } from "../src/office.js";
import { FakeDriver } from "../src/runner/driver.js";
import { saveConfig, defaultConfig } from "../src/config.js";
import { nowIso } from "../src/util.js";
import { connect } from "node:net";

const exec = promisify(execFile);

async function makeFloor(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "office-serve-"));
  await exec("git", ["init", "-q", "-b", "main"], { cwd: root });
  await exec("git", ["config", "user.email", "o@e.com"], { cwd: root });
  await exec("git", ["config", "user.name", "O"], { cwd: root });
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "index.ts"), "export const a = 1;\n", "utf8");
  await exec("git", ["add", "-A"], { cwd: root });
  await exec("git", ["commit", "-qm", "init"], { cwd: root });

  await saveConfig(join(root, "office.config.json"), { ...defaultConfig("max5x"), driver: "fake" });
  const roles = join(root, "office", "agents");
  await mkdir(roles, { recursive: true });
  await writeFile(join(roles, "ada.md"), "---\nname: Ada\ntitle: Implementation\ntier: sonnet\nautonomy: scoped\nscope:\n  - src/\n---\n\nYou implement.\n", "utf8");
  await writeFile(join(roles, "rex.md"), "---\nname: Rex\ntitle: Review\ntier: sonnet\nautonomy: scoped\nscope:\n  - test/\n---\n\nYou review.\n", "utf8");
  return root;
}

describe("the visual floor", () => {
  let root: string;
  let url: string;
  let close: () => Promise<void>;

  before(async () => {
    root = await makeFloor();
    const started = await serve({ root, port: 0, host: "127.0.0.1" });
    url = started.url;
    close = started.close;
  });

  after(async () => { await close(); });

  test("serves a self-contained page with no external requests", async () => {
    const res = await fetch(`${url}/`);
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.match(html, /<title>ai-office<\/title>/);
    assert.doesNotMatch(html, /src="https?:/, "the dashboard must not fetch anything off-machine");
    assert.doesNotMatch(html, /href="https?:\/\/(?!localhost)/, "no external stylesheets either");
  });

  test("the snapshot carries a desk per role, with tier and scope", async () => {
    const res = await fetch(`${url}/api/floor`);
    const floor = await res.json() as Awaited<ReturnType<typeof snapshot>>;
    assert.deepEqual(floor.desks.map((d) => d.id).sort(), ["ada", "rex"]);
    assert.equal(floor.maxConcurrent, 2);
    assert.equal(floor.desks[0]?.status, "idle");
    assert.deepEqual(floor.desks.find((d) => d.id === "ada")?.scope, ["src/"]);
  });

  test("budget percentages are reported against the configured caps", async () => {
    const office = await Office.open(root, new FakeDriver());
    await office.ledger.record({
      at: nowIso(), agent: "ada", model: "sonnet", tier: "sonnet", costUsd: 0.5,
      inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
      durationMs: 10, turns: 1, ok: true,
    });

    const floor = await (await fetch(`${url}/api/floor`)).json() as Awaited<ReturnType<typeof snapshot>>;
    assert.equal(floor.budget.window.used, 1_000_000);
    assert.ok(floor.budget.window.pct > 0.1 && floor.budget.window.pct < 0.2, `unexpected pct ${floor.budget.window.pct}`);
    assert.equal(floor.budget.turns, 1);
    assert.equal(floor.burn.at(-1)?.agent, "ada");
  });

  test("mail in flight is exposed so the client can animate it once", async () => {
    const office = await Office.open(root, new FakeDriver());
    await office.mail.send({ from: "ada", to: "rex", subject: "signature", body: "?" });

    let floor = await (await fetch(`${url}/api/floor`)).json() as Awaited<ReturnType<typeof snapshot>>;
    assert.equal(floor.mail.at(-1)?.delivered, false, "still in the outbox");

    await office.router.deliverAll(new Set(["ada", "rex"]));
    floor = await (await fetch(`${url}/api/floor`)).json() as Awaited<ReturnType<typeof snapshot>>;
    const msg = floor.mail.at(-1);
    assert.equal(msg?.delivered, true);
    assert.equal(msg?.from, "ada");
    assert.equal(msg?.to, "rex");
    assert.equal(floor.desks.find((d) => d.id === "rex")?.unread, 1);
  });

  test("an escalation can be decided from the browser, and the agent remembers why", async () => {
    const office = await Office.open(root, new FakeDriver());
    const raised = await office.escalations.raise({ agent: "ada", kind: "explicit", summary: "bump major?", detail: "d" });
    await office.saveState({ ...(await office.state("ada")), status: "blocked" });

    const res = await fetch(`${url}/api/escalations/${raised.id}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ note: "yes, and note it in the changelog" }),
    });
    assert.equal(res.status, 200);

    assert.equal((await office.escalations.list({ openOnly: true })).length, 0);
    assert.equal((await Office.open(root)).state("ada").then((s) => s.status) instanceof Promise, true);
    assert.equal((await (await Office.open(root)).state("ada")).status, "idle");
    assert.match(await office.memory.brief("ada"), /note it in the changelog/);
  });

  // fetch() silently drops a caller-supplied Host header, so this has to go over
  // a raw socket -- which is also how the attack it guards against would arrive.
  test("a request not addressed to localhost is refused", async () => {
    const port = Number(new URL(url).port);
    const status = await rawRequest(port, "GET /api/floor HTTP/1.1\r\nHost: evil.example.com\r\nConnection: close\r\n\r\n");
    assert.equal(status, 403);

    const ok = await rawRequest(port, "GET /api/floor HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
    assert.equal(ok, 200);
  });

  test("the diff route refuses an agent who does not exist", async () => {
    assert.equal((await fetch(`${url}/api/diff/kevin`)).status, 404);
    assert.equal((await fetch(`${url}/api/memory/kevin`)).status, 404);
  });

  test("the stream opens as an event stream", async () => {
    const controller = new AbortController();
    const res = await fetch(`${url}/api/stream`, { signal: controller.signal });
    assert.equal(res.headers.get("content-type"), "text/event-stream");
    controller.abort();
  });

  test("a newly hired agent appears without restarting the server", async () => {
    await writeFile(join(root, "office", "agents", "doc.md"),
      "---\nname: Doc\ntitle: Docs\ntier: haiku\nautonomy: scoped\nscope:\n  - README.md\n---\n\nYou write docs.\n", "utf8");
    const floor = await (await fetch(`${url}/api/floor`)).json() as Awaited<ReturnType<typeof snapshot>>;
    assert.ok(floor.desks.some((d) => d.id === "doc"), "the roster is re-read per request");
  });
});

/** Send a hand-written request and return the status line's code. */
function rawRequest(port: number, request: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => socket.write(request));
    let data = "";
    socket.on("data", (chunk) => { data += chunk; });
    socket.on("error", reject);
    socket.on("close", () => {
      const match = /^HTTP\/1\.\d (\d{3})/.exec(data);
      match ? resolve(Number(match[1])) : reject(new Error(`no status line in: ${data.slice(0, 200)}`));
    });
  });
}
