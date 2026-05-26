---
date: 2026-05-26
type: refactor
status: landed
title: "refactor: Extract LifecycleChoreographer from the tmux host"
origin: docs/issues/2026-05-26-arch-lifecycle-router-in-tmux-host.md
depth: deep
---

# refactor: Extract `LifecycleChoreographer` from the tmux host

## Summary

`tmux-host.ts` (1532 lines, the largest file in the repo) holds its right-pane
lifecycle orchestration inline: `onLifecycleEvent` (`:813-956`) is a 143-line
handler that translates each `StepLifecycleEvent` into an ordered choreography of
per-step tee writes, right-pane-controller source register/unregister, failure
banners, and parallel-rollup state. The ordering rules ("unregister BEFORE
close", "summary BEFORE freeze", sequential unregister→error-banner) live only as
comments, and the whole thing is reachable only by standing up a live tmux
session — there is no seam to feed it events and assert the resulting calls.

Extract a **`LifecycleChoreographer`**: a deep module with a two-method
interface (`handle(event)`, `quiescent()`) that owns the choreography behind a
FIFO serialization queue. The host's `onLifecycleEvent` collapses to
`void choreographer.handle(event)`. The collaborators it drives are already clean
interfaces (`RightPaneController`, `PerStepTee`, `RollupAggregator`), so the
module becomes unit-testable with recording fakes — no tmux.

This is a **behaviour-preserving refactor with two deliberate improvements**:
(1) cross-event ordering becomes strict FIFO instead of best-effort interleave;
(2) a latent bug is fixed — today `step:failed` closes the tee synchronously
(`:913`) while the unregister IIFE (`:897`) is still in flight, so close can beat
the unregister the comment says must happen first.

---

## Problem Frame

The lifecycle orchestration is the densest behaviour in the repo's biggest file,
and it has never been independently tested — the tell is that **no
`FakeRightPaneController` exists anywhere in the codebase**. Every assertion
about right-pane lifecycle today rides through a real-tmux Tier-1 test, which is
slow, coarse, and cannot pin the per-event call ordering that the comments insist
on. The ordering invariants are the actual payload of this code, and they have no
home and no tests.

---

## Goals

- A `LifecycleChoreographer` module: `handle(event): Promise<void>` +
  `quiescent(): Promise<void>`, FIFO-serialized, never-rejecting.
- The choreographer owns the ordering invariants and the `rollup` aggregator.
- Host `onLifecycleEvent` shrinks to a one-line forward; `tmux-host.ts` drops
  ~140 lines.
- A unit test file that exercises every event type and the cross-event ordering
  through recording fakes — no real tmux.

## Non-Goals

- **No broad "right-pane orchestrator."** `onRunnerEvent` / `onCommandLine` keep
  writing the tee on the host. The tee stays a shared collaborator injected into
  both. (Grilled and rejected — bigger interface, bigger risk, no commensurate
  win.)
- No change to `RightPaneController`, `PerStepTee`, `RollupAggregator`, or the
  `Host` interface.
- No change to the `plain` host.
- No change to observable end-of-run output beyond the ordering fix above.

---

## Key Technical Decisions

### KTD1. Narrow scope — lifecycle translation only

The module owns the `StepLifecycleEvent → side-effect` mapping. It does not
absorb runner-event or command-line tee writes. Cohesion is "everything that
reacts to a lifecycle event", not "everything that touches the tee."

### KTD2. Awaitable `handle()` over a FIFO serialization queue

The host fires lifecycle events without awaiting (`Host.onLifecycleEvent` is
`void` by contract). The choreographer chains each call on an internal tail
promise so each event's effects fully settle before the next begins:

```ts
let tail: Promise<void> = Promise.resolve()
function handle(event: StepLifecycleEvent): Promise<void> {
  tail = tail.then(() => process(event).catch(deps.onSendError))
  return tail
}
function quiescent(): Promise<void> {
  return tail
}
```

This makes every "BEFORE" comment a tested invariant that holds **across** events,
not just within one. Strict FIFO is a deliberate behavioural change from today's
interleave — safe because lifecycle events are infrequent and only drive
right-pane rendering; the executor never awaits `onLifecycleEvent`, so a slow
queue never stalls workflow execution.

### KTD3. The chain must never poison

If a `process(event)` rejected and we chained it raw, the rejected `tail` would
silently skip every later event. Each link swallows into `onSendError`
(`= handleSendError`, which already no-ops after teardown and writes to stderr).
`process` therefore never rejects out of the chain.

### KTD4. `torndown` stays host-owned, read through a thunk

`onRunnerEvent` / `onCommandLine` / teardown all touch `torndown`; only one spot
in the lifecycle handler reads it (`:880`, to skip the failure-summary write
during teardown). Inject `isTorndown: () => boolean`. No ownership migration.

### KTD5. `rollup` becomes choreographer-private; `controller` is injected optional

`createRollupAggregator()` moves inside the module — it has no other consumer.
`controller` is injected as `RightPaneController | undefined`; tee effects run
regardless of controller presence, so the existing `?.` guards move into the
module unchanged (steps-view-disabled / no-stateStore fixtures pass `undefined`).

### KTD6. teardown awaits `quiescent()` before draining the tee

`teardown()` currently sets `torndown = true` then `deps.tee.drain()`. With the
queue, pending `handle()` work may still hold the tee open; teardown must
`await choreographer.quiescent()` before `tee.drain()` so no close/write races
the drain.

---

## High-Level Technical Design

```
                 executor emits StepLifecycleEvent
                              │
                  Host.onLifecycleEvent (void)
                              │  void choreographer.handle(event)
                              ▼
        ┌─────────────────────────────────────────────┐
        │  LifecycleChoreographer   (deep module)       │
        │  handle(event): Promise<void>  ── FIFO queue  │
        │  quiescent(): Promise<void>                   │
        │                                               │
        │  owns: rollup aggregator + ordering rules     │
        └───────────────┬───────────┬───────────┬───────┘
                        │           │           │
                  PerStepTee  RightPaneController  (RollupAggregator: private)
                 (injected,   (injected,
                  shared)      optional)
```

Test seam: inject a recording `RightPaneController` + recording `PerStepTee` +
fake `Clock`; assert the ordered call sequence per event and across events.

---

## Implementation Units

### U1. `LifecycleChoreographer` module + unit tests (TDD, tests first)

**New file:** `src/hosts/two-pane/lifecycle-choreographer.ts`

```ts
export interface LifecycleChoreographerDeps {
  readonly controller: RightPaneController | undefined
  readonly tee: PerStepTee
  readonly logger: SessionLogger | undefined
  readonly runId: RunId
  readonly clock: Clock
  readonly isTorndown: () => boolean
  readonly onSendError: (err: unknown) => void
}

export interface LifecycleChoreographer {
  handle(event: StepLifecycleEvent): Promise<void>
  quiescent(): Promise<void>
}

export function createLifecycleChoreographer(
  deps: LifecycleChoreographerDeps,
): LifecycleChoreographer
```

Move the bodies of the seven `event.type` branches verbatim from
`tmux-host.ts:813-956` into a private `process(event)`, replacing the
fire-and-forget `void controller?.x().catch(handleSendError)` calls with
`await`ed calls inside `process` (the queue provides the ordering;
`process` awaits each step in sequence). `teePathFor`, `summarizeFailure`,
`renderFailurePanePayload`, `renderRollupPayload`, `ROLLUP_STEP_NAME` move or are
imported. `rollup` is created internally.

**New test:** `tests/unit/hosts/two-pane/lifecycle-choreographer.test.ts`
(written first). Recording `RightPaneController` fake (push `[method, args]`),
recording `PerStepTee` fake, fake `Clock`. Each test name a full sentence; AAA
with blank-line separators. Assert:

- `step:start` autonomous: `tee.open → tee.write(marker) → registerSource(live, file-tail)`
- `step:start` autonomous, no logsDir: `emitBanner(info, "no transcript captured")`, no source
- `step:start` non-autonomous: no effects
- `step:cached`: `emitBanner(info, "cached")`
- `step:complete`: `unregisterSource(live)` strictly before `tee.close`
- `step:failed`: `tee.write(summary)` → `unregisterSource(live, {suppressCompletionBanner:true})` → `emitBanner(error)` → `tee.close`
- `step:failed` with `isTorndown()===true`: summary write skipped
- `step:parallel-start`: `tee.open(_rollup) → registerSource(rollup, file-tail)`
- `step:parallel-branch-update`: rollup aggregation across ≥2 updates → `tee.write(_rollup, snapshot)`
- `step:parallel-complete`: `unregisterSource(rollup) → tee.close(_rollup) → rollup.reset`
- **cross-event FIFO**: fire `handle(complete A)` then `handle(start B)` without awaiting; await `quiescent()`; assert A's full effect sequence precedes B's
- **chain not poisoned**: a fake controller that rejects on one event still processes the next; `onSendError` saw the rejection
- **controller `undefined`**: tee effects happen, nothing throws

### U2. Host wiring + teardown ordering

In `buildHost` (`tmux-host.ts`):

- Construct the choreographer after `tee`/`controller`/`rollup` are available:
  ```ts
  const choreographer = createLifecycleChoreographer({
    controller, tee: deps.tee, logger: deps.logger, runId: deps.runId,
    clock: deps.clock, isTorndown: () => torndown, onSendError: handleSendError,
  })
  ```
- Replace `onLifecycleEvent`'s body (`:813-956`) with
  `const onLifecycleEvent = (event: StepLifecycleEvent): void => { void choreographer.handle(event) }`.
- Delete the now-unused module-local `rollup` (`:759`) — it lives in the
  choreographer.
- In `teardown()`: `await choreographer.quiescent()` before `await deps.tee.drain()`.
- Keep `handleSendError`, `torndown`, `onRunnerEvent`, `onCommandLine` as-is.

### U3. Barrel, glossary, and doc drift

- Export `createLifecycleChoreographer` + types from the two-pane barrel if the
  module is consumed across the module boundary (it is host-internal; export only
  if a test imports it cross-barrel — prefer a direct path import from the test).
- `CONTEXT.md` already carries the **lifecycle choreographer** entry (added with
  this plan).
- Update any comment in `tmux-host.ts` that referenced the inline handler.

---

## System-Wide Impact

- **`tmux-host.ts`**: −~140 lines; `onLifecycleEvent` becomes one line; `rollup`
  binding removed; `teardown` gains one `await`.
- **No interface changes** to `Host`, `RightPaneController`, `PerStepTee`,
  `RollupAggregator`, or any runner.
- **New test artifact**: a recording `FakeRightPaneController` (first in the repo)
  — reusable by future right-pane tests.
- **Behavioural delta**: strict FIFO cross-event ordering; `step:failed`
  close-after-unregister fixed. Both are improvements; the real-tmux Tier-1 tests
  must still pass.

---

## Risk Analysis & Mitigation

| Risk | Likelihood | Mitigation |
| --- | --- | --- |
| Chain poisoning skips events after one rejection | Medium if forgotten | KTD3 — each link `.catch(onSendError)`; explicit test |
| teardown drains tee mid-write | Medium | KTD6 — `await quiescent()` before `drain()`; teardown test |
| Strict FIFO changes visible ordering subtly | Low | Lifecycle events infrequent; executor never awaits; Tier-1 real-tmux regression |
| `step:failed` close-after-unregister changes replay bytes | Low | Summary is written before unregister regardless; test asserts write-before-unregister |
| Hidden coupling to `torndown` timing | Low | Thunk reads live value at process time, same as inline read |

---

## Verification

- New unit test green: `bun test tests/unit/hosts/two-pane/lifecycle-choreographer.test.ts`
- Existing real-tmux Tier-1 host tests green (regression): the two-pane lifecycle
  tests that drive `onLifecycleEvent` through a live session.
- `bun run check` green (lint + typecheck + unit + mocked-integration).
- File-size check: `tmux-host.ts` back under or nearer the 300-line guidance is
  not expected (it stays large), but the lifecycle concern is gone from it; the
  new module is ≤ ~200 lines.

---

## Scope Boundaries

**In scope:** the extraction, the FIFO queue, the teardown `quiescent()` await,
the failure-close ordering fix, the unit test + recording fake, the glossary
entry.

**Deferred:** broad right-pane orchestrator (tee writes for runner/command
events); any `RightPaneController` reshaping; the other four architecture issues
in `docs/issues/2026-05-26-arch-*`.

---

## landed 2026-05-26

Extracted `src/hosts/two-pane/lifecycle-choreographer.ts` (FIFO queue + the seven
`process(event)` branches, the `_rollup` meta key, and the now-private rollup
aggregator). `tmux-host.ts`'s `onLifecycleEvent` collapsed to
`void choreographer.handle(event)`; the module-local `rollup` binding and its
`teardown` reset were removed, and `teardown` now `await choreographer.quiescent()`
before `tee.drain()`.

**Surprise — strict FIFO defers what used to be synchronous.** The plan's KTD2
makes the lifecycle side effects (notably `tee.open` on `step:start` and the
per-source `registerSource`) settle behind the queue instead of synchronously
with `onLifecycleEvent` returning. Two existing tests had baked in the old
synchronous timing and needed updating to the real async contract (which
production already satisfies via the subprocess-spawn gap), using the same
`waitFor*` poll idiom the passing `autonomous-live-pane` integration test
already uses:
- `tests/integration/hosts/tmux-host-command-line.test.ts` (3 cases) — poll for
  the tee's starting-marker before firing `onCommandLine`.
- `tests/integration/lifecycle/per-source-sessions-10-step-walkthrough.real.test.ts`
  — poll the lifecycle log until all 10 live sources spawn, instead of a single
  mid-run read (this cell was already flaky on `main` under full-suite real-tmux
  load).

The repo's first recording `FakeRightPaneController` + `FakePerStepTee` live in
`tests/helpers/recording-lifecycle-collaborators.ts` (reusable by future
right-pane tests).

Tests added:
- Unit: `tests/unit/hosts/two-pane/lifecycle-choreographer.test.ts` — 14 cases
  covering every event type, the cross-event FIFO ordering, chain-not-poisoned,
  and the controller-undefined path.
- No integration/e2e tests added (existing Tier-1 real-tmux lifecycle cells are
  the regression surface and stay green in isolation).
