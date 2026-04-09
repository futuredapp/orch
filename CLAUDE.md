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

## How to add a new runner

- Load the `runner-author` skill.
- Create `src/runners/<name>/` with the four-method adapter.
- Add the required integration tests (mocked + real; real auto-skipped when the CLI is missing).

## How to write tests

- Load the `testing-strategy` skill.
- Three layers: unit, integration (mocked edges), e2e (real CLIs, env-gated).
- Every runner gets TWO integration tests (mocked + real).
- `mock.module`, `vi.mock`, `jest.mock` are banned inside tests for `src/core/`, `src/state/`, `src/validators/`, and `src/runners/`.
