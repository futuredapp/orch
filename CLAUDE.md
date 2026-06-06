# orch — project rules

This is a TypeScript (Bun) orchestrator that chains coding-agent CLIs (Claude Code, Codex, and any other CLI wrapped as a `Runner` adapter). Read `docs/brainstorms/` and `docs/getting-started.md` for design context before making non-trivial changes.

The full phased roadmap lives at [`docs/plans/implementation-phases.md`](docs/plans/implementation-phases.md).

## Non-negotiable rules

1. **Subprocess isolation.** All subprocess calls go through `ProcessService` (in `src/services/process/`). Never import `child_process`, `node-pty`, or `Bun.spawn` outside that folder.
2. **Runners are adapters.** `ClaudeRunner`, `CodexRunner`, and any other runner live under `src/runners/<name>/` and implement the `Runner` interface. The core (`src/core/`) never imports a concrete runner.
3. **Mock only at the edge.** Unit tests mock `*Service` ports only. If you need to mock something else, the seam is wrong — fix the seam, don't add the mock.
4. **Tests read like sentences.** Every test name is a full sentence. Arrange-Act-Assert with blank-line separators. No shared hidden state across tests in a file.
5. **File and function size limits.** Files ≤ 300 lines, functions ≤ 60 lines. Warnings, not errors — but if you exceed them, leave a comment explaining why.
6. **TypeScript strict.** `strict: true`, `noUncheckedIndexedAccess: true`. No `any`, no `!` non-null assertions.
7. **Single public barrel per module.** Import from `src/<module>/index.ts` across module boundaries, not from internal files.
8. **No side effects at module import time.** Modules export functions and constants; nothing runs on `import`.
9. **Paths are branded types.** Use the `Path` wrapper type where a filesystem path is expected — never a raw `string`.
10. **`bun run check` is the gate.** Every PR must be green locally before push: lint + typecheck + unit + mocked-integration tests.

## How to add a feature

- Read the active phase in [`docs/plans/implementation-phases.md`](docs/plans/implementation-phases.md).
- Load the `phase-implementer` skill.
- Write tests first.
- Land behind `bun run check`.
- If debugging a finished run, read [`docs/logging.md`](docs/logging.md) before touching code — `.orch/state/<runId>/logs/` usually has the answer.

## How to add a new runner

- Load the `runner-author` skill.
- Create `src/runners/<name>/` with the four-method adapter.
- Add the required integration tests (mocked + real; real auto-skipped when the CLI is missing).
- **Env policy: passthrough.** Build the subprocess env via `mergeEnv(process.env, extras, ctx.env)` from `src/services/process/merge-env.ts` (re-exported via `src/services/index.ts` — there is no `src/runners/_shared/`). No filtering, no allowlisting. `extras` is a runner/mode-specific override slot (e.g. `{ FORCE_COLOR: '3' }` for Claude in interactive mode); `ctx.env` always wins last. See [`docs/plans/2026-04-27-feat-env-passthrough-plan.md`](docs/plans/2026-04-27-feat-env-passthrough-plan.md).

## How to write tests

- Load the `testing-strategy` skill.
- **Non-two-pane code** uses the unchanged three-layer model — `unit`, `integration` (mocked edges), `e2e` (real CLIs, env-gated) — mirroring `src/`. **The two-pane host** uses the scenario/driver DSL (see "How to write a two-pane test").
- Every runner gets TWO integration tests (mocked + real).
- `mock.module`, `vi.mock`, `jest.mock` are banned inside tests for `src/core/`, `src/state/`, `src/validators/`, and `src/runners/`.
- **Default test command: `bun run test:two-pane:fast`** (model + tmux-argv + DSL unit tests; no tmux, milliseconds). **Never run bare `bun test`** — selection is by path only (the filesystem is the manifest); a bare run ignores the concurrency ceiling and runs both trees unbounded. A Bun preload prints a warning if you do. The gate is `bun run check`; `bun run check:release` additionally runs the gated real-CLI levels.

## How to write a two-pane test

- Read [`docs/testing-strategy.md`](docs/testing-strategy.md) for the scenario/driver DSL and the decision rule.
- A two-pane test is a `scenario(meta, body)` written **once** and run against the drivers it lists. The DSL is the only import surface (`import { scenario, emits, fromCassette, claudeAgent } from 'tests/dsl/index.ts'`); scenario files never name a driver, touch tmux, or mention timeouts.
- Pick the category by **where the risk is**:
  - `model` — what the controller *decides* to show (no tmux, fast, the bulk).
  - `screen` — whether those bytes *survive real tmux* (single steps pane).
  - `full-host` — two-pane *plumbing / communication* (full host, real tmux); pick the agent mode: `fake-agent` (default), `recorded-agent` (realistic cassette replay), `real-agent` (the actual binary, gated).
  - `lifecycle` — *process* behaviour (signals, attached TTY, teardown).
  - `tmux-argv` — adapter *argv / escaping* (unit-speed, no tmux).
- Scenarios call only semantic Pane Object methods (+ the `assertShowsContent` content escape hatch). Chrome literals live **co-located on the Pane Object**, never inline in a scenario and never imported from `src/`.
- Triage rule (the north star): *"Would this test still pass if the visible pane were empty / wrong / unformatted? If yes, demote or delete."*
- Run it: `bun run test:two-pane:fast` for the tight loop; `:screen` / `:full:fake` / `:tmux` when you touched rendering or panes; `:lifecycle` for process behaviour. **Never bare `bun test`.** The drivers and the real-tmux harness live under [`tests/dsl/`](tests/dsl/) and [`tests/_support/real-tmux/`](tests/_support/real-tmux/README.md).
- For black-box, screen-level QA or reproducing a rendering/lifecycle bug on screen, the `orch-qa-engineer` skill drives the `scriptedFake` subprocess fake end-to-end (deterministic, zero-token). It is **not** a driver and **not** on the `bun run check` gate — it complements the categories, it doesn't replace them.

## How to update user docs

- User-facing docs live under [`docs/public/`](docs/public/) and are published as a VitePress site. Everything else under `docs/` (brainstorms, plans, adr, findings, issues, solutions, logging.md, testing-strategy.md) is internal — never link the public site into it, and never publish it.
- Load the `doc-writer` skill before editing — it codifies the conventions (one concept per page, runnable examples with imports shown, reference signatures quoted from `src/`, no forward references in the numbered guide).
- After any change to the public barrels (`src/index.ts` and the module barrels it re-exports), reconcile `docs/public/reference/api.md` and `docs/public/reference/runners.md` so the signatures still match.
- `bun run docs:build` is the docs gate — it fails on dead internal links. Run it before pushing doc changes. `bun run docs:dev` is the local preview.
