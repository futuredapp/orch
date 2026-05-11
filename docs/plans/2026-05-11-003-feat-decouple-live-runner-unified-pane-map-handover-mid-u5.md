---
title: Handover — Pane-Map Implementation (mid-U5, work-in-progress)
type: handover
date: 2026-05-11
plan: docs/plans/2026-05-11-001-feat-decouple-live-runner-unified-pane-map-plan.md
supersedes: docs/plans/2026-05-11-002-feat-decouple-live-runner-unified-pane-map-handover-after-u4.md
status: active
---

# Pane-map plan — handover mid-U5 (uncommitted WIP)

This document hands the pane-map plan off to the next agent **while U5 is
partially done**. The prior handover
([`2026-05-11-002-...-after-u4.md`](2026-05-11-002-feat-decouple-live-runner-unified-pane-map-handover-after-u4.md))
covered the state after U1+U3+U4 were committed on `main`. Since then I
began U5 but **did not commit**: all changes are in the working tree.
Read the plan
([`2026-05-11-001-...-plan.md`](2026-05-11-001-feat-decouple-live-runner-unified-pane-map-plan.md))
top-to-bottom before continuing — this handover only summarizes what is
already done in the working tree, what is still broken, and what the
remaining units (U5 finish → U6 → U7 → U8 → U9 → U10) need.

## Top-of-stack snapshot

```
e3790a2 docs(pane-map): handover after U1 + U3 + U4   (HEAD of main)
1f0280e feat(two-pane): banner + view-mode plumbing                (U4)
9ce66bf docs(pane-map): handover after U1 + U3
9f83526 feat(two-pane): pane-map module + per-run scratch session  (U3)
b6cc8b4 feat(tmux): add swapPane and argv-form splitPane           (U1)
```

**Working tree (uncommitted) — 8 files changed, +476/-277:**

| File | What changed | Status |
|---|---|---|
| `src/hosts/plain/per-step-tee.ts` | added `teePathFor(logger, step)` helper returning `Path \| null` (null on no logger / null logsDir). | ✅ done |
| `src/hosts/two-pane/pane-map/right-pane-controller.ts` | `registerSource` for `live` keys now auto-swaps when `viewMode='live'` OR emits info banner `"step ${stepName} running — press f to follow"` when `viewMode='replay'`. `unregisterSource` for `live` keys now also emits info banner `"step ${stepName} complete"` and flips `viewMode` to replay when the live source was `currentKey`. | ✅ done |
| `src/hosts/two-pane/tmux-host.ts` | hoisted `createRightPaneController` BEFORE `buildHost` so the host can pass the controller into lifecycle handlers. Controller creation no longer gated on `disableStepsView` — only on `basePath + stateStore + !onStepsIntent`. **Dropped `inFlight: Set<StepName>` entirely.** `onLifecycleEvent('step:start', autonomous)` → `tee.open` + `controller.registerSource({type:'live', stepName},{kind:'file-tail', path:teePath})`. logsDir-null guard fires `emitBanner({kind:'info',...})` instead. `step:cached` → emits info banner only. `step:complete` → `controller.unregisterSource(live)` then `tee.close`. `step:failed` → `tee.write(failurePayload)` BEFORE `unregisterSource` BEFORE `tee.close`, then unconditional error banner. Dropped `enqueueRight` + `enqueueOnPane`. `onRunnerEvent` now only `tee.write` — no more `sendKeys` on rightPane. `onCommandLine` now only `tee.write` — drops `pane`-targeting fan-out entirely. **Rollup path on `step:parallel-branch-update` still uses inline `sendKeys` on rightPane — U7 moves it to a `_rollup` tee.** | ✅ done |
| `tests/integration/hosts/tmux-host-command-line.test.ts` | full rewrite: asserts tee contents, no sendKeys on either pane. Uses BunFsService + tempdir. | ✅ all 4 pass |
| `tests/integration/hosts/two-pane/right-pane-live-output.test.ts` | full rewrite: asserts tee bytes + `splitPane(argv:['tail','-n','5000','-F',...])` on scratch session + zero right-pane sendKeys + zero right-pane respawns. Uses BunFsService + tempdir. | ✅ all 5 pass |
| `tests/unit/hosts/two-pane/pane-map/right-pane-controller.test.ts` | followLive tests use `.findLast` for swapPane (registerSource now auto-swaps for live). | ✅ all pass |
| `tests/unit/hosts/tmux-host.test.ts` | `onRunnerEvent` & `step:failed` tests assert zero right-pane sendKeys (the U5 invariant). | ✅ all 13 pass |
| `tests/integration/hosts/two-pane-mocked.test.ts` | partially migrated: test 1 changed to assert tee bytes, but **fails** with `FakeRunner: no script configured for invocation 2` (see below). | ❌ 1/4 broken |

## Test gate: 1458 / 1469 pass; 9 skipped; **2 failing**

```
(fail) two-pane mocked workflow > streams readable transcript bytes through the per-step tee
(fail) two-pane D2 — failing step > renders the Story 1.5 failure frame on the right pane
```

### Failure 1 — `two-pane-mocked.test.ts` "streams readable transcript bytes"

**File:** [`tests/integration/hosts/two-pane-mocked.test.ts`](../../tests/integration/hosts/two-pane-mocked.test.ts)

**Symptom:** `FakeRunner(...): no script configured for invocation 2` — the
agent's `buildCommand` is called THREE times even though the workflow
runs only two `step.define(...)` calls (`plan` and `work`).

**What I changed** in the test: added a `createFileSessionLogger` and a
`FileStateStore` sharing `basePath = '/state'` (was `'/runs'`), and
threaded `logger` into both the host options and `WorkflowDeps`.

**My current theory** (UNVERIFIED — agent should re-verify before fixing):

- The 3rd invocation has empty `prompt` and `cwd=/workspace` — i.e. matches
  the shape of either step. Probably one of the two steps is being
  retried.
- The 2 valid invocations succeed; a 3rd `buildCommand` arrives unscripted.
- Suspect: when the logger is wired, `host.teardown()` flushes pending
  lifecycle events back through the workflow's `step:complete` path —
  but that doesn't trigger runner re-invocation. So this is probably not
  it.
- Alternative suspect: maybe `agent.script(...)` in `FakeRunner` does not
  enqueue a new script for the second call (e.g. the API expects ONE
  call per `FakeRunner` instance, not two). The original code used the
  same `agent` for both plan and work; check if that pattern was
  actually supported (search `FakeRunner` tests for a 2-call pattern).

**Recommended fix path:**
1. Inspect `src/runners/fake/fake-runner.ts` `script()` semantics:
   `this.#scriptsEnqueued++` per call suggests multi-script is supported.
2. Re-read the original passing version of the test (revert just that
   file via `git diff main -- tests/integration/hosts/two-pane-mocked.test.ts`).
   The original used `basePath: '/runs'` for `FileStateStore` (a path
   unrelated to the host) and **no logger at all**.
3. Likely root cause: when adding the logger, the workflow's
   `transcriptSidecar` / per-step folder logic may invoke the runner's
   `parseEvents` / `toTranscriptLines` in a way that triggers a hidden
   second `buildCommand`. Verify by adding a `console.trace()` inside
   FakeRunner.buildCommand when `#invocations >= #scriptsEnqueued`.
4. **Simpler fix candidate**: split the test into separate agents per
   step (one `FakeRunner` per `step.define`) — that's a robust fixture
   regardless of internal call counts. Original test had `agent.script`
   twice on the SAME `FakeRunner`; new test should split or scope-check.
5. **Don't dive into `runRunner` retry logic** — `grep -n retry src/core/workflow.ts` returns zero; there is no retry layer to find.

### Failure 2 — `two-pane-failure-and-parallel.test.ts` "renders the Story 1.5 failure frame"

**File:** [`tests/integration/hosts/two-pane-failure-and-parallel.test.ts`](../../tests/integration/hosts/two-pane-failure-and-parallel.test.ts) (159 lines, I have NOT migrated)

**Symptom:** still asserts the legacy `sendKeys(failurePayload)` on the right
pane. U5 moved the failure frame into the tee. The fix is a straight
migration — same pattern as `tests/unit/hosts/tmux-host.test.ts` (which
I already migrated): drop the sendKeys assertion, assert that **either**
the tee contains the failure summary (if logger is wired) **or** that
zero right-pane sendKeys exist (if logger isn't wired). Read the file,
match its style, do the simpler of the two assertions.

## What U5 *did not* touch yet (still pending under the U5 umbrella)

The plan ([U5 section](2026-05-11-001-feat-decouple-live-runner-unified-pane-map-plan.md))
calls out a few clean-ups that I haven't done yet but which belong in the
same commit as the U5 host wiring:

1. **Remove the controller's `isRightPaneBusy?` option.** It's still
   declared in `RightPaneControllerOptions` (defensive — the legacy
   `dispatchEnter` reads it). With `inFlight` gone from `tmux-host.ts`,
   no caller populates it, so `opts.isRightPaneBusy?.() === true` is
   always false → no busy refusal. The option can stay until U8 deletes
   the legacy `onIntent` path entirely; U5 plan only requires deleting
   the propagation from the host. **My change already did that** —
   `createRightPaneController(...)` no longer passes `isRightPaneBusy`.
2. **Re-ungate `right-pane-live-doubling.real.integration.test.ts`.** The
   plan says drop `ORCH_REPRO_BUG=1` and convert to a regression guard
   "doubling does NOT occur in the file-tail model." I haven't touched
   this file. The test is currently `it.skipIf(!runReproducer)` which
   means it doesn't run in CI. Migrate to:
   - Real-tmux setup with `createTmuxHost` + a logger.
   - Drive an autonomous step via FakeRunner that emits an ANSI
     transcript.
   - `tmux capture-pane` after the swap-in completes.
   - Assert: no caret-notation echo (`^[`), and exactly one rendered
     copy of each line.
   - Gate only on `Bun.which('tmux') !== null`; drop the `ORCH_REPRO_BUG`
     env gate.
3. **Sanity-grep:** `grep -n inFlight src/hosts/two-pane/tmux-host.ts` should
   return zero hits. I removed it but didn't grep — verify.
4. **Real-tmux integration test** for the live path (mentioned in the
   plan's Test scenarios for U5): "run an autonomous example, let it
   finish, capture the visible pane's content, assert it matches the
   persisted `formatted_output.txt`." I haven't added this. Lower
   priority than fixing the 2 failures above.

## What's next — U6, U7, U8, U9, U10

The plan's dependencies are unchanged. **Finish U5 first** (fix the 2
failures + the cleanup list above), then proceed.

### U6 — Interactive runners → `pty` archetype

Read the [U6 section of the plan](2026-05-11-001-feat-decouple-live-runner-unified-pane-map-plan.md#u6-wire-interactive-runners-to-the-pty-archetype)
verbatim. Key points:

- Rewrite `runInteractive` in `src/hosts/two-pane/tmux-host.ts:659-720`:
  1. `controller.registerSource({type:'interactive', stepName: spawn.stepName}, {kind:'pty', argv, env, cwd})`
  2. `controller.showSource(sourceKey)`
  3. `tmux.waitFor({channel: 'pane-exit-<hiddenPaneId>'})`
  4. In `finally`: `controller.unregisterSource(sourceKey)` (controller
     swaps to placeholder and kills the hidden pane per its rule for
     `interactive` keys).
- **Delete** the post-exit `respawnPane(['cat'], killRunning:true)` cleanup
  at `tmux-host.ts:702-712`. The visible pane never directly ran the
  runner argv in the new model, so there's nothing to clean up.
- The `paneRole = 'left'` branch (steps-view daemon at
  `tmux-host.ts:661-662`) is **untouched** — left pane stays on the
  legacy `respawnPane` path.
- **Migrate `dispatchAgentInteractive`** into the new controller as part
  of `onIntent('enter')` for past interactive steps: resolve the resume
  argv, then `registerSource(...,'pty',resumeArgv)` + `showSource`. On
  error, `emitBanner({kind:'error', text: refusal})`. (This consolidates
  the legacy resume path into the unified model — but **be careful**:
  this also touches the legacy `dispatchEnter` flow which U8 will fully
  flip. Either land the resume-via-pane-map migration in U6 inline with
  U6's interactive scope, OR defer it to U8 alongside the
  `onIntent('enter')` flip. The plan text reads as if U6 owns it; I lean
  toward U6 owning it for the resume failure mode + U8 owning the
  cached/replay-spec resolution.)

**Inline test migrations** (per U6 plan):
- [`tests/integration/hosts/two-pane-interactive.test.ts`](../../tests/integration/hosts/two-pane-interactive.test.ts)
- [`tests/integration/hosts/two-pane-sequential-runs.test.ts`](../../tests/integration/hosts/two-pane-sequential-runs.test.ts)
- [`tests/integration/hosts/two-pane/resume-launcher-mocked.integration.test.ts`](../../tests/integration/hosts/two-pane/resume-launcher-mocked.integration.test.ts)
- [`tests/integration/hosts/two-pane/resume-failure-mocked.integration.test.ts`](../../tests/integration/hosts/two-pane/resume-failure-mocked.integration.test.ts)

The `tests/unit/hosts/tmux-host.test.ts` block `TmuxHost.runInteractive`
(lines 280–355) also asserts the legacy `respawn-pane(runner argv)` +
`respawn-pane(['cat'])` pair. Flip these to assert `splitPane(scratch,
runnerArgv)` + `swapPane` + `killPane`. I left these untouched because
they're U6 territory.

### U7 — Rollup hidden pane + parallel-block lifecycle events

Read [U7 section](2026-05-11-001-feat-decouple-live-runner-unified-pane-map-plan.md#u7-wire-rollup-to-its-own-hidden-pane-add-parallel-block-lifecycle-events).
Key points:
- Add two new lifecycle events in `src/core/workflow.ts`:
  `step:parallel-start` (before first branch's `step:start`) and
  `step:parallel-complete` (after all branches settle). Each carries a
  block id (deterministic counter is fine).
- `step:parallel-branch-update` continues to fire as today.
- In `tmux-host.ts`:
  - On `step:parallel-start`: `tee.open('_rollup')` then
    `controller.registerSource({type:'rollup'}, {kind:'file-tail', path: teePathFor(logger,'_rollup')})`.
  - On `step:parallel-branch-update`: replace the **inline `sendKeys`
    rollup path** (which my U5 left in place — see `tmux-host.ts` `if
    (event.type === 'step:parallel-branch-update')`) with
    `tee.write('_rollup', renderRollupPayload(snapshot))`.
  - On `step:parallel-complete`: `controller.unregisterSource({type:'rollup'})`,
    `tee.close('_rollup')`, `rollup.reset()`.
- The `_rollup` step name probably needs to be acceptable to `StepName`'s
  branded type — check `src/core/types.ts` `stepName(...)`.
  The plan says "the leading underscore sorts above step names; matches
  the project's 'meta entry' convention," so it should be valid.

### U8 — Past-step replay warm-cache + edge-case wiring

Read [U8 section](2026-05-11-001-feat-decouple-live-runner-unified-pane-map-plan.md#u8-past-step-replay-panes--warm-cache-verification--edge-case-wiring).
- Finalize `resolveReplaySpec(opts, step): Promise<PaneSpec>` in
  `pane-map/right-pane-controller.ts`. Today the controller has
  `dispatchByKind` (still legacy `respawnPane`) — replace it with a
  function that returns a `PaneSpec` for each step kind. Then flip
  `onIntent('enter')` to call `registerSource(replayKey, spec)` +
  `showSource(replayKey)`.
- Test migrations:
  - `right-pane-replay.integration.test.ts` (~6 respawnPane assertions)
  - `right-pane-busy-gate.integration.test.ts` ("busy refusal" → "swap succeeded")
  - `kind-details.integration.test.ts`

### U9 — Right-pane-source invariant guard test

Add `tests/integration/hosts/two-pane/right-pane-source-invariant.test.ts`.
One assertion: across `src/hosts/two-pane/` source files, zero
`respawnPane(...rightPaneId...)` invocations. Implement via
`Bun.file(...).text()` + regex (not shell `grep`) so it runs
cross-platform. The plan's U9 section also recommends a fixture-time
check: for each test run's `FakeTmuxService.recordedCalls`, no
`respawnPane` has `target === rightPaneId`.

### U10 — Cleanup, docs, prior-doc archival

- **Delete** `src/hosts/two-pane/right-pane-controller.ts` (the old
  top-level shim — re-export only).
- Update `docs/getting-started.md`, `docs/logging.md`, the two solution
  docs (`autonomous-transcript-rendering.md`,
  `interactive-mode-colors.md`).
- Mark `docs/brainstorms/2026-05-06-...md`, `docs/brainstorms/2026-05-07-...md`,
  and `docs/plans/2026-05-07-...md` with `status: superseded` +
  `superseded_by: ...`.

## How to verify the gate

```sh
# All of these should be green after the next session finishes U5:
bun test tests/integration/hosts/two-pane/right-pane-live-output.test.ts   # 5/5
bun test tests/integration/hosts/tmux-host-command-line.test.ts            # 4/4
bun test tests/unit/hosts/tmux-host.test.ts                                # 13/13
bun test tests/unit/hosts/two-pane/pane-map/right-pane-controller.test.ts  # all
bun test tests/integration/hosts/two-pane-mocked.test.ts                   # 4/4 (currently 3/4)
bun test tests/integration/hosts/two-pane-failure-and-parallel.test.ts     # all (currently fails)

bun run check                                                              # 0 failing
```

## Open implementation questions surfaced mid-U5

1. **Should `registerSource` for `interactive` auto-swap too?** The plan
   text says "controller auto-swaps if `viewMode==='live'`" — I read this
   as `live` keys only. U6 will explicitly `showSource(sourceKey)` after
   `registerSource`. If `registerSource(interactive)` also auto-swapped,
   U6's explicit `showSource` would be a no-op (idempotent), so it
   wouldn't matter — but it WOULD record an extra `swapPane` call in the
   `tmux.recordedCalls` log, which test assertions may or may not count.
   **My current implementation does NOT auto-swap for `interactive`.**
   U6 should preserve this — the explicit `showSource` is clearer.
2. **`onCommandLine`'s `pane: 'left'` field is now ignored.** The plan
   accepts this. Real impact: a workflow author who explicitly set
   `pane: 'left'` on a command step no longer sees its bytes on the
   left pane. The left pane is owned by the steps-view daemon; command
   output never lived there in practice. **U10 should document the
   removal** in `docs/getting-started.md` or wherever `pane: 'left'` was
   surfaced. Search for `pane: 'left'` in user-facing docs.
3. **`step:complete` ordering: unregister BEFORE close.** My U5 host
   handler does `controller.unregisterSource(...)` THEN `deps.tee.close(...)`.
   The plan's `step:failed` ordering is explicit (`tee.write summary` →
   `unregisterSource` → `tee.close`). For `step:complete` the plan
   doesn't explicitly say. My read: unregister first so the hidden pane
   keeps tailing the still-open tee; then close. This preserves any
   bytes that arrive between unregister and close — important when a
   runner emits a final terminal event AFTER the workflow's step:complete
   fires. Worth verifying with an integration test in U5 cleanup.

## Branch + commit policy

The user previously confirmed working directly on `main` (see
`2026-05-11-002-...-after-u4.md` § "Branch + commit policy"). **Continue
on `main`** unless the user asks otherwise.

**Suggested commit shape for U5** (when finally green):

```
feat(two-pane): autonomous + command live via file-tail sources (U5)

- Add teePathFor() helper to per-step-tee.ts.
- Hoist controller creation before buildHost; drop inFlight set.
- onLifecycleEvent('step:start' autonomous) registers file-tail source;
  null-logsDir path emits info banner instead.
- step:cached emits info banner; step:complete unregisters
  (transforms live → replay warm cache); step:failed writes summary to
  tee, unregisters, closes tee, emits unconditional error banner.
- registerSource(live) auto-swaps in live mode, or emits
  "running — press f to follow" banner in replay mode.
- unregisterSource(live) flips viewMode to replay + emits
  "step X complete" banner when the live source was currentKey.
- onRunnerEvent and onCommandLine drop sendKeys to right pane;
  tee.write is the only sink.
- Inline test migrations: right-pane-live-output, tmux-host-command-line,
  tmux-host unit, two-pane-mocked.
```

Don't include attribution in the commit message body (per prior handover).

## Quick orientation commands

```sh
# Re-read the plan
less docs/plans/2026-05-11-001-feat-decouple-live-runner-unified-pane-map-plan.md

# See the WIP diff
git diff --stat
git diff src/hosts/two-pane/tmux-host.ts

# Re-run the gate
bun run check 2>&1 | grep -E "fail\)|pass|Ran"

# Run just the U5-affected tests
bun test tests/integration/hosts/two-pane/right-pane-live-output.test.ts
bun test tests/integration/hosts/tmux-host-command-line.test.ts
bun test tests/integration/hosts/two-pane-mocked.test.ts
bun test tests/integration/hosts/two-pane-failure-and-parallel.test.ts
```

## When stuck

- The plan is authoritative. If this handover conflicts with the plan,
  the plan wins.
- Don't try to fix prior-handover deferrals (U3/U4 carryovers) by
  changing already-committed code — those are scheduled units.
- The 2 failing tests are pre-merge work for the U5 commit. Don't
  commit until they're green AND the plan's U5 verification items
  (grep `inFlight` returns empty, `right-pane-live-doubling` ungated)
  are done.
- The `inFlight` removal is structurally safe: the controller's
  `isRightPaneBusy?` option is now never populated, so the legacy
  `dispatchEnter` busy gate is always false. U8 will delete that option
  entirely. Don't worry about it now.
