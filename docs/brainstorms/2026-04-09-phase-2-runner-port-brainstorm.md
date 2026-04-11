---
date: 2026-04-09
status: brainstorm
topic: Phase 2 — Runner port, RunnerContext, RunnerEvent, FakeRunner, runRunner glue
relates-to: docs/plans/implementation-phases.md (Phase 2)
---

# Phase 2 Brainstorm — `Runner` port + `FakeRunner`

## What we're building

Phase 2 introduces the abstraction that every coding-agent CLI will plug into. No real CLI lands yet — this phase ships the **interface**, the **context type**, the **event type**, a **fake implementation**, a **validating `defineRunner()` helper**, and the **`runRunner()` glue** that executes any runner against a `ProcessService`. Phase 4's core DSL will be able to run full workflows powered entirely by `FakeRunner`, and Phase 5 will drop in a real `ClaudeRunner` that implements the same interface without touching core.

### Deliverables

```
src/runners/
├── runner.ts          # Runner interface + RunnerContext + RunnerEvent + RunnerResult + defineRunner
├── execute.ts         # runRunner(runner, ctx, { processService }) — the glue
├── fake/
│   ├── index.ts
│   └── fake-runner.ts # scriptable FakeRunner class
└── index.ts           # public barrel: exports Runner, RunnerContext, RunnerEvent, defineRunner, FakeRunner, runRunner

tests/unit/runners/
├── runner.test.ts     # defineRunner validation
├── execute.test.ts    # runRunner against FakeProcessService
└── fake/fake-runner.test.ts
```

Nothing imports from concrete runners yet. `src/runners/index.ts` is the only cross-module entry point.

## Why this approach

The core design tension in Phase 2 is how "pure adapter methods" (which the brainstorm specifies) reconcile with "core runs workflows entirely via FakeRunner" (Phase 4). Resolving it requires a three-layer split:

1. **Pure adapter (`Runner`)** — four methods (`buildCommand`, `parseEvents`, `extractStructuredOutput`, optional `escalationWiring`), plus `name` and `supports`. No I/O, no state, no ProcessService import. This is what runner authors write.
2. **Glue (`runRunner`)** — one async function that consumes a `Runner` + `RunnerContext` + a `ProcessService` port and produces a `RunnerResult` (`events`, `finalEvent`, `exitCode`, optional `structuredOutput`). This is the only place that knows how to pump stdout lines into `parseEvents` and detect end-of-run.
3. **Test double (`FakeRunner`)** — a concrete class implementing `Runner`. It pre-scripts a constructor-injected `FakeProcessService` using a per-instance nonce argv, so tests can drive it the same way real runners will be driven.

This split satisfies all three design drivers from the implementation plan:
- **Testability** — core tests inject `FakeProcessService` + `FakeRunner`, no `mock.module` anywhere. The seam is explicit.
- **Readability** — the adapter is ≤ four methods; the glue is ≤ 60 lines; FakeRunner's API reads as `fake.script({ events, structuredOutput }).runsFor(workflow)`.
- **Maintainability** — adding a new runner means writing a four-method file; the glue, core, and tests never need to change.

## Key decisions (locked from the Q&A)

### 1. `Runner` is adapter-only; `runRunner` holds the glue

```ts
// src/runners/runner.ts
export interface Runner {
  readonly name: string
  readonly supports: { interactive: boolean; structuredOutput: boolean }

  buildCommand(ctx: RunnerContext): { argv: readonly string[]; env: Record<string, string> }
  parseEvents(line: string): RunnerEvent | null
  extractStructuredOutput(finalEvent: TerminalEvent, schema?: unknown): unknown

  // Placeholder — populated in Phase 14. Not implemented in this phase.
  escalationWiring?(ctx: RunnerContext): unknown
}
```

The `Runner` interface is pure. The executor lives in `src/runners/execute.ts`:

```ts
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
    signal?: AbortSignal // declared in Phase 2, wired in Phase 11
  },
): Promise<RunnerResult>
```

Core (Phase 4) depends on `runRunner` + `ProcessService`, never on a concrete runner.

**Why:** keeps the public primitive tiny (users write four pure methods in ~30 lines), keeps the glue in one file, and keeps FakeRunner a peer of real runners — no special paths.

### 2. `RunnerContext` is YAGNI-minimal

```ts
export interface RunnerContext {
  readonly cwd: Path
  readonly env: Readonly<Record<string, string>>
  readonly prompt: string
  readonly extraArgs?: readonly string[]
}
```

`schema`, `secrets`, `paneHandle`, `transcriptPath`, `escalation` are all **deferred** to the phases that actually need them (Phase 7, 13, 14). Each addition will touch `RunnerContext`, the glue, and a single test.

**Why:** The brainstorm listed those fields as the *eventual* surface, but YAGNI wins here — optional fields you never populate are dead weight that misleads runner authors about what's available now.

### 3. `RunnerEvent` is a closed terminal + open info-event union

```ts
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
```

`runRunner` iterates `handle.stdout`, calls `runner.parseEvents(line)` for each line, pushes non-null results into `events`, and breaks the loop when it sees a `TerminalEvent`. The `finalEvent` is passed to `extractStructuredOutput` only if `ctx.schema` is set (in Phase 2 that branch is never taken; the field doesn't exist yet).

**Why:** closed terminal types give core the strong discriminator it needs for end-of-run detection and exhaustive switches, while open info events let runners log tool calls, thinking, or messages without a vocabulary lock-in.

### 4. `FakeRunner` is a class that pre-scripts `FakeProcessService`

```ts
// src/runners/fake/fake-runner.ts
export interface FakeScript {
  readonly events?: readonly InfoEvent[]
  readonly structuredOutput?: unknown
  readonly failWith?: { message: string; exitCode?: number }
}

export class FakeRunner implements Runner {
  readonly name = 'fake'
  readonly supports = { interactive: true, structuredOutput: true }

  constructor(private readonly processService: FakeProcessService) { /* ... */ }

  script(s: FakeScript): this   // register next response on FakeProcessService
  get invocationCount(): number // how many times buildCommand ran

  buildCommand(ctx: RunnerContext): { argv: readonly string[]; env: Record<string, string> }
  parseEvents(line: string): RunnerEvent | null      // JSON.parse(line)
  extractStructuredOutput(finalEvent: TerminalEvent): unknown  // finalEvent.data
}
```

Mechanics:
- Each `FakeRunner` instance generates a nonce (`f-<4-char>`) on construction.
- `script({events, structuredOutput})` registers `fps.when([':fake:', nonce]).respondWith({ stdout: [...eventLines, terminalLine], exit: 0 })`.
- `buildCommand` returns `{ argv: [':fake:', this.nonce], env: ctx.env }` and increments `#invocations`.
- `parseEvents` does `JSON.parse(line)` — format is controlled by `script()` so it's guaranteed valid.
- `extractStructuredOutput(final)` returns `final.data`.

Phase 4 unit tests then look like:

```ts
const fps = new FakeProcessService()
const fake = new FakeRunner(fps)
fake.script({ structuredOutput: { phases: [{ name: 'setup' }] } })

const result = await runRunner(fake, ctxFor('do the thing'), { processService: fps })

expect(fake.invocationCount).toBe(1)
expect(result.finalEvent.type).toBe('turn-complete')
expect(result.structuredOutput).toEqual({ phases: [{ name: 'setup' }] })
```

**Why:** FakeRunner is the same shape as every future runner, so Phase 4's memoization tests exercise the exact code path Phase 5's ClaudeRunner will use — no "test-only fast path" to drift out of sync.

### 5. `runRunner` lives in `src/runners/execute.ts` and ships in Phase 2

Phase 2 now owns both the type and the executor. Phase 4 just imports `runRunner` and calls it from `run(STEP, ...)`.

**Why:** the runner layer stays self-contained, Phase 2 tests assert end-to-end that `FakeRunner → runRunner → FakeProcessService` produces the right `RunnerResult`, and Phase 4's scope stays focused on memoization + DSL.

### 6. `defineRunner()` is a validating identity

```ts
// src/runners/runner.ts
import { z } from 'zod'

const RunnerAdapterSchema = z.object({
  name: z.string().min(1),
  supports: z.object({ interactive: z.boolean(), structuredOutput: z.boolean() }),
  buildCommand: z.function(),
  parseEvents: z.function(),
  extractStructuredOutput: z.function(),
  escalationWiring: z.function().optional(),
})

export function defineRunner<T extends Runner>(config: T): T {
  RunnerAdapterSchema.parse(config)
  return Object.freeze(config) as T
}
```

Per-invocation factories like `claude({ model: 'claude-opus-4-6' })` are **not** part of Phase 2. They land in Phase 5, where `claude` closes over its options and returns `defineRunner({ name: 'claude', buildCommand: ctx => buildClaudeCommand(ctx, opts), ... })`. `FakeRunner` stays a class because it needs per-instance state (the nonce, the invocation count, the FakeProcessService reference); that's an acceptable exception — both classes and `defineRunner`-produced objects satisfy the `Runner` interface.

**Why:** Zod catches missing methods at module-load time with a readable error, `Object.freeze` prevents accidental mutation, and nothing in Phase 2 forces the per-invocation factory shape on runners that don't need options.

## Tests this phase must ship

Following the testing-strategy skill layer convention:

### Unit
- `runner.test.ts`
  - `defineRunner` accepts a valid adapter and freezes it.
  - `defineRunner` throws a readable error when any required method is missing.
  - `isTerminalEvent` narrows correctly.
- `fake/fake-runner.test.ts`
  - A scripted runner emits the configured info events followed by a `turn-complete`.
  - `script({ structuredOutput })` surfaces the value via `extractStructuredOutput`.
  - `script({ failWith })` produces an `error` terminal event and a non-zero exit code.
  - `invocationCount` increments each time `buildCommand` runs.
  - Two `script()` calls in FIFO order produce two independent runs.
  - `runRunner` against an empty FakeRunner queue throws `FakeRunner: no script configured for invocation N`.

### Integration (mocked edges)
- `execute.test.ts`
  - `runRunner(FakeRunner, ctx, { processService: FakeProcessService })` round-trips events, terminal event, and structured output.
  - `runRunner` returns a non-zero `exitCode` when the runner errors and does not throw.
  - `runRunner` measures `durationMs` using an injected `Clock`.
  - `runRunner` never calls `extractStructuredOutput` when `ctx.schema` is absent (parity with Phase 7's future wiring).

### Integration (real CLI)
- **None in Phase 2.** The first real runner lands in Phase 5.

### E2E
- **None in Phase 2.**

## File/function budget check

- `runner.ts` — ~80 lines (types + Zod schema + `defineRunner`).
- `execute.ts` — ~60 lines; `runRunner` body ≤ 60 lines including the stdout loop.
- `fake/fake-runner.ts` — ~100 lines including JSDoc on the script API.
- Every test file ≤ 150 lines.

All comfortably under the 300-line per-file / 60-line per-function warnings.

## CLAUDE.md rules check

- No `child_process`/`Bun.spawn`/`node-pty` import outside `src/services/process/`. ✅ (the glue only imports `ProcessService`, which is the port from Phase 1).
- No concrete runner imported inside `src/core/`. ✅ (core doesn't exist yet, and Phase 4 will only import `Runner` + `runRunner` + `FakeRunner` from `src/runners`).
- No `mock.module` on internal modules. ✅ (tests inject `FakeProcessService` directly).
- No `any`, no `!`. ✅ (use `unknown` for `data` and schema; narrow with `isTerminalEvent`).
- No side effects at import. ✅ (`defineRunner` runs only when called).
- `Path` branded type for `cwd`. ✅ (defined in Phase 3 — Phase 2 forward-declares it as a branded string type if Phase 3 hasn't landed yet, with a comment).

**Note on `Path`:** Phase 3 formally introduces `Path` as a branded type in `src/core/types.ts`. Phase 2 needs it a phase early for `RunnerContext`. **Resolved:** Phase 2 forward-declares the brand locally in `src/runners/runner.ts` with a TODO comment (`type Path = string & { readonly __brand: 'Path' }`); Phase 3 relocates it to `src/core/types.ts` and switches `runner.ts` to the core import. This is the only cross-phase dependency we pre-resolve.

## Dependencies from Phase 1

This phase **requires** Phase 1 to be landed:
- `ProcessService` interface + `SpawnHandle` (for `runRunner` to compile).
- `FakeProcessService` with `.when(argv).respondWith({stdout, exit})` (for FakeRunner to pre-script responses).
- A `Clock` stub (`src/services/clock/`) — used by `runRunner` to measure duration in a deterministic test.

If any of those aren't landed yet, Phase 2 cannot start.

## Things deliberately NOT in this phase

- Any concrete runner (`claude`, `codex`, `aider`).
- Per-invocation runner factories (`claude({ model })` shape).
- `schema` field on `RunnerContext` or `extractStructuredOutput` wiring to Zod.
- `tmux` pane handle, transcript path, escalation wiring.
- `secrets` field on `RunnerContext`.
- A runner registry or npm-plugin mechanism.
- The `run(STEP)` DSL (Phase 4).

## Resolved questions

1. **Where does `Path` live in Phase 2?** → Forward-declare the brand locally in `src/runners/runner.ts` with a TODO; Phase 3 relocates it to `src/core/types.ts` and `runner.ts` switches to the core import. (See "Note on `Path`" above.)
2. **Does `runRunner` accept an `AbortSignal`?** → Yes, declared as `signal?: AbortSignal` in `runRunner`'s `deps` argument now, even though Phase 2 never wires cancellation. Phase 11 fills it in with zero call-site churn.
3. **Multi-script semantics on `FakeRunner`?** → FIFO queue. Each `script()` call enqueues one response; `buildCommand` consumes one per invocation. Running out throws `FakeRunner: no script configured for invocation N` so silent under-scripting becomes a loud test failure.
4. **Public barrel surface?** → Full surface from a single `src/runners/index.ts`:
   ```ts
   export type {
     Runner, RunnerContext, RunnerEvent,
     TerminalEvent, InfoEvent, RunnerResult,
     FakeScript,
   } from './runner.ts'

   export { defineRunner, isTerminalEvent } from './runner.ts'
   export { runRunner } from './execute.ts'
   export { FakeRunner } from './fake/index.ts'
   ```

## Open questions

_None remaining for Phase 2 — every design decision is locked. New questions discovered during planning should land in the plan document, not here._

## Handoff

- Next step: `/workflows:plan` with this document as input. The plan should expand each deliverable into ordered sub-tasks with tests-first commits (scaffold → tests → implementation → green gate).
- The `phase-implementer` skill should be loaded when implementation begins.
- The `testing-strategy` skill should be loaded before writing any of the listed tests.
