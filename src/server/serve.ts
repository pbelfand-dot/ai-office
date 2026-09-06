import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { watch, type FSWatcher } from "node:fs";
import { Office } from "../office.js";
import { snapshot } from "./snapshot.js";
import { decide } from "../commands/gate.js";
import { page } from "./page.js";

export interface ServeOptions {
  root: string;
  port: number;
  host: string;
}

/**
 * A local window onto the floor.
 *
 * Bound to loopback by default and never anything else without you saying so:
 * the approve and deny routes act as you, and a dashboard that can sign off an
 * agent's out-of-scope write is not something to expose to a network by
 * accident. The Host check on top of that is for DNS rebinding, where a page
 * you visit resolves a name to 127.0.0.1 and talks to this server from your
 * browser.
 */
export async function serve(opts: ServeOptions): Promise<{ url: string; close: () => Promise<void> }> {
  const office = await Office.open(opts.root);
  const clients = new Set<ServerResponse>();

  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      send(res, 500, { error: err instanceof Error ? err.message : String(err) });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (!isLocal(req.headers.host)) {
      return send(res, 403, { error: "this dashboard only answers requests addressed to localhost" });
    }

    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(page());
      return;
    }

    if (url.pathname === "/favicon.svg") {
      res.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "max-age=86400" });
      res.end(FAVICON);
      return;
    }

    if (url.pathname === "/api/floor") {
      // Reopen so role edits and newly hired agents show up without a restart.
      return send(res, 200, await snapshot(await Office.open(opts.root)));
    }

    if (url.pathname === "/api/stream") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(": connected\n\n");
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }

    const diff = /^\/api\/diff\/([\w.-]+)$/.exec(url.pathname);
    if (diff) {
      const agent = diff[1] as string;
      if (!office.roles.has(agent)) return send(res, 404, { error: `no agent named "${agent}"` });
      const patch = await office.worktrees.diff(agent).catch(() => "");
      return send(res, 200, { agent, diff: patch });
    }

    const memory = /^\/api\/memory\/([\w.-]+)$/.exec(url.pathname);
    if (memory) {
      const agent = memory[1] as string;
      if (!office.roles.has(agent)) return send(res, 404, { error: `no agent named "${agent}"` });
      const [facts, journal, inbox] = await Promise.all([
        office.memory.facts(agent),
        office.memory.journal(agent),
        office.mail.inbox(agent, { unreadOnly: false }),
      ]);
      return send(res, 200, { agent, facts, journal: journal.slice(-25).reverse(), inbox });
    }

    const gate = /^\/api\/escalations\/([\w.-]+)\/(approve|deny)$/.exec(url.pathname);
    if (gate && req.method === "POST") {
      const body = await readBody(req);
      const note = typeof body.note === "string" && body.note.trim() ? body.note.trim() : undefined;
      const message = await decide(await Office.open(opts.root), gate[1] as string, gate[2] as "approve" | "deny", note);
      broadcast(clients, "change");
      return send(res, 200, { ok: true, message: strip(message) });
    }

    send(res, 404, { error: "no such route" });
  }

  // fs.watch is chatty -- an atomic write is a create plus a rename -- so
  // coalesce a burst into one push rather than re-rendering four times.
  let timer: NodeJS.Timeout | null = null;
  const bump = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      broadcast(clients, "change");
    }, 120);
  };

  await office.paths.ensureOffice();
  const watchers: FSWatcher[] = [];
  for (const dir of [office.paths.office, office.paths.rolesDir]) {
    try {
      watchers.push(watch(dir, { recursive: true }, bump));
    } catch {
      // Recursive watch is not universal. The client also polls, so this
      // degrades to slower updates rather than to no updates.
    }
  }

  const heartbeat = setInterval(() => broadcast(clients, "ping"), 25_000);
  heartbeat.unref();

  await new Promise<void>((resolve) => server.listen(opts.port, opts.host, resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : opts.port;

  return {
    url: `http://${opts.host}:${port}`,
    close: async () => {
      clearInterval(heartbeat);
      for (const w of watchers) w.close();
      for (const client of clients) client.end();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function isLocal(host: string | undefined): boolean {
  if (!host) return false;
  const name = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  return name === "localhost" || name === "127.0.0.1" || name === "::1";
}

function broadcast(clients: Set<ServerResponse>, event: string): void {
  for (const client of clients) {
    try {
      client.write(`event: ${event}\ndata: {}\n\n`);
    } catch {
      clients.delete(client);
    }
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(json);
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 64 * 1024) throw new Error("request body too large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

const FAVICON = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">',
  '<rect width="16" height="16" rx="3" fill="#161b22"/>',
  '<circle cx="5.5" cy="5.5" r="2.2" fill="#3fb950"/>',
  '<circle cx="10.5" cy="5.5" r="2.2" fill="#58a6ff"/>',
  '<circle cx="5.5" cy="10.5" r="2.2" fill="#d29922"/>',
  '<circle cx="10.5" cy="10.5" r="2.2" fill="#6e7681"/>',
  "</svg>",
].join("");

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[\\d+m`, "g");
const strip = (s: string): string => s.replace(ANSI, "");
