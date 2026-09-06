#!/usr/bin/env node
import { parseArgs } from "node:util";
import { Office } from "./office.js";
import { init, hire } from "./commands/setup.js";
import { floor, roster, budget, providers } from "./commands/status.js";
import { brief, run, ask, tasks } from "./commands/work.js";
import { callerOf, mail, inbox, remember, recall, escalate, done, revive, diff } from "./commands/agent.js";
import { approvals, decide } from "./commands/gate.js";
import { bold, dim, red } from "./commands/format.js";
import type { CodexPlan, Plan } from "./config.js";

const HELP = `${bold("office")} -- a floor of CLI agents that stops where you tell it to

${bold("Setting up")}
  office init [--plan pro|max5x|max20x|api] [--codex-plan none|go|plus|pro|api] [--no-seed] [--force]
  office hire <agent> [--title T] [--provider claude|codex] [--tier small|mid|large] [--autonomy ask|scoped|trusted] [--scope src/]

${bold("Working")}
  office brief "<what you want done>" [--run] [--max-turns N]   split a brief into assigned tasks
  office run [--max-turns N]                                    work the queue
  office ask <agent> "<instruction>"                            one instruction, one agent, no planner
  office tasks [--all]

${bold("Watching")}
  office serve [--port 4319] [--host 127.0.0.1]   the floor in a browser, live
  office floor            who is on what, and what is left of the budget
  office roster           the desks and what each one is allowed to touch
  office providers        the subscriptions behind the floor, and their caps
  office budget [--calibrate]
  office diff <agent>     what an agent actually changed

${bold("Deciding")}
  office approvals [--all]
  office approve <id> [--note "..."]
  office deny <id> [--note "..."]
  office revive <agent>   reset a desk the circuit breaker stopped

${bold("What agents run on themselves")} ${dim("(pass --as <agent> to stand in from your own shell)")}
  office inbox [--all] [--read]
  office mail <agent> "<subject>" "<body>"
  office remember "<what you learned>" [--tag T]
  office recall "<query>" [--agent A] [--limit N]
  office escalate "<question for the human>"
  office done "<what you changed>"
`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }

  const root = process.env.OFFICE_ROOT ?? process.cwd();
  const open = () => Office.open(root);

  switch (command) {
    case "init": {
      const { values } = parseArgs({ args: rest, options: {
        plan: { type: "string", default: "max5x" },
        "codex-plan": { type: "string", default: "none" },
        force: { type: "boolean", default: false },
        seed: { type: "boolean", default: true },
      }, allowPositionals: false });
      const plan = values.plan as Plan;
      const codexPlan = values["codex-plan"] as CodexPlan;
      if (!["pro", "max5x", "max20x", "api"].includes(plan)) throw new Error(`unknown plan "${plan}"`);
      if (!["none", "go", "plus", "pro", "api"].includes(codexPlan)) throw new Error(`unknown codex plan "${codexPlan}"`);
      return say(await init({ root, plan, codexPlan, force: values.force as boolean, seed: values.seed as boolean }));
    }

    case "hire": {
      const { values, positionals } = parseArgs({ args: rest, options: {
        title: { type: "string" }, tier: { type: "string" }, autonomy: { type: "string" },
        provider: { type: "string" }, scope: { type: "string", multiple: true },
      }, allowPositionals: true });
      const id = need(positionals[0], "office hire <agent>");
      return say(await hire(root, id, values as { title?: string; tier?: string; autonomy?: string; scope?: string[]; provider?: string }));
    }

    case "serve": {
      const { values } = parseArgs({ args: rest, options: {
        port: { type: "string", default: "4319" },
        host: { type: "string", default: "127.0.0.1" },
      } });
      const { serve } = await import("./server/serve.js");
      const { url } = await serve({ root, port: Number(values.port), host: values.host as string });
      process.stdout.write(`${bold("the floor")} ${url}\n${dim("  Live. Approving an escalation here does what `office approve` does.")}\n${dim("  Ctrl-C to stop.")}\n`);
      return 0;
    }

    case "floor": return say(await floor(await open()));
    case "roster": return say(await roster(await open()));
    case "providers": return say(await providers(await open()));

    case "budget": {
      const { values } = parseArgs({ args: rest, options: { calibrate: { type: "boolean", default: false } } });
      return say(await budget(await open(), values.calibrate as boolean));
    }

    case "brief": {
      const { values, positionals } = parseArgs({ args: rest, options: {
        run: { type: "boolean", default: false },
        "max-turns": { type: "string", default: "50" },
      }, allowPositionals: true });
      const text = need(positionals.join(" ").trim(), 'office brief "<what you want done>"');
      return say(await brief(await open(), text, { run: values.run as boolean, maxTurns: Number(values["max-turns"]) }));
    }

    case "run": {
      const { values } = parseArgs({ args: rest, options: { "max-turns": { type: "string", default: "50" } } });
      return say(await run(await open(), { maxTurns: Number(values["max-turns"]) }));
    }

    case "ask": {
      const { positionals } = parseArgs({ args: rest, allowPositionals: true, options: {} });
      const agent = need(positionals[0], 'office ask <agent> "<instruction>"');
      const instruction = need(positionals.slice(1).join(" ").trim(), 'office ask <agent> "<instruction>"');
      return say(await ask(await open(), agent, instruction));
    }

    case "tasks": {
      const { values } = parseArgs({ args: rest, options: { all: { type: "boolean", default: false } } });
      return say(await tasks(await open(), { all: values.all as boolean }));
    }

    case "diff": {
      const { positionals } = parseArgs({ args: rest, allowPositionals: true, options: {} });
      return say(await diff(await open(), need(positionals[0], "office diff <agent>")));
    }

    case "revive": {
      const { positionals } = parseArgs({ args: rest, allowPositionals: true, options: {} });
      return say(await revive(await open(), need(positionals[0], "office revive <agent>")));
    }

    case "approvals": {
      const { values } = parseArgs({ args: rest, options: { all: { type: "boolean", default: false } } });
      return say(await approvals(await open(), { all: values.all as boolean }));
    }

    case "approve":
    case "deny": {
      const { values, positionals } = parseArgs({ args: rest, options: { note: { type: "string" } }, allowPositionals: true });
      const id = need(positionals[0], `office ${command} <escalation-id> [--note "..."]`);
      return say(await decide(await open(), id, command === "approve" ? "approve" : "deny", values.note as string | undefined));
    }

    case "inbox": {
      const { values } = parseArgs({ args: rest, options: {
        all: { type: "boolean", default: false }, read: { type: "boolean", default: false }, as: { type: "string" },
      } });
      return say(await inbox(await open(), callerOf(values.as as string | undefined), { all: values.all as boolean, read: values.read as boolean }));
    }

    case "mail": {
      const { values, positionals } = parseArgs({ args: rest, options: { as: { type: "string" }, task: { type: "string" } }, allowPositionals: true });
      const to = need(positionals[0], 'office mail <agent> "<subject>" "<body>"');
      const subject = need(positionals[1], 'office mail <agent> "<subject>" "<body>"');
      const body = need(positionals.slice(2).join(" ").trim(), 'office mail <agent> "<subject>" "<body>"');
      return say(await mail(await open(), callerOf(values.as as string | undefined), to, subject, body, values.task as string | undefined));
    }

    case "remember": {
      const { values, positionals } = parseArgs({ args: rest, options: { as: { type: "string" }, tag: { type: "string" } }, allowPositionals: true });
      const text = need(positionals.join(" ").trim(), 'office remember "<what you learned>"');
      return say(await remember(await open(), callerOf(values.as as string | undefined), text, values.tag as string | undefined));
    }

    case "recall": {
      const { values, positionals } = parseArgs({ args: rest, options: {
        agent: { type: "string" }, limit: { type: "string", default: "8" }, as: { type: "string" },
      }, allowPositionals: true });
      const query = need(positionals.join(" ").trim(), 'office recall "<query>"');
      return say(await recall(await open(), query, { agent: values.agent as string | undefined, limit: Number(values.limit) }));
    }

    case "escalate": {
      const { values, positionals } = parseArgs({ args: rest, options: { as: { type: "string" }, task: { type: "string" } }, allowPositionals: true });
      const question = need(positionals.join(" ").trim(), 'office escalate "<question for the human>"');
      return say(await escalate(await open(), callerOf(values.as as string | undefined), question, values.task as string | undefined));
    }

    case "done": {
      const { values, positionals } = parseArgs({ args: rest, options: { as: { type: "string" }, task: { type: "string" } }, allowPositionals: true });
      const summary = need(positionals.join(" ").trim(), 'office done "<what you changed>"');
      return say(await done(await open(), callerOf(values.as as string | undefined), summary, values.task as string | undefined));
    }

    default:
      process.stderr.write(`${red(`unknown command "${command}"`)}\n\n${HELP}\n`);
      return 1;
  }
}

function need<T>(value: T | undefined, usage: string): T {
  if (value === undefined || value === "" ) throw new Error(`usage: ${usage}`);
  return value;
}

function say(text: string): number {
  process.stdout.write(`${text}\n`);
  return 0;
}

main(process.argv.slice(2))
  .then((code) => { process.exitCode = code; })
  .catch((err: unknown) => {
    process.stderr.write(`${red("error")} ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
