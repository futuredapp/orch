# Fix Group 6 — Test rigor: prove routing/rendering, not stderr substrings

**Status: done** · No product code changed (test-only group).

## What the group called for

Two AT-claiming tests passed today for weaker reasons than their AT (they asserted an
implementation proxy, not the behavior). Per Group 6's north star — "assert the projected
view, not a proxy" — both were hardened so a real regression is caught.

## What I changed

### H1 — AT-1 "opens in the read-only viewer" was proven only by an stderr substring

`tests/integration/cli/commands/resume-finished.test.ts`

- The completed-open test asserted `stderr` contained `'read-only view'` — the literal
  `process.stderr.write('… read-only view…')` at the top of `openFinished`. That proves only the
  routing **branch** was entered; a viewer that rendered nothing would still pass.
- Added a `makeViewerSpyHost()` (records `attachedForeground()` + `runnerTouched()`) and rewrote the
  test as a **routing** test: it now asserts the viewer's foreground was **attached** (so it
  survives a copy change) and that **no step executed** (read-only), exactly as
  `open-finished.test.ts` asserts for the leaf path. The stderr-literal assertion is gone.
- The rendered-view assertion stays in the gated real-tmux test; reflected the routing/rendering
  split in the AT-1 status row (now `✅ routing + 🟡 rendering`, with a Note).
- `VIEWER_HOST_FACTORY` is unchanged and still used by the crashed/running regression cases.

### H2 — AT-R10 "a later `orch resume` re-routes to the right view" was bypassed

`tests/integration/cli/commands/open-failed.test.ts` and `tests/integration/cli/commands/retry.test.ts`

- The two completed-reopen AT-R10 tests re-invoked the **leaf** `openFinished` with a hand-passed
  `status: 'completed'`, bypassing the thing AT-R10 protects: that a subsequent `resumeCmd`
  **re-loads** the now-`completed` state and *decides* to route it to `openFinished` (not
  `openFailed`/a re-run).
- Converted both reopens to drive the **real `resumeCmd(deps, FAILED_ID, {}, TWO_PANE_OPTS, …)`**.
  Each now asserts the read-only branch was taken — stderr contains `(completed)` **and**
  `read-only view` (the banner the routing emits), the runner boundary is untouched, and the
  invocation count is unchanged — in addition to the prior exit-0 / status-unchanged assertions.
- Added a small `captureStderr()`/`restoreStderr` helper to each file (mirrors the one in
  `resume-finished.test.ts`) and an `afterEach` restore. Added the `resumeCmd` import and removed the
  now-unused `openFinished` import from each.
- These re-routes resolve the run from the registry (proven discoverable by the existing AT-20
  failed-half test) and need no `orch.config.ts`, since `completed → openFinished` carries no
  executor load. Left the **AT-R10a** parked-failed reopen (`open-failed.test.ts`) on `openFailed`:
  it reopens as `failed` and legitimately needs the injected `loaded` workflow (routing it through
  `resumeCmd` would hit `loadWorkflow` with no config); Group 1 already strengthened it with the
  projector assertion.

## Verification

- `bun test` on the three touched files: **24 pass / 0 fail**.
- `bun run check` (lint + typecheck + unit/mocked-integration + two-pane:lifecycle + migration):
  **green, exit 0**.

## Issues hit

None. The conversions were mechanical once it was confirmed that (a) the executed failed run is
registry-discoverable for `resumeCmd`'s prefix resolution, and (b) the completed re-route path
needs no workflow config. Both held.

## Status after this group

All 6 groups of `fix-plan.md` are now `Status: done`.
