---
date: 2026-05-05
topic: custom-command-step
---

# Custom Command Step

## What We're Building

A new step kind — `command` — that runs an arbitrary shell command (tests, linters, build commands, deploys, …) instead of an agent. Stdout/stderr stream raw into the right pane as the command runs, just like an agent transcript. The step returns `{ exitCode, stdout, stderr }` so a follow-up agent step can read it (e.g., "run `bun test`; if it failed, ask Claude to fix").

The motivating use case: see `bun test` output land in the right pane as part of a workflow, rather than tailing logs in another terminal.

## Why This Approach

The seams already exist. The architecture investigation confirmed:

- Steps are a discriminated union (`src/core/step.ts:104`) — adding a new kind is a precedent-backed pattern (`worktree`, `commit`, `ask` all work this way).
- `ProcessService.spawn()` (`src/services/process/`) already returns line-framed `AsyncIterable<string>` for stdout/stderr.
- The right pane already has a generic line sink via `enqueueRight()` (`src/hosts/two-pane/tmux-host.ts:333`) — not tied to runner transcripts.
- `PerStepTee` + `RawSink` already capture step output to `.orch/state/<runId>/logs/`.

A test-specific step or a new `Runner` adapter would both be the wrong shape. Runners are built around NDJSON-emitting agents; tests emit unstructured text. A test-only step would block adoption for lint/build/deploy commands that share the same plumbing. **Generic command step** is the right primitive — tests are one use case among many.

## Key Decisions

- **Generic, not test-specific.** A `command` step kind that runs any shell command; tests are one use case. Avoids opinionated semantics that would block lint/build/deploy use.
- **No default failure policy.** Every call site must declare what happens on non-zero exit (e.g., `onFailure: 'halt' | 'continue'`). Matches the project's "no hidden behavior" stance and surfaces the choice at the workflow author's eye.
- **Raw passthrough to the right pane.** Lines stream exactly as the command emits them — ANSI colors preserved. No `[stdout]` framing, no parsing. Reuses the existing `enqueueRight` sink.
- **Output captured by default.** Step result is `{ exitCode, stdout, stderr }` so downstream agent steps can read it via the existing `result` mechanism. Enables the "run tests → fix failing tests" loop without hand-rolled file reads.
- **`cwd` defaults to the active worktree.** If the workflow has entered a worktree (via `createWorktree`), the command runs there; otherwise repo root. Override with `cwd?: Path` on the step config. Mirrors how agent steps already resolve cwd from the run context.
- **Env via `mergeEnv` passthrough.** Same policy as runners (`docs/plans/2026-04-27-feat-env-passthrough-plan.md`) — no filtering, `ctx.env` wins last. Consistency over carving a new env model.
- **No new Runner.** This is a step executor, not a runner adapter. Lives at something like `src/core/command-executor.ts`, consumed by the same step-dispatch site that handles `worktree` and `commit` today.
- **Step kind name: `command`.** `step.define('test', { kind: 'command', argv: ['bun', 'test'] })`. Considered `shell` (rejected — implies `sh -c` evaluation we won't do), `run` (rejected — collides with the workflow-level `run(STEP)` helper), `exec` (acceptable alternative).
- **Capture is full and uncapped.** The step result contains complete `stdout`/`stderr`. Memory cost is acceptable for the common case; logs/ already has a copy on disk.
- **Trim at the consumer, not the producer.** Workflow authors who want to feed only the last N lines into a downstream agent prompt use a small helper on the result (sketch: `result.stdout.tail(200)` or a freestanding `tail(result.stdout, 200)`). This keeps the step result honest (it really is the whole output) while making the "feed last 200 lines into Claude" ergonomic. Final shape decided in planning.

## Resolved Questions

- ~~**Naming.**~~ → `command`.
- ~~**Captured-output cap.**~~ → No cap; trim at the consumer with a `tail` helper.

## Open Questions

These are plan-detail, captured so they aren't lost:

- **Exact failure-policy field name.** `onFailure: 'halt' | 'continue'`, `failOnNonZero: boolean`, `continueOnError: boolean`? Pick one in planning.
- **Validators.** Agent steps support `validate:` hooks. Do command steps need them? Probably not initially — exit code + failure policy already covers the common case — but flag for review.
- **Cache/idempotency.** The `onCacheHit()` exhaustive switch in `src/core/step.ts:238` will need a branch for the new kind. Default behavior: re-run every time (commands are side-effectful), no cache key participation.
- **Interactive / TTY commands.** Raw passthrough means non-interactive only. `vitest --watch` and similar are out of scope for v1. If demand appears, the existing tmux-subpane mechanism used for interactive agent steps could be reused.
- **`pane?` override.** Step config already has a `pane?` field for routing display. Confirm command steps honor it (e.g., to hide output, or render in left pane).

## Example Usages

These are sketches of intended call-site shape, not finalized API. Field names (`onFailure`, `argv`, `capture`, …) are placeholders — the plan picks the canonical names. The point is to show the kinds of workflows this primitive unlocks.

### 1. Tests as a gating step

The simplest case: run the test suite, halt the workflow if it fails. Output streams into the right pane live.

```ts
const RUN_TESTS = step.define('tests', {
  kind: 'command',
  argv: ['bun', 'test'],
  onFailure: 'halt',
})

await run(RUN_TESTS)
```

### 2. The "tests → fix" loop

Run tests; if they fail, hand the last 200 lines of output to a Claude step that fixes them. Repeat once.

```ts
const TESTS = step.define('tests', {
  kind: 'command',
  argv: ['bun', 'test'],
  onFailure: 'continue',  // we want to inspect the failure ourselves
})

const FIX_TESTS = step.define('fix-tests', {
  kind: 'agent',
  runner: 'claude',
  prompt: ({ tests }) => `Tests are failing. Fix them.\n\nLast lines of output:\n${tests.stdout.tail(200)}`,
})

const result = await run(TESTS)
if (result.exitCode !== 0) {
  await run(FIX_TESTS, { tests: result })
  await run(TESTS)  // verify the fix
}
```

### 3. Lint inside a worktree

The cwd default ("active worktree if one exists") makes this read naturally — no `cwd` field needed.

```ts
await run(CREATE_WORKTREE)
await run(step.define('lint', {
  kind: 'command',
  argv: ['bun', 'run', 'lint'],
  onFailure: 'halt',
}))
```

### 4. Build with display-only output

Capture is on by default but ignored at the call site — the workflow only cares about exit code, the pane shows the build output for the human watching.

```ts
const BUILD = step.define('build', {
  kind: 'command',
  argv: ['bun', 'run', 'build'],
  onFailure: 'halt',
})

await run(BUILD)
```

### 5. Pre-merge gate: lint + typecheck + tests in sequence

Three command steps chained — every failure surfaces in the right pane as it happens, and the workflow stops at the first one to fail.

```ts
const LINT = step.define('lint', { kind: 'command', argv: ['bun', 'run', 'lint'], onFailure: 'halt' })
const TYPES = step.define('types', { kind: 'command', argv: ['bun', 'run', 'typecheck'], onFailure: 'halt' })
const TESTS = step.define('tests', { kind: 'command', argv: ['bun', 'test'], onFailure: 'halt' })

await run(LINT)
await run(TYPES)
await run(TESTS)
```

### 6. Run a script with explicit cwd

For commands that must run somewhere other than the active worktree.

```ts
await run(step.define('migrate', {
  kind: 'command',
  argv: ['bun', 'run', 'db:migrate'],
  cwd: 'apps/api' as Path,
  onFailure: 'halt',
}))
```

## Next Steps

→ `/workflows:plan` to define field names, executor file layout, the `onCacheHit` branch, the `tail` helper shape, and the test plan (unit + mocked integration covering halt-on-failure, continue-on-failure, cwd resolution, env merge, and downstream `result` consumption).
