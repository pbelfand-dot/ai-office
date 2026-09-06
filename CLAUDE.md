# ai-office

A headless harness that runs several CLI coding agents against one repository,
sharing one subscription budget.

## Layout

```
src/
  cli.ts               entry point; parseArgs, one case per command
  office.ts            wires everything together; Office.open(root, driver?)
  config.ts            office.config.json, plan presets, validation
  types.ts             Role, Task, Message, LedgerEntry, AgentState, Escalation
  paths.ts             every path under .office/ lives here, nowhere else
  agents/              frontmatter parser, role registry, seeded default roles
  workspace/           git worktree per agent
  memory/              per-agent journal + facts, BM25 search across the floor
  mail/                file-backed outbox -> router -> inbox
  budget/ledger.ts     the governor: usage windows, tier demotion, calibration
  gate/                policy (scope, destructive, spend) and the circuit breaker
  runner/driver.ts     spawns the `claude` CLI; FakeDriver for tests
  orchestrator/        prompt building, one turn, the planner, the scheduler
  server/              `office serve`: snapshot, http + SSE, the inlined page
  commands/            one module per command group, pure string returns
office/agents/*.md     role definitions (frontmatter + briefing)
.office/               runtime state, gitignored
```

## Conventions

- **Zero runtime dependencies.** TypeScript and `@types/node` are dev-only. Do
  not add a runtime dep without a reason that survives being asked twice.
- **Commands return strings, they do not print.** `cli.ts` is the only place
  that writes to stdout. This keeps every command testable.
- **All paths go through `Paths`.** No string-joining `.office/` anywhere else.
- **State writes are atomic** (`writeJsonAtomic`): temp file, then rename.
- **Comments explain the trade-off, not the mechanism.** If a comment restates
  the line below it, delete it.

## Testing

`npm test` typechecks with `tsconfig.test.json` and runs `node --test` over the
compiled output. Use `FakeDriver` — never spawn the real CLI in a test.
`test/floor.test.ts` builds a throwaway git repo per test; follow that pattern
rather than mocking git.

## Things that look like bugs and are not

- `permissionModeFor` ignores autonomy and always returns `acceptEdits`. Plan
  mode would block the shell commands the office protocol needs. Containment is
  the worktree; the gate decides what leaves it.
- `inScope` checks path traversal *before* the empty-scope case. An empty scope
  means the whole repo, never the whole filesystem.
- `runTurn` persists `status: "working"` and `currentTaskId` before spawning.
  The agent runs `office done` from inside its own turn and needs to know which
  task it is on.
- Memory is never auto-summarised. See the comment in `memory/store.ts`.
- `server/page.ts` holds the dashboard as strings and its client code uses no
  template literals — the file is itself one. Keep it that way, or `npm run
  build` stops being a bare `tsc`.
- `serve` reopens the `Office` per request. Roles change on disk while it runs.
- `upsertTask` goes through a `Mutex`. Atomic writes stop a torn file, not a
  lost update, and two agents finish in the same tick by design.
- `worktree.diff` renders untracked files with `--no-index`. Agents mostly
  create files; a review pane that hides them is worse than none.
- The token budgets in `config.ts` are a governor you set, not a quota Anthropic
  publishes. Do not present them as official numbers.
