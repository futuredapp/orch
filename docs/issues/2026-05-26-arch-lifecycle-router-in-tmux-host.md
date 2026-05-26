---
date: 2026-05-26
status: open
area: src/hosts/two-pane
type: architecture
recommendation: worth-exploring
dependency-category: in-process
top-recommendation: true
plan: docs/plans/2026-05-26-001-refactor-lifecycle-choreographer-plan.md
---

# Lift a lifecycle router out of the tmux host

## Problem

`Host.onLifecycleEvent` in `src/hosts/two-pane/tmux-host.ts:813-956` is a
143-line inline handler that translates each `StepLifecycleEvent` into a
choreography of per-step tee, file-tail source register/unregister, failure
summary, and parallel-rollup mutations. It carries **load-bearing ordering
invariants** stated only in comments:

- `step:start`: open tee → write marker → register live source (or banner if no logs)
- `step:complete`: unregister **before** close (warm-replay sees trailing bytes)
- `step:failed`: tee.write summary **first**, then sequential unregister→error-banner
  (so a slow `pendingRegistrations` drain can't overwrite the error banner)
- `step:parallel-*`: open rollup tee, apply snapshots, unregister before close, reset

None of this has an interface. It is reachable today only by standing up a live
tmux session — there is no seam at which to feed it events and assert the
resulting controller / tee / rollup calls.

## Files

- `src/hosts/two-pane/tmux-host.ts:813-956` — the inline handler (largest file in the repo, 1532 lines)
- collaborators it orchestrates: `deps.tee` (per-step tee), `deps.controller`
  (right-pane controller), `rollup` (parallel aggregator), `teePathFor`,
  `summarizeFailure`, `renderFailurePanePayload`, `renderRollupPayload`,
  `ROLLUP_STEP_NAME`, `handleSendError`, `torndown`

## Solution

Extract `LifecycleRouter.handle(event)` over the controller, tee, and rollup.
The host's `onLifecycleEvent` becomes a one-line forward. The router owns the
ordering invariants and the parallel-rollup state.

## Wins

- Deep module: large behaviour behind a small interface (`handle(event): void`)
- Test surface stops being "real tmux" — fake controller + fake tee, assert calls
- Ordering invariants get one home and one set of tests
- `tmux-host.ts` drops ~140 of its 1532 lines

## Deletion test

Delete the router and the orchestration reappears inline across every lifecycle
branch, with the ordering invariants re-scattered into comments. It concentrates
complexity → it earns its keep.

## Resolved design (grilled 2026-05-26)

**Scope — narrow lifecycle router.** The module owns only the lifecycle→side-effect
translation. `onRunnerEvent` / `onCommandLine` keep writing the tee on the host;
the tee stays a shared collaborator injected into both. Smallest interface,
lowest-risk cut, isolates the ordering invariants.

**Return shape — awaitable + internal FIFO serialization queue.** `handle()`
returns `Promise<void>` and chains on an internal tail promise, so each event's
side effects fully settle before the next begins — even though the host fires it
without awaiting (`Host.onLifecycleEvent` is `void` by contract). This finally
makes every "unregister BEFORE close" / "summary BEFORE freeze" comment a real,
tested invariant rather than a fire-and-forget hope. (Today `step:failed` closes
the tee synchronously at `:913` while the unregister IIFE at `:897` is still in
flight — close can beat unregister. The queue fixes that.)

**`torndown` — injected `isTorndown: () => boolean`.** Host keeps ownership (its
`onRunnerEvent`/`onCommandLine`/teardown all touch the flag); the router reads
through a thunk. No ownership migration.

**`rollup` — router-private.** `createRollupAggregator()` moves inside the router;
it has no other consumer.

**`controller` — injected as `RightPaneController | undefined`.** Tee effects run
regardless of controller presence (steps-view-disabled / no-stateStore test
fixtures pass `undefined`); the `?.` guards move into the router.

### Proposed interface

```ts
// src/hosts/two-pane/lifecycle-router.ts
export interface LifecycleRouterDeps {
  readonly controller: RightPaneController | undefined
  readonly tee: PerStepTee
  readonly logger: SessionLogger | undefined
  readonly runId: RunId
  readonly clock: Clock
  readonly isTorndown: () => boolean
  readonly onSendError: (err: unknown) => void   // today's handleSendError
}

export interface LifecycleRouter {
  /** Translate one event into right-pane side effects. FIFO-serialized:
   *  the returned promise settles after THIS event's (and all prior
   *  events') effects complete. Never rejects — failures go to onSendError. */
  handle(event: StepLifecycleEvent): Promise<void>
  /** Resolves when the queue is drained. teardown awaits this before tee.drain(). */
  quiescent(): Promise<void>
}

export function createLifecycleRouter(deps: LifecycleRouterDeps): LifecycleRouter
```

Host wiring shrinks to:
```ts
const router = createLifecycleRouter({ ...deps, isTorndown: () => torndown, onSendError: handleSendError })
const onLifecycleEvent = (event: StepLifecycleEvent): void => { void router.handle(event) }
// teardown(): await router.quiescent(); await deps.tee.drain(); …
```

### Correctness subtleties to honour

- **Chain must not poison.** `tail = tail.then(() => process(e).catch(onSendError))`
  — if one event's `#process` rejected and we chained raw, every later event
  would be silently skipped. Each link swallows into `onSendError`.
- **teardown awaits `quiescent()`** before `tee.drain()`, or drain can race an
  in-flight `tee.close`/`write`.
- **Strict FIFO is a behavioural change** from today's best-effort interleave.
  Acceptable: lifecycle events are infrequent and only drive right-pane
  rendering — the workflow executor never awaits `onLifecycleEvent`, so a slow
  queue never stalls execution.

### Test plan

New `tests/unit/hosts/two-pane/lifecycle-router.test.ts` — inject a recording
`RightPaneController` fake + recording `PerStepTee` + fake `Clock`. (Not a banned
mock target: `src/hosts/` is outside the core/state/validators/runners mock ban,
and we inject through interfaces, not `mock.module`.) Assert the exact ordered
call sequence per event:

- `step:start` (autonomous): `tee.open → tee.write(marker) → registerSource(live, file-tail)`; teePath null → `emitBanner(info, "no transcript")`; non-autonomous → no effects
- `step:cached`: `emitBanner(info, "cached")`
- `step:complete`: `unregisterSource(live)` **then** `tee.close`
- `step:failed`: `tee.write(summary)` **then** `unregisterSource(live, suppressCompletionBanner)` **then** `emitBanner(error)` **then** `tee.close`; with `isTorndown()===true` → summary write skipped
- `step:parallel-start`: `tee.open(_rollup) → registerSource(rollup)`
- `step:parallel-branch-update`: `rollup.apply` snapshot aggregation across multiple updates → `tee.write(_rollup)`
- `step:parallel-complete`: `unregisterSource(rollup) → tee.close(_rollup) → rollup.reset`
- **cross-event FIFO**: fire `handle(complete A)` and `handle(start B)` unawaited; assert A's effects fully precede B's
- **controller `undefined`**: tee effects still happen, no throw

Regression safety: the existing real-tmux + FakeRunner Tier-1 host tests exercise
lifecycle through the host and must pass unchanged (host delegates).

## Recommendation strength

**Worth exploring** — and the **top recommendation**. The truest deepening on
the board: behaviour with no interface becomes a deep, testable module, and it
lands on the project's own two-pane testing rule.
