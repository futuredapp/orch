# Plan 002: Unit-test the embedded-binary launch contract (`embedded-child.ts`)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 832a56d..HEAD -- src/services/process/embedded-child.ts tests/unit/services/process`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `832a56d`, 2026-06-11

## Why this matters

`src/services/process/embedded-child.ts` decides how orch re-invokes itself to
launch TUI children (the left-pane steps view, the `ask()` prompt). In a dev
checkout it launches `[bun, <runner-file>, ...]`; in a `bun build --compile`
standalone binary the runner file lives under Bun's embedded FS (`/$bunfs/...`)
and must be replaced with an internal subcommand — getting this wrong is
exactly the production bug that crashed the Homebrew binary's left pane with
"Unknown command" (documented in the file's own header and in
`docs/testing-strategy.md`). Today this seam has **zero direct tests**: the
binary-smoke suite checks that the subcommand dispatcher routes, but nothing
tests the detection rule or the argv construction. These are two small pure
functions — a 30-minute test file permanently pins the contract.

## Current state

- `src/services/process/embedded-child.ts` — the whole file is 49 lines, two
  exported pure functions:

  ```typescript
  // src/services/process/embedded-child.ts:28-30
  export function isEmbeddedRunnerPath(runnerScript: string): boolean {
    return runnerScript.includes('/$bunfs/')
  }

  // src/services/process/embedded-child.ts:41-49
  export function embeddedChildArgv(opts: {
    readonly execPath: string
    readonly runnerScript: string
    readonly subcommand: string
    readonly trailing: readonly string[]
  }): string[] {
    const head = isEmbeddedRunnerPath(opts.runnerScript) ? opts.subcommand : opts.runnerScript
    return [opts.execPath, head, ...opts.trailing]
  }
  ```

- Production callers (do not modify them; context only):
  - `src/hosts/two-pane/steps-view/start-steps-view.ts:147` — launches the
    steps-view left pane.
  - `src/services/prompt/ink-prompt-service.ts:73` — launches the `ask()`
    Ink prompt child.
- Existing unit tests for this module's folder live in
  `tests/unit/services/process/` (currently: `fake-process-service.test.ts`,
  `foreground.test.ts`, `line-framer.test.ts`, `merge-env.test.ts`,
  `raw-streams.test.ts`). There is no `embedded-child.test.ts`.

- Repo test conventions (from `CLAUDE.md` and observed in
  `tests/unit/services/process/merge-env.test.ts` — use it as the structural
  exemplar):
  - Every test name is a full sentence.
  - Arrange-Act-Assert with blank-line separators.
  - A header comment explaining what contract the file pins.
  - Import style: `import { describe, expect, it } from 'bun:test'` and
    relative imports into `src/` like
    `import { mergeEnv } from '../../../../src/services/process/merge-env.ts'`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Run the new test file | `bun test tests/unit/services/process/embedded-child.test.ts` | all pass |
| Full unit tier | `bun run test:unit` | all pass |
| Lint | `bun run lint` | exit 0 |
| Typecheck | `bun run typecheck` | exit 0 |

**Never run bare `bun test`** (repo rule — test selection is by path only; a
preload prints a warning on bare runs).

## Scope

**In scope**:
- `tests/unit/services/process/embedded-child.test.ts` (create)

**Out of scope** (do NOT touch):
- `src/services/process/embedded-child.ts` itself — this plan pins current
  behavior; it does not change it.
- The callers (`start-steps-view.ts`, `ink-prompt-service.ts`).
- `tests/binary-smoke/` — the smoke tests stay as-is; they cover the
  downstream dispatcher half of the contract.

## Steps

### Step 1: Create the test file

Create `tests/unit/services/process/embedded-child.test.ts`, modeled
structurally on `tests/unit/services/process/merge-env.test.ts`. Header
comment: state that this pins the dev-checkout vs compiled-binary launch
contract, and reference the production incident (compiled binary treating a
`/$bunfs/` runner path as a CLI command → "Unknown command" → dead pane).

Cover at minimum these cases (each as a full-sentence `it(...)`):

1. `isEmbeddedRunnerPath` returns true for a path under Bun's embedded FS,
   e.g. `'/$bunfs/root/steps-view-runner.tsx'`.
2. `isEmbeddedRunnerPath` returns false for an absolute dev-checkout path,
   e.g. `'/Users/dev/orch/src/hosts/two-pane/steps-view/steps-view-runner.tsx'`.
3. `isEmbeddedRunnerPath` returns false for a relative path
   (`'src/runner.tsx'`) and for the empty string.
4. `embeddedChildArgv` in a dev checkout returns
   `[execPath, runnerScript, ...trailing]` — assert the exact array for e.g.
   `execPath: '/usr/local/bin/bun'`, `runnerScript: '/repo/src/runner.tsx'`,
   `subcommand: '__steps-view'`, `trailing: ['--opts', 'abc']`.
5. `embeddedChildArgv` for a compiled binary (runnerScript under `/$bunfs/`)
   returns `[execPath, subcommand, ...trailing]` — the runner path must NOT
   appear anywhere in the result (assert
   `expect(argv).not.toContain(runnerScript)` in addition to the exact array).
6. `embeddedChildArgv` preserves trailing args verbatim and in order in both
   modes, including an empty `trailing: []`.

**Verify**: `bun test tests/unit/services/process/embedded-child.test.ts` →
6+ tests, all pass.

### Step 2: Run the gates

**Verify**: `bun run lint` → exit 0; `bun run typecheck` → exit 0;
`bun run test:unit` → all pass (no other unit test broken).

## Test plan

The plan IS the test plan — see Step 1's case list. Structural pattern:
`tests/unit/services/process/merge-env.test.ts`.

## Done criteria

- [ ] `tests/unit/services/process/embedded-child.test.ts` exists with ≥6 tests
- [ ] `bun test tests/unit/services/process/embedded-child.test.ts` exits 0
- [ ] `bun run test:unit` exits 0
- [ ] `bun run lint` and `bun run typecheck` exit 0
- [ ] `git status` shows no modified files outside the in-scope list
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `src/services/process/embedded-child.ts` no longer matches the excerpt in
  "Current state" (the detection rule or argv shape changed).
- A test you write per the case list FAILS — that means the documented
  contract and the code disagree; report the discrepancy instead of adjusting
  the assertion to match the code.

## Maintenance notes

- If the embedded-FS marker ever changes (a Bun upgrade renaming `/$bunfs/`),
  these tests fail first — that is their job. Update the detection and the
  tests together, and re-run `bun run test:binary-smoke` plus a real compiled
  binary check (`bun run build:binary`), since bun-level tests cannot see
  binary-only behavior.
- Deferred (out of scope here): an integration test that asserts the
  *callers* pass the right `subcommand` constants (`__steps-view`, `__ask`).
