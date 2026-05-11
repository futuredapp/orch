---
title: Handover — Pane-Map Implementation (after U5 + U6)
type: handover
date: 2026-05-11
plan: docs/plans/2026-05-11-001-feat-decouple-live-runner-unified-pane-map-plan.md
supersedes: docs/plans/2026-05-11-003-feat-decouple-live-runner-unified-pane-map-handover-mid-u5.md
status: superseded
superseded_by: docs/plans/2026-05-11-005-feat-decouple-live-runner-unified-pane-map-handover-after-u7.md
---

# Pane-map plan — handover after U5 + U6

This document hands the pane-map plan off to the next agent **after U5
and U6 are committed on `main`**. The prior handover
([`2026-05-11-003-...-mid-u5.md`](2026-05-11-003-feat-decouple-live-runner-unified-pane-map-handover-mid-u5.md))
covered the mid-U5 state with two failing tests; I finished U5, then
landed U6 on top. Read the plan
([`2026-05-11-001-...-plan.md`](2026-05-11-001-feat-decouple-live-runner-unified-pane-map-plan.md))
top-to-bottom before continuing — this handover summarizes what
shipped, deviations from the plan I noticed, prior-handover deferrals
still standing, and the next agent's scope (U7 → U10).

## Top-of-stack snapshot

```
ec1d99c feat(two-pane): interactive runners via pty archetype       (U6)  ← HEAD of main
e867b86 feat(two-pane): autonomous + command live via file-tail     (U5)
e3790a2 docs(pane-map): handover after U1 + U3 + U4
1f0280e feat(two-pane): banner + view-mode plumbing                 (U4)
9ce66bf docs(pane-map): handover after U1 + U3
9f83526 feat(two-pane): pane-map module + per-run scratch session   (U3)
b6cc8b4 feat(tmux): add swapPane and argv-form splitPane            (U1)
```

**Test gate after U6:** `bun run check` is green. 1460 pass, 8 skip, 0 fail.

## What U5 landed

Commit `e867b86`. Single commit with all of U5's wiring plus the
inline test migrations.

- `src/hosts/plain/per-step-tee.ts` — added `teePathFor(logger, step)
  : Path | null` helper.
- `src/hosts/two-pane/pane-map/right-pane-controller.ts` —
  `registerSource` auto-swaps for `live` keys (viewMode==='live') or
  emits a `"step X running — press f to follow"` info banner
  (viewMode==='replay'). `unregisterSource` for `live` keys
  transitions to `replay` (warm cache, no kill), flips `viewMode` to
  replay + emits `"step X complete"` info banner when the live source
  was current.
- `src/hosts/two-pane/tmux-host.ts` — hoisted `createRightPaneController`
  BEFORE `buildHost`. Dropped `inFlight: Set<StepName>` entirely.
  Lifecycle handlers (`step:start` autonomous, `step:cached`,
  `step:complete`, `step:failed`) now use controller methods. Removed
  all `enqueueRight` / `enqueueOnPane` for runner-event / command-line
  bytes — `tee.write` is the only sink.
- Test migrations (inline, same commit):
  - `tests/integration/hosts/two-pane/right-pane-live-output.test.ts`
  - `tests/integration/hosts/tmux-host-command-line.test.ts`
  - `tests/integration/hosts/two-pane-mocked.test.ts`
  - `tests/integration/hosts/two-pane-failure-and-parallel.test.ts`
  - `tests/unit/hosts/tmux-host.test.ts`
  - `tests/unit/hosts/two-pane/pane-map/right-pane-controller.test.ts`
  - `tests/integration/hosts/two-pane/right-pane-live-doubling.real.integration.test.ts`
    — rewritten as a regression guard for the file-tail model (dropped
    `ORCH_REPRO_BUG` env gate; kept `Bun.which('tmux')` availability
    gate; asserts zero right-pane sendKeys, exactly one copy per line,
    no caret-notation in the tee).

### Diff from the prior handover's "Recommended fix path"

The mid-U5 handover identified two failing tests and listed candidate
fixes. Final approach:

1. **`two-pane-mocked.test.ts` "streams readable transcript bytes"** —
   used the "split into per-step FakeRunner instances" fix (step 4 in
   the prior handover). Root cause never fully diagnosed; the simpler
   fixture is robust regardless. Test now uses one `FakeRunner` per
   `step.define` rather than two `.script(...)` calls on the same
   instance.
2. **`two-pane-failure-and-parallel.test.ts` "renders the Story 1.5
   failure frame"** — straight migration as the handover described.
   Asserts zero right-pane sendKeys (no logger wired in this fixture,
   so the controller is undefined; the unit-test layer asserts the tee
   bytes + banner emit for the with-controller case).

## What U6 landed

Commit `ec1d99c`. Single commit.

- `src/hosts/two-pane/pane-map/right-pane-controller.ts` — added
  `getPaneId(key: SourceKey): PaneId | undefined` to the
  `RightPaneController` surface. U6 needs it to resolve the hidden
  pane id between `registerSource` and `waitFor pane-exit-<hidden>`.
- `src/hosts/two-pane/tmux-host.ts` — rewrote `runInteractive` for
  `paneRole === 'right'`. New shape:
  1. `controller.registerSource({type:'interactive', stepName}, {kind:'pty', argv, env, cwd})`.
  2. `controller.getPaneId(sourceKey)` → hiddenPaneId.
  3. `controller.showSource(sourceKey)` → swap visible ↔ hidden.
  4. `await tmux.waitFor({channel: 'pane-exit-<hiddenPaneId>'})`.
  5. `finally`: `controller.unregisterSource(sourceKey)` (kills hidden
     pane, swaps placeholder back).
  - Deleted the post-exit `respawnPane(['cat'])` cleanup.
  - The `paneRole === 'left'` branch (steps-view daemon) stays on the
    legacy `respawnPane` path — DO NOT touch.
- Added a **defensive throw** in `runInteractive` when `paneRole === 'right'`
  and `controller === undefined`: this is a wiring error and the
  fallback would re-introduce the kernel pty echo doubling + ANSI
  corruption U5/U6 removed. Throw fast with a pointer to `basePath +
  stateStore`.
- Test migrations (inline):
  - `tests/unit/hosts/tmux-host.test.ts` (`TmuxHost.runInteractive`
    block) — added `buildHostWithController` helper, asserts no
    rightPane respawns, asserts scratch splitPane with runner argv,
    asserts swap + wait `pane-exit-<hiddenPaneId>` + kill.
  - `tests/integration/hosts/two-pane-interactive.test.ts` — same
    treatment.
  - `tests/integration/hosts/two-pane-sequential-runs.test.ts` (real
    tmux) — wires `basePath` + `stateStore` into `createTmuxHost`
    so the controller is constructed. The 3 sequential-runs tests
    pass against real tmux.

### Deviation from plan: the resume-via-pane-map migration is deferred to U8

The plan's U6 section says U6 should also migrate `dispatchAgentInteractive`
(the resume path in the legacy `onIntent('enter')` flow) into the new
controller. The prior handover's open question §1 noted I leaned
toward "U6 owns it" but flagged the entanglement with U8's
`dispatchByKind` migration.

**Decision I made and rationale.** I deferred the resume migration to
U8 instead. The full `dispatchEnter → dispatchByKind →
dispatchAgentInteractive` path is one unified flow in
`right-pane-controller.ts:479-681`; migrating the interactive sub-path
without migrating the autonomous-replay sibling would leave a
half-migrated `dispatchByKind` whose two branches use different
mechanisms (pane-map for interactive, legacy respawnPane for
autonomous replay). U8 owns `resolveReplaySpec` which is the natural
single-shot migration for all four step kinds (agent autonomous, agent
interactive, command, commit/worktree/ask). Resume is the
agent/interactive branch of `resolveReplaySpec`.

**Concrete consequence.** The resume tests still hit the unchanged
legacy code path and still pass:
- `tests/integration/hosts/two-pane/resume-launcher-mocked.integration.test.ts` (2/2)
- `tests/integration/hosts/two-pane/resume-failure-mocked.integration.test.ts` (1/1)

The plan's U6 test scenarios for "resume-from-past-interactive Enter"
and "resume-failure" are **NOT** covered by U6; they belong to U8.
When the next agent (or one further down the chain) writes U8, they
should:
1. Migrate `dispatchAgentInteractive` into a new
   `resolveReplaySpec({type:'interactive', ...})` returning a
   `{kind:'pty', argv: resumeArgv, env, cwd}` `PaneSpec`.
2. Flip the resume failure-mode tests to assert `emitBanner({kind:'error', text: refusal})`
   instead of the current `respawnCatInline` of the refusal text.
3. Flip the resume-launcher-mocked assertions to `splitPane(scratch,
   resumeArgv) + swapPane` instead of `respawnPane(resumeArgv) on
   right pane`.

If the user prefers U6 to fully own this scope (and you have time),
revisit — but the deferral is intentional and the gate is green.

### New public surface from U6 (for the next agent to consume)

`RightPaneController.getPaneId(key: SourceKey): PaneId | undefined` —
returns the hidden pane id currently mapped to `key`, or `undefined`
when the key is not registered. Used by U6's `runInteractive` to wait
on `pane-exit-<hiddenPaneId>` after `registerSource` but before
`unregisterSource` kills the pane. U7 + U8 may not need it (their
register/unregister pairs don't bracket an external `waitFor`), but
it's a small, well-isolated accessor that's easy to reuse.

## Prior-handover deferrals still standing

These come from earlier handovers and are NOT U7/U8/U9/U10's primary
scope, but should be on the next agent's radar:

1. **From `2026-05-11-002-...-after-u4.md`:** the controller's
   `isRightPaneBusy?` option is still declared on
   `RightPaneControllerOptions`. With `inFlight` gone (U5), no caller
   populates it, so the legacy `dispatchEnter` busy gate is always
   false. **U8 should delete the option** when it flips
   `onIntent('enter')` to the new swap-based path (busy gate is
   structurally unnecessary in the swap model).
2. **From `2026-05-11-003-...-mid-u5.md`:** the legacy top-level shim
   at `src/hosts/two-pane/right-pane-controller.ts` (re-exports the
   pane-map version + the legacy helpers). **U10 owns deletion** once
   U8's `resolveReplaySpec` migration replaces the legacy
   `dispatchByKind` flow.
3. **From U5's mid-flight notes:** `pane: 'left'` on a `command()`
   step no longer fans bytes to the left pane (tee is the only sink).
   The left pane is owned by the steps-view daemon; command output
   never lived there in practice. **U10 should document this in
   `docs/getting-started.md`** if `pane: 'left'` was surfaced there.
4. **Open implementation question §3 from the mid-U5 handover** — the
   `step:complete` ordering (`unregisterSource` BEFORE `tee.close`)
   is in place. Worth an integration test in U10 cleanup, but not
   load-bearing.

## What's next — U7, U8, U9, U10

The plan's dependencies are unchanged. The next agent's mission is
U7 → U8 → U9 → U10, in that order. Each unit lands its own commit;
`bun run check` must be green at every commit (per CLAUDE.md rule 10
and the plan's stricture: "Each behavior-changing unit migrates its
own previously-passing tests in the same commit so check stays green
throughout").

### U7 — Rollup hidden pane + parallel-block lifecycle events

Read the
[U7 section of the plan](2026-05-11-001-feat-decouple-live-runner-unified-pane-map-plan.md#u7-wire-rollup-to-its-own-hidden-pane-add-parallel-block-lifecycle-events)
verbatim. Key transformations:

1. **Two new lifecycle events** in `src/core/workflow.ts`:
   `step:parallel-start` (fired once at the top of the `parallel(...)`
   wrapper before any branch starts) and `step:parallel-complete`
   (fired once after all branches settle). Carry a block id
   (deterministic counter). Existing `step:parallel-branch-update`
   continues to fire per-branch.
2. **In `tmux-host.ts`:**
   - On `step:parallel-start`: `tee.open('_rollup')` then
     `controller.registerSource({type:'rollup'}, {kind:'file-tail', path: teePathFor(logger,'_rollup')})`.
   - On `step:parallel-branch-update`: replace the **inline
     `enqueueRight(renderRollupPayload(...))`** still in tmux-host.ts
     (~line 680-700) with `tee.write('_rollup', renderRollupPayload(snapshot))`.
   - On `step:parallel-complete`: `controller.unregisterSource({type:'rollup'})`,
     `tee.close('_rollup')`, `rollup.reset()` — in that order.
3. **`StepName` brand check:** `'_rollup'` must be acceptable to
   `stepName(...)` (`src/core/types.ts`). Verify before writing tests.
4. **No prior tests to migrate** — rollup-on-right-pane assertions
   today piggyback on `enqueueRight` which is the only `sendKeys` path
   still on right pane after U5. U7 adds new tests rather than
   migrating existing ones.

**Verification:** No `enqueueRight(renderRollupPayload(...))` remains.
New `step:parallel-start` / `step:parallel-complete` events fire as
expected. Manual smoke on a parallel example shows rollup output in
its own swap-able pane.

### U8 — Past-step replay panes — warm-cache + edge-case wiring

Read the
[U8 section](2026-05-11-001-feat-decouple-live-runner-unified-pane-map-plan.md#u8-past-step-replay-panes--warm-cache-verification--edge-case-wiring).
Key transformations:

1. **Finalize `resolveReplaySpec(opts, step): Promise<PaneSpec>`** in
   `pane-map/right-pane-controller.ts`. Today the controller has
   `dispatchByKind` (still legacy `respawnPane`); replace it with a
   spec-returning function for each step kind. Branches per the plan:
   - agent/autonomous → `{kind:'file-tail', path: <logsDir>/agents/<stepName>/formatted_output.ansi}`
   - agent/interactive → resume-runner branch (U6 deferred — U8 owns
     it now per this handover's deviation note above).
   - command → `{kind:'file-tail', path: <command pane log path>}`
     or inline placeholder.
   - commit/worktree/ask → write `.replay/<safe>.txt`, then
     `{kind:'file-tail', path: <that file>}`.
2. **Flip `onIntent('enter')`** to `registerSource(replayKey, spec) +
   showSource(replayKey)`. Busy gate goes away (swap is safe by
   construction).
3. **Delete `isRightPaneBusy?` option** from
   `RightPaneControllerOptions` per prior-handover deferral §1 above.
4. **Test migrations (inline):**
   - `tests/integration/hosts/two-pane/right-pane-replay.integration.test.ts` (~6 respawnPane assertions)
   - `tests/integration/hosts/two-pane/right-pane-busy-gate.integration.test.ts` ("busy refusal" → "swap succeeded")
   - `tests/integration/hosts/two-pane/kind-details.integration.test.ts`
   - **U6's deferred resume tests** —
     `resume-launcher-mocked.integration.test.ts` + `resume-failure-mocked.integration.test.ts`
     get migrated here.

**Verification:** Migrated past-step replay tests pass with `swapPane`
assertions. Cold-vs-warm latency observable. `bun run check` green.

### U9 — Right-pane-source invariant guard test

Read the
[U9 section](2026-05-11-001-feat-decouple-live-runner-unified-pane-map-plan.md#u9-right-pane-source-invariant-guard-test).
Single-file deliverable:

1. `tests/integration/hosts/two-pane/right-pane-source-invariant.test.ts`
   — for each fixture's host, no `respawnPane` call has
   `target === rightPaneId`. The only allowed `respawnPane` targets
   are the left pane or scratch-session panes.
2. **Static check** in the same file (or a sibling): a regex
   assertion that `src/hosts/two-pane/` contains zero
   `respawnPane(...rightPaneId...)` invocations. Use `Bun.file().text()
   + regex`, NOT shell `grep` — cross-platform.

### U10 — Cleanup, docs, prior-doc archival

Read the
[U10 section](2026-05-11-001-feat-decouple-live-runner-unified-pane-map-plan.md#u10-cleanup-docs-and-prior-doc-archival).
Single commit:

1. **Delete** the top-level shim at
   `src/hosts/two-pane/right-pane-controller.ts` (legacy re-export
   wrapper). Confirm zero internal callers first.
2. **Update docs:**
   - `docs/getting-started.md` — short paragraph on the swap-target
     model.
   - `docs/logging.md` — new lifecycle event types (`pane-spawned`,
     `pane-killed`, `right-pane-swap`, etc.).
   - `docs/solutions/autonomous-transcript-rendering.md` — addendum
     on `tail -F` delivery channel.
   - `docs/solutions/interactive-mode-colors.md` — frontmatter status
     flip + pointer to pane-map design.
3. **Archive prior docs** with `status: superseded` +
   `superseded_by` frontmatter:
   - `docs/brainstorms/2026-05-06-...md`
   - `docs/brainstorms/2026-05-07-...md`
   - `docs/plans/2026-05-07-...md`
4. **Update active-phase pointer** in
   `docs/plans/implementation-phases.md`.

## How to verify the gate

```sh
bun run check                                                              # 0 failing

# Spot-check the U5/U6 commits:
bun test tests/integration/hosts/two-pane/right-pane-live-output.test.ts   # 5/5
bun test tests/integration/hosts/tmux-host-command-line.test.ts            # 4/4
bun test tests/unit/hosts/tmux-host.test.ts                                # 13/13
bun test tests/integration/hosts/two-pane-mocked.test.ts                   # 4/4
bun test tests/integration/hosts/two-pane-failure-and-parallel.test.ts     # 2/2
bun test tests/integration/hosts/two-pane-interactive.test.ts              # 1/1
bun test tests/integration/hosts/two-pane-sequential-runs.test.ts          # 3/3 (real tmux, gated on which('tmux'))
```

## Branch + commit policy

The user previously confirmed working directly on `main` (see
`2026-05-11-002-...-after-u4.md` § "Branch + commit policy").
**Continue on `main`** unless the user asks otherwise. Don't `git push`
without explicit user authorization. No attribution footer in commit
bodies (per prior handover convention).

## When stuck

- The plan is authoritative. If this handover conflicts with the plan,
  the plan wins.
- Don't "fix" prior-handover deferrals (U3/U4/U5/U6 carryovers) by
  changing already-committed code — those are scheduled units. The
  resume-via-pane-map migration noted above is scheduled for U8;
  don't try to land it earlier without strong reason.
- Each behavior-changing unit migrates its own previously-passing
  tests in the same commit. `bun run check` is green at every commit.
- Reading the prior handover docs (especially the
  [mid-U5](2026-05-11-003-feat-decouple-live-runner-unified-pane-map-handover-mid-u5.md)
  one's "Open implementation questions surfaced mid-U5" section) is
  worth the time.
