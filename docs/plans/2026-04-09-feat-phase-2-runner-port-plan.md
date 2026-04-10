---
title: Phase 2 — Runner port, RunnerContext, RunnerEvent, FakeRunner, runRunner glue
type: feat
status: landed
date: 2026-04-09
phase: 2
relates-to:
  - docs/brainstorms/2026-04-09-phase-2-runner-port-brainstorm.md
  - docs/plans/implementation-phases.md
---

# Phase 2 — `Runner` port + `FakeRunner` + `runRunner`

## Enhancement summary

**Deepened on:** 2026-04-09
**Phase 1 alignment reviewed on:** 2026-04-10
**Sections enhanced:** type design, runtime algorithm, security, agent-native, consistency, simplicity
**Research agents used:** zod docs (framework-docs), bun/asyncIterable (best-practices), TS branded-types & discriminated unions (best-practices, empirically verified with `tsc 6.0.2`), hexagonal/test-double patterns (best-practices), kieran-typescript-reviewer, architecture-strategist, code-simplicity-reviewer, performance-oracle, security-sentinel, agent-native-reviewer, pattern-recognition-specialist

### Decisions that need a human before Commit 1

These came up across multiple reviewers and don't have a clear best answer — pick one and write the rationale into the plan before scaffolding:

1. **Speculative-surface trade-off.** Simplicity reviewer wants `escalationWiring`, `deps.signal?`, `extractStructuredOutput(schema?)`, `RunnerResult.structuredOutput`, and `Object.freeze` *all* deleted. Architecture reviewer says `deps.signal?` is a legitimate seam-stability technique because adding it later forces a cross-cutting rewrite. Both are right about different things. Pick a posture: "ship the smallest correct surface and pay relocation cost later" vs "freeze the surface now so Phase 4–14 are zero-churn".
2. **`runRunner` location.** Architecture reviewer wants `src/core/run-runner.ts` (it's orchestration glue, not adapter code) so `src/runners/` stays pure adapter-land. Plan as written keeps it under `src/runners/execute.ts`. If kept, add an ADR note explaining why; if moved, Phase 4 stops being "the phase that introduces `src/core/`".
3. **Process model for Phase 5.** Performance reviewer flagged that the `buildCommand → spawn → parseEvents` shape is **structurally incompatible** with session reuse (`claude --resume`). Cold-spawning Claude per step is 200–800 ms. Either commit to one-process-per-step now, or reserve an optional fifth method `openSession?(ctx)` in Phase 2 for free. Adding it post-Phase 5 is a breaking change to every adapter.

### Findings adopted as plan-modifying (highest confidence)

These are the items reviewers agreed on; they need to be reflected in the type signatures and pseudocode before Commit 1, not deferred:

1. **`InfoEvent` discriminator collapse is a real, empirically-verified TS bug.** Under strict + `noUncheckedIndexedAccess`, `RunnerEvent = TerminalEvent | InfoEvent` simplifies to `InfoEvent`, exhaustiveness checks fail, and `e.message` on the error branch is `unknown` instead of `string`. Fix: add a `kind: 'terminal' | 'info'` second discriminator. (See "Type-design fixes" below for the replacement types.)
2. **`buildCommand` returns mutable `env`.** Make it `Readonly<Record<string, string>>` and hoist the return type to a named `RunnerCommand`.
3. **`runRunner` deadlocks on real CLIs that emit trailing lines after the terminal event.** The `break`-and-then-`wait()` pseudocode is correct against `FakeProcessService` and broken against any real subprocess. Fix: drain stdout after break, or implement `[Symbol.asyncDispose]` on `SpawnHandle` and use `await using`.
4. **`stderr` must be drained concurrently from `spawn` time.** ~~Otherwise `handle.wait()` deadlocks on a full stderr pipe.~~ **Partially resolved by Phase 1:** `BunProcessService` eagerly drains stderr via a background `drainStderr()` loop with a 200-line tail buffer. `FakeProcessService` makes stderr iterable but doesn't auto-drain. `runRunner` still needs to consume `handle.stderr` (even if discarding) to prevent deadlock on edge cases. See "Gaps requiring action" in the alignment review.
5. **Line buffering is a `ProcessService` responsibility, not a runner responsibility.** ~~Phase 1 must guarantee `SpawnHandle.stdout: AsyncIterable<string>` is line-framed.~~ **RESOLVED by Phase 1:** `BunProcessService` wraps stdout via `frameLines()` (`src/services/process/line-framer.ts`) which splits on `\n`, strips trailing `\r`, and handles partial chunks correctly. `FakeProcessService` yields individual lines from its scripted `stdout` array. Contract satisfied.
6. **`deps.clock?` optional with `defaultClock` fallback hides a real dependency.** Make `clock` required. Phase 4's tests pass `FakeClock` once and stop caring; the convenience saves two characters per test site.
7. **`Path` brand has no validating constructor → `cwd` is unvalidated.** Phase 1 ships `path()` (unsafe cast) at `src/services/types.ts`. Still missing: `pathAbs()` (absolute + non-empty + no NUL + non-`/`). **Add `pathAbs()` to `src/services/types.ts` as a prep commit before Phase 2 Commit 1.** Phase 3 relocates both to `src/core/types.ts` with zero churn.
8. **Default-deny env contract.** `runRunner` must NOT spread `process.env`. Document the contract: `buildCommand` returns the exact env the subprocess sees, plus `runRunner` strips loader-injection vars (`LD_PRELOAD`, `LD_LIBRARY_PATH`, `LD_AUDIT`, `DYLD_*`, `NODE_OPTIONS`, `BUN_INSPECT*`, `PYTHONSTARTUP`, `PERL5OPT`, `RUBYOPT`) as belt-and-suspenders.
9. **Zod schema-API drift.** ~~If the project is on Zod 4, `z.function()` is no longer a schema.~~ **Verified 2026-04-10:** project pins `"zod": "^3.23.8"` — Zod 3.x. The original plan's `z.function()` schema works as written. If upgrading to Zod 4 before Commit 3, switch to `z.custom<Fn>()` per the Z1 guidance below.
10. **`extractStructuredOutput` signature mismatch with `runner-author` skill.** Skill says `(finalEvent: RunnerEvent, schema: ZodSchema)`; plan says `(finalEvent: TerminalEvent, schema?: unknown)`. Sync the skill in Commit 6 or Phase 5 runner authors will write code that doesn't compile.
11. **Filename collision: `src/runners/runner.ts` and `tests/unit/runners/runner.test.ts` will sit next to future `claude/`, `codex/` folders and read as concrete runners.** Rename to `src/runners/types.ts` and `tests/unit/runners/define-runner.test.ts` (or `runner-interface.test.ts`).

### New considerations discovered (not in the original plan)

- **Resource backstops:** maxLineBytes (Phase 1 contract), hardcoded wall-clock timeout, hardcoded maxEvents — Phase 11's `AbortSignal` is the *configurable* solution but doesn't substitute for unconditional safety nets shipped in Phase 2.
- **`ProcessService.spawn` contract must reject `shell: true`, string commands, and NUL bytes in argv.** Lock this in the Phase 2 prerequisites table; Phase 1 owns the implementation.
- **`onEvent` streaming observer.** A `deps.onEvent?: (evt: RunnerEvent) => void` callback enables live progress reporting and unblocks Phase 4 from holding the full `events[]` array forever. Two lines, zero call-site churn.
- **Cross-runner contract test harness.** `tests/integration/runners/runner-contract.test.ts` defines invariants ("emits a terminal event eventually", "no events after terminal", "buildCommand is pure", "env is `Readonly`") that every Phase 5+ runner runs against its own factory. Highest-leverage agent-native item.
- **`ProcessService` ↔ `FakeProcessService` Pact-style contract test.** Single highest-leverage addition for fake-drift prevention.
- **TerminalEvent extensibility story.** Phase 11 will want `cancelled`. Phase 14 will want `escalation-requested`. Either pre-widen the union with `(string & {})` or add a follow-up note that every widening is a breaking change for adapters.
- **`Runner.version: string`.** Free to add now, breaking to add later. Versioned memoization keys, audit trails, runner-swap compatibility in Phase 9 all depend on it.
- **`Runner.satisfies` assertion** for `FakeRunner` (typecheck-only) so Phase 11 interface additions break in `fake-runner.ts`, not three files downstream.

A full corpus of findings, evidence, and reviewer attribution lives under [Research-driven findings](#research-driven-findings) below.

## Overview

Land the abstraction that every coding-agent CLI will plug into. Phase 2 ships the **interface** (`Runner`), the **context** (`RunnerContext`), the **event union** (`RunnerEvent` = closed `TerminalEvent` + open `InfoEvent`), the **result** (`RunnerResult`), a **validating factory** (`defineRunner`), a **scriptable test double** (`FakeRunner`), and the **executor glue** (`runRunner`) that pumps a runner against a `ProcessService`.

No real CLI adapter lands in this phase. Phase 4's core DSL will power full workflows from `FakeRunner` alone; Phase 5 will drop in `ClaudeRunner` as the first real runner without touching core.

## Problem statement / motivation

The brainstorm in [`docs/brainstorms/2026-04-09-phase-2-runner-port-brainstorm.md`](../brainstorms/2026-04-09-phase-2-runner-port-brainstorm.md) resolved the design tension at the heart of this phase:

> How do "pure adapter methods" (runners as data transformations) reconcile with "core runs workflows entirely via FakeRunner" (Phase 4)?

The answer is a **three-layer split**:

1. **Pure adapter (`Runner`)** — four methods (`buildCommand`, `parseEvents`, `extractStructuredOutput`, optional `escalationWiring`) plus `name` and `supports`. No I/O, no state, no `ProcessService` import. This is what runner authors write.
2. **Glue (`runRunner`)** — one async function that consumes a `Runner` + `RunnerContext` + a `ProcessService` and produces a `RunnerResult`. The only place that knows how to pump stdout lines into `parseEvents` and detect end-of-run.
3. **Test double (`FakeRunner`)** — a concrete class implementing `Runner`. Pre-scripts an injected `FakeProcessService` using a per-instance nonce argv, so tests drive it the same way real runners will be driven.

This satisfies all three design drivers from the implementation plan (testability → everything fakes at the edge, readability → adapters are ≤ 4 methods, maintainability → new runners touch one folder).

## Phase 1 alignment review (2026-04-10)

Phase 1 landed on 2026-04-10. Post-landing audit against this plan's prerequisites:

### Fully aligned (no action needed)

| Prerequisite | Verified |
|---|---|
| `ProcessService` interface — `spawn(opts: SpawnOptions): SpawnHandle` | `src/services/process/process-service.ts` — exact match |
| `SpawnHandle.stdout: AsyncIterable<string>` line-framed | `BunProcessService` wraps via `frameLines()` (proper `\n` splitting + CR strip). `FakeProcessService` yields individual string lines. |
| `SpawnHandle.stderr: AsyncIterable<string>` drained concurrently | `BunProcessService` eagerly drains via background `drainStderr()`. |
| `SpawnHandle.wait(): Promise<{ exitCode: number }>` | Exact match. |
| `SpawnHandle.kill(signal?)` | Defaults to `SIGTERM` — exact match. |
| `FakeProcessService.when(argv).respondWith({stdout, exit})` | Exact match, plus optional `stderr` field. |
| FIFO multi-response per argv | Uses `Map<string, FakeResponse[]>` with `push()` / `shift()` — FIFO works. |
| `Clock` port — `now(): number` | `src/services/clock/clock.ts` — exact match. |
| `FakeClock` — controllable | Ships `advance(ms)`, `set(ms)`, `now()`. |
| `SystemClock` | `src/services/clock/system-clock.ts`. |
| Process barrel exports | All expected symbols plus `frameLines`, `ProcessSpawnError`, `FakeResponse`, `SpawnOptions`. |
| Clock barrel exports | All expected symbols plus `SystemClock`. |

### Better than expected (plan assumptions now stale)

1. **`Path` branded type already exists** at `src/services/types.ts` — `type Path = string & { readonly __brand: 'Path' }` with `path()` unsafe cast. Phase 2 does NOT need to forward-declare `Path` locally in `src/runners/runner.ts`. Import from `src/services/types.ts` directly.
2. **Full `FsService` + `FakeFsService` + `BunFsService`** shipped — the roadmap said "stubs". Phase 3 (state store) benefits immediately.
3. **`ProcessSpawnError`** class — useful for error reporting in `runRunner`, not originally listed as a prerequisite.
4. **Finding R3 (line buffering)** is pre-resolved — Phase 1 owns `frameLines()` and both `BunProcessService` and `FakeProcessService` guarantee one `await` = one complete line.
5. **Finding R2 (concurrent stderr drain)** is pre-resolved for real subprocesses — `BunProcessService.drainStderr()` runs eagerly from spawn time. `FakeProcessService` makes `stderr` iterable.

### Gaps requiring action before Commit 1

| Gap | Plan reference | Severity | Resolution |
|---|---|---|---|
| **`pathAbs()` validating constructor** | S3, type-design fixes | Medium | `path()` (unsafe cast) exists at `src/services/types.ts:6`. `pathAbs()` (absolute + non-empty + no NUL + non-`/`) does NOT exist. **Add `pathAbs()` to `src/services/types.ts` as a prep commit before Phase 2 Commit 1.** This avoids forward-declaring validators in `src/runners/`. |
| **`collectTail` not exported** | R2, prerequisites | Medium | `drainStderr()` is private to `bun-process-service.ts`. `runRunner` needs to drain stderr to prevent pipe deadlock. **Option A:** extract and export a generic `collectTail(stream, maxLines)` from `src/services/process/index.ts`. **Option B:** implement stderr draining inline in `execute.ts` (couples to iterable shape but keeps it self-contained). **Pick one before Commit 1.** |
| **`maxLineBytes` not enforced** | S1 | Medium | `frameLines()` has no size cap. A runaway agent line can OOM the orchestrator. **Defer to a Phase 1 follow-up PR** — document the gap as accepted risk for Phase 2 and add a `TODO(security)` in `execute.ts`. Phase 11's configurable limits are the real fix. |
| **NUL byte rejection in argv** | S6 | Low | `SpawnOptions` doesn't enforce this. Phase 1 informational — no blocker. |
| **`SpawnHandle[Symbol.asyncDispose]`** | R6 | Low | Not shipped. Plan says "optional but recommended." Fine to defer. |

## Prerequisites (blockers)

**Phase 1 landed 2026-04-10. All hard prerequisites are satisfied.** Verified symbols in `src/services/`:

| Symbol | File | Status |
|---|---|---|
| `ProcessService` interface | `src/services/process/process-service.ts` | ✅ `spawn(opts: SpawnOptions): SpawnHandle` |
| `SpawnHandle` | `src/services/process/process-service.ts` | ✅ `stdout: AsyncIterable<string>`, `stderr`, `wait()`, `kill()` |
| `FakeProcessService` | `src/services/process/fake-process-service.ts` | ✅ `.when(argv).respondWith({ stdout, stderr?, exit })` with FIFO queue |
| `FakeResponse` | `src/services/process/fake-process-service.ts` | ✅ `{ stdout?: readonly string[]; stderr?: readonly string[]; exit: number }` |
| `Clock` port | `src/services/clock/clock.ts` | ✅ `now(): number` |
| `FakeClock` | `src/services/clock/fake-clock.ts` | ✅ `advance(ms)`, `set(ms)`, `now()` |
| `SystemClock` | `src/services/clock/system-clock.ts` | ✅ |
| `Path` branded type | `src/services/types.ts` | ✅ `string & { readonly __brand: 'Path' }` + `path()` cast |
| `src/services/process/index.ts` barrel | — | ✅ full surface |
| `src/services/clock/index.ts` barrel | — | ✅ full surface |
| `src/services/index.ts` top barrel | — | ✅ re-exports all of the above |

**Verification (already confirmed 2026-04-10):**

```bash
bun run check   # ✅ green — 44 tests, 0 failures, lint + typecheck clean
```

## Proposed solution

### High-level shape

```
src/runners/
├── runner.ts           # Runner + types + defineRunner + isTerminalEvent
├── execute.ts          # runRunner(runner, ctx, deps)
├── fake/
│   ├── fake-runner.ts  # scriptable FakeRunner class
│   └── index.ts        # barrel for the fake subtree
└── index.ts            # public barrel for the whole module

tests/unit/runners/
├── runner.test.ts      # defineRunner validation + isTerminalEvent narrowing
└── fake/
    └── fake-runner.test.ts   # FakeRunner script queue, errors, invocationCount

tests/integration/runners/
└── execute.test.ts     # FakeRunner → runRunner → FakeProcessService round-trip
```

Cross-module callers import **only** from `src/runners/index.ts`. Internal files (`runner.ts`, `execute.ts`, `fake/fake-runner.ts`) are private to the module.

### The public types

All locked by the brainstorm. Reproduced here as the source of truth for implementation:

```ts
// src/runners/runner.ts

// Phase 1 already ships Path at src/services/types.ts — import it, don't forward-declare.
import type { Path } from '../services/types.ts'

export interface RunnerContext {
  readonly cwd: Path
  readonly env: Readonly<Record<string, string>>
  readonly prompt: string
  readonly extraArgs?: readonly string[]
}

export type TerminalEvent =
  | { readonly type: 'turn-complete'; readonly data?: unknown }
  | { readonly type: 'error'; readonly message: string; readonly data?: unknown }

export interface InfoEvent {
  readonly type: string // any tag other than 'turn-complete' | 'error'
  readonly [key: string]: unknown
}

export type RunnerEvent = TerminalEvent | InfoEvent

export function isTerminalEvent(e: RunnerEvent): e is TerminalEvent {
  return e.type === 'turn-complete' || e.type === 'error'
}

export interface Runner {
  readonly name: string
  readonly supports: { readonly interactive: boolean; readonly structuredOutput: boolean }

  buildCommand(ctx: RunnerContext): { argv: readonly string[]; env: Record<string, string> }
  parseEvents(line: string): RunnerEvent | null
  extractStructuredOutput(finalEvent: TerminalEvent, schema?: unknown): unknown

  // Placeholder — populated in Phase 14.
  escalationWiring?(ctx: RunnerContext): unknown
}

export function defineRunner<T extends Runner>(config: T): T
```

```ts
// src/runners/execute.ts
import type { ProcessService } from '@orch/services/process'
import type { Clock } from '@orch/services/clock'
import type { Runner, RunnerContext, RunnerEvent, TerminalEvent } from './runner.ts'

export interface RunnerResult {
  readonly events: readonly RunnerEvent[]
  readonly finalEvent: TerminalEvent
  readonly exitCode: number
  readonly durationMs: number
  readonly structuredOutput?: unknown
}

export async function runRunner(
  runner: Runner,
  ctx: RunnerContext,
  deps: {
    processService: ProcessService
    clock?: Clock
    signal?: AbortSignal // declared now, wired in Phase 11
  },
): Promise<RunnerResult>
```

```ts
// src/runners/fake/fake-runner.ts
import type { FakeProcessService } from '@orch/services/process'
import type {
  Runner,
  RunnerContext,
  RunnerEvent,
  InfoEvent,
  TerminalEvent,
} from '../runner.ts'

export interface FakeScript {
  readonly events?: readonly InfoEvent[]
  readonly structuredOutput?: unknown
  readonly failWith?: { readonly message: string; readonly exitCode?: number }
}

export class FakeRunner implements Runner {
  readonly name = 'fake'
  readonly supports = { interactive: true, structuredOutput: true } as const

  constructor(processService: FakeProcessService)

  script(s: FakeScript): this
  get invocationCount(): number

  buildCommand(ctx: RunnerContext): { argv: readonly string[]; env: Record<string, string> }
  parseEvents(line: string): RunnerEvent | null
  extractStructuredOutput(finalEvent: TerminalEvent): unknown
}
```

```ts
// src/runners/index.ts — the ONLY cross-module entry point
export type {
  Runner,
  RunnerContext,
  RunnerEvent,
  TerminalEvent,
  InfoEvent,
  RunnerResult,
  FakeScript,
  // Path is NOT re-exported here — consumers import it from @orch/services.
  // Phase 1 already ships Path at src/services/types.ts.
} from './runner.ts'

export { defineRunner, isTerminalEvent } from './runner.ts'
export { runRunner } from './execute.ts'
export { FakeRunner } from './fake/index.ts'
```

### Key mechanics (locked from brainstorm)

1. **`defineRunner` is a validating identity.** Zod schema validates `name`, `supports.interactive`, `supports.structuredOutput`, `buildCommand`, `parseEvents`, `extractStructuredOutput`, and optional `escalationWiring`. On success, `Object.freeze(config)` and return it. On failure, throw a readable error naming the missing field.

2. **`runRunner` algorithm.** Pseudocode:

   ```
   startedAt = clock.now()
   const { argv, env } = runner.buildCommand(ctx)
   const handle = processService.spawn({ argv, env, cwd: ctx.cwd })
   const events: RunnerEvent[] = []
   let finalEvent: TerminalEvent | null = null

   for await (const line of handle.stdout) {
     const evt = runner.parseEvents(line)
     if (evt === null) continue
     events.push(evt)
     if (isTerminalEvent(evt)) { finalEvent = evt; break }
   }

   const { exitCode } = await handle.wait()
   const durationMs = clock.now() - startedAt

   if (finalEvent === null) {
     finalEvent = { type: 'error', message: `runner ${runner.name} produced no terminal event` }
   }

   // Phase 2: ctx never has a schema field, so this branch is dead code
   // until Phase 7 adds `schema` to RunnerContext. We still plumb the
   // optional second arg so Phase 7 is a one-line change here.
   const structuredOutput = undefined

   return { events, finalEvent, exitCode, durationMs, structuredOutput }
   ```

   The body must stay ≤ 60 lines including comments (CLAUDE.md rule).

3. **`FakeRunner.script()` mechanics.**
   - Each `FakeRunner` instance generates a 4-char nonce at construction: `f-<base36>` (e.g., `f-x7q2`).
   - `script({ events, structuredOutput, failWith })` serializes the scripted response into NDJSON lines and registers them on the injected `FakeProcessService`:
     - Info event lines: `JSON.stringify(evt)` one per line.
     - Terminal line: `JSON.stringify({ type: 'turn-complete', data: structuredOutput })` — or `JSON.stringify({ type: 'error', message: failWith.message })` when `failWith` is set.
     - Exit code: `0` on success, `failWith.exitCode ?? 1` on failure.
     - Registers via `fps.when([':fake:', nonce]).respondWith({ stdout: [...lines], exit })`.
   - A per-instance FIFO queue tracks *how many* scripts have been enqueued vs consumed. If `buildCommand` runs and there's no pending script, throw `FakeRunner(${nonce}): no script configured for invocation ${invocationCount}`.
   - `buildCommand` returns `{ argv: [':fake:', nonce], env: ctx.env }` and increments `#invocations`.
   - `parseEvents(line)` = `JSON.parse(line) as RunnerEvent`. Format is controlled by `script()` so it's guaranteed valid.
   - `extractStructuredOutput(final)` returns `(final as { data?: unknown }).data`.

4. **Multi-script FIFO semantics.** Two `script()` calls in order produce two independent runs. `FakeProcessService.when()` must already support this (Phase 1 deliverable). The FakeRunner queue and the FakeProcessService queue advance together: one `script()` enqueues exactly one scripted response.

5. **`AbortSignal` is declared, not wired.** The `deps.signal?: AbortSignal` parameter lives in Phase 2's `runRunner` signature so Phase 11 can wire cancellation with zero call-site churn. Phase 2 does not consume it.

## Implementation plan (PR-sized, ordered sub-commits)

Every sub-commit must leave the tree in a state that passes `bun run check`, except for the explicit **red-tests** commit which is allowed to fail `bun test` only.

### Commit 1 — Scaffold

**Goal:** interface, types, and empty method bodies compile under `tsc --noEmit`.

- [x] Create `src/runners/runner.ts` with all public types (`Path` imported from `src/services/types.ts` — NOT forward-declared, `RunnerContext`, `TerminalEvent`, `InfoEvent`, `RunnerEvent`, `Runner`, `FakeScript` re-exported later), `isTerminalEvent` predicate, and `defineRunner` body that `throw new Error('not implemented')`.
- [x] Create `src/runners/execute.ts` with `RunnerResult` type and `runRunner` signature — body `throw new Error('not implemented')`.
- [x] Create `src/runners/fake/fake-runner.ts` with the `FakeRunner` class skeleton: constructor, `script`, `invocationCount`, `buildCommand`, `parseEvents`, `extractStructuredOutput` — every method `throw new Error('not implemented')`.
- [x] Create `src/runners/fake/index.ts` re-exporting `FakeRunner` and `FakeScript`.
- [x] Create `src/runners/index.ts` as the public barrel with the exact surface listed above.
- [x] Verify `bun run typecheck` passes (lint/test allowed to fail red).
- [x] Commit: `phase 2: scaffold Runner interface, executor, FakeRunner skeleton`.

**Guardrails to check before committing:**
- No `any`, no `!` assertions.
- No `import` from `child_process`, `node:child_process`, `node-pty`, or `Bun.spawn`.
- No `default export` anywhere (Biome `noDefaultExport`).
- Every file uses `import type` for type-only imports (Biome `useImportType`).

### Commit 2 — Red tests (tests-first gate)

**Goal:** complete test suite landed, all failing. These are the tests the final green commit must satisfy.

#### `tests/unit/runners/runner.test.ts`

```ts
describe('defineRunner', () => {
  it('accepts a valid adapter and returns a frozen copy', () => { ... })
  it('throws a readable error when name is missing', () => { ... })
  it('throws a readable error when supports is missing', () => { ... })
  it('throws a readable error when buildCommand is missing', () => { ... })
  it('throws a readable error when parseEvents is missing', () => { ... })
  it('throws a readable error when extractStructuredOutput is missing', () => { ... })
  it('allows escalationWiring to be omitted', () => { ... })
})

describe('isTerminalEvent', () => {
  it('narrows a turn-complete event to TerminalEvent', () => { ... })
  it('narrows an error event to TerminalEvent', () => { ... })
  it('returns false for an arbitrary info event', () => { ... })
})
```

Use a local `makeValidAdapter()` factory inside the test file — do **not** import `FakeRunner` here (keep the tests focused on `defineRunner`, not `FakeRunner`'s behavior).

#### `tests/unit/runners/fake/fake-runner.test.ts`

Every test follows Arrange-Act-Assert with blank-line separators. Names are full sentences:

```ts
describe('FakeRunner', () => {
  it('emits the configured info events followed by a turn-complete terminal event', async () => { ... })

  it('surfaces the scripted structured output via extractStructuredOutput', async () => { ... })

  it('produces an error terminal event and a non-zero exit code when script sets failWith', async () => { ... })

  it('increments invocationCount each time buildCommand runs', async () => { ... })

  it('consumes scripts in FIFO order across two independent runs', async () => { ... })

  it('throws FakeRunner: no script configured for invocation N when the queue is empty', async () => { ... })
})
```

These tests drive `FakeRunner` through `runRunner` (which is still throwing at this commit) — so they will be red both because FakeRunner throws AND because runRunner throws. That's fine; the red commit just needs to compile.

**Test-helper watch-out.** Build the `RunnerContext` via an inline helper inside the test file for Phase 2 (e.g. `function ctxFor(prompt: string): RunnerContext`). Do **not** create `tests/helpers/build-test-run.ts` yet — that helper lands in Phase 4 where it actually wires a workflow. Over-helper-ing in Phase 2 creates churn.

#### `tests/integration/runners/execute.test.ts`

> **Why integration, not unit?** The brainstorm's file-tree listed this file under `tests/unit/runners/`, but the same section labels it "Integration (mocked edges)". The testing-strategy skill is clear: a test that composes multiple real modules (FakeRunner + runRunner) with a fake only at the outermost edge (FakeProcessService, FakeClock) is **integration**. We follow the label, not the tree.

```ts
describe('runRunner', () => {
  it('round-trips info events, terminal event, and structured output through a FakeRunner', async () => { ... })

  it('returns a non-zero exitCode when the runner errors and does not throw', async () => { ... })

  it('measures durationMs using the injected Clock', async () => { ... })

  it('never calls extractStructuredOutput when ctx.schema is absent', async () => { ... })

  it('reports an error terminal event when the process closes without producing one', async () => { ... })
})
```

The last test is new (not in the brainstorm list) but falls directly out of the pseudocode's `finalEvent === null` branch. It must be covered.

The `ctx.schema` test uses a spy-via-subclass of `FakeRunner` that overrides `extractStructuredOutput` to record calls. **No `mock.module`, no Jest/Bun spy on an internal module** — the testing-strategy skill forbids it. Subclass-as-spy is allowed because it doesn't mock an internal module.

- [x] Commit: `phase 2: red tests for Runner, defineRunner, FakeRunner, runRunner` — note explicitly in the commit body that `bun test` is expected to be red at this commit and the next commit makes it green. Lint + typecheck must still pass.

### Commit 3 — Implement `defineRunner` + `isTerminalEvent`

**Goal:** `tests/unit/runners/runner.test.ts` goes green.

- [x] Add Zod schema `RunnerAdapterSchema` in `runner.ts`:

  ```ts
  const RunnerAdapterSchema = z.object({
    name: z.string().min(1),
    supports: z.object({
      interactive: z.boolean(),
      structuredOutput: z.boolean(),
    }),
    buildCommand: z.function(),
    parseEvents: z.function(),
    extractStructuredOutput: z.function(),
    escalationWiring: z.function().optional(),
  })
  ```

- [x] Implement `defineRunner`:

  ```ts
  export function defineRunner<T extends Runner>(config: T): T {
    RunnerAdapterSchema.parse(config)
    return Object.freeze(config) as T
  }
  ```

- [x] Implement `isTerminalEvent` (already scaffolded — just replace the throw).
- [x] Run `bun test tests/unit/runners/runner.test.ts` → green.
- [x] Commit: `phase 2: implement defineRunner validating identity`.

### Commit 4 — Implement `FakeRunner`

**Goal:** `tests/unit/runners/fake/fake-runner.test.ts` goes green in isolation. The execute tests still fail because `runRunner` is unimplemented.

- [x] Generate nonce in constructor: `this.#nonce = 'f-' + Math.random().toString(36).slice(2, 6)`. (Nonce must be stable for the instance's lifetime; do **not** re-roll per call.)
- [x] Private FIFO queue counter: `#scriptsEnqueued = 0`, `#invocations = 0`. Empty-queue detection is `#invocations >= #scriptsEnqueued`.
- [x] `script(s: FakeScript): this`:
  - Build the stdout line array:
    - `events: InfoEvent[]` → `events.map((e) => JSON.stringify(e))`.
    - Append terminal line: success → `{ type: 'turn-complete', data: structuredOutput }`; failure → `{ type: 'error', message: failWith.message }`.
  - Exit code: `failWith ? (failWith.exitCode ?? 1) : 0`.
  - Register on the injected `FakeProcessService`: `this.#fps.when([':fake:', this.#nonce]).respondWith({ stdout: lines, exit })`.
  - Increment `#scriptsEnqueued`.
  - Return `this` for chaining.
- [x] `buildCommand(ctx)`:
  - If `#invocations >= #scriptsEnqueued` throw `FakeRunner(${this.#nonce}): no script configured for invocation ${this.#invocations}` (1-indexed error message — matches brainstorm test wording).
  - Increment `#invocations`.
  - Return `{ argv: [':fake:', this.#nonce], env: ctx.env }`.
- [x] `parseEvents(line)`:
  - `JSON.parse(line) as RunnerEvent`.
  - Return `null` only if `line.trim() === ''`.
- [x] `extractStructuredOutput(final)`:
  - `return (final as { data?: unknown }).data`.
- [x] `get invocationCount()` returns `#invocations`.
- [x] Run `bun test tests/unit/runners/fake/fake-runner.test.ts` → green.
- [x] Commit: `phase 2: implement FakeRunner with FIFO script queue`.

**~~Watch-out — interaction with FakeProcessService semantics.~~** **RESOLVED:** Phase 1's `FakeProcessService` uses `Map<string, FakeResponse[]>` with `push()` / `shift()` — FIFO multi-response per argv is confirmed working. No action needed.

### Commit 5 — Implement `runRunner`

**Goal:** `tests/integration/runners/execute.test.ts` goes green. Full test suite green.

- [x] Implement `runRunner` per the pseudocode above. Structure the body as:
  1. `const startedAt = (deps.clock ?? defaultClock).now()`.
  2. Build command and spawn the handle.
  3. Stream loop: `for await (const line of handle.stdout)` → `parseEvents` → push non-null → break on `isTerminalEvent`.
  4. `const { exitCode } = await handle.wait()`.
  5. `const durationMs = (deps.clock ?? defaultClock).now() - startedAt`.
  6. If `finalEvent === null`, synthesize an `error` terminal event.
  7. `return { events, finalEvent, exitCode, durationMs, structuredOutput: undefined }`.
- [x] `defaultClock` is a tiny in-module `{ now: () => Date.now() }` — **not** exported. Runtime callers inject a real `Clock` from `src/services/clock/`; tests inject `FakeClock`. The in-module fallback exists only so Phase 4's unit tests can construct a `runRunner` call without wiring a clock when they don't care about duration.
- [x] Keep the function body ≤ 60 lines. If it's close to the limit, extract `consumeStream(runner, handle)` as a helper inside `execute.ts` (same file; private).
- [x] Run `bun test` → full green.
- [x] Commit: `phase 2: implement runRunner executor`.

### Commit 6 — Barrel audit + phase landing note

**Goal:** cross-module callers can see exactly the surface the brainstorm promises. Phase doc is updated.

- [x] Verify `src/runners/index.ts` exports match the brainstorm's "Public barrel surface" exactly — no more, no less.
- [x] Run the full gate: `bun run check`.
- [x] Update `docs/plans/implementation-phases.md`:
  - Flip Phase 2's status glyph from `☐` to `✓`.
  - Append `**Landed:** 2026-04-09` (or actual landing date) to the end of the Phase 2 block.
  - Do **not** touch any other phase.
- [x] Commit: `phase 2: land — public runner barrel + roadmap update`.

## Research-driven findings

This section captures the deep research/review pass run on 2026-04-09. Findings are grouped by topic and tagged with the reviewer that produced them. Each finding includes severity, a concrete fix, and (when relevant) the empirical evidence behind it. Several items overlap with the bullet list in [Enhancement summary](#enhancement-summary) at the top — that list is the executive summary; this section is the receipts.

### Type-design fixes

**Recommended replacement types** — apply before Commit 1 if the human accepts the fixes flagged "blocker" in the kieran-typescript-reviewer corpus. This is the canonical shape every other section in this `Research-driven findings` block assumes.

```ts
// src/runners/types.ts (renamed from runner.ts — see "Naming & layout fixes")

// Phase 1 already ships Path + path() at src/services/types.ts.
// Do NOT re-declare. Import from the services layer.
import type { Path } from '../services/types.ts'
export type { Path }

// pathAbs() does NOT exist in Phase 1. Add it to src/services/types.ts
// as a prep commit before Phase 2 Commit 1. Shape:
//   export const pathAbs = (s: string): Path => {
//     if (!s || s === '/' || s.includes('\0') || !s.startsWith('/'))
//       throw new Error(`pathAbs: invalid absolute path: ${JSON.stringify(s)}`)
//     return s as Path
//   }
// Phase 3 relocates both path() and pathAbs() to src/core/types.ts.

export interface RunnerContext {
  readonly cwd: Path
  readonly env: Readonly<Record<string, string>>
  readonly prompt: string
  readonly extraArgs: readonly string[]   // default [] in builders, drops the `?? []` at every site
  // readonly metadata?: Readonly<Record<string, string>>   // (nit, agent-native): reserve for trace IDs
}

// Two-level discriminator restores exhaustiveness — empirically verified with
// `tsc 6.0.2 --strict --noUncheckedIndexedAccess`. Without `kind`, RunnerEvent
// simplifies to InfoEvent and `e.message` on the error branch becomes `unknown`.
export type TerminalEvent =
  | { readonly kind: 'terminal'; readonly type: 'turn-complete'; readonly data?: unknown }
  | {
      readonly kind: 'terminal'
      readonly type: 'error'
      readonly message: string
      readonly code?: string         // (agent-native): stable identifier, e.g. 'rate-limited'
      readonly retryable?: boolean   // (agent-native): hint to workflow layer
      readonly cause?: unknown
      readonly data?: unknown
    }

export interface InfoEvent {
  readonly kind: 'info'
  readonly type: string
  readonly payload?: Readonly<Record<string, unknown>>   // pushes `unknown | undefined` into ONE bag
}

export type RunnerEvent = TerminalEvent | InfoEvent

export function isTerminalEvent(e: RunnerEvent): e is TerminalEvent {
  return e.kind === 'terminal'   // single property check, narrows cleanly
}

export interface RunnerCommand {
  readonly argv: readonly string[]
  readonly env: Readonly<Record<string, string>>   // was mutable in the original plan
}

export interface Runner {
  readonly name: string
  readonly version: string                          // (architecture): free to add now, breaking later
  readonly supports: {
    readonly interactive: boolean
    readonly structuredOutput: boolean
    readonly [capability: string]: unknown          // (agent-native): .passthrough() bag
  }
  buildCommand(ctx: RunnerContext): RunnerCommand
  parseEvents(line: string): RunnerEvent | null
  extractStructuredOutput(finalEvent: TerminalEvent): unknown
  // schema?: unknown parameter DROPPED — Phase 7 widens the signature, not adds a parameter.
  // escalationWiring DROPPED — Phase 14 adds it then; an unused field today is YAGNI.
}

export function defineRunner<T extends Runner>(config: T): Readonly<T>
```

```ts
// src/runners/execute.ts

export interface RunnerResult<T = unknown> {     // generic (kieran nit) — Phase 7 supplies T
  readonly events: readonly RunnerEvent[]
  readonly finalEvent: TerminalEvent
  readonly exitCode: number
  readonly durationMs: number
  readonly structuredOutput?: T
}

export async function runRunner<T = unknown>(
  runner: Runner,
  ctx: RunnerContext,
  deps: {
    processService: ProcessService
    clock: Clock                                  // REQUIRED — no defaultClock fallback
    onEvent?: (evt: RunnerEvent) => void          // (perf, agent-native): live observer
    // signal?: AbortSignal — keep ONLY if the speculation/seam decision lands on "freeze surface"
  },
): Promise<RunnerResult<T>>
```

#### Why each change

| # | Reviewer | Severity | Change | Why |
|---|---|---|---|---|
| T1 | kieran-typescript, best-practices (verified) | **blocker** | Add `kind: 'terminal' \| 'info'` to discriminate `TerminalEvent` and `InfoEvent`. | `RunnerEvent` collapses to `InfoEvent` under structural subtyping. Verified empirically: `e.message` on the `error` branch is `unknown`, not `string`; `default:` exhaustiveness check fails. The `kind` field is the only encoding that restores compile-time exhaustiveness without TS negated types. |
| T2 | kieran-typescript | **blocker** | Replace `[key: string]: unknown` index signature on `InfoEvent` with `payload?: Readonly<Record<string, unknown>>`. | Under `noUncheckedIndexedAccess`, the index signature infects every `InfoEvent` access (and every `RunnerEvent` access through union narrowing) with `\| undefined`. Phase 4 + 5 parsers will be littered with `if (evt.tokens !== undefined)` for no reason. Pushing the bag to `payload` localizes the unsafety. |
| T3 | kieran-typescript, architecture, simplicity, agent-native | major | Drop `schema?: unknown` from `extractStructuredOutput`. | "Triple-unknown" signature (`finalEvent: TerminalEvent, schema?: unknown): unknown`). Phase 7 widening one→two args is *exactly* the same churn as widening one→one with-schema. Plus: skill currently documents `schema: ZodSchema` (required) — the divergence will produce broken Phase 5 runners. |
| T4 | kieran-typescript, simplicity | major | Make `buildCommand` return type `RunnerCommand` with `readonly env`. | Mutable `env: Record<string, string>` lets middleware silently mutate the env handed to a subprocess after the runner has "purely" computed it. Asymmetric with the already-`readonly` `argv`. |
| T5 | kieran-typescript, simplicity | major | Make `deps.clock` required; delete `defaultClock` fallback. | Hidden `defaultClock = { now: () => Date.now() }` violates "mock only at the edge" in spirit and makes `runRunner` behavior depend on whether the caller injected a clock. Phase 4 tests pay 2 chars per site to pass `clock: new FakeClock()`. |
| T6 | kieran-typescript, simplicity | nit | Default `extraArgs` to `readonly []` (non-optional). | Eliminates `...(ctx.extraArgs ?? [])` boilerplate at every runner site under `noUncheckedIndexedAccess`. |
| T7 | kieran-typescript, best-practices | ~~minor~~ **moot** | ~~`Path` brand uses `unique symbol`, not magic string `'__brand'`.~~ Phase 1 ships `Path` with `__brand` string literal at `src/services/types.ts`. Changing to `unique symbol` now would be a Phase 1 breaking change. Accept the string literal brand — Phase 3 can optionally strengthen it during relocation. |
| T8 | kieran-typescript | nit | Add `RunnerResult<T = unknown>` generic. | Phase 7's structured output flows through `RunnerResult.structuredOutput`. Generic now → zero `as T` casts at every call site when Phase 7 lands. |
| T9 | kieran-typescript | nit | Module-level `_assertFakeRunnerIsARunner = {} as FakeRunner satisfies Runner`. | Phase 11 interface additions break inside `fake-runner.ts` immediately, not three files downstream. |
| T10 | kieran-typescript | minor | Barrel re-exports `FakeScript` from `./fake/index.ts`, not `./runner.ts`. | The original plan's `export type { ... FakeScript } from './runner.ts'` is wrong; `FakeScript` lives in the fake subtree. |

#### Empirical evidence — `tsc 6.0.2 --strict --noUncheckedIndexedAccess`

Reproduction steps (from the best-practices/branded-types research agent):

- `PathRunner` and `PathCore` declared in two modules with identical shape `string & { readonly __brand: 'Path' }` → mutually assignable. ~~Drift risk from forward declaration is **only** a typo concern.~~ **Moot:** Phase 1 ships `Path` at `src/services/types.ts`; Phase 2 imports it directly — no forward-declaration, no drift. (`/tmp/ts-brand-check/brand-identity.ts`)
- `RunnerEvent` with `[key: string]: unknown` on `InfoEvent`: `if (e.type === 'turn-complete')` narrows `e` to `{ type: 'turn-complete' } | InfoEvent` (NOT to the turn-complete branch alone). `e.data` becomes `unknown`. (`/tmp/ts-brand-check/union-proof.ts`)
- `case 'error': return e.message` → `e.message` is **`unknown`, not `string`**. (`/tmp/ts-brand-check/union-proof.ts`)
- `default: const _: never = e` → fails. The exhaustiveness escape hatch is dead. (`/tmp/ts-brand-check/exhaustive.ts`)
- Adding `kind: 'terminal' | 'info'` discriminator → `if (e.kind === 'terminal') { switch (e.type) { ... default: const _: never = e } }` compiles. `e.message` is `string`. Outer `else` narrows to pure `InfoEvent`. (`/tmp/ts-brand-check/alt-proof.ts`)

### Runtime algorithm fixes — `runRunner` correctness

The original plan's pseudocode is correct against `FakeProcessService` and **broken against any real subprocess** in three ways. All three are pre-Phase-5 latent bugs that the Phase 2 integration tests cannot catch because the fake doesn't exhibit the failure modes. The fixes belong in the Phase 2 pseudocode and the Phase 1 prerequisites.

#### R1 — stdout drain after terminal-event break (performance, best-practices) — **major**

When `runRunner` `break`s on the terminal event, the subprocess may still be writing trailing bytes (final token counts, telemetry, newlines). Three failure modes depending on `BunProcessService` implementation:

- Pipe buffer fills (~64 KB on Linux) → child blocks on `write(2)` → `handle.wait()` deadlocks forever.
- Child receives SIGPIPE → exits non-zero → executor reports a successful run as an error.
- Userland AsyncIterable buffers indefinitely → memory leak proportional to remaining child output.

**Fix in Phase 2 pseudocode:**

```ts
for await (const line of handle.stdout) {
  const evt = runner.parseEvents(line)
  if (evt === null) continue
  events.push(evt)
  deps.onEvent?.(evt)
  if (isTerminalEvent(evt)) { finalEvent = evt; break }
}

// Drain remaining stdout so the child doesn't block on a full pipe.
// Cheap: just iterates and discards. Cap with `maxDrainBytes` if paranoid.
if (finalEvent !== null) {
  for await (const _ of handle.stdout) { /* discard */ }
}
```

**Add to `tests/integration/runners/execute.test.ts`:** a regression test that scripts `FakeProcessService` with trailing lines AFTER the terminal event and asserts (a) `runRunner` returns within the test timeout, (b) the trailing lines are absent from `result.events`.

#### R2 — ~~concurrent stderr drain~~ — **Partially resolved by Phase 1**

~~`SpawnHandle.stderr` is in the Phase 1 prerequisites table but `runRunner` never reads it.~~

**Phase 1 ships eager stderr draining for real subprocesses:** `BunProcessService` kicks off `drainStderr()` at spawn time with a 200-line tail buffer (`STDERR_TAIL_SIZE = 200`). The `handle.stderr` iterable replays the tail after draining completes. This prevents pipe-buffer deadlock for real CLIs.

**Remaining gap:** `FakeProcessService`'s `stderr` is a passive iterable — it doesn't auto-drain. `runRunner` should still kick off a background stderr consumer to be safe across both real and fake process services. Implement inline in `execute.ts` rather than depending on an exported `collectTail` helper:

```ts
const handle = processService.spawn({ argv, env, cwd: ctx.cwd })
// Kick off background stderr drain immediately — even though BunProcessService
// already eagerly drains, FakeProcessService does not.
const stderrLines: string[] = []
const stderrDone = (async () => {
  for await (const line of handle.stderr) {
    stderrLines.push(line)
    if (stderrLines.length > 200) stderrLines.shift()
  }
})()
try {
  for await (const line of handle.stdout) { /* ... */ }
} finally {
  const { exitCode } = await handle.wait()
  await stderrDone
  // attach stderrLines to synthesized error event when finalEvent === null
}
```

#### R3 — ~~line buffering is `ProcessService`'s responsibility~~ — **RESOLVED by Phase 1**

~~Bun's `Subprocess.stdout` is `ReadableStream<Uint8Array>`, not lines.~~ **Phase 1 ships `frameLines()` at `src/services/process/line-framer.ts`** — a pure async generator that splits on `\n`, strips trailing `\r`, handles partial chunks via an internal buffer, and flushes residual on EOF. `BunProcessService` wraps both stdout and stderr through `frameLines()`. `FakeProcessService` yields individual lines from its scripted `stdout` array. Contract satisfied: one `await` = one complete line.

**Updated prerequisites (reflecting Phase 1 as shipped):**

| Symbol | File | Status |
|---|---|---|
| `SpawnHandle.stdout` | `src/services/process/process-service.ts` | ✅ `AsyncIterable<string>`, line-framed via `frameLines()`. |
| `SpawnHandle.stderr` | same | ✅ `AsyncIterable<string>`. `BunProcessService` eagerly drains via background `drainStderr()` with 200-line tail. |
| `collectTail(stream, n)` | `src/services/process/index.ts` | ❌ Not exported. `drainStderr()` is private to `bun-process-service.ts`. See "Gaps requiring action" in alignment review. |
| `SpawnHandle[Symbol.asyncDispose]` | same | ❌ Not implemented. Optional — fine to defer. |

#### R4 — parser-error path needs an explicit `kill` with SIGKILL grace (best-practices) — minor

If `parseEvents` throws (malformed line, prototype-pollution check failure), the `for await` propagates the throw. Without a `kill()`, the subprocess can hold the executor open forever.

**Fix:**

```ts
try {
  for await (const line of handle.stdout) { /* ... */ }
} catch (err) {
  handle.kill('SIGTERM')
  setTimeout(() => handle.kill('SIGKILL'), 5_000).unref()
  throw err
} finally {
  const { exitCode } = await handle.wait()
  // ...
}
```

#### R5 — `performance.now()` over `Date.now()` for `durationMs` (performance) — minor

`Date.now()` has 1 ms resolution and is subject to NTP wall-clock skew. For sub-100ms FakeRunner unit tests, deltas can legitimately be `0`, making any `expect(durationMs).toBeGreaterThan(0)` flaky. `performance.now()` is monotonic and microsecond-resolution. The `Clock` port API doesn't change (`now(): number`) — only the default implementation. Update Phase 1's `Clock` port spec.

#### R6 — `[Symbol.asyncDispose]` unifies cleanup (best-practices) — minor

TC39 explicit-resource-management is Stage 3 (TS 5.2+, Node 22.4+). Bun's `Subprocess` already implements `AsyncDisposable`. Implementing `[Symbol.asyncDispose]` on `SpawnHandle` lets `runRunner` write `await using handle = processService.spawn(...)` and gets kill+reap+stderr-drain into one disposer. Cleaner than try/finally and eliminates zombie processes on unexpected throws.

### Security findings

Reviewer: security-sentinel. The orchestrator runs other people's code (AI coding agents that can be prompt-injected); the trust boundary matters.

#### S1 — Resource exhaustion via unbounded JSON / stdout — **HIGH**

A misbehaving or prompt-injected agent CLI emits a single 1 GB line, or unbounded info events. `runRunner`'s `events: RunnerEvent[]` grows without bound; `JSON.parse` allocates the entire payload. Heap OOM crashes the orchestrator and every other in-flight runner sharing the Bun process.

**Mitigation (Phase 2, hardcoded backstops; Phase 11 makes them configurable):**

- `ProcessService` line iterator MUST enforce `maxLineBytes` (default ~1 MiB). Lines over the threshold synthesize an `error` terminal event from `runRunner` and trigger `handle.kill()`.
- `runRunner` MUST enforce a hardcoded `maxEvents` (e.g., 100_000) and a hardcoded wall-clock timeout (e.g., 10 minutes) in Phase 2. Both synthesize `error` terminal events on overflow.
- Add an integration test: "runRunner aborts with an error terminal event when `maxLineBytes` is exceeded".

#### S2 — Environment variable passthrough has no allowlist/denylist — **HIGH**

A Phase 5+ runner will naturally do `{ ...process.env, ...secrets }`. This propagates loader-injection vars (`LD_PRELOAD`, `LD_LIBRARY_PATH`, `LD_AUDIT`, `DYLD_INSERT_LIBRARIES`, `DYLD_LIBRARY_PATH`, `NODE_OPTIONS`, `BUN_INSPECT*`, `PYTHONSTARTUP`, `PERL5OPT`, `RUBYOPT`) into the subprocess. If the orchestrator's own env is ever compromised (dotenv leak, upstream service), every spawned coding agent inherits the injection.

**Mitigation:**

- Lock the env contract in the plan text: `runRunner` does NOT spread `process.env`. `buildCommand` returns the exact env the subprocess sees.
- `runRunner` strips the loader denylist as belt-and-suspenders even after `buildCommand`.
- Add a one-sentence placeholder for `secrets`: "Phase N adds typed secret injection — runners receive no ambient env until then."

#### S3 — `cwd: Path` brand is structural-only, not validating — MEDIUM (partially resolved)

~~Any `string as Path` cast mints a `Path`. The plan has no smart constructor.~~

**Phase 1 ships `path()` (unsafe cast) at `src/services/types.ts`.** The validating constructor `pathAbs()` (absolute + non-empty + no NUL + non-`/`) does NOT exist yet.

**Mitigation:** add `pathAbs()` to `src/services/types.ts` as a prep commit before Phase 2 Commit 1. Even the minimal validator closes 90% of the risk. Phase 3 relocates both to `src/core/types.ts` with structural identity preserved.

#### S4 — No timeout / max-events / cancellation until Phase 11 — MEDIUM

Between Phase 2 landing and Phase 11, every workflow has zero cancellation, zero wall-clock timeout, zero event cap. Phase 4 will build the DSL on top and compound the problem. Hardcoded backstops (S1) cover the most acute failure modes; document them as temporary in the "Scope boundaries" section.

#### S5 — `parseEvents` runtime validation gap — MEDIUM

`FakeRunner.parseEvents` does `JSON.parse(line) as RunnerEvent` — a blind cast. Real runners will do the same unless told otherwise. Three sub-risks:

- **Prototype pollution:** modern V8's `JSON.parse` does NOT walk `__proto__` into `Object.prototype` (safe in isolation), but downstream `Object.assign(target, evt)` or `in` checks would weaponize a `__proto__` key. The `as RunnerEvent` cast offers zero runtime protection.
- **Type confusion:** a malicious agent emits `{"type":"turn-complete","data":{...}}` with arbitrary `data` shape; Phase 7's structured-output consumers must re-validate.
- **Trust signal misuse:** `{"type":"error","message":"<huge>"}` forces premature termination or pollutes logs.

**Mitigation:** validate inside `runRunner` after the runner returns, using a `RunnerEventSchema` declared in `types.ts`. This is the safer seam — a lazy runner author can't bypass it. Document a runner-author rule: "Never `Object.assign({}, evt)` or `in`-check a parsed event without first stripping `__proto__`/`constructor`/`prototype` keys."

#### S6 — ~~`ProcessService.spawn` contract must forbid `sh -c`~~ — **Partially resolved by Phase 1**

~~If Phase 1's `spawn` accepts `command: string` or `shell: true`, a runner author could return `argv: ['sh', '-c', userInput]` and introduce shell injection.~~

**Phase 1 ships `SpawnOptions` with `argv: readonly string[]` only** — no `command: string`, no `shell: true` option. `BunProcessService.spawn()` passes `cmd: [...opts.argv]` to `Bun.spawn()` without shell wrapping. The contract is structurally enforced by the type system.

**Remaining gap:** NUL byte rejection in argv is not enforced at runtime. Low severity — a runner author would need to deliberately inject NUL bytes. Document as accepted risk.

#### S7 — Zod validation could leak secrets in error messages — LOW

Zod's default `ZodError.message` serializes the parsed object on `invalid_type`. If a Phase 5+ runner factory ever passes a config with secrets, a `defineRunner` failure dumps the secret to boot logs (since `defineRunner` runs at module import time per the plan's compliance checklist).

**Mitigation:** use `safeParse` and construct the error message from `issue.path` only (never `issue.input`):

```ts
throw new RunnerDefinitionError(
  `defineRunner: invalid runner config (fields: ${issues.map(i => i.path.join('.')).join(', ')})`
)
```

Add a unit test: "defineRunner error message does not include the config object's values".

#### S8 — `Object.freeze` is defense-in-depth, not security — informational

`Object.freeze` is shallow. It catches honest bugs ("middleware mutates `runner.name` for logging"), not adversarial ones. If you keep it, document the intent in a one-line comment; if you cut it (per simplicity reviewer's recommendation), nothing of security value is lost. Either decision is fine — just don't sell it as a security control.

### Agent-native findings

Reviewer: agent-native-reviewer. The orchestrator IS an agent runtime — every action a user takes via the orchestrator must eventually be invokable by an agent.

#### A1 — `extractStructuredOutput` deferral blocks agent-to-agent handoff — major

Structured output is the *primary* way one agent reads another agent's results. Phase 7 deferral means agents writing workflows in Phases 4–6 cannot programmatically consume runner outputs. Either parameterize `Runner<TOutput = unknown>` and `RunnerResult<TOutput>` in Phase 2 (the type-design fix above does this), or land `schema` on `RunnerContext` early. The current plan's `unknown` return type pushes validation onto every consumer.

#### A2 — `InfoEvent` open shape blocks agent discoverability — major

An agent reading `result.events` cannot discover what info events might arrive without grepping every runner. Combined with the structural collapse of the union (T1), agents writing event-handling code work blind.

**Mitigation:** publish a `WellKnownInfoTag` string-literal type in `types.ts` documenting the canonical info event vocabulary (`'tool-call' | 'thinking' | 'token-usage' | ...`). Phase 5+ runners pick from it and add their own tags. Combined with the `kind: 'info'` discriminator, agents have a starting vocabulary AND structural narrowing.

#### A3 — Error events are too thin for agent-driven retry — major

`{ type: 'error'; message: string }` is human-language. An agent asked to "retry on transient failures, escalate permanent ones" cannot decide. Add `code?: string` (stable identifier) and `retryable?: boolean` (workflow-layer hint) — see the "Type-design fixes" types above. Synthesize `code: 'no-terminal-event'` for the `finalEvent === null` branch in `runRunner`.

#### A4 — No runtime runner registry — major

The plan exports runners through named imports. An agent cannot enumerate available runners at runtime. Six lines fixes this:

```ts
// src/runners/index.ts
const _registry = new Map<string, Runner>()
export const runnerRegistry: ReadonlyMap<string, Runner> = _registry

// in defineRunner, last step:
_registry.set(config.name, frozen)
```

This is NOT a plugin system (the scope-excluded item) — it's an in-process named registry. Static imports still work; dynamic enumeration also works. Phase 5's `ClaudeRunner` becomes discoverable by `'claude'`.

#### A5 — `runRunner` is batch-only — major

`runRunner` returns `Promise<RunnerResult>` after the entire run completes. An agent orchestrator cannot stream progress to its own caller until then. For multi-minute Claude Code runs this is the difference between "agent reports progress" and "agent looks frozen". Add `deps.onEvent?: (evt: RunnerEvent) => void` (already in the type-design fixes above) — zero call-site churn, enables live streaming, eliminates the need for Phase 4's memoization to retain the full `events[]` array.

#### A6 — Cross-runner contract test harness — major

Define a generic contract test in `tests/integration/runners/runner-contract.test.ts` that asserts every Phase 5+ runner's invariants:

- emits a terminal event eventually
- emits no events after the terminal event
- `buildCommand` is pure (no I/O, deterministic for the same `ctx`)
- `parseEvents` is total (every line either parses or returns null, never throws on well-formed JSON)
- env return is `Readonly` and contains no loader-injection vars

Phase 5's `claude-runner.test.ts` calls this with the claude factory and gets all invariants for free. **Single highest-leverage agent-native item in the plan.**

#### A7 — `ProcessService` ↔ `FakeProcessService` Pact-style contract test — major

Single highest-leverage *fake-drift* mitigation. A test that both `BunProcessService` and `FakeProcessService` must pass, asserting identical observable behavior on the same script. Without this, `FakeProcessService` will silently drift from `Bun.spawn` semantics (backpressure, partial-line buffering, SIGPIPE on close, EPIPE on mid-write). Land in Phase 2 even if the real implementation is in Phase 1 — Phase 2 is the first consumer.

#### A8 — `runner-author` skill drift — minor

The skill in `.claude/skills/runner-author/SKILL.md` documents:

- `extractStructuredOutput(finalEvent: RunnerEvent, schema: ZodSchema)` — wrong type for `finalEvent`, wrong required-ness for `schema`.
- `argv: string[]` — wrong (should be `readonly string[]`).
- `defineRunner` import from `@orch/runners/runner` — wrong (should be `@orch/runners` per single-barrel rule).
- Uses `ctx.secrets.MYAGENT_KEY` — non-existent in Phase 2 scope.

**Add to Commit 6 checklist:** "Update `.claude/skills/runner-author/SKILL.md` to match the shipped Phase 2 surface. Specifically: (a) `extractStructuredOutput(finalEvent: TerminalEvent): unknown`, (b) `argv: readonly string[]`, (c) imports from `@orch/runners` barrel only, (d) drop the `ctx.secrets` example until the secrets phase, (e) document that classes implementing `Runner` directly are valid for stateful runners."

### Simplicity findings

Reviewer: code-simplicity-reviewer. Cuts that could land before Commit 1, ordered by confidence. Each is independent — apply individually. **The "speculative-surface trade-off" decision in the Enhancement summary lists which of these to take; below is the full menu.**

| # | Cut | LOC saved | Lose |
|---|---|---|---|
| C1 | `escalationWiring?(ctx)` field | ~5 + 1 test | Phase 14 adds it in one line; nothing consumes it today |
| C2 | `schema?: unknown` parameter on `extractStructuredOutput` | ~2 | Phase 7 widens the signature instead of widening the parameter list — same one-line change |
| C3 | `deps.signal?: AbortSignal` declared but not consumed | ~2 + 1 AC | Phase 11 widens `deps` instead — no caller passes signal today, so widening breaks no one |
| C4 | `deps.clock?` optional + `defaultClock` fallback | ~3 | Two characters per Phase 4 test site (`clock: new FakeClock()`). **Already adopted as plan-modifying fix T5.** |
| C5 | `Object.freeze` in `defineRunner` | ~2 | Theoretical defense against post-definition mutation that TypeScript `readonly` already forbids at compile time |
| C6 | Replace Zod schema with hand-rolled `if`s, OR cut validation entirely | ~15 + ~6 tests | Zod's value is validating untrusted data; `defineRunner` is called by typed code, the only way to hit validation errors is `as Runner` casts. **Counter-evidence:** the Zod-research agent showed Zod 4 changes that need to be addressed *anyway* (`z.function()` removed) — if validation stays, the Zod schema must change |
| C7 | `isTerminalEvent` exported from barrel | ~3 tests | Internal-to-module is enough; export when a real consumer asks |
| C8 | `FakeRunner` nonce in error messages + `invocationCount` getter | ~10 + 1 test | Debugging context that may or may not be load-bearing once Phase 4 has multiple runners per workflow |
| C9 | `RunnerResult.structuredOutput` field | ~2 | Phase 7 adds it; field is `undefined` in Phase 2 anyway. **Counter-evidence:** kieran's nit T8 wants this field generic (`RunnerResult<T>`) — keeping the field as a generic placeholder is cheap and prevents a breaking change in Phase 7 |
| C10 | Six sub-commits → three (scaffold+tests, impl, barrel/roadmap) | commit overhead | Bisectability between "defineRunner landed" and "FakeRunner landed" — both in the same PR anyway |
| C11 | ~~`Path` re-exported from `src/runners/index.ts`~~ | ~~~1~~ | **Moot:** Phase 1 ships `Path` from `src/services/types.ts`. Phase 2 imports it; no re-export from runners barrel. |

**Survivors (load-bearing per simplicity reviewer):** the four-method `Runner` interface, the `RunnerEvent` discriminated union (with the `kind` discriminator from T1), `runRunner` pseudocode, the `FakeRunner` + `FakeProcessService` script-queue pairing, the ≤60-line `runRunner` body budget.

### Naming & layout fixes

Reviewer: pattern-recognition-specialist.

| # | Severity | Fix |
|---|---|---|
| N1 | major | Rename `src/runners/runner.ts` → `src/runners/types.ts`. Reading `ls src/runners/` once Phase 5 lands shows `claude/ codex/ fake/ runner.ts execute.ts index.ts` — `runner.ts` reads as a concrete runner. |
| N2 | major | Rename `tests/unit/runners/runner.test.ts` → `tests/unit/runners/define-runner.test.ts` (matches the SUT) and `tests/integration/runners/execute.test.ts` → `tests/integration/runners/run-runner.test.ts`. Same collision risk in `tests/`. |
| N3 | minor | Add to Commit 2 guardrails: "Every test file imports runners symbols from `@orch/runners` only." Add a Commit 6 grep: `grep -rn "from '@orch/runners/" tests/` returns only `'@orch/runners'` (or the bare barrel index). |
| N4 | minor | Hoist the rationale for `class FakeRunner` (vs `defineRunner`) from "Alternatives considered" #4 to the section that introduces `FakeRunner`. Add a one-liner to `runner-author/SKILL.md`: "Use `defineRunner()` for stateless real runners. Stateful runners (test doubles, session-bound) are plain classes implementing `Runner`." |
| N5 | minor | Add one sentence near the FakeRunner shape explaining the constructor-vs-deps-bundle asymmetry: "Constructor takes `FakeProcessService` directly because FakeRunner owns exactly one collaborator; `runRunner` uses a bundle because it coordinates three (process, clock, signal)." |
| N6 | nit | Add a one-line note explaining why the testing-strategy skill's `step.define` namespace pattern is NOT followed for runners: local variables named `runner` collide with a `runner.define` namespace. |

### Architectural concerns the plan is silent on

Reviewer: architecture-strategist.

#### AR1 — `runRunner` location: `src/runners/execute.ts` vs `src/core/run-runner.ts` — major

`runRunner` imports `ProcessService` and `Clock` from `@orch/services/*`. `Runner` imports nothing. The asymmetry is the tell: `runRunner` is **orchestration**, not adapter code. CLAUDE.md Rule 2 says "the core never imports a concrete runner" — `runRunner` takes `Runner` *by interface*, so it's compliant. The opposite is the risk: today `src/runners/` is pure adapter-land; the moment `execute.ts` lands, `src/runners/` also depends on `@orch/services/process` and `@orch/services/clock`, making it a two-layer module.

**Recommendation:** create `src/core/run-runner.ts` *now*, in Phase 2. `src/core/` as a directory can exist with one file; the "Phase 4 core DSL" is a *logical* phase, not a "directory doesn't exist yet" constraint. This keeps `src/runners/` pure adapter-land and means the `runner-author` skill can honestly say "you never import from anywhere except `@orch/runners` types." Phase 4 then *extends* core rather than relocating files.

**Counter-argument (from the plan as written):** keeping `runRunner` in `src/runners/` means Phase 4 doesn't need to relocate it later. But the plan explicitly rejects this for `AbortSignal` (forward-declares to avoid call-site churn) — the same logic should apply here.

**Decision:** flagged in the Enhancement summary "Decisions that need a human" list.

#### AR2 — ~~`Path` forward-declaration: pragmatic but brittle~~ — **RESOLVED**

~~The `TODO(phase-3)` comment is grep-based, not compiler-enforced.~~ **Phase 1 already ships `Path` at `src/services/types.ts`.** Phase 2 imports it directly — no forward-declaration, no drift risk, no `TODO(phase-3)` grep needed. One source of truth from day one. Phase 3 relocates to `src/core/types.ts`.

#### AR3 — `AbortSignal` seam should throw if used in Phase 2 — minor

If kept (per the speculative-surface decision), `runRunner` should fail loudly when `signal.aborted === true` or when a listener fires:

```ts
if (deps.signal?.aborted) {
  throw new Error('runRunner: cancellation not implemented until phase 11')
}
deps.signal?.addEventListener('abort', () => {
  throw new Error('runRunner: cancellation not implemented until phase 11')
})
```

Silently ignoring a caller's cancellation request is a correctness bug even if no caller exists yet.

#### AR4 — TerminalEvent extensibility story is missing — major

`TerminalEvent` is a closed union (`turn-complete | error`). Phase 11 wants `cancelled`. Phase 14 escalation wants `escalation-requested`. Each addition is a breaking change to every adapter's `parseEvents` return type and every `isTerminalEvent` caller.

**Recommendation:** pick one of:
- (a) Pre-widen with `(string & {})` and document "closed set in Phase 2, extensions tracked in ADRs."
- (b) Accept the churn and add a "Phase 11/14 will widen this union" note to Post-phase follow-ups.

Option (b) is fine if called out; silence is not.

#### AR5 — `Runner.version: string` is free now, breaking later — major

Add `readonly version: string` to the `Runner` interface in Phase 2. Cost: one line per adapter. Benefit: versioned memoization keys in Phase 4, runner swap compatibility in Phase 9, audit trails. Adding it later is a breaking change for every adapter that already exists. **Adopted in the type-design fixes above.**

#### AR6 — Cross-cutting concerns the plan is silent on — major

| Concern | Phase 2 disposition | Recommendation |
|---|---|---|
| **Timeouts** | Not addressed | Hardcoded backstop in Phase 2 (S1). Configurable in Phase 11. |
| **Logging / observability** | Not addressed | Add `deps.onEvent?` callback (perf, agent-native) — two lines, enables Phase 4 streaming persistence. |
| **Resource cleanup** | Plan assumes `for await` `break` is enough | `[Symbol.asyncDispose]` on `SpawnHandle` (R6); explicit stdout drain (R1). |
| **stderr** | Listed in prerequisites; never read | Drain concurrently from spawn (R2); attach last 64 KB to synthesized error events. |
| **Retries / error budgets** | Out of scope | Add a one-liner to Post-phase follow-ups: "retries are a Phase 4 concern, layered ON TOP of `runRunner`, not inside it." |

### Hexagonal / test-double pattern advice

Reviewer: best-practices (hexagonal/GOOS literature).

The plan's three-layer split (adapter / glue / fake) implements a **sociable unit test built on a Humble Object seam** (Meszaros, *xUnit Test Patterns*; Freeman & Pryce, *GOOS*; Fowler "Humble Object" bliki). The closest term of art is "classicist sociable test with fakes at the adapter port" (Shai Yallin's "Fake, Don't Mock"). The testing-strategy skill already codifies this as "mock only at the edge."

#### H1 — Fake drift (Seemann, GOOS ch. 20) — major

`FakeProcessService` will slowly diverge from real `Bun.spawn` semantics (backpressure, partial line buffering, SIGPIPE on close, stderr interleaving). The plan's mitigation ("two integration tests per runner: mocked + real") is correct *only if* `bun run check` fails loudly when the real test is skipped in CI.

**Recommendation:** add a nightly CI job that sets `RUN_REAL_*=1` and blocks merge-to-main on failure. This is the highest-leverage anti-drift mechanism. Combined with the contract test (A7), fake drift is structurally prevented.

#### H2 — Fake feature creep (Meszaros §"Fake Object") — minor

If `FakeRunner.script({failWith})` grows features that real runners don't emit (retry counters, backpressure simulation), tests pass against fantasy.

**Recommendation:** forbid any `FakeRunner` capability that isn't exercised by at least one real runner's fixture. Add a test that asserts `FakeRunner`'s scripted event vocabulary is a subset of the union of real runners' `parseEvents` outputs. (Trivial in Phase 2: `FakeRunner` accepts any `InfoEvent`. Worth revisiting in Phase 5.)

#### H3 — Sociable tests turn into slow integration tests (Fowler) — minor

Because `runRunner` is real, every "unit" test pays the full executor cost. Add a wallclock budget assertion in CI for `tests/unit/**` (e.g., < 5 s total). If it creeps past, the humble object has stopped being humble.

#### H4 — Hidden coupling via the shared port — major

`FakeProcessService` is shared across all runners. A change to its contract ripples silently. **A4's contract test (Pact-style) is the mitigation.** Single highest-leverage architectural addition to the plan.

#### H5 — `FakeRunner.script()` should accept an optional matcher — minor

Implicit FIFO couples test order to enqueue order. When a test fails, "queue was empty" doesn't tell you *which* call was unexpected. Make `script()` accept an optional matcher: `script({ events, matcher: (argv) => boolean })`. Falls back to FIFO when no matcher is given. Strictly better for debuggability; cheap.

Also: capture the enqueue site's stack in the empty-queue error:

```ts
script(s: FakeScript): this {
  const enqueuedAt = new Error().stack
  this.#queue.push({ ...s, enqueuedAt })
  // ...
}
```

Trace from "queue was empty" back to the script() call site that didn't fire.

### Zod-specific guidance

Reviewer: framework-docs-researcher (Zod).

The project pins `zod: ^3.23.8` (verified 2026-04-10 by reading `package.json`). The original plan's Zod schema works on 3.x. **If you upgrade to Zod 4 before Commit 3 (recommended for `z.prettifyError`), the schema needs three changes:**

#### Z1 — `z.function()` is no longer a schema in Zod 4

Replacement is `z.custom<Fn>()` with a `typeof` check:

```ts
import { z } from 'zod'

const fn = <F extends (...args: never[]) => unknown>() =>
  z.custom<F>((v) => typeof v === 'function', { message: 'expected function' })

const RunnerAdapterSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  supports: z.object({
    interactive: z.boolean(),
    structuredOutput: z.boolean(),
  }).passthrough(),                          // (agent-native A8): allow new capabilities
  buildCommand: fn<Runner['buildCommand']>(),
  parseEvents: fn<Runner['parseEvents']>(),
  extractStructuredOutput: fn<Runner['extractStructuredOutput']>(),
}).strict()                                  // reject typos in field names
```

#### Z2 — `z.prettifyError(err)` for readable errors (Zod 4 only)

Emits multi-line output like `✖ Invalid input: expected boolean, received undefined → at supports.interactive`. On Zod 3, hand-roll: `err.issues.map(i => \`${i.path.join('.')}: ${i.message}\`).join('\n')`.

#### Z3 — Use `safeParse` and return the original `config`

`schema.parse(config)` returns a new object whose type is `z.infer<typeof schema>`, **stripping the literal `T`**. Returning the original `config` (after validation) preserves the caller's literal type. The cast is safe because validation has already confirmed the runtime shape:

```ts
export function defineRunner<T extends Runner>(config: T): Readonly<T> {
  const result = RunnerAdapterSchema.safeParse(config)
  if (!result.success) {
    const missing = result.error.issues
      .filter(i => i.code === 'invalid_type' && (i as { received?: string }).received === 'undefined')
      .map(i => i.path.join('.'))
    const header = missing.length
      ? `missing required field${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}\n`
      : ''
    throw new Error(`defineRunner: ${header}${z.prettifyError(result.error)}`)
  }
  // NOTE: parse result is discarded. We return the original `config` (not result.data)
  // to preserve the caller's literal type T. Validation has confirmed the runtime shape.
  return Object.freeze(config)
}
```

This addresses S7 (no value leakage in error messages) and T-series naming/typing fixes simultaneously.

### References (added by the deepening pass)

Sources cited by the research agents above:

- Zod v4 docs / changelog — https://zod.dev/v4 , https://zod.dev/v4/changelog
- Zod API reference — https://zod.dev/api
- Zod issue #4143 (`z.function` removal, `z.custom` pattern) — https://github.com/colinhacks/zod/issues/4143
- Bun spawn — https://bun.com/docs/api/spawn , https://bun.com/reference/bun/spawn
- Node.js stream `Symbol.asyncIterator` — https://nodejs.org/api/stream.html#readablesymbolasynciterator
- Node.js PR #38526 (non-destroying iterator, `destroyOnReturn`) — https://github.com/nodejs/node/pull/38526
- 2ality — Easier Node.js streams via async iteration — https://2ality.com/2019/11/nodejs-streams-async-iteration.html
- TC39 explicit-resource-management (Stage 3) — https://github.com/tc39/proposal-explicit-resource-management
- Martin Fowler — Humble Object — https://martinfowler.com/bliki/HumbleObject.html
- Martin Fowler — Unit Test (sociable vs solitary) — https://martinfowler.com/bliki/UnitTest.html
- Martin Fowler — Test Double — https://martinfowler.com/bliki/TestDouble.html
- xUnit Test Patterns — Humble Object — http://xunitpatterns.com/Humble%20Object.html
- Mark Seemann — Functional architecture is Ports and Adapters — https://blog.ploeh.dk/2016/03/18/functional-architecture-is-ports-and-adapters/
- Shai Yallin — Fake, Don't Mock — https://www.shaiyallin.com/post/fake-don-t-mock
- Codurance — TDD Anti-Patterns Chapter 2 — https://www.codurance.com/publications/tdd-anti-patterns-chapter-2
- Freeman & Pryce, *Growing Object-Oriented Software, Guided by Tests* (chs. 8, 20)
- Feathers, *Working Effectively with Legacy Code* (chs. 9, 25 — "Seams")
- Meszaros, *xUnit Test Patterns* (Humble Object, Test Stub, Fake Object)

## Acceptance criteria

### Functional requirements

- [x] `src/runners/runner.ts` exists and exports `Runner`, `RunnerContext`, `RunnerEvent`, `TerminalEvent`, `InfoEvent`, `defineRunner`, `isTerminalEvent`. (`Path` is imported from `src/services/types.ts`, not re-exported from this module.)
- [x] `src/runners/execute.ts` exists and exports `runRunner` and `RunnerResult`.
- [x] `src/runners/fake/fake-runner.ts` exists and exports `FakeRunner` and `FakeScript`.
- [x] `src/runners/index.ts` is the only cross-module entry point and re-exports the full public surface.
- [x] `defineRunner` validates a config with Zod, freezes it, and returns it; throws readable errors on every missing required field.
- [x] `isTerminalEvent` narrows `RunnerEvent` to `TerminalEvent` for `turn-complete` and `error` types.
- [x] `FakeRunner.script()` enqueues a scripted response on the injected `FakeProcessService` and is chainable.
- [x] `FakeRunner.invocationCount` returns the number of times `buildCommand` has been called on the instance.
- [x] `runRunner(fake, ctx, { processService: fps, clock })` produces a `RunnerResult` with `events`, `finalEvent`, `exitCode`, `durationMs`, and `structuredOutput` fields.
- [x] `runRunner` never throws on a runner error — it returns a non-zero `exitCode` and an `error` `finalEvent`.
- [ ] ~~`runRunner` declares `deps.signal?: AbortSignal` but does not consume it in Phase 2.~~ Dropped per smallest-surface decision — Phase 11 widens `deps`.

### Non-functional requirements

- [x] `runner.ts` ≤ 300 lines (expected ~80).
- [x] `execute.ts` ≤ 300 lines (expected ~60); `runRunner` body ≤ 60 lines.
- [x] `fake-runner.ts` ≤ 300 lines (expected ~100).
- [x] Every test file ≤ 150 lines.
- [x] No `any`, no `!`, no `default export`, no `console.log`.
- [x] No `import` of `child_process`, `node:child_process`, `node-pty`, or `Bun.spawn` anywhere under `src/runners/`.
- [x] No `mock.module`, `vi.mock`, or `jest.mock` anywhere under `tests/unit/runners/` or `tests/integration/runners/`.
- [x] Every test name is a full sentence.
- [x] Arrange-Act-Assert with blank-line separators in every test.

### Quality gates

- [x] `bun run lint` is clean (Biome).
- [x] `bun run typecheck` is clean (`tsc --noEmit` under `strict: true` and `noUncheckedIndexedAccess: true`).
- [x] `bun run test` is fully green (unit + mocked-integration).
- [x] `bun run check` is green end-to-end on a clean clone.
- [x] PR description lists tests added per layer (unit / mocked-integration / real-integration / e2e) — **real-integration and e2e are explicitly NONE in Phase 2**.

## Tests per layer

Per the testing-strategy skill, each layer proves a different property. Phase 2 ships three test files across two layers:

### Unit — `tests/unit/runners/`

| File | Proves |
|---|---|
| `runner.test.ts` | `defineRunner`'s Zod validation catches every required field; `isTerminalEvent` narrows correctly. |
| `fake/fake-runner.test.ts` | `FakeRunner`'s script queue FIFO semantics, error path, invocationCount, empty-queue diagnostic. |

### Integration (mocked edges) — `tests/integration/runners/`

| File | Proves |
|---|---|
| `execute.test.ts` | `FakeRunner + runRunner + FakeProcessService` compose correctly: events round-trip, terminal event detected, durationMs measured via injected `Clock`, non-throwing error path, `extractStructuredOutput` is NOT called when `ctx.schema` is absent, synthesized error when process closes without a terminal event. |

### Integration (real) and E2E

**Explicitly none.** Phase 5 lands the first real runner; Phase 12/16 land e2e flows. Any temptation to "just wire up a real `echo` test" here is a violation — `FakeProcessService` already proves the shape, and BunProcessService's own integration test is Phase 1's responsibility.

## Dependencies & risks

### Dependencies

| From | Symbol | Used in | Verified |
|---|---|---|---|
| Phase 1 | `ProcessService`, `SpawnHandle`, `SpawnOptions` | `runRunner` signature and body | ✅ 2026-04-10 |
| Phase 1 | `FakeProcessService`, `FakeResponse` | `FakeRunner` constructor, `execute.test.ts` | ✅ 2026-04-10, FIFO confirmed |
| Phase 1 | `Clock`, `FakeClock` | `runRunner` `deps.clock`, `execute.test.ts` duration test | ✅ 2026-04-10 |
| Phase 1 | `Path`, `path()` | `RunnerContext.cwd` | ✅ 2026-04-10, at `src/services/types.ts` |
| External | `zod` (already in `package.json`) | `defineRunner` schema | ✅ verify Zod major version before Commit 3 |

### Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| ~~Phase 1's `FakeProcessService.when()` doesn't support multiple scripted responses for the same argv~~ | ~~Medium~~ | **RESOLVED:** Phase 1's `FakeProcessService` uses `Map<string, FakeResponse[]>` with `push()` / `shift()` — FIFO multi-response per argv is confirmed. Existing tests at `tests/unit/services/process/fake-process-service.test.ts` cover this. |
| TypeScript structural subtyping lets `InfoEvent` absorb `TerminalEvent` (both have `type: string`), weakening exhaustive-switch narrowing | Low | `isTerminalEvent` predicate is the canonical narrow; never pattern-match on `type` directly in `src/runners/execute.ts`. Narrow via the predicate, then trust TerminalEvent's literal union. |
| `runRunner`'s stdout loop forgets to `break` on the terminal event and drains extra lines | Low | The integration test "round-trips info events, terminal event, and structured output" asserts `events.at(-1).type === 'turn-complete'` AND `events.length === expectedCount` — post-terminal lines would fail the count assertion. |
| `FakeRunner` nonce collision across two instances in the same test | Very low | 4-char base36 gives ~1.6M values. Tests construct one FakeRunner per scenario. If paranoid, use a monotonic counter + random suffix. Do not spend time here. |
| ~~Forward-declared `Path` brand drifts from Phase 3's canonical declaration~~ | ~~Low~~ | **RESOLVED:** Phase 1 ships `Path` at `src/services/types.ts`. Phase 2 imports it — no forward-declaration, no drift risk. Phase 3 relocates to `src/core/types.ts` and both `src/services/types.ts` and `src/runners/runner.ts` switch to the core import. |
| Over-engineering the test helper layer (`buildTestRun`, `ctxFor`, etc.) in Phase 2 | Medium | Keep helpers inline inside each test file for Phase 2. Promote to `tests/helpers/` only in Phase 4 when they're used across modules. |

## CLAUDE.md compliance checklist

One checkbox per non-negotiable rule. Tick at commit-6 time:

- [x] **Rule 1** — no `child_process`/`node-pty`/`Bun.spawn` outside `src/services/process/`. Verified by: `grep -rn 'child_process\|node-pty\|Bun\.spawn' src/runners/` returns empty.
- [x] **Rule 2** — runners are adapters; `src/core/` doesn't import concrete runners. Verified by: `src/core/` does not exist yet in Phase 2 (trivially satisfied).
- [x] **Rule 3** — mock only at the edge. Verified by: `grep -rn 'mock\.module\|vi\.mock\|jest\.mock' tests/unit/runners tests/integration/runners` returns empty.
- [x] **Rule 4** — test names are full sentences; Arrange-Act-Assert with blank-line separators. Verified by manual review at commit-6.
- [x] **Rule 5** — files ≤ 300 lines, functions ≤ 60 lines. Verified by: `.claude/hooks/warn-big-file.sh` on each changed file.
- [x] **Rule 6** — TypeScript strict, no `any`, no `!`. Enforced by Biome (`noExplicitAny: error`, `noNonNullAssertion: error`).
- [x] **Rule 7** — single public barrel per module; import from `src/runners/index.ts` only. Verified by: no test under `tests/**` imports `src/runners/runner.ts` / `src/runners/execute.ts` / `src/runners/fake/fake-runner.ts` directly — all imports go through `@orch/runners` (tests/helpers excepted if any; none exist in Phase 2).
- [x] **Rule 8** — no side effects at import time. Verified by: `const barrel = await import('@orch/runners')` in a dedicated test; `defineRunner`'s Zod schema is declared lazily at first `defineRunner()` call, not at module top — **actually it's top-level const, which is fine because declaring a schema is a pure data operation, not a side effect.** (Double-check: running the schema is lazy; only construction runs at import, and Zod construction is pure.)
- [x] **Rule 9** — `Path` branded type used for `cwd`. Verified by `RunnerContext.cwd: Path` (not `string`). `Path` imported from `src/services/types.ts` (Phase 1), not forward-declared.
- [x] **Rule 10** — `bun run check` is green on every commit except Commit 2 (the intentional red-test commit, which is green on lint + typecheck and red only on test).

## Scope boundaries (explicitly NOT in this phase)

Copied from the brainstorm's "Things deliberately NOT in this phase". Any PR reviewer sees an addition beyond this list → request removal.

- ❌ Any concrete runner (`claude`, `codex`, `aider`).
- ❌ Per-invocation runner factories (`claude({ model })` shape).
- ❌ `schema` field on `RunnerContext` or `extractStructuredOutput` wiring to Zod.
- ❌ `tmux` pane handle, transcript path, escalation wiring.
- ❌ `secrets` field on `RunnerContext`.
- ❌ A runner registry or npm-plugin mechanism.
- ❌ The `run(STEP)` DSL (Phase 4).
- ❌ `tests/helpers/build-test-run.ts` or any shared test-helper scaffolding.
- ❌ Real-integration or E2E tests.

## Alternatives considered (from brainstorm — summarized)

1. **Single-layer "runner owns I/O".** Rejected: puts `ProcessService` inside every adapter, making `ClaudeRunner` need to know about subprocess framing. Violates "runners are adapters".
2. **Two-layer "core owns `runRunner`".** Rejected: makes Phase 4 scope include subprocess plumbing, delaying the memoization work and tangling two concerns per commit.
3. **`FakeRunner` as a function, not a class.** Rejected: needs per-instance mutable state (nonce, invocationCount, FPS reference). A closure would work but makes the state implicit; a class makes it obvious to readers.
4. **`FakeRunner` as a `defineRunner(...)`-produced object.** Rejected: `defineRunner` freezes its argument, which precludes the mutable invocation counter. Exception documented in the brainstorm: both classes and `defineRunner`-produced objects satisfy the `Runner` interface, so they coexist cleanly.
5. **Put `runRunner` in Phase 4 with the core DSL.** Rejected: leaves Phase 2 unable to ship an end-to-end test; the `RunnerResult` shape becomes vapor until Phase 4.

## Post-phase follow-ups (not blockers)

- Phase 3's PR must relocate `Path` and `path()` from `src/services/types.ts` to `src/core/types.ts` and switch both `src/services/types.ts` and `src/runners/runner.ts` to the core import. Add `pathAbs()` if not already added as a prep commit.
- Phase 7's PR must add `schema?: unknown` to `RunnerContext` and un-dead-code the `extractStructuredOutput` branch in `runRunner`.
- Phase 11's PR must wire `deps.signal` into the stdout loop (cancel → `handle.kill()` → synthesize an `error` terminal event or return the in-flight events + a special `cancelled` subtype). Phase 11 owns that decision.

## References

### Internal references

- `docs/brainstorms/2026-04-09-phase-2-runner-port-brainstorm.md` — source brainstorm, every design decision locked.
- `docs/plans/implementation-phases.md` — phased roadmap; Phase 2 block at lines 72–84.
- `CLAUDE.md` — non-negotiable rules.
- `.claude/skills/phase-implementer/SKILL.md` — order of operations (scaffold → tests → implementation → green gate).
- `.claude/skills/testing-strategy/SKILL.md` — three-layer model, "mock only at the edge" rule.
- `.claude/skills/runner-author/SKILL.md` — canonical runner shape for Phase 5+; Phase 2 must stay consistent with this.
- `tsconfig.json` — path aliases (`@orch/runners/*`, `@orch/services/*`).
- `biome.json` — lint rules (`noExplicitAny`, `noNonNullAssertion`, `noDefaultExport`, `useImportType`).

### External references

- Zod docs for `z.function()` and `z.object().parse()` — validating arbitrary-shape adapters without losing type safety. https://zod.dev
- Bun test runner docs — `describe`, `it`, `expect`, async iteration. https://bun.sh/docs/test/writing

### Related work

- Phase 1 (`ProcessService` port) — hard dependency.
- Phase 3 (state store + branded types) — consumes `Path` and relocates it.
- Phase 4 (core DSL + memoization) — first real consumer of `runRunner` + `FakeRunner`.
- Phase 5 (`ClaudeRunner`) — first real runner; must conform to the `Runner` interface frozen by Phase 2 without further changes.

## Handoff

When implementation begins:

1. Load the `phase-implementer` skill.
2. Load the `testing-strategy` skill before writing any tests.
3. Verify Phase 1's deliverables (`ProcessService`, `FakeProcessService`, `Clock`) exist and are green.
4. Work the six commits in order. Do not squash — each commit tells a reviewer a self-contained story.
5. On merge, update `docs/plans/implementation-phases.md` per Commit 6's checklist.
