# ai-office

A floor of CLI coding agents that share one subscription, remember what they
decided, mail each other, and stop at the line you draw.

It runs headless and gives you a live floor in the browser when you want to
watch. One git worktree per agent, markdown memory that survives restarts, a
file-backed mailbox, a three-stage circuit breaker, an approval gate, and a
budget governor that knows nine agents do not get nine budgets.

```
office init --plan max5x
office brief "Migrate the payments module off the deprecated client. Keep the
              public interface identical. Add tests for the two edge cases in
              issue 412." --run
office serve      # watch it happen
```

## The one idea

Every agent on a provider signs in as the same subscription. So that provider
has **one** budget however many desks draw on it. Adding agents to it does not
add capacity — it spends the same capacity faster, in parallel, and lands you at
a hard stop mid-refactor on a Tuesday morning.

Agents on a *different* provider draw on a different allowance. That is the only
way to add concurrency without buying more of one plan, so the budget here is
one pool per provider and the scheduler is built around it:

- **Concurrency is capped per provider**, not globally and not by how many role
  files exist. Claude `max5x` + ChatGPT Plus ships at 2 + 2.
- **A spent pool stops its own desks, not the floor.** When the Claude window
  closes, the Codex desks keep working. Pools are never summed in the UI either,
  because a single number would imply an allowance that does not exist.
- **A ledger records every turn** against its provider — real token counts read
  out of each CLI's own output.
- **Between the soft stop and the cap, work continues a tier down.** A demoted
  agent that finishes beats a premium agent that gets cut off.
- **At the cap, nothing on that provider starts.** Discovering the wall by
  hitting it wastes the turn that hits it.
- **`office budget --calibrate`** replaces the shipped guesses with numbers
  measured from your own ledger, per pool.

## The money

Anthropic's individual plans are Pro at $20/month, Max 5x at $100, Max 20x at
$200. Codex is included in every ChatGPT plan — Free, Go ($8), Plus ($20), Pro —
with no separate Codex subscription to buy. Both vendors enforce two overlapping
limits: a rolling window (five hours) and a weekly cap, either of which pauses
you until its timer resets.

Neither vendor publishes exact token quotas for subscription plans. So the token
budgets in `office.config.json` are not quotas — they are *your* governor, set
by you, defaulted from the published plan multiples and meant to be replaced
after a week of measurement. Anything that told you otherwise would be inventing
a number.

Three things worth knowing before you size a floor:

- Anthropic's weekly limits moved in 2026. A temporary 50% boost ran from May
  13; on August 30 a 25% increase was made permanent and the boost ended, which
  nets out *below* the capacity people had grown used to. Size against the
  permanent number, not the one you remember.
- On a subscription, `costUsd` in the ledger is notional — what the CLI reports
  the turn *would* have cost on the API. You are not billed it, and Codex does
  not report one at all. It is still the best proxy for "how much of my week did
  that burn", which is why the gate escalates on it.
- **If you already pay for ChatGPT, you already own the second pool.** Turning
  it on costs nothing: `office init --codex-plan plus`.

Concretely, on Max 5x + ChatGPT Plus ($120/month total): four desks, two on each
subscription. A premium orchestrator that only plans, implementation on Claude,
review and documentation on Codex. A *fifth* desk on Claude is not free capacity
— it is the same Claude week, spent faster. A desk on Codex is.

Putting review on the other provider is not load balancing. A reviewer running a
different model than the implementer catches things a second pass by the same
model does not, and you were paying for it either way.

## The floor

`office serve` opens a live view at `http://127.0.0.1:4319`. Desks arranged on a
floor, an envelope flying between two of them when one agent mails another, and
the budget meters across the top where you cannot miss them.

It is a dashboard, not decoration. Nine terminals is an unreadable interface;
nine desks where you can see at a glance who is blocked, who got demoted a tier,
and how much of the week is gone is a readable one. What it shows:

- **Desks.** Status by colour, the task on the monitor, the tier actually in use
  (amber when the governor demoted it), unread mail as a badge, a red chip when
  the circuit breaker is engaged.
- **Budget meters, one pair per pool.** Window and week for each provider, with
  the soft stop marked as a tick. Never summed: one number would imply a shared
  allowance that does not exist.
- **Waiting on you.** Every open escalation, with approve and deny inline. Type
  a reason and the agent gets it in its memory — a denial it cannot see is a
  denial it will repeat.
- **The agent pane.** Click a desk for its scope, branch, last memory note, and
  a live diff of what it has actually changed, new files included.
- **The burn strip.** One bar per turn across the bottom, coloured by provider
  and red for a failure. It is the shape of the week, where a looping agent looks
  obvious, and where a fleet leaning on one subscription does too.

Bound to loopback, and it refuses any request not addressed to localhost —
approve and deny act as you, so it is not something to leave open on a network.
No external requests, no CDN, no framework: it is one self-contained page.

## What each agent gets

| | |
|---|---|
| **A role** | `office/agents/<id>.md` — frontmatter plus a briefing. Provider, tier, autonomy, scope, tool allowlist. |
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

## Providers

| | |
|---|---|
| `claude` | Claude Code. Verified end to end against the real CLI. |
| `codex` | OpenAI Codex, via `codex exec --json`. See the caveat below. |

Set which desk runs where in its role file (`provider: codex`) and the tier-to-
model mapping in `office.config.json`. Tiers are `small`/`mid`/`large` rather
than model names, so a role does not have to be rewritten when a provider
renames a model or when a desk moves between providers.

The Claude models default to the CLI's own aliases (`haiku`/`sonnet`/`opus`),
which survive a model release. **The Codex mapping ships empty on purpose** — no
model names are guessed here, so Codex takes whatever default your plan gives it
until you set them yourself from `codex --help`.

> **The Codex driver has not been run against the real binary.** Its flag
> construction and event-stream parsing are covered by tests written against
> OpenAI's documented `codex exec --json` schema, but unlike the Claude driver it
> has never completed a live turn. Expect the first real run to find something.
> `office providers` will tell you what it is about to spawn.

## Install

Needs Node 22+, git, and at least one agent CLI installed and signed in
(`claude`, `codex`, or both).

```bash
npm install
npm run build
npm link          # puts `office` on PATH, which agents need in their own shells
```

Then, in the repository you want worked on:

```bash
office init --plan max5x --codex-plan plus   # both pools, if you pay for both
office roster                # who is on the floor and what they may touch
office brief "..."           # split a brief into assigned tasks (does not run it)
office run                   # work the queue
office floor                 # who is on what, and what is left of the budget
```

## Commands

| | |
|---|---|
| `office init [--plan ...] [--codex-plan none\|go\|plus\|pro]` | Write config, hire a starting floor |
| `office hire <agent> [--provider] [--tier] [--autonomy] [--scope]` | Add a desk |
| `office providers` | The subscriptions behind the floor, and their caps |
| `office brief "<text>" [--run]` | Split a brief into assigned tasks |
| `office run [--max-turns N]` | Work the queue |
| `office ask <agent> "<instruction>"` | One instruction, one agent, no planner |
| `office serve [--port N] [--host H]` | The live floor in a browser |
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
an Electron app with a Pixi.js floor you can watch. This is a smaller take on
the same shape, built around the budget constraint rather than around the
visualisation, and driven from a terminal rather than a desktop app. If you want
to see the avatars walk, go there.

[md]: https://github.com/chaitanyagiri/munder-difflin

## Development

```bash
npm test     # typechecks, then runs 119 tests
```

The suite covers scope and destructive-command policy, the breaker's three
stages, the ledger's demote/stop behaviour, mail delivery and dead-lettering,
memory rollover and search ranking, both providers' argument construction and
output parsing, per-provider budget isolation, concurrent writes to shared state,
the dashboard's routes and its localhost guard, and an end-to-end two-provider
floor over a real git repo with a fake driver. `FakeDriver` lets the
whole floor be exercised without spending a token.

## Licence

MIT.
