# ai-office

A floor of CLI coding agents that share one subscription, remember what they
decided, mail each other, and stop at the line you draw.

It is a headless harness, not a desktop app. There is no pixel office. What
there is: one git worktree per agent, markdown memory that survives restarts, a
file-backed mailbox, a three-stage circuit breaker, an approval gate, and a
budget governor that knows nine agents do not get nine budgets.

```
office init --plan max5x
office brief "Migrate the payments module off the deprecated client. Keep the
              public interface identical. Add tests for the two edge cases in
              issue 412." --run
office floor
```

## The one idea

Every agent on the floor signs in as the same subscription. So the floor has
**one** budget, not one per desk. Adding agents does not add capacity — it
spends the same capacity faster, in parallel, and lands you at a hard stop
mid-refactor on a Tuesday morning.

Almost every tool in this category treats the agent count as the headline
number. Here it is the constrained resource, and the scheduler is built around
that:

- **Concurrency is capped by plan**, not by how many role files exist. `max5x`
  ships at 2 concurrent turns.
- **A ledger records every turn** — real token counts and cost, read out of the
  CLI's own JSON result.
- **Between the soft stop and the cap, work continues a tier down.** A demoted
  agent that finishes beats a premium agent that gets cut off.
- **At the cap, nothing starts.** Discovering the wall by hitting it wastes the
  turn that hits it.
- **`office budget --calibrate`** replaces the shipped guesses with numbers
  measured from your own ledger.

## The money

Anthropic's individual plans are Pro at $20/month, Max 5x at $100, and Max 20x
at $200. Claude Code enforces two overlapping limits: a five-hour rolling window
and a weekly cap, either of which pauses you until its timer resets.

Anthropic does **not** publish exact token quotas for these plans. So the token
budgets in `office.config.json` are not quotas — they are *your* governor, set
by you, defaulted from the published plan multiples (1x / 5x / 20x) and meant to
be replaced after a week of measurement. Anything that told you otherwise would
be inventing a number.

Two things worth knowing before you size a floor:

- The weekly limits moved in 2026. A temporary 50% boost ran from May 13; on
  August 30 Anthropic made a 25% increase permanent and ended the boost, which
  nets out *below* the boosted capacity people had grown used to. Size against
  the permanent number, not the one you remember.
- On a subscription, the `costUsd` in the ledger is notional — it is what the
  CLI reports the turn *would* have cost on the API. You are not billed it. It
  is still the best available proxy for "how much of my week did that burn",
  which is why the gate escalates on it.

What that means concretely on Max 5x at $100/month: two concurrent agents, a
premium orchestrator that only plans, workers on Sonnet, and documentation on
Haiku. A third worker is not free capacity — it is the same week, spent
one-and-a-half times faster.

## What each agent gets

| | |
|---|---|
| **A role** | `office/agents/<id>.md` — frontmatter plus a briefing. Tier, autonomy, scope, tool allowlist. |
| **A worktree** | `git worktree` on branch `office/<id>`. Two agents never share a checkout. |
| **Memory** | `journal.md` (what happened, append-only, rolls over) and `facts.md` (what is still true). Searchable across the whole floor with BM25. |
| **A mailbox** | JSON files on disk. Outbox → router → inbox. Survives a crash; greppable. |

Memory is deliberately not auto-summarised. Condensing a journal well means
reading it, and reading it means a model call — so the office would quietly
spend your window compressing notes nobody asked for. Rolling over is free.
Deciding what is durable is the agent's job, on a turn you already paid for.

## The protocol

Agents cannot call each other in-process; each is a separate CLI with its own
context. They coordinate by running these in their own shell:

```
office inbox                    # read mail addressed to you
office mail <agent> "<subj>" "<body>"
office remember "<what you learned>"
office recall "<query>"         # search every agent's memory
office escalate "<question>"    # hand a decision to the human, and stop
office done "<what you changed>"
```

Anything an agent cannot express as one of these, it cannot do to the rest of
the floor.

## Where it stops

Three independent brakes, because they fail differently.

**The gate** decides whether work leaves the worktree. Autonomy is per role:
`ask` (every write comes back to you), `scoped` (writes inside your scope are
free, outside escalates), `trusted` (only destructive operations and spend
escalate). A new role starts at `ask` and gets promoted once you have read a few
of its diffs — not because everything shares one slider you eventually switch
off out of irritation.

Containment is the worktree, and the gate decides what leaves it. The tempting
alternative — running low-autonomy agents in the CLI's `plan` mode so it refuses
to write — does not work here: plan mode also blocks the shell commands the
protocol is built on, so the agent could no longer mail, remember, or finish. It
would look obedient and be useless.

**The circuit breaker** steers, then constrains, then stops. Two turns without
visible progress and the agent is told, in its next system prompt, to name what
is blocking it and either mail someone or escalate. Three and it loses its
premium model. Past that, or 25 turns on one task, and the desk is parked until
you run `office revive`. A looping agent is the most expensive failure in this
whole category, because it fails quietly and bills the entire time.

**The budget governor** is above. It is the only one that can stop the floor
outright.

`bypassPermissions` is never selected for you.

## Install

Needs Node 22+, git, and at least one agent CLI installed and signed in
(`claude`).

```bash
npm install
npm run build
npm link          # puts `office` on PATH, which agents need in their own shells
```

Then, in the repository you want worked on:

```bash
office init --plan max5x     # writes office.config.json, hires a floor of four
office roster                # who is on the floor and what they may touch
office brief "..."           # split a brief into assigned tasks (does not run it)
office run                   # work the queue
office floor                 # who is on what, and what is left of the budget
```

## Commands

| | |
|---|---|
| `office init [--plan pro\|max5x\|max20x\|api]` | Write config, hire a starting floor |
| `office hire <agent> [--tier] [--autonomy] [--scope]` | Add a desk |
| `office brief "<text>" [--run]` | Split a brief into assigned tasks |
| `office run [--max-turns N]` | Work the queue |
| `office ask <agent> "<instruction>"` | One instruction, one agent, no planner |
| `office floor` / `office roster` / `office tasks` | Status |
| `office diff <agent>` | What an agent actually changed |
| `office budget [--calibrate]` | Burn rate, and what your numbers should be |
| `office approvals` / `approve <id>` / `deny <id>` | Decide |
| `office revive <agent>` | Reset a desk the breaker parked |

Every agent-side command takes `--as <agent>` so you can stand in for an agent
from your own shell without spending a turn.

## Writing a good briefing

The failure mode is not the harness, it is the brief. "Improve the codebase"
produces four agents improving four different things and a bill for all of it.

A brief that works names the change, the boundary, and what done looks like:

> Migrate the payments module off the deprecated client. Keep the public
> interface identical. Add tests for the two edge cases in issue 412.

`office brief` refuses anything under twenty characters, which catches the worst
of it and none of the rest. That part is on you.

## Start with two

One orchestrator and one worker. Give them a task you could hand a competent
contractor in one paragraph. Read what came back — `office diff ada` — before
you hire a third. The number of desks is the least interesting thing about this;
the interesting parts are that they remember, that they talk to each other, and
that they stop where you told them to.

## Prior art

The idea of wrapping CLI agents as a coordinated office, each with a desk, a
mailbox and its own memory, is [Munder Difflin's][md] (MIT, ~6.3k stars). It is
an Electron app with a Pixi.js floor you can watch. This is a smaller, headless
take on the same shape, built around the budget constraint rather than around
the visualisation. If you want to see the avatars walk, go there.

[md]: https://github.com/chaitanyagiri/munder-difflin

## Development

```bash
npm test     # typechecks, then runs 79 tests
```

The suite covers scope and destructive-command policy, the breaker's three
stages, the ledger's demote/stop behaviour, mail delivery and dead-lettering,
memory rollover and search ranking, plan and CLI-result parsing, and an
end-to-end floor over a real git repo with a fake driver. `FakeDriver` lets the
whole floor be exercised without spending a token.

## Licence

MIT.
