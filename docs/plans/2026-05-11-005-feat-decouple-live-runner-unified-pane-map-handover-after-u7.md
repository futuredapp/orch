---
title: Handover — Pane-Map Implementation (after U7)
type: handover
date: 2026-05-11
plan: docs/plans/2026-05-11-001-feat-decouple-live-runner-unified-pane-map-plan.md
supersedes: docs/plans/2026-05-11-004-feat-decouple-live-runner-unified-pane-map-handover-after-u6.md
status: superseded
superseded_by: docs/plans/2026-05-11-001-feat-decouple-live-runner-unified-pane-map-plan.md
---

# Pane-map plan — handover after U7

U7 is committed on `main`. Read the plan
([`2026-05-11-001-...-plan.md`](2026-05-11-001-feat-decouple-live-runner-unified-pane-map-plan.md))
before continuing. The prior handover
([`2026-05-11-004-...-after-u6.md`](2026-05-11-004-feat-decouple-live-runner-unified-pane-map-handover-after-u6.md))
covered U5 + U6 and laid out the scope for U7/U8/U9/U10.

## Top-of-stack snapshot

```
d2cea62 feat(two-pane): rollup → hidden pane + parallel-block lifecycle events (U7)  ← HEAD
ec1d99c feat(two-pane): interactive runners via pty archetype                        (U6)
e867b86 feat(two-pane): autonomous + command live via file-tail sources              (U5)
1f0280e feat(two-pane): banner + view-mode plumbing                                  (U4)
9f83526 feat(two-pane): pane-map module + per-run scratch session                    (U3)
b6cc8b4 feat(tmux): add swapPane and argv-form splitPane                             (U1)
```

**Test gate:** `bun run check` is green. 1468 pass, 8 skip, 0 fail.

## What U7 landed

Single commit `d2cea62`.

- **New lifecycle events** in `src/core/workflow.ts`:
  - `step:parallel-start` — fired once at the top of every `parallel(...)`
    call before any branch starts. Carries a deterministic `blockId`.
  - `step:parallel-complete` — fired once after every branch settles
    (regardless of pass/fail). Block id matches the start.
  - `step:parallel-branch-update` still fires per branch as before.
- **ExecutionContext seam** (`src/core/execution-context.ts`): adds
  `emitLifecycle?` and `parallelBlockIdRef?` so `parallel()` (in core)
  can fire events without depending on `Host` or `WorkflowDeps`.
  `executeWorkflowFn` sets both on the root store; the homogeneous-branch
  wrapper inherits them so nested parallels keep firing.
- **`metaStepName()`** in `src/core/types.ts` — reserves a leading `_`
  for internal tee keys (`_rollup`). The user-facing `stepName()` stays
  strict (rejects underscore prefix).
- **`src/hosts/two-pane/tmux-host.ts`** — rollup wiring:
  - `step:parallel-start` → `tee.open('_rollup')` +
    `controller.registerSource({type:'rollup'}, {kind:'file-tail', path: teePathFor(logger,'_rollup')})`.
  - `step:parallel-branch-update` → `tee.write(ROLLUP_STEP_NAME, renderRollupPayload(snapshot))`.
    No more `sendKeys(rollup)` on the right pane.
  - `step:parallel-complete` → `unregisterSource({type:'rollup'})` →
    `tee.close('_rollup')` → `rollup.reset()`, in that order.
  - `ROLLUP_STEP_NAME = metaStepName('_rollup')` declared at module top.
- **`pane-map/right-pane-controller.ts`** — `registerSource` for
  `{type:'rollup'}` now auto-swaps in `live` mode and emits an info
  banner (`"parallel branches running — press f to follow"`) in `replay`
  mode, mirroring the `live` source path.
- **`plain-host.ts` + `status-loop.ts`** — handle the new block-scoped
  events. Plain host renders `[orch] step:parallel-start [block 0]`
  (text) or `{ev:'step.parallel-start', blockId}` (JSON). The
  per-step status loop swallows them (block events have no `stepName`).

### Test work shipped in the same commit

- **New:** `tests/unit/core/workflow-parallel-lifecycle.test.ts` —
  block-id determinism, start-before-first-branch / complete-after-last,
  two-blocks-yield-distinct-ids, empty-block still pairs, failing-branch
  still emits complete.
- **New:** `tests/integration/hosts/two-pane/tmux-host-rollup-pane-map.integration.test.ts`
  — drives a real `parallel(...)` block through `createTmuxHost` with a
  logger + scratch session. Asserts tee bytes contain the rollup, no
  right-pane sendKeys / respawns, `splitPane` argv shape is
  `['tail','-n','5000','-F', '...agents/_rollup/formatted_output.ansi']`,
  `killPane` fires on complete.
- **Migrated** (legacy `sendKeys(rollup)` assertions → U7 invariant):
  - `tests/unit/hosts/tmux-host.test.ts` (`TmuxHost.onLifecycleEvent —
    step:parallel-branch-update`) → asserts zero right-pane sendKeys.
  - `tests/integration/hosts/two-pane-failure-and-parallel.test.ts`
    (`two-pane D2 — parallel rollup`) → asserts zero right-pane sendKeys
    when no logger/controller is wired.
- **Type narrowing fix:** `tests/integration/core/interactive-workflow.test.ts`
  — switched to explicit type guards so the new block events don't break
  the `events[i]?.stepName` access pattern.

### Deviation note: rollup auto-swap-on-register

The plan's U7 prose says "the controller's `followLive()` auto-prefers
rollup when it's registered". I extended `registerSource` for
`{type:'rollup'}` to ALSO auto-swap-or-banner (symmetric with `live`),
because the U7 test scenarios in the plan say "controller emits an info
banner instead of swapping (same path as `{type:'live'}` per U3)" —
that only makes sense if rollup goes through the same auto-swap branch.
The existing controller unit test at
`tests/unit/hosts/two-pane/pane-map/right-pane-controller.test.ts:198-210`
still passes because the explicit `showSource(rollupKey)` becomes a
no-op when the controller already swapped to rollup on register.

If a future agent thinks this is wrong, undoing it is a 5-line change in
`right-pane-controller.ts:309-319`.

## Prior-handover deferrals still standing

Carried over from the after-U6 handover, unchanged:

1. **`isRightPaneBusy?` option** on `RightPaneControllerOptions` still
   declared but never populated. **U8 deletes it** when it flips
   `onIntent('enter')` to the swap-based path.
2. **Top-level shim** at `src/hosts/two-pane/right-pane-controller.ts`.
   **U10 deletes it** once U8's `resolveReplaySpec` replaces the legacy
   `dispatchByKind`.
3. **`pane: 'left'` on `command()` steps** — bytes no longer fan to the
   left pane. **U10 documents this** in `docs/getting-started.md`.
4. **`step:complete` ordering integration test** — load-bearing but not
   yet covered. Optional U10 cleanup.

## What's next — U8, U9, U10

Dependencies unchanged from the prior handover.

### U8 — Past-step replay panes — warm cache + edge-case wiring

Read the
[U8 section of the plan](2026-05-11-001-feat-decouple-live-runner-unified-pane-map-plan.md#u8-past-step-replay-panes--warm-cache-verification--edge-case-wiring).
Summary:

- Finalize `resolveReplaySpec(opts, step): Promise<PaneSpec>` in
  `pane-map/right-pane-controller.ts`. Branches:
  - agent/autonomous → `{kind:'file-tail', path: <logsDir>/agents/<stepName>/formatted_output.ansi}`.
    Fallback to JSON-NDJSON re-render when the persisted tee is missing.
  - agent/interactive → resume-runner branch (U6 deferred — **U8 owns
    this** per the after-U6 handover).
  - command → `{kind:'file-tail', path: <command pane log path>}` or
    inline placeholder.
  - commit / worktree / ask → write `<stateDir>/.replay/<safeStepName>.txt`
    with `renderKindDetails(step)`, then `{kind:'file-tail', path: <that file>}`.
- Flip `onIntent('enter')` to `registerSource(replayKey, spec) +
  showSource(replayKey)`. Busy gate goes away.
- **Delete** the `isRightPaneBusy?` option from
  `RightPaneControllerOptions`.
- **Test migrations (inline with U8):**
  - `tests/integration/hosts/two-pane/right-pane-replay.integration.test.ts`
  - `tests/integration/hosts/two-pane/right-pane-busy-gate.integration.test.ts`
  - `tests/integration/hosts/two-pane/kind-details.integration.test.ts`
  - U6's deferred resume tests:
    `resume-launcher-mocked.integration.test.ts` +
    `resume-failure-mocked.integration.test.ts`.

### U9 — Right-pane-source invariant guard test

Single-file deliverable. Read the
[U9 section](2026-05-11-001-feat-decouple-live-runner-unified-pane-map-plan.md#u9-right-pane-source-invariant-guard-test).
Static regex + per-fixture assertion that no `respawnPane` targets the
visible right pane.

### U10 — Cleanup, docs, prior-doc archival

- Delete the top-level `right-pane-controller.ts` re-export shim.
- Update `docs/getting-started.md`, `docs/logging.md`, and the two
  solution docs.
- Mark prior brainstorms / plan as `status: superseded`.
- Update the active-phase pointer in `docs/plans/implementation-phases.md`.

## How to verify the gate

```sh
bun run check                                                              # 0 failing

# Spot-check U7-affected paths:
bun test tests/unit/core/workflow-parallel-lifecycle.test.ts               # 4/4
bun test tests/integration/hosts/two-pane/tmux-host-rollup-pane-map.integration.test.ts  # 4/4
bun test tests/unit/hosts/tmux-host.test.ts                                # 13/13
bun test tests/integration/hosts/two-pane-failure-and-parallel.test.ts     # 2/2
bun test tests/unit/hosts/two-pane/pane-map/                               # 19/19
```

Sanity-grep — no rollup sendKeys remain:

```sh
grep -rn "enqueueRight\|enqueueOnPane" src/   # zero hits
grep -rn "renderRollupPayload" src/hosts/     # only the import + tee.write line
```

## Branch + commit policy

The user previously confirmed working directly on `main`.
**Continue on `main`** unless asked otherwise. Don't `git push` without
explicit authorization. No attribution footer in commit bodies.

## When stuck

- The plan is authoritative. If this handover conflicts with the plan,
  the plan wins.
- Don't "fix" prior-handover deferrals by changing already-committed
  code — those are scheduled units (U8 owns the resume + busy-gate
  cleanup; U10 owns the shim deletion + docs).
- Each behavior-changing unit migrates its own previously-passing tests
  in the same commit. `bun run check` is green at every commit.
