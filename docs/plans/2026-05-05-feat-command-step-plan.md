---
title: "feat: `command()` step — run arbitrary shell commands as a first-class workflow primitive"
type: feat
date: 2026-05-05
status: active
brainstorm: docs/brainstorms/2026-05-05-custom-command-step-brainstorm.md
related:
  - docs/plans/implementation-phases.md
  - docs/plans/2026-04-27-feat-env-passthrough-plan.md
  - docs/plans/2026-05-01-feat-tui-ask-step-plan.md
  - src/core/worktree.ts
  - src/core/ask-executor.ts
  - src/services/process/bun-process-service.ts
---

# feat: `command()` step — run arbitrary shell commands as a first-class workflow primitive

## Overview

Add a built-in step factory `command(name, opts)` that runs an arbitrary shell command (tests, linters, build, deploy scripts, …) as a first-class workflow step. Stdout and stderr stream raw — bytes-for-bytes, ANSI preserved — into the active host pane as the command runs, just like an agent transcript. The step returns `{ exitCode, stdout, stderr, durationMs }` so a downstream agent step can read the output via the existing `extraContext` / closure mechanism. A small freestanding `tail(text, n)` helper trims the captured output at the consumer site for prompts that only want the last N lines.

The motivating case: see `bun test` output land in the right pane as part of a workflow, rather than tailing logs in another terminal — and feed the failures into a Claude step that fixes them.

A new step kind `'command'` joins `'agent' | 'commit' | 'worktree' | 'ask'` in the discriminated `StepConfig` union. The executor branch lives in a new `src/core/command.ts`, mirroring the file shape of `worktree.ts` and `ask-executor.ts`. No new `Runner` is involved — runners exist for NDJSON-emitting agents; commands emit unstructured text and need a different shape.

## Problem statement / motivation

Today an `orch` workflow can drive autonomous and interactive agents, create commits, materialise worktrees, and ask the user. It cannot run a test, lint, build, or deploy command without leaving the workflow surface — authors either:

1. Run the command in another terminal and reach back into `orch` afterwards (loses observability and breaks resume).
2. Wrap the command in a custom `Runner` adapter (overweight: runners are NDJSON-emitting; tests/lint output is plain text).
3. Stick a `runRunner(claude, { prompt: 'run tests and report' })` in front of the command (slow, expensive, less reliable than just running the command).

The compound goal — `tests → fix failing tests → tests` as a single workflow — is a one-line `parallel` away once a command primitive exists, and an entirely separate codebase fork without it. Lint+typecheck+test gates, build steps before deploys, and migrations during rollouts are the same shape: side-effectful, exit-coded, line-oriented programs whose output the human (and the next agent) wants to see live.

The brainstorm's architecture investigation confirmed the seams already exist:

- Step kinds are a discriminated union (`src/core/step.ts:104`); adding a new kind is precedent-backed (`worktree`, `commit`, `ask` all work this way).
- `ProcessService.spawn()` already returns line-framed `AsyncIterable<string>` for stdout (`src/services/process/bun-process-service.ts:41`).
- The two-pane host already has a generic line sink via `enqueueRight` (`src/hosts/two-pane/tmux-host.ts:333`); plain host has the equivalent in `onRunnerEvent`.
- The session logger has per-step folders ready for `commands/<step>/{stdout.log, stderr.log, session.json}` siblings of today's `agents/<step>/…` layout.

What's missing is the kind, the factory, the executor, and a small surface change to expose live byte-streaming to the host without funnelling through the runner-event pipeline.

## Proposed solution

A new step kind `'command'` with:

- **Factory** `command(name, opts)` exported from the public barrel. Takes an explicit step name (memoization key) and a config object: `{ argv, onFailure, cwd?, env?, pane?, silent? }`.
- **Executor** `runCommandStep` in a new `src/core/command.ts`. Spawns via `ProcessService.spawn`, fan-outs lines to the host and to the per-step log files, awaits exit, decides halt-vs-continue per `onFailure`.
- **Host seam** new method `host.onCommandLine(spec)` so commands deliver raw bytes to the pane without pretending to be runner events. Plain host writes a `[<step>] ` prefixed line to stdout/stderr; tmux host enqueues the line on the resolved pane via the existing `PaneQueue`.
- **Result** `CommandResult = { exitCode, stdout, stderr, durationMs }`. Persisted in `StepEntry.value` (JSON-safe). Cache replay re-validates against a Zod schema.
- **`tail(text, n)`** freestanding helper exported from the barrel — trim at the consumer, not the producer.
- **Cwd default** `currentCwd(deps.cwd)` — same as every other step, so a `createWorktree({ enter: true })` upstream is observed automatically.
- **Env policy** `mergeEnv(process.env, {}, config.env ?? {})` — passthrough, consistent with the runner env policy.
- **Failure policy** every call site declares `onFailure: 'halt' | 'continue'` (no default — surfaces the choice at workflow-author eye-level).
- **Cache** memoized by step name. `onCacheHit` validates the cached value and is a no-op on success — commands are side-effectful but cache-on-success matches every other step's resume contract; rerun by clearing the entry.

The phase numbering is **Phase 19** in `docs/plans/implementation-phases.md` (the first new primitive after the in-flight reframe, ask, and worktree work).

## Non-goals (v1)

- **No interactive / TTY commands.** `vitest --watch`, `bun --watch`, REPLs are out. `ProcessService.spawn` returns line-framed pipes, not a PTY. If demand emerges, a future variant could route through `host.runInteractive` (the same path interactive agent steps use), but that's a separate primitive — `command()` v1 is non-interactive only.
- **No `validate:` slot.** Exit code + `onFailure` already covers the "halt the workflow when this thing fails" case. Authors who want post-run filesystem assertions chain a follow-up step or call into the validator surface manually. Add the slot if review pressure builds.
- **No retry policy.** `onFailure: 'continue'` plus a workflow-level `if (result.exitCode !== 0) await run(...)` already encodes every retry shape we'd want; a `retries: 3` field would force one specific retry semantics. Defer.
- **No `shell: true` / `sh -c` mode.** Argv only. Authors who need shell features pass `argv: ['/bin/sh', '-c', '<script>']` explicitly. Sidesteps quoting / injection landmines.
- **No bytewise fanout.** Output is line-framed via the existing `frameLines` async generator (`src/services/process/line-framer.ts`). A program that writes a progress bar with carriage-return updates lands as one line per `\n` boundary; intra-line `\r` updates batch into a single delivered line on the eventual newline. Consistent with how runner transcripts already render.
- **No output cap or ring-buffer.** The result holds the complete `stdout` / `stderr`. Memory cost is bounded by command output volume (the log files already mirror the bytes to disk). Authors trim with `tail()` at the consumer.
- **No new `RunMode`.** Commands compose with `plain` and `two-pane` hosts unchanged. `single-pane` was deferred to v2 by the reframe; commands inherit that decision.
- **No new view kind.** Commands render through a dedicated host method (`onCommandLine`), not through `StepView`. The view registry stays runner-event oriented; a command-output view kind is a v2 concern if we ever want pluggable command renderers.

## Technical approach

### Architecture diagram

```
┌────────────────────────── workflow.ts ──────────────────────────┐
│  runStepOnce(s)                                                 │
│    switch (config.kind) {                                       │
│      case 'agent':    runAgentStep / runInteractiveStep         │
│      case 'commit':   runCommitStep                             │
│      case 'worktree': runWorktreeStep                           │
│      case 'ask':      runAskStep                                │
│      case 'command':  runCommandStep   ◀── new branch           │
│    }                                                            │
└──────────────────────────────┬──────────────────────────────────┘
                               │ deps.processService.spawn(...)
                               │ deps.host.onCommandLine(...)
                               │ deps.logger?.streamSink(...)
                               ▼
┌────────────────────── ProcessService port ──────────────────────┐
│  spawn(opts): SpawnHandle { stdout, stderr, wait, kill }        │
│                                                                 │
│  Phase 0 prereq: stderr is now LIVE (see § "Phase 0").          │
└─────────────────────────────────────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────── Host port ──────────────────────────┐
│  onCommandLine({ stream, line, step, pane })   ◀── new method   │
│  PlainHost: writes [<step>] line to stdout/stderr               │
│  TmuxHost:  enqueues on pane via PaneQueue (right by default,   │
│             left if `pane: 'left'`)                             │
└─────────────────────────────────────────────────────────────────┘
```

Key invariant: **the executor never imports `child_process`, `Bun.spawn`, or `node-pty`.** It calls `processService.spawn`. Same rule that holds for runners (CLAUDE.md non-negotiable #1).

### Public API

```ts
// src/core/command.ts (new file)

import type { Path, StepName } from './types.ts'
import type { PaneRole } from './view.ts'

export interface CommandStepConfig {
  readonly kind: 'command'
  readonly argv: readonly string[]
  /** Required. No default — surfaces the policy at the workflow-author's eye. */
  readonly onFailure: 'halt' | 'continue'
  /**
   * Override. When omitted, runs in `currentCwd(deps.cwd)` — i.e. inside the
   * active worktree if one was entered, else repo root. Absolute paths used
   * verbatim; relative paths resolve against `currentCwd`.
   */
  readonly cwd?: Path
  /**
   * Workflow-author env layer. Merged via mergeEnv(process.env, {}, env) so
   * `process.env` is the baseline and `env` wins last. Matches runner env policy.
   */
  readonly env?: Readonly<Record<string, string>>
  /** Default 'right'. Routes line output to the chosen pane (two-pane host). */
  readonly pane?: PaneRole
  /** Run the command but emit no host output (logs still capture). */
  readonly silent?: boolean
}

export interface CommandResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly durationMs: number
}

export interface CommandOpts {
  readonly argv: readonly string[]
  readonly onFailure: 'halt' | 'continue'
  readonly cwd?: Path
  readonly env?: Readonly<Record<string, string>>
  readonly pane?: PaneRole
  readonly silent?: boolean
}

/**
 * Build a command step. `await run(STEP)` returns a `CommandResult` with the
 * full captured `stdout` / `stderr` plus exit code and duration.
 *
 * Cwd defaults to the active worktree (if any) else repo root; override with
 * `cwd`. Env passes through `process.env`; override layer merged on top.
 *
 * Failure policy is required: `'halt'` throws `StepError` on non-zero exit;
 * `'continue'` returns the result so downstream steps can inspect it.
 *
 * Example:
 *   const TESTS = command('tests', {
 *     argv: ['bun', 'test'],
 *     onFailure: 'continue',
 *   })
 *   const r = await run(TESTS)
 *   if (r.exitCode !== 0) await run(FIX_TESTS, { extraContext: { stdout: tail(r.stdout, 200) } })
 */
export function command(name: string, opts: CommandOpts): Step<CommandResult>

/** Trim a captured stream to the last `n` lines. Final '\n' preserved. */
export function tail(text: string, n: number): string
```

### Field name decisions and rationale

The brainstorm left several naming questions open. Decisions, with reasons:

| Concern | Decision | Why |
|---|---|---|
| Step kind name | `'command'` | Matches the brainstorm's stated preference. `'shell'` implies shell evaluation we won't do; `'run'` collides with the `run()` workflow helper; `'exec'` was the runner-up but loses against `'command'` for clarity. |
| Factory name | `command(name, opts)` | Symmetric with `commit('msg')`, `createWorktree(branch, opts)`, `ask({...})`. **Name as first positional** because, unlike commit/worktree, there is no natural slug source on the config (argv `['bun', 'test']` slugs poorly). |
| Reserved prefix | `'command:'` | Same shape as `commit:`, `worktree:`, `ask:`. `step.define()` rejects this prefix (extends the existing `RESERVED_PREFIXES` list). |
| Failure policy field | `onFailure: 'halt' \| 'continue'` | More explicit than `failOnNonZero: boolean`; leaves room for future values (`'warn'`, `'retry'`) without re-shaping the type. Matches our existing convention of literal-union state fields over booleans. |
| Default policy | None — required | Project rule: "no hidden behavior." Forces every call site to declare. Two characters at the call site beats a footgun. |
| Result shape | `{ exitCode, stdout, stderr, durationMs }` | Brainstorm + `durationMs` (cheap, useful for telemetry, every other step result has it). |
| Tail helper | freestanding `tail(text, n)` | A method on the result wouldn't survive cache replay (JSON round-trip strips methods). Function over plain strings is robust. Exported from the public barrel for ergonomics. |
| Cwd resolution | absolute → verbatim, relative → resolve against `currentCwd` | Matches how `worktree.ts` resolves its `target` option (`worktree.ts:260-280`). Author's mental model: "cwd is relative to where the workflow currently is." |
| Output capture | full and uncapped on the result | Brainstorm decision. Logs already mirror bytes to disk, so memory pressure is the only worry — fine for the 99% case (tens of KB of test output). Workflow author opts in to trimming via `tail()` for prompt-feeding. |
| Pane override | `pane?: PaneRole` (default `'right'`) | Mirrors the existing `pane?` field on `AgentStepConfig`. Plain host ignores; two-pane host honours. |

### File-by-file plan

#### Phase 0 prerequisite — live stderr in `BunProcessService`

`src/services/process/bun-process-service.ts:11-44` currently does:

```ts
// Pump stderr eagerly to prevent pipe backpressure deadlock.
// SpawnHandle.stderr iterates the tail buffer, not the live stream.
const stderrTail: string[] = []
const stderrStream = proc.stderr as ReadableStream<Uint8Array>
const stderrDone = drainStderr(stderrStream, stderrTail, STDERR_TAIL_SIZE)

const stdoutStream = proc.stdout as ReadableStream<Uint8Array>
return {
  stdout: frameLines(stdoutStream),
  stderr: replayBuffer(stderrTail, stderrDone),
  // ...
}
```

`replayBuffer` only yields lines AFTER `stderrDone` resolves (after the process exits AND the drain loop finishes). For a long-running command (a 30-second test run), every stderr byte sits invisible until exit. The brainstorm's "raw passthrough" promise is unenforceable under this shape.

**Change** — switch `SpawnHandle.stderr` to live `frameLines(stderrStream)`. Drop `STDERR_TAIL_SIZE`, `drainStderr`, `replayBuffer` once no consumer relies on them. Audit:

- `src/runners/execute.ts:63` — `drainStream(handle.stderr, (line) => deps.onRawLine?.('stderr', line))`. Live streaming improves this: `onRawLine` fires earlier and (importantly) sees ALL stderr lines instead of the last 200. Quiet bug fixed.
- `src/core/worktree-post-create.ts:57` — `for await (const chunk of handle.stderr) stderrBuf.push(chunk)`. Behaviour identical (collects all bytes; arrival order unchanged from the stream's perspective).
- `src/observability/instrument-process-service.ts:64` — passes `handle.stderr` through; an instrumentation wrapper. Identity transformation; unaffected.

No consumer depends on the post-exit replay semantics. The change is strictly an improvement.

Files:
- `src/services/process/bun-process-service.ts` — replace tail-buffer logic with live `frameLines(stderrStream)`. Keep stdin pipe as `'ignore'` (don't surprise commands that try to read; if a command needs stdin, that's a future variant).
- `src/services/process/fake-process-service.ts` — verify the fake also yields stderr lives (it almost certainly does — it's scripted FIFO; trace the fakes that have scripted stderr to confirm the iteration order matches what the real adapter now produces).
- `tests/unit/services/process/*.test.ts` — add a test asserting that stderr lines are observable BEFORE the process exits (using a slow-exit fake or a real `node -e "process.stderr.write('a\\n'); setTimeout(()=>{}, 200)"`).

This is the minimum prerequisite slice. Land it as commit 1 of the PR (or a separate small PR before this feature).

#### `src/core/command.ts` (new — modeled on `src/core/worktree.ts`)

Public surface (factory + types) per the API section above. Internal pieces:

- `validateName(name)` — non-empty, no whitespace, slugifiable. Mirrors `slugify()` in `src/core/commit.ts` and `src/core/worktree.ts` (keep slug rules in sync — drop a comment pointing at both for grep).
- `validateArgv(argv)` — `argv.length >= 1`; `argv[0]` non-empty, no NUL bytes, no newlines. (Don't reject leading dash on argv[0] — it's a binary path; users who want `./-weird-bin` should be allowed. NUL/newline bans are common-sense filesystem hygiene.)
- `validateOnFailure(policy)` — accept literal `'halt' | 'continue'`; throw with a clear message otherwise.
- `validateCwd(cwd)` — if defined, no NUL/newline.
- `validateEnv(env)` — if defined, every value a string with no NUL/newline.
- `CommandResultSchema` — Zod schema for cache validation:

  ```ts
  export const CommandResultSchema = z.object({
    exitCode: z.number().int(),
    stdout: z.string(),
    stderr: z.string(),
    durationMs: z.number().int().nonnegative(),
  })
  ```

- `runCommandStep(deps, config, key, cwd, overrides)` — the executor. Signature mirrors `runWorktreeStep`. Returns `{ value: CommandResult; entry: StepEntry }`.

  Pseudocode:

  ```ts
  // Reject prompt/extraContext/extraPrompt overrides (agent-only).
  rejectAgentOverrides(key, overrides)

  const startedAt = deps.clock.now()
  const resolvedCwd = resolveCwd(cwd, config.cwd)        // absolute? verbatim. relative? resolve.
  const env = mergeEnv(process.env, {}, config.env ?? {})
  const pane = config.pane ?? 'right'
  const isSilent = config.silent === true

  // Lifecycle: start. mode='autonomous' (closest fit; commands aren't TTY-driven).
  emitStepLifecycle(deps.host, stepSpan, {
    type: 'step:start', stepName: key, mode: 'autonomous',
  })

  // Open per-step log sinks (mirroring openRawCapture in workflow.ts).
  const stdoutSink = deps.logger?.streamSink(`commands/${key}/stdout.log`, { truncateOnOpen: true })
  const stderrSink = deps.logger?.streamSink(`commands/${key}/stderr.log`, { truncateOnOpen: true })

  const handle = deps.processService.spawn({
    argv: config.argv,
    cwd: resolvedCwd,
    env,
    tag: 'command',  // observability marker, distinct from 'agent'
  })

  const stdoutCapture: string[] = []
  const stderrCapture: string[] = []

  const fanout = (stream: 'stdout' | 'stderr', line: string) => {
    const cap = stream === 'stdout' ? stdoutCapture : stderrCapture
    cap.push(line)
    const sink = stream === 'stdout' ? stdoutSink : stderrSink
    void sink?.write(`${line}\n`).catch(() => {})
    if (!isSilent) deps.host.onCommandLine({ stream, line, step: key, pane })
  }

  const stdoutDone = drainStream(handle.stdout, (line) => fanout('stdout', line))
  const stderrDone = drainStream(handle.stderr, (line) => fanout('stderr', line))
  const { exitCode } = await handle.wait()
  await Promise.all([stdoutDone, stderrDone])
  await Promise.all([stdoutSink?.close(), stderrSink?.close()])

  const durationMs = deps.clock.now() - startedAt
  const value: CommandResult = {
    exitCode,
    stdout: stdoutCapture.join('\n'),
    stderr: stderrCapture.join('\n'),
    durationMs,
  }

  if (exitCode !== 0 && config.onFailure === 'halt') {
    emitStepFailure(...)
    throw new StepError(key, exitCode, `command exited ${exitCode}`)
  }

  emitStepSuccess(...)
  // session.json shape mirrors agent steps
  await writeCommandSession(...)

  return { value, entry: buildCommandEntry(...) }
  ```

  `drainStream` already exists in `src/runners/execute.ts:63`; either lift to `src/services/process/` for sharing or duplicate (3 lines).

#### `src/core/step.ts` — wire the new kind

- Add `CommandStepConfig` to the `StepConfig` discriminated union (line 104).
- Add `command:` to `RESERVED_PREFIXES` (line 115).
- Add `case 'command':` to `onCacheHit` (line 201). Body:

  ```ts
  case 'command': {
    const parsed = CommandResultSchema.safeParse(cachedValue)
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => i.message).join(', ')
      throw new Error(`command cache entry "${key}" is malformed: ${issues}`)
    }
    return
  }
  ```

  No re-execution side-effect needed (commands are pure data on resume — the side-effect they had already happened in the original run).

- Re-export `CommandStepConfig` and `CommandResult` from the public barrel (`src/core/index.ts`).

#### `src/core/workflow.ts` — dispatch to the executor

- `runStepOnce` switch (line 1001): add `case 'command':` calling `runCommandStep` with the same dep slice as worktree (`gitService` not needed — commands don't touch git directly):

  ```ts
  case 'command':
    result = await runCommandStep(
      {
        processService: deps.processService,
        clock: deps.clock,
        host: deps.host,
        logger: deps.logger,
      },
      config,
      key,
      currentCwd(deps.cwd),
      overrides,
    )
    break
  ```

- The default `_exhaustive: never` catches any miss at compile time.

#### `src/core/index.ts` — public barrel

```ts
export type { CommandResult, CommandOpts, CommandStepConfig } from './command.ts'
export { command, tail, CommandResultSchema } from './command.ts'
```

#### `src/hosts/host.ts` — add `onCommandLine` to the port

```ts
export interface CommandLine {
  readonly stream: 'stdout' | 'stderr'
  readonly line: string
  readonly step: StepName
  readonly pane: PaneRole
}

export interface Host {
  readonly mode: RunMode
  // ... existing methods ...
  onCommandLine(spec: CommandLine): void   // ◀── new
  // ... existing methods ...
}
```

The single call site is `runCommandStep`. No backward-compat shim needed — adding a method to the port is one shipped commit covering all hosts (plain + tmux + any test fakes).

#### `src/hosts/plain/plain-host.ts` — implement `onCommandLine`

Mirror the existing prefix-printer. `stream === 'stderr'` writes to `opts.stderr`; `'stdout'` writes to `opts.stdout`. Keeps the symmetry with how the user sees agent transcript lines.

Per-step formatted-output tee already opens on `step:start (autonomous)`; lifecycle delivery is unchanged. The tee may want a third sink path (`commands/<step>/formatted_output.txt`) for parity, but for v1 the dedicated `commands/<step>/{stdout.log,stderr.log}` sinks owned by the executor are sufficient — the tee was sized for runner-event ANSI rendering, not raw command bytes.

```ts
const onCommandLine = ({ stream, line, step, pane }: CommandLine): void => {
  if (opts.format === 'json') {
    writeJsonLine({ ev: 'command-line', step, stream, line })
    return
  }
  const sink = stream === 'stderr' ? opts.stderr : opts.stdout
  sink.write(`[${step}] ${line}\n`)
  void pane  // plain host has no pane semantics; keep param for type symmetry
}
```

#### `src/hosts/two-pane/tmux-host.ts` — implement `onCommandLine`

Reuse the existing per-pane `PaneQueue` and the `enqueueRight` helper (line 333). For `pane: 'left'`, route to a paired `enqueueLeft` (small refactor: extract a shared `enqueue(pane, payload)` helper from the existing per-pane writers).

Lines stream **byte-for-byte** with no `[<step>] ` prefix — the brainstorm explicitly wants ANSI colors preserved and the pane is dedicated to one step at a time during command execution. (Parallel command branches share the right pane today; we accept interleaving for v1, same trade-off as parallel agent transcripts. A dedicated rollup-only mode is a v2 concern.)

```ts
const onCommandLine = ({ stream, line, step, pane }: CommandLine): void => {
  if (torndown) return
  void deps.tee.writeRaw?.(step, `${line}\n`).catch(() => {})  // optional per-step formatted_output
  const enqueue = pane === 'left' ? enqueueLeft : enqueueRight
  enqueue(`${line}\r\n`)
  void stream  // both streams stream into the same pane in v1
}
```

#### Test fakes — `tests/helpers/fake-host.ts`

Extend `FakeHost` to record `onCommandLine` calls in an inspectable array. The pattern is identical to how `onRunnerEvent` and `onLifecycleEvent` are recorded today.

#### `src/services/process/bun-process-service.ts` — see Phase 0

(Already described above — live stderr.)

#### `src/observability/instrument-process-service.ts` — pass through `tag: 'command'`

The instrumentation wrapper already filters by `tag` to skip agent spawns (so they don't double-log). Add a branch (or accept the tag) to log command spawns to `spawns.ndjson`. The point is to surface command argv and exit code in the structured spawn log.

#### `package.json` — no new deps

Everything reuses existing primitives (`zod` for the result schema, `node:path` for cwd resolution).

### Cache & memoization semantics

A successful run persists `CommandResult` in `StepEntry.value`. Resume re-uses the cached value without re-executing the subprocess — same contract as every other step. Three implications worth surfacing:

1. **Side effects are not re-applied.** A command that mutated the filesystem (e.g. `bun run db:migrate`) leaves its mutation behind on the original run; resume of the same workflow sees the mutation but does NOT re-run the migration. This is correct for the "the workflow already did the migration; resume is just continuing the rest" case. It's wrong for the "I want to retry the migration" case — but retry-on-resume isn't a documented contract for any step kind today, and the workaround is the standard one (clear `state.json`, or use `as:` to re-key).

2. **`onCacheHit` validates the cached shape.** A hand-edited or schema-incompatible cached value throws on cache hit (matches worktree's behaviour). This is the load-bearing safety against state corruption.

3. **The cache key is the step name, not the argv.** `command('tests', { argv: ['bun', 'test'] })` and `command('tests', { argv: ['bun', 'test', '--coverage'] })` collide. Workflow authors who want to discriminate on argv pass distinct names: `command('tests-coverage', ...)`. Documented in the factory's docstring.

### Failure semantics — `onFailure: 'halt'` vs `'continue'`

| Exit | Policy | Behaviour |
|---|---|---|
| 0 | either | Returns `CommandResult` normally. Lifecycle: `step:complete`. Persists to state. |
| ≠ 0 | `'halt'` | Throws `StepError(key, exitCode, msg)`. Lifecycle: `step:failed`. State persists `status: 'crashed'`. Resume re-runs the command. |
| ≠ 0 | `'continue'` | Returns `CommandResult` with `exitCode !== 0`. Lifecycle: `step:complete` (the COMMAND completed; the user said failures are not workflow-fatal). Persists to state. |

Note that under `'continue'`, the lifecycle event is `step:complete`, not `step:failed`. The status pane glyph reflects "the command ran to completion"; the workflow author owns the semantic interpretation of the exit code. This is intentional — `'continue'` says "I'll handle the failure myself, downstream."

### Logging integration

Per-step folder layout (mirrors `agents/<step>/`):

```
.orch/state/<runId>/logs/
  commands/
    <step>/
      session.json     # argv, env keys, exit code, duration, line counts, reproduce string
      stdout.log       # raw bytes, '\n' framed
      stderr.log       # raw bytes, '\n' framed
```

`session.json` shape (mirrors `AUTONOMOUS_OUTPUTS` map in `workflow.ts:856`):

```json
{
  "stepName": "tests",
  "stepSpanId": "<span-id>",
  "kind": "command",
  "argv": ["bun", "test"],
  "envKeys": ["FORCE_COLOR", "PATH", "..."],
  "cwd": "/abs/path",
  "exitCode": 0,
  "durationMs": 1234,
  "stdoutLineCount": 42,
  "stderrLineCount": 0,
  "outputs": { "stdout": "stdout.log", "stderr": "stderr.log" },
  "reproduce": "cd '/abs/path' && PATH='...' bun test"
}
```

`reproduce` is built via the existing `buildReproduce` helper (`workflow.ts:311`) and passed through `redactReproduceCommand` so secrets in env values don't leak.

`orch logs <runId>` already discovers per-step folders generically; the new `commands/` sibling just appears alongside `agents/` with no special-casing.

### Step lifecycle

- `step:start` fires with `mode: 'autonomous'`. (The `mode` field on `StepLifecycleEvent.step:start` is a `StepMode = 'interactive' | 'autonomous'` union; commands aren't TTY-interactive, so `'autonomous'` is the closest fit. We don't widen `StepMode` for v1 — `mode` is a coarse routing hint, not a precise taxonomy.)
- `step:complete` fires on every clean exit (zero) and on non-zero under `'continue'`.
- `step:failed` fires on non-zero under `'halt'`.
- `step:cached` fires on resume cache hit (kind-agnostic, already handled by `runStepOnce`).
- `step:parallel-branch-update` fires when the step runs inside `parallel(items, fn)`. Tools count is `undefined` (no agent tools); status pane treats the branch like any other.

### Concurrency

Commands compose with `parallel()` like any other step. Each branch spawns its own subprocess via `processService.spawn`; per-branch state is isolated; the right-pane queue serialises writes so interleaved output stays line-coherent. No new locks needed.

`parallel(items, fn)` (homogeneous form) inherits `workflowCwd` correctly. `parallel([promises])` (heterogeneous form) is fine; commands don't touch `setWorkflowCwd` so the heterogeneous-cwd-corruption guard from worktree doesn't fire.

### Compatibility with `silent: true`

`silent: true` skips the `host.onCommandLine` calls. Lifecycle events still fire, log files still capture, the result is still persisted. Use case: a one-shot `command('warm-cache', { argv: ['./scripts/warm.sh'], onFailure: 'halt', silent: true })` whose output the human doesn't care to see in the pane.

### Override rejection

`runCommandStep` rejects `prompt`, `extraContext`, `extraPrompt` overrides (agent-only). `as:` is honoured for re-keying. `mode:` override is meaningless for commands; we accept-and-ignore (or reject — pick during PR review; trivial either way).

## Phased delivery

Two PR-sized slices. The Phase 0 prerequisite is a separate commit (potentially a separate PR if review pressure prefers landing it first).

### Phase 0 — live stderr in `BunProcessService` (1 commit)

**Scope** — Replace the 200-line stderr tail buffer with a live `frameLines(stderrStream)`. Audit the three consumers; confirm none rely on post-exit replay semantics.

**Files** — `src/services/process/bun-process-service.ts`, plus a new test in `tests/unit/services/process/bun-process-service.test.ts` asserting live observability. No changes to `FakeProcessService` (already live).

**Tests** — One unit test: spawn a process, observe a stderr line BEFORE `wait()` resolves. One integration test: spawn `node -e "process.stderr.write('a\\n'); setTimeout(()=>{}, 200)"`, race a 50 ms timer against the first stderr yield, assert the yield wins.

**DoD** — `bun run check` green. No behaviour change in any runner integration test (live streaming is strictly an improvement of when bytes arrive).

### Phase 1 — `command()` step end-to-end (1 PR)

**Scope** — Everything in § "File-by-file plan" except Phase 0. Lands as one PR because the new kind, factory, executor, host method, and tests are tightly coupled.

**Files** — see above.

**Tests** — see § "Test plan".

**DoD** — `bun run check` green. New `examples/command-demo/index.ts` (10–20 lines) demonstrates the `tests → fix → tests` loop. Optional gated `RUN_REAL_CLAUDE=1` integration test exercises the real Claude-on-failed-tests loop end-to-end against a deliberately broken fixture.

### Phase 2 (deferred) — interactive command variant

**Out of scope for this plan.** If demand emerges (`vitest --watch`, REPLs, interactive migrators), a follow-up adds `command.interactive(name, opts)` that routes through `host.runInteractive` instead of `processService.spawn`. The shape mirrors the autonomous-vs-interactive split in `step.define()`.

## Test plan

### Unit (`tests/unit/core/command.test.ts`)

Every test name a full sentence per CLAUDE.md rule #4.

**Factory validation**
- `rejects an empty step name`
- `rejects a step name longer than 128 characters minus the prefix`
- `rejects a step name that begins with the reserved "command:" prefix`
- `rejects argv that is empty`
- `rejects argv whose first element is the empty string`
- `rejects argv whose first element contains a null byte`
- `rejects argv whose first element contains a newline`
- `rejects an unknown onFailure value`
- `requires onFailure — undefined throws`
- `accepts onFailure: 'halt'`
- `accepts onFailure: 'continue'`
- `freezes the returned Step`
- `derives the step name as "command:<slug>" from the input name`
- `derives the same slug rules as commit() and createWorktree()`

**Cache validation (CommandResultSchema)**
- `accepts a well-formed CommandResult`
- `rejects a CommandResult with a non-integer exitCode`
- `rejects a CommandResult with a negative durationMs`
- `rejects a CommandResult with a non-string stdout`

**onCacheHit branch**
- `onCacheHit succeeds for a well-formed cached value`
- `onCacheHit throws for a malformed cached value`
- `onCacheHit does not re-execute the command (no side effects)`

**Tail helper**
- `tail returns the entire string when n exceeds the line count`
- `tail returns the empty string when n is 0`
- `tail preserves a trailing newline`
- `tail handles a string with no newlines`
- `tail handles CRLF line endings`

### Integration (mocked) — `tests/integration/core/command-mocked.test.ts`

Use `FakeProcessService` for scripted stdout/stderr/exit, `FakeHost` to capture `onCommandLine` calls, `FileStateStore` over a temp dir for memoization.

- `runs argv through ProcessService and captures stdout in the result`
- `captures stderr live as lines arrive (not just on exit)`
- `streams stdout lines into host.onCommandLine in order`
- `routes lines to the resolved pane (default 'right')`
- `respects pane: 'left' override`
- `silent: true skips host.onCommandLine but still captures stdout/stderr`
- `merges process.env with config.env (config.env wins)`
- `resolves cwd to currentCwd when config.cwd is absent`
- `resolves cwd verbatim when config.cwd is absolute`
- `resolves cwd against currentCwd when config.cwd is relative`
- `inherits the active worktree cwd when createWorktree({enter:true}) ran upstream`
- `throws StepError on non-zero exit when onFailure is 'halt'`
- `returns the result on non-zero exit when onFailure is 'continue'`
- `emits step:complete (not step:failed) under onFailure:'continue' with non-zero exit`
- `persists the CommandResult to state.json after success`
- `persists the CommandResult to state.json under continue policy with non-zero exit`
- `crashes the run cleanly under halt policy and resumes by re-running`
- `cache hit on resume returns the persisted CommandResult without re-spawning`
- `composes inside parallel(items, fn) without sharing capture buffers across branches`
- `rejects prompt overrides`
- `rejects extraContext overrides`
- `rejects extraPrompt overrides`
- `writes commands/<step>/stdout.log and stderr.log via the logger`
- `writes commands/<step>/session.json with argv, exitCode, durationMs, reproduce`

### Integration (mocked, host-side) — `tests/integration/hosts/`

- `plain host: onCommandLine writes [<step>] line to stdout` (`tests/integration/hosts/plain-host.test.ts`)
- `plain host: onCommandLine routes stderr to opts.stderr`
- `plain host: onCommandLine emits ev=command-line under JSON format`
- `tmux host: onCommandLine enqueues right by default` (`tests/integration/hosts/tmux-host.test.ts`)
- `tmux host: onCommandLine with pane:'left' enqueues left`
- `tmux host: onCommandLine drops writes after teardown`
- `tmux host: onCommandLine preserves ANSI escape sequences byte-for-byte`

### Integration (real, no env gate — auto-skip when binary missing) — `tests/integration/core/command-real.test.ts`

Uses `BunProcessService` and `bun` from `Bun.which('bun')` (auto-skip otherwise).

- `runs bun --version and captures stdout`
- `captures stderr from a node -e snippet that writes to both`
- `times out the test at 5s if the spawn hangs (defensive — expectation: completes well under 1s)`
- `non-zero exit halts under onFailure:'halt'`
- `non-zero exit returns the result under onFailure:'continue'`
- `tail(result.stdout, 5) returns the last 5 lines of a 20-line program`
- `the cwd override actually changes the spawn's working directory (uses pwd or process.cwd())`

No `RUN_REAL_*` env gate needed. The test simply skips if the binary isn't present, matching how worktree's real-git tests behave.

### Test counts (rough — flesh out during PR)

| Layer | Count |
|---|---|
| Unit (factory, schema, onCacheHit, tail) | 25 |
| Integration mocked (executor) | 24 |
| Integration mocked (hosts) | 7 |
| Integration real (BunProcessService) | 7 |
| **Total new tests** | **~63** |

## Acceptance criteria

- [x] `command(name, opts)` factory exported from `src/core/index.ts`; matches the API in this plan byte-for-byte (field names, optionality, types).
- [x] `tail(text, n)` exported from the same barrel.
- [x] `CommandStepConfig` added to the discriminated `StepConfig` union.
- [x] `RESERVED_PREFIXES` includes `'command:'` and `step.define()` rejects it with a message naming `command()` as the alternative.
- [x] `onCacheHit` has a `case 'command':` that validates the cached value via `CommandResultSchema` and is a no-op on success.
- [x] `runStepOnce` has a `case 'command':` that delegates to `runCommandStep`. The default-`never` exhaustiveness check still catches misses.
- [x] `Host` interface gains `onCommandLine(spec: CommandLine): void`. `PlainHost`, `TmuxHost`, and `FakeHost` all implement it.
- [x] `BunProcessService` live-streams stderr (no 200-line tail).
- [x] Per-step logs write to `commands/<step>/{stdout.log,stderr.log,session.json}`.
- [x] `bun run check` green.
- [x] All test counts in § "Test plan" are met or exceeded.
- [x] An `examples/command-demo/index.ts` file demonstrates the `tests → fix-tests → tests` loop end-to-end.
- [x] `docs/plans/implementation-phases.md` gains a "Phase 19 — `command()` step primitive" entry with status flipped to ✓ at land time.

## Risks and mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Live stderr breaks an existing runner test | Low | The audit shows no consumer relies on post-exit replay. Phase 0 commits independently with its own test gate. |
| Output capture eats unbounded memory on a runaway command | Low (today) | Brainstorm accepted the trade-off; logs already mirror to disk. v2 can add an optional `maxBytes` if a real workload hits OOM. |
| ANSI passthrough confuses hosts that strip color | None | Plain host already strips ANSI on TTY check (`color = isTTY && !NO_COLOR` in `plain-host.ts:75`); tmux host preserves ANSI by design. |
| Cache-on-success surprises authors who expect commands to re-run | Medium | Document in the factory docstring; provide an `as:` re-keying recipe; consider adding `noCache: true` in v2 if review demands it. |
| Parallel commands interleave on the right pane | Low (precedent) | Same trade-off as parallel agent transcripts today. v2 dedicated rollup pane is the eventual fix. |
| `mode: 'autonomous'` on a command's lifecycle is misleading | Low | Internal field, not user-facing. Document. v2 could widen `StepMode` to add `'command'` if any consumer needs to discriminate. |

## Alternative approaches considered

1. **A test-specific `tests()` step.** Rejected — the brainstorm's argument stands: lint, build, deploy commands share the same plumbing. A test-only primitive blocks adoption.
2. **A new `Runner` adapter.** Rejected — runners are NDJSON-emitting agents. Commands emit unstructured text and have no session model. Forcing a `Runner` shape would mean a fake schema, a fake event stream, and a confusing-to-read adapter. Step kind is the right primitive.
3. **Reuse `host.onRunnerEvent` with a synthetic command "runner".** Rejected — same reason as above. The host receiving runner events that are actually command lines makes the runtime invariant "every onRunnerEvent has a real Runner upstream" false, and breaks downstream observability.
4. **Add a `command-output` `ViewKind`.** Rejected for v1 — too much surface for the gain. The view registry is sized for runner-event-driven views; commands need a cheaper sink. Revisit in v2 if pluggable command renderers become a goal.
5. **Methods on `CommandResult` (`result.stdout.tail(200)`).** Rejected — JSON cache round-trip strips methods, breaking on resume. Freestanding `tail()` is robust.

## Open questions for review

These are minor and don't block the plan:

1. **Should `mode:` override on a command step throw, or accept-and-ignore?** Accept-and-ignore is friendlier; throwing is consistent with how `prompt:` overrides are rejected. Lean toward throw for symmetry.
2. **Should the per-step folder be `commands/<step>/` or sit under `agents/<step>/` with a `kind: 'command'` in `session.json`?** Separate folders are easier to grep; single folder is simpler. Lean toward separate (`commands/`) — the difference in shape (no `events.ndjson`, no `transcript.ndjson`) matters more than the shared-namespace aesthetic.
3. **`pane: 'left'` is allowed but probably weird.** Add a runtime warning, or trust the workflow author? Lean toward trust — the pane override exists precisely for unusual cases.
4. **Should `silent: true` also skip the per-step log files?** Lean against — the logger is observability, the silence is about live rendering. Keep them orthogonal.
5. **Memoization rerun ergonomics.** Should we ship a `noCache: true` option in v1 for commands that authors expect to always rerun (think: `git pull`)? Lean against — the workflow can use `as:` with a unique suffix per run, and consistency with other step kinds matters more than convenience for one shape.

## References

### Internal
- `docs/brainstorms/2026-05-05-custom-command-step-brainstorm.md` — design context.
- `docs/plans/implementation-phases.md` — phased roadmap (this plan slots as Phase 19).
- `docs/plans/2026-04-27-feat-env-passthrough-plan.md` — env policy this plan inherits.
- `docs/plans/2026-05-01-feat-tui-ask-step-plan.md` — closest precedent for "new step kind via discriminated union".
- `docs/plans/2026-04-13-feat-phase-10-git-commit-primitive-plan.md` — first new-kind plan; the shape this plan continues.
- `src/core/step.ts:104` — discriminated union site.
- `src/core/step.ts:115` — `RESERVED_PREFIXES`.
- `src/core/step.ts:201` — `onCacheHit` exhaustive switch.
- `src/core/workflow.ts:1001` — `runStepOnce` dispatch.
- `src/core/worktree.ts` — closest executor precedent.
- `src/core/ask-executor.ts` — most recent executor precedent.
- `src/services/process/bun-process-service.ts:11-44` — Phase 0 prerequisite site.
- `src/services/process/merge-env.ts` — env merge contract.
- `src/hosts/host.ts` — Host port (gains `onCommandLine`).
- `src/hosts/two-pane/tmux-host.ts:333` — `enqueueRight`.
- `src/hosts/plain/plain-host.ts:77` — `onRunnerEvent` (reference for prefix-line rendering).

### External
None — this is purely internal architecture; no new library dependencies.
