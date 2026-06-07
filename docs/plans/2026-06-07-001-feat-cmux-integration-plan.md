---
status: active
created: 2026-06-07
origin: docs/brainstorms/2026-06-04-cmux-integration-brainstorm.md
acceptance-tests: docs/brainstorms/2026-06-04-cmux-integration-brainstorm-acceptance-tests.md
---

# feat: CmuxHost — cmux sidebar pills and notifications

---

## Summary

A `CmuxHost` adapter that bridges orch's existing `Host` lifecycle seam to cmux's sidebar status pills and desktop notifications. While a run is active inside cmux, four sidebar pills show the current workflow name, step (with incrementing counter), active runner, and mode. Notifications fire on interactive step starts, run completion, and run failure. Outside cmux — or when a config switch disables the integration — the adapter is a hard no-op: zero cmux CLI invocations, identical run behavior.

This plan covers **Phase 1 only** (AT-1 through AT-12). Phase 2 (AT-13 through AT-16: runner awaiting-input events) is research-gated; a separate plan will follow the hook-routing investigation described in the origin document.

---

## Problem Frame

When orch runs inside cmux it spawns claude/codex inside tmux panes, placing cmux two layers removed from the agents it normally auto-observes. The cmux sidebar shows nothing about the orch run, and cmux never fires a notification when a step finishes or an agent stalls on input. Operators supervising several parallel runs must visually poll each orch TUI pane to find state, completion, or blocked input — the exact cost cmux is designed to eliminate.

**Success criteria (Phase 1):**
- Operator can see at a glance which workflow / step / runner / mode is active without opening any TUI pane
- A run completing, failing, or starting an interactive step fires a desktop notification the operator can act on without polling
- Running orch outside cmux is provably zero-side-effect (confirmed by an AT that asserts zero ProcessService cmux invocations)

---

## Origin document coverage

All requirements from the origin brainstorm are addressed:

| R-ID | Description | Plan coverage |
|------|-------------|---------------|
| R1 | CmuxHost on the Host seam, composed via composite | U1, U4 |
| R2 | All cmux code in `src/hosts/cmux/` | U3 |
| R3 | cmux CLI exclusively via ProcessService | U3 |
| R4 | Four sidebar pills while run is active | U3 |
| R5 | Pills update in place; step + mode refresh on transition | U3 |
| R6 | All pills cleared at run end | U3, U4 |
| R7–R9 | Awaiting-input detection (Phase 2) | Deferred |
| R10 | Completion + failure notifications | U3, U4 |
| R11 | Interactive step start fires "needs you" notification | U3 |
| R12 | Notifications carry workflow / step identity | U3 |
| R13 | Run-end notifications via composition-root hook | U4 |
| R14 | CMUX_SURFACE_ID absent → hard no-op | U3 |
| R15 | cmux CLI failure swallowed; never propagates into step or run | U3 |
| R16 | Config switch disables integration even when env var set | U2, U3, U4 |

Acceptance examples AE1 and AE3–AE6 are covered in Phase 1 by AT-3, AT-3, AT-8, AT-10, and AT-12 respectively. AE2 (awaiting-input detection) is entirely deferred to Phase 2 and is covered by AT-13 through AT-16.

---

## Key Technical Decisions

### 1. Fan-out composite host, not a registry

A `createCompositeHost(primary: Host, secondary: Host): Host` utility fans the observability methods (`writeBanner`, `onRunnerEvent`, `onLifecycleEvent`, `onCommandLine`) to both hosts and delegates all other methods exclusively to the primary. The `mode` property mirrors the primary.

The registry (`HostRegistry`) maps `RunMode → HostFactory` and is intentionally not touched — cmux is not a mode. The composite is created explicitly in the composition root (see U4).

*(see origin: R1, "Composite host + CmuxHost, not a registry/event-bus")*

### 2. cmux CLI via ProcessService only

Every cmux operation is a `processService.spawn({ argv: ['cmux', ...], cwd, env })` call, consistent with CLAUDE.md rule #1. No direct socket, no `child_process` outside `src/services/process/`. All spawns are wrapped in `try/catch` that discards the error (R15).

### 3. Availability probe: `cmux ping`

At factory time, `createCmuxHost` checks two conditions in order:
1. `CMUX_SURFACE_ID` absent in env → return no-op host immediately (zero cmux calls, zero probe)
2. Config `cmux.enabled === false` → return no-op host immediately
3. `processService.spawn(['cmux', 'ping'])` exit ≠ 0 → return no-op host; run proceeds normally

If all three pass, the live `CmuxHost` is returned and the integration is active for the entire run. The probe runs exactly once; the no-op/live decision is never revisited mid-run.

This design satisfies AT-8 (no env var), AT-9 (ping fails), and AT-11 (config switch) through the same factory gate rather than per-call conditionals.

### 4. Config switch: `cmux.enabled` in OrchestratorConfig

The config switch is an optional nested object on `OrchestratorConfig`:
```
cmux?: { readonly enabled?: boolean }
```
Absence is equivalent to `enabled: true`. The Zod schema adds `cmux: z.object({ enabled: z.boolean().optional() }).optional()` following the existing `prompts` pattern.

An env var escape hatch (`ORCH_CMUX_DISABLED=1`) is out of scope for Phase 1 — the config field is sufficient and consistent with how other switches work in orch.

*(see origin: R16, AT-11 feasibility note)*

### 5. Static workspace-scoped pill keys

Pill keys are static strings scoped to the cmux workspace:
- `orch_workflow` — workflow name (e.g. `"lint-fix"`)
- `orch_step` — step name + counter (e.g. `"plan · 1"`)
- `orch_runner` — runner name (e.g. `"claude"`)
- `orch_mode` — mode label (`"auto"` or `"interactive"`)

Because cmux workspaces are typically one orch run per workspace (parallel runs occupy separate workspaces — that is cmux's model), static keys are correct for Phase 1. If two orch runs ever share one workspace, the pills would reflect the most recently started run — acceptable and consistent behavior. RunId-namespaced keys are a deferred enhancement.

### 6. Step counter without denominator

`step:start` does not carry a total step count (workflow steps are a dynamic function call sequence, not a static list). `CmuxHost` tracks an incrementing `stepIndex` counter and displays `"plan · 1"`, `"review · 2"` without a `/N` denominator.

The acceptance test AT-1 expectation ("position counter '1/3'") is updated in this plan to assert `"plan · 1"` (the counter only). The `/N` denominator requires a new `step:count` seam addition (e.g. a `workflow:start` lifecycle event carrying step count) — deferred.

### 7. `runnerName` on `step:start`

`step:start` is extended with `runnerName?: string` (optional) so `CmuxHost` can populate the runner pill correctly. The field is optional because `ask` and `command` steps emit `step:start` without a runner. Autonomous and interactive agent steps have `config.agent.name` available at emission time (confirmed in `src/core/step-lifecycle.ts`). This is a backward-compatible addition (existing host implementations ignore unknown fields; the type union is exhaustively discriminated on `type`). When `runnerName` is absent, `CmuxHost` emits an empty string for `orch_runner`.

### 8. Run-end hook via `beforeTeardown` in `ExecuteWithAttachOpts`

`run-ended` is not delivered to the Host seam (it is appended to `lifecycle.ndjson` only). Run-end notifications (R10, R13, AT-4 through AT-7) require a composition-root hook.

The hook is an optional `beforeTeardown?: (exitCode: number) => Promise<void>` field on `ExecuteWithAttachOpts`. It is called (with error-swallowing) immediately before each `opts.host.teardown()` call — at all five call sites in `executeWithAttach` (success, `resolveCaughtError`, quit, unreachable-attach, and signal handlers). Signal-handler sites fire it without `await` (fire-and-forget). The caller passes `(code) => cmuxHost.notifyRunEnd(code)`. `CmuxHost` internally tracks the last `step:failed` event to derive the failing step name for the failure notification payload.

This avoids touching the `Host` interface and keeps the notification logic inside `CmuxHost` rather than scattered at the call site.

---

## Output structure

```
src/hosts/
  composite/
    index.ts          (barrel)
    composite-host.ts (createCompositeHost implementation)
  cmux/
    index.ts          (barrel)
    cmux-host.ts      (createCmuxHost, CmuxHostOptions, live + no-op implementations)

tests/unit/hosts/
  composite/
    composite-host.test.ts
  cmux/
    cmux-host.test.ts (unit tests: probe, pill update, error swallowing)

tests/integration/hosts/cmux/
  cmux-host.test.ts   (AT-1 through AT-12: full runWorkflow + executeWithAttach path)
```

Existing files touched: `src/core/step-lifecycle.ts` (runnerName on step:start), `src/config/index.ts`, `src/cli/commands/execute-with-attach.ts`, `src/cli/commands/run.ts`, `src/hosts/index.ts`.

---

## Implementation units

### U1. Fan-out composite host

**Goal:** Create a reusable `createCompositeHost(primary, secondary)` that fans observability signals to both hosts while delegating interface methods exclusively to the primary.

**Requirements:** R1 (composition model)

**Dependencies:** none

**Files:**
- `src/hosts/composite/composite-host.ts` ← create
- `src/hosts/composite/index.ts` ← create
- `tests/unit/hosts/composite/composite-host.test.ts` ← create

**Approach:**
- `createCompositeHost(primary: Host, secondary: Host): Host` returns a plain object
- `mode`: mirror `primary.mode`
- Fan to both: `writeBanner`, `onRunnerEvent`, `onLifecycleEvent`, `onCommandLine`
- Delegate to primary only: `attach`, `runInteractive`, `attachForeground`, `awaitForegroundShutdown`, `probeReachability`, `teardown`
- Secondary's errors in fanned methods must NOT propagate — wrap each secondary call in `try/catch(() => {})`. The secondary (CmuxHost) self-swallows its own errors per R15, but the composite adds a second layer of isolation so a secondary implementation bug never surfaces as a primary host error.
- The composite is ~20 lines; no file size concern.

**Patterns to follow:** `PlainHost`'s delegation style in `src/hosts/plain/plain-host.ts`

**Test scenarios:**
- Fan: `onLifecycleEvent` fires on both primary and secondary
- Fan: `onRunnerEvent` fires on both primary and secondary
- Delegate: `teardown` resolves from primary only; secondary's method is not called
- Isolation: secondary `onLifecycleEvent` throwing does not propagate out of the composite
- mode: composite reports `primary.mode`

**Verification:** `bun run check` green; composite unit tests pass

---

### U2. Core seam additions

**Goal:** Three small targeted additions to thread runner identity, the config switch, and the run-end hook through existing seams.

**Requirements:** R4 (four sidebar pills — runnerName seam addition), R16 (config switch), R13 (run-end hook)

**Dependencies:** none

**Files:**
- `src/core/workflow.ts` ← modify (add `runnerName: string` to `step:start`)
- `src/config/index.ts` ← modify (add `cmux?` to schema + interface)
- `src/cli/commands/execute-with-attach.ts` ← modify (add `beforeTeardown?` to opts + call it)

**Approach:**

**2a. `step:start` runnerName.** Add `readonly runnerName?: string` (optional) to the `step:start` variant of `StepLifecycleEvent` (line 168 area). The field is optional because `ask` and `command` steps emit `step:start` without a runner. The actual emission point is `src/core/step-lifecycle.ts`, not `workflow.ts` — search there for `type: 'step:start'` to find the callers. Autonomous and interactive agent steps pass `runnerName: config.agent.name`; ask/command steps omit the field. Existing host implementations (`PlainHost`, `TmuxHost`) access lifecycle events via `event.type` discrimination; TypeScript will catch any exhaustiveness gap.

**2b. OrchestratorConfig cmux switch.** Add:
```
// interface
readonly cmux?: { readonly enabled?: boolean }
// Zod schema
cmux: z.object({ enabled: z.boolean().optional() }).optional()
```
No change to `defineConfig` (it's an identity function). Config without the `cmux` field continues to load and validate as before.

**2c. `beforeTeardown` hook.** In `ExecuteWithAttachOpts`:
```
readonly beforeTeardown?: (exitCode: number) => Promise<void>
```
In `executeWithAttach`, call this hook before every `host.teardown()` — all five call sites: success path (~line 223), `resolveCaughtError` (~line 239), quit branch (~line 169), unreachable-attach branch (~line 191), and signal handlers (~lines 114-117). The first four are `await`-able contexts:
```
await opts.beforeTeardown?.(exitCode).catch(() => {})
```
The signal handlers are fire-and-forget (the callback registered for `SIGTERM`/`SIGINT` cannot be `async`). At those sites, use:
```
void opts.beforeTeardown?.(exitCode).catch(() => {})
```
This means pill-clear may not complete before the process exits on hard signals — an accepted limitation documented in the Risks table. The `.catch(() => {})` ensures a failing cmux notification never blocks teardown. The `exitCode` known at each call site is passed directly.

**Test scenarios:**
- `step:start` from an agent step carries `runnerName`; `step:start` from an ask/command step emits with `runnerName` absent; existing `PlainHost` test still passes after type update
- `OrchestratorConfig` with and without `cmux` field parses via `ConfigSchema.safeParse`
- `executeWithAttach` calls `beforeTeardown` with exit code 0 on success; calls it with a non-zero code when the workflow rejects; calls it (fire-and-forget) on the signal handler path
- `beforeTeardown` throwing does not prevent teardown from being called

**Verification:** TypeScript strict mode clean after additions; all existing tests green

---

### U3. CmuxHost implementation

**Goal:** The full `CmuxHost` — availability probe, pill lifecycle, notification dispatch, error swallowing — behind a factory that returns either a live host or a zero-op no-op.

**Requirements:** R2, R3, R4, R5, R6, R10, R11, R12, R14, R15

**Dependencies:** U1 (composite pattern used for structural reference), U2 (runnerName on step:start, config switch shape)

**Files:**
- `src/hosts/cmux/cmux-host.ts` ← create
- `src/hosts/cmux/index.ts` ← create
- `tests/unit/hosts/cmux/cmux-host.test.ts` ← create

**Approach:**

`CmuxHostOptions`:
```
interface CmuxHostOptions {
  readonly processService: ProcessService
  readonly clock: Clock
  readonly workflowName: string
  readonly cmuxConfig?: { readonly enabled?: boolean }  // from OrchestratorConfig.cmux
  readonly env?: Readonly<Record<string, string>>       // process.env slice for CMUX_SURFACE_ID check
  readonly cwd: Path
}
```

`createCmuxHost(opts: CmuxHostOptions): Promise<Host & { notifyRunEnd(exitCode: number): Promise<void> }>`:
1. If `opts.env?.CMUX_SURFACE_ID` is absent → return no-op host (zero cmux calls)
2. If `opts.cmuxConfig?.enabled === false` → return no-op host
3. Spawn `cmux ping` via `processService.spawn`. If exit ≠ 0 → return no-op host
4. Return the live `CmuxHost` instance

**No-op host:** satisfies the full `Host` interface with sync no-ops for all methods, and also provides a no-op `notifyRunEnd(exitCode)` that resolves immediately (satisfying the extended return type on all branches). Reuse the composite-host pattern (or a standalone object literal). `mode` matches the primary host's mode — but since the no-op host is only ever used as the secondary in the composite, `mode` can be a fixed `'plain'` sentinel.

**Live CmuxHost internal state:**
- `stepIndex: number` — increments on each `step:start`
- `lastFailedStep: StepName | undefined` — set on `step:failed`
- `runStartMs: number` — recorded at first `step:start` (from `opts.clock.now()`)

**`onLifecycleEvent` dispatch (live host):**

| event type | cmux CLI action |
|------------|-----------------|
| `step:start` | `cmux set-status orch_workflow <workflowName>` <br> `cmux set-status orch_step "<stepName> · <stepIndex>"` <br> `cmux set-status orch_runner <runnerName ?? "">` (empty string when runnerName absent — ask/command steps) <br> `cmux set-status orch_mode <modeLabel>` where `modeLabel = event.mode === 'autonomous' ? 'auto' : 'interactive'` <br> If `event.mode === 'interactive'`: `cmux notify --title "orch · <workflowName>" --body "⏸ step '<stepName>' needs you"` |
| `step:failed` | Record `lastFailedStep = event.stepName` (no cmux call; notification fires at run-end) |
| all others | no-op |

**`notifyRunEnd(exitCode: number)` method (called via `beforeTeardown`):**

| exitCode | cmux actions |
|----------|-------------|
| `EXIT.OK` | `cmux notify --title "orch · <workflowName>" --body "✅ completed in <duration>"` <br> then four `cmux clear-status` calls |
| anything else | `cmux notify --title "orch · <workflowName>" --body "❌ failed at step '<lastFailedStep>'"` (or `"❌ run failed"` if no step name) <br> then four `cmux clear-status` calls |

Duration format: `<M>m<S>s` (e.g. `"4m12s"`); derived from `clock.now() - runStartMs`.

**Error swallowing:** every `processService.spawn({ argv: ['cmux', ...] })` call is wrapped:
```ts
try {
  const handle = processService.spawn({ argv: ['cmux', ...], cwd: opts.cwd, env: {} })
  // drain stdout/stderr (empty loop) to avoid backpressure
  await handle.wait()
} catch {
  // swallowed per R15
}
```

**Remaining Host methods on live host:** `writeBanner`, `onRunnerEvent`, `onCommandLine`, `attach`, `runInteractive`, `attachForeground`, `awaitForegroundShutdown`, `probeReachability`, `teardown` are all no-ops or immediate resolves. `teardown` does NOT fire run-end notification (that goes through `beforeTeardown`/`notifyRunEnd`).

**Patterns to follow:** `PlainHost` no-op variants for interface methods; `FakeProcessService.when(argv).respondWith(...)` pattern for tests.

**Test scenarios (unit, against CmuxHost directly with FakeProcessService):**

*Probe / availability:*
- CMUX_SURFACE_ID absent → `createCmuxHost` returns no-op; zero ProcessService calls
- CMUX_SURFACE_ID set + ping exits 1 → no-op; zero further cmux calls
- CMUX_SURFACE_ID set + ping exits 0 → live host returned
- cmux.enabled = false + CMUX_SURFACE_ID set → no-op; zero cmux calls (checked before probe)

*Pill lifecycle:*
- first `step:start` event → four `cmux set-status` calls with correct keys and values
- second `step:start` event → `orch_step` and `orch_mode` values updated; `orch_workflow` and `orch_runner` values also re-set (idempotent; cmux upserts by key); total call count is 4 more (8 total across two steps)
- pill key for `orch_step` on second step matches key from first step (not a new key)

*Notifications:*
- `step:start` with `mode: 'interactive'` → `cmux notify` call appears after the four set-status calls
- `step:start` with `mode: 'autonomous'` → no `cmux notify` call

*Error swallowing:*
- `processService` returning exit 1 on a `cmux set-status` call → `onLifecycleEvent` does not throw; host method returns normally

**Verification:** unit tests pass; `bun run check` green

---

### U4. Composition root wiring

**Goal:** Wire `CmuxHost` into `runCmd` (and `resumeCmd`) so the composite host reaches `executeWithAttach` and the run-end notification fires correctly.

**Requirements:** R1 (composition model), R13 (run-end hook from composition root)

**Dependencies:** U1, U2, U3

**Files:**
- `src/cli/commands/run.ts` ← modify
- `src/cli/commands/resume.ts` ← modify (if it calls `executeWithAttach` separately)
- `src/cli/main.ts` ← minimal (if helpers live there)

**Approach:**

In `runCmd` (and analogously in `resumeCmd`), after the primary host is created:

```
// 1. Create primary host from registry as before
const primaryHost = await registry.resolve(mode)(inputs)

// 2. Create CmuxHost (probe happens here; may return no-op)
const cmuxHost = await createCmuxHost({
  processService: deps.processService,
  clock: inputs.clock,
  workflowName: inputs.workflowName,
  cmuxConfig: orchestratorConfig.cmux,
  env: process.env,
  cwd: inputs.cwd,      // or config dir — wherever cmux CLI would be found
})

// 3. Compose
const host = createCompositeHost(primaryHost, cmuxHost)

// 4. Pass beforeTeardown to executeWithAttach
await executeWithAttach({
  host,
  workflow: ...,
  beforeTeardown: (exitCode) => cmuxHost.notifyRunEnd(exitCode),
  ...rest,
})
```

The `notifyRunEnd` method is part of the extended type `Host & { notifyRunEnd(exitCode: number): Promise<void> }` returned by `createCmuxHost` — both the live and no-op branches return this shape. The composite's `Host` interface is what flows into `executeWithAttach`; `cmuxHost` is held as a separate reference for the `beforeTeardown` callback.

`CmuxHostOptions.cwd` should be the `configDir` (where orch was invoked from) — the cmux binary is on `PATH` so `cwd` is only needed for `processService.spawn`'s API contract.

**Patterns to follow:** how `createTmuxHost` is called in `registerBuiltinHosts` (same per-invocation inputs pattern).

**Test scenarios:**
- These are covered by the AT integration tests in U6; no separate unit tests needed for the wiring itself.

**Verification:** `bun run check` green; AT-4 through AT-7 integration tests pass (run-end notifications fire)

---

### U5. Barrel exports

**Goal:** Export composite host and CmuxHost types from `src/hosts/index.ts` so cross-module imports use the single public barrel.

**Requirements:** R2 (single-public-barrel convention per CLAUDE.md rule #7)

**Dependencies:** U1, U3

**Files:**
- `src/hosts/index.ts` ← modify
- `src/hosts/composite/index.ts` ← create (re-export from composite-host.ts)
- `src/hosts/cmux/index.ts` ← create (re-export from cmux-host.ts)

**Approach:**
Add to `src/hosts/index.ts`:
```ts
export type { CmuxHostOptions, CmuxHost } from './cmux/index.ts'
export { createCmuxHost } from './cmux/index.ts'
export { createCompositeHost } from './composite/index.ts'
```

`CmuxHost` is the named alias for `Host & { notifyRunEnd(exitCode: number): Promise<void> }`, defined in `cmux-host.ts` and re-exported through the barrel. The `Host` interface itself is not extended — `notifyRunEnd` lives only on the concrete type.

**Test scenarios:** `Test expectation: none — pure barrel re-export, no behavioral change`

**Verification:** TypeScript resolves `import { createCmuxHost, createCompositeHost } from 'src/hosts/index.ts'` without errors

---

### U6. Phase 1 acceptance tests (AT-1 to AT-12)

**Goal:** Implement all twelve Phase 1 behavioral acceptance tests, exercising the full composition path (`runWorkflow()` + composite host + CmuxHost + FakeProcessService).

**Requirements:** All AT-1 through AT-12 (see `docs/brainstorms/2026-06-04-cmux-integration-brainstorm-acceptance-tests.md`)

**Dependencies:** U1, U2, U3, U4

**Files:**
- `tests/integration/hosts/cmux/cmux-host.test.ts` ← create

**Prerequisite — `FakeProcessService` call history.** The AT tests assert on which `cmux` argv sequences were spawned (e.g. "exactly one `cmux notify` call"). `FakeProcessService` currently has only `#queues` Maps with scripted responses; it has no call-history recording or assertion API. Before writing the AT tests, extend `FakeProcessService` with:
- A `calls: readonly { argv: readonly string[] }[]` property that accumulates every `spawn()` call in order
- A helper (e.g. `cmuxCalls()` → `this.calls.filter(c => c.argv[0] === 'cmux')`) for test clarity
- `assertAllConsumed()` that throws if any scripted response was never triggered

This extension lives in `tests/_support/fake-process-service.ts` (or wherever `FakeProcessService` is currently defined) and is a prerequisite to implementing the AT scenarios.

**Execution note:** These are mocked-integration tests. They must drive the actual composition path (using the real `createCmuxHost`, `createCompositeHost`, real `runWorkflow`, and `FakeRunner` + `FakeProcessService`), not call `cmuxHost.onLifecycleEvent()` directly. AT-4 through AT-7 must drive `executeWithAttach` (not bare `runWorkflow()`) to exercise the `beforeTeardown` hook.

**Approach:**

Test helper `buildCmuxTestHarness({ stepCount, steps, cmuxConfig? })`:
- Creates `FakeProcessService`, `FakeRunner`, `FakeClock`
- Creates the `CmuxHost` (with `CMUX_SURFACE_ID` set in env)
- Creates `createCompositeHost(createPlainHost(...), cmuxHost)`
- Scripted `FakeProcessService` responses for `cmux ping` (exit 0) and each expected cmux invocation
- Returns `{ run(), processService, cmuxHost }`

**Test scenarios (one test per AT-ID):**

*AT-1 — First step sets all four pills:*
- Arrange: three-step workflow, FakeRunner scripted for all steps, FakeProcessService scripts `cmux ping` (exit 0) and four `cmux set-status` calls
- Act: run the workflow through `executeWithAttach`
- Assert: FakeProcessService call history contains `cmux set-status orch_workflow "wf"`, `cmux set-status orch_step "plan · 1"`, `cmux set-status orch_runner "claude"`, `cmux set-status orch_mode "auto"` before the first `step:complete` lifecycle event fires (or before step 2 starts); all four calls appear in the history

*AT-2 — Step transition refreshes pills in place, no accumulation:*
- Arrange: two-step workflow (step 1 autonomous, step 2 interactive)
- Act: run to completion
- Assert: `orch_step` key appears in both the step 1 and step 2 `set-status` calls with the SAME key; `set-status` for `orch_step` on step 2 carries value `"review · 2"`; total set-status call count equals 4 (step 1) + 4 (step 2) = 8 (plus optional interactive notify)

*AT-3 — Interactive step fires "needs you" notification, autonomous does not:*
- Arrange: workflow with one autonomous step followed by one interactive step
- Act: run to completion
- Assert: exactly one `cmux notify` call appears before the interactive step completes; no `cmux notify` call appears for the autonomous step

*AT-4 — Successful run fires completion notification with duration:*
- Arrange: single-step workflow; FakeProcessService scripts `cmux ping`, four set-status, one `cmux notify` (completion), four `cmux clear-status`
- Act: drive via `executeWithAttach`
- Assert: `cmux notify` with title `"orch · <wf>"` and body containing `"✅"` + duration string; notify appears after workflow settles and before `teardown` completes (verified by call ordering in processService history)

*AT-5 — Failed run fires failure notification with step name:*
- Arrange: FakeRunner configured to exit non-zero on step "build"; processService scripts failure notify and four clear-status
- Act: drive via `executeWithAttach`
- Assert: `cmux notify` body contains `"❌"` and `"build"`

*AT-6 — Pills cleared on successful run end:*
- Arrange: same as AT-4
- Assert: all four `cmux clear-status` calls appear after `cmux notify`; `orch_workflow`, `orch_step`, `orch_runner`, `orch_mode` each cleared exactly once

*AT-7 — Pills cleared on failed run end:*
- Same structure as AT-6 but with failure workflow (same as AT-5)
- Assert: four `cmux clear-status` calls appear after the failure notify

*AT-8 — CMUX_SURFACE_ID absent → zero cmux invocations:*
- Arrange: CmuxHost created with no `CMUX_SURFACE_ID` in env; FakeProcessService has NO scripted responses for cmux argv (any call would throw)
- Act: run a workflow to completion
- Assert: processService receives zero calls where `argv[0] === 'cmux'`; run completes with expected outcome (EXIT.OK)

*AT-9 — cmux unavailable (ping fails) → zero subsequent cmux calls:*
- Arrange: `CMUX_SURFACE_ID` set; FakeProcessService scripts `cmux ping` with exit 1; no other cmux responses scripted
- Act: run to completion
- Assert: exactly one cmux call (the ping); no further `cmux set-status` or `cmux notify` calls; run completes normally

*AT-10 — cmux CLI failure mid-run is swallowed:*
- Arrange: FakeProcessService scripts ping (exit 0), then scripts one `cmux set-status` call with exit 1, then scripts remaining calls normally
- Act: run to completion
- Assert: run completes with same exit code as a zero-failure baseline run; no exception escapes from the host into the workflow

*AT-11 — Config switch disables integration:*
- Arrange: `CMUX_SURFACE_ID` set + `cmuxConfig.enabled = false`; FakeProcessService has no scripted cmux responses
- Act: run to completion
- Assert: zero cmux argv calls (including no ping); run completes normally

*AT-12 — Notification identifies the specific workflow:*
- Arrange: two separate `executeWithAttach` / `runWorkflow` calls, workflow names `"lint-fix"` and `"code-review"`, each with their own `FakeProcessService`
- Act: both runs to completion
- Assert: notify call on first processService contains `"lint-fix"` but not `"code-review"`; second processService's notify contains `"code-review"` but not `"lint-fix"`

**Patterns to follow:**
- `tests/integration/hosts/plain-mode.test.ts` for full runWorkflow + host integration pattern
- `tests/integration/cli/run-builtin.test.ts` for executeWithAttach driving pattern
- `FakeRunner.script(...)` + `FakeProcessService.when([...]).respondWith(...)` as the edge mocks
- Call `fps.assertAllConsumed()` in `afterEach` to catch over-scripted responses

**Verification:** All twelve AT tests green; `bun run check` green; update AT status table in `docs/brainstorms/2026-06-04-cmux-integration-brainstorm-acceptance-tests.md` to mark AT-1 through AT-12 as `✅ implemented`

---

## Scope boundaries

### Deferred to Follow-Up Work (implementation sequencing)

- **`runnerName` update to existing PlainHost/TmuxHost tests** — TypeScript will surface any compile errors from adding `runnerName` to `step:start`; downstream test fixes are mechanics, not new decisions.
- **Icon and color choices** for `cmux set-status` calls — left to the implementer; the plan pins keys and value format only.

### Deferred for Later (separate plan or Phase 2)

- **Phase 2 (AT-13 to AT-16)** — Awaiting-input detection via Claude/Codex runner hooks. Research-gated on understanding how cmux's own claude wrapper routes hooks back through the tmux wrapping layer. A separate plan will follow.
- **`/N` step denominator** — Requires a `workflow:start` lifecycle event carrying total step count. Deferred to a separate seam addition.
- **`ORCH_CMUX_DISABLED` env var escape hatch** — Not needed for Phase 1; the config switch is sufficient.

### Outside this product's identity

- **Progress bar** (`cmux set-progress`) — Excluded per origin brainstorm; TUI already shows progress.
- **Sidebar log trail** (`cmux log`) — Excluded; TUI already shows step log.
- **Generalized observer / plugin registry** — Deferred; composite-host start makes this a cheap future refactor.
- **Persistent Unix-socket transport** — Deferred; CLI-via-ProcessService is v1.

---

## System-wide impact

| Area | Change | Risk |
|------|--------|------|
| `src/core/step-lifecycle.ts` | `step:start` gains optional `runnerName?: string` | Low — optional field; agent steps populate it, ask/command steps omit it; TypeScript catches any consumer gap |
| `src/config/index.ts` | Optional `cmux?` field on config | Low — optional; existing configs unchanged |
| `src/cli/commands/execute-with-attach.ts` | Optional `beforeTeardown?` hook | Low — optional, error-swallowed, path-tested |
| `src/cli/commands/run.ts`, `resume.ts` | Composite host construction | Low — wrapped host; all non-cmux behavior unchanged |
| Tests for `PlainHost`, `TmuxHost` | Must supply `runnerName` on scripted `step:start` events | Low — TypeScript will flag missing fields |

---

## Risks

| Risk | Mitigation |
|------|-----------|
| `cmux ping` succeeds but `cmux set-status` silently fails | R15 + AT-10: cmux failures are swallowed; the test confirms the run outcome is unaffected |
| Run-end notification fires before workflow actually settles (race) | `beforeTeardown` is called from `executeWithAttach` AFTER `await trackedWorkflow` completes, not before |
| Two parallel orch runs in the same workspace clobber each other's pills | Acknowledged Phase 1 limitation; static keys are sufficient for the one-run-per-workspace model cmux is designed for |
| Phase 2 hook routing more complex than expected | Phase 2 is explicitly research-gated and excluded from this plan; no code is pre-written for it |
| Pills not cleared on SIGTERM/SIGINT | Signal handlers are fire-and-forget; `beforeTeardown` is called but cannot be awaited; pill-clear is best-effort. Accepted limitation for Phase 1 |

---

## Deferred implementation notes

- Exact `--icon` and `--color` values for each pill — to be chosen at implementation time from available cmux icon names
- Exact notification body string formatting (locale of duration, emoji choices) — implementation detail
- Whether `cwd` for ProcessService cmux spawns should be `configDir` or `process.cwd()` — both work since cmux is on PATH; choose whichever is easier to thread through the options
- Whether `resumeCmd` needs its own cmux wiring or shares a helper with `runCmd` — look at how resume currently calls `executeWithAttach`
