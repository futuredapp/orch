# 2026-05-20 — behavioral batch findings ledger

Triage notes for each Tier 5 behavioral cell. Three buckets:

- **Test/DSL bug** — fixed in the test or DSL; no product impact.
- **Missing observable seam** — DSL extension or narrow non-behavior-changing accessor.
- **Product bug** — written up here; cell either uses `it.todo` or
  `assertContractViolatedThroughout` (sentinel). Manual repro recorded.

Batch 1 result: **8 pass / 2 todo / 0 fail** across 10 cells.

Batches 2 + 3 result: **12 pass / 1 todo / 0 fail** across 13 cells (Groups D, E, F, G, H).

Combined Tier 5 lifecycle suite (existing lifecycle cells + Batch 1-3): **27 pass / 3 todo / 0 fail** across 30 cells.

---

## DSL bugs surfaced & fixed inline

### F-1 ScriptedFakeRunner snapshot reader treated `value !== undefined` as the completion signal

**Symptom:** `hasStepCompleted("plan")` failed with `actual=unknown` even though the row glyph had flipped to `✓` and the runner had exited 0.

**Root cause:** `tests/helpers/behavioral-dsl/internal/snapshot.ts:readStateJson` mapped step entries to `'completed'` only when `entry.value !== undefined`. But `state-store.saveStep` is what *writes* the entry, and it's called when the step terminates — `value` is whatever the agent returned (may legitimately be `undefined` for agent steps without structured output). Presence of the entry IS the completion signal.

**Fix:** Switched the heuristic to `entry.endedAt !== undefined` (the more reliable presence marker). Applied to both `snapshot.ts` and `awaits.ts:readStepStatus` (duplicated logic).

**Files:** `tests/helpers/behavioral-dsl/internal/snapshot.ts`, `tests/helpers/behavioral-dsl/awaits.ts`.

### F-2 `runArtifactExists` matcher pointed at the wrong directory

**Symptom:** `runArtifactExists('session', 'plan')` failed even though `session.json` was on disk.

**Root cause:** Matcher used `<stateDir>/agents/<step>/<filename>`. Actual `SessionLogger` layout is `<stateDir>/logs/agents/<step>/<filename>` (see `src/observability/file-session-logger.ts:69`).

**Fix:** Added the missing `logs/` segment.

**Files:** `tests/helpers/behavioral-dsl/filesystem-matchers.ts`.

### F-3 `ExternalTmuxProbe.pressKeyInPane` sent named keys as literal text

**Symptom:** `selectStep('plan')` could not detect cursor movement after pressing `Down`/`Up`. Underlying issue: `Down` was being sent as the 4-character string `"Down"` to the Ink child, not as the arrow-down keystroke.

**Root cause:** The probe unconditionally appended `-l` to `tmux send-keys`. With `-l`, tmux sends literal bytes — fine for single chars (`q`, `?`, `f`), wrong for named keys (`Enter`, `Up`, `Down`, `Escape`, …). Mirrors the same split that `tests/helpers/real-tmux/keys.ts` already handles for Tier 1.

**Fix:** Built a `NAMED_TMUX_KEYS` set in the probe; named keys go through `send-keys` *without* `-l`, literal chars keep `-l`.

**Files:** `tests/helpers/behavioral-dsl/internal/external-tmux-probe.ts`.

### F-4 Selection-highlight matcher used the wrong cursor glyph

**Symptom:** `stepIsHighlighted('plan')` always returned false.

**Root cause:** Matcher accepted `▸`, `▶`, `>` as selection markers. The actual Ink steps view renders the cursor as `▌` (see `src/hosts/two-pane/steps-view/steps-view.tsx:248`) — and only when `isUserDriven=true` (i.e., after the user has manually moved with ↑/↓; the initial automatic follow-the-live-step selection is invisible).

**Fix:** Replaced marker set with `['▌']` and documented the `isUserDriven` precondition in both the matcher and `selectStep`. Cells that need to detect highlight must press at least one arrow key first.

**Files:** `tests/helpers/behavioral-dsl/pane-matchers.ts`, `tests/helpers/behavioral-dsl/user-actions.ts`.

---

## Test-shape bugs surfaced & fixed inline

### T-1 Footer copy is conditional on workflow size

**Symptom:** `containsText('↑')` and `containsText('select')` failed on the
single-step launch cell.

**Observation:** A single-step workflow renders the abbreviated footer
`▶ live · ⏎ view step · q quit · ? help`. The `↑↓ select` and `f follow`
hints only appear when the steps list has > 1 entry.

**Fix:** Single-step launch cell asserts the abbreviated footer; the
multi-step variant in `three-step-linear` exercises the full footer.

**Files:** `tests/integration/lifecycle/launch.workflow-header-and-step-list-render.behavioral.real.test.ts`.

---

## Product bugs (do NOT patch — sentinel cells)

### P-1 `followLive()` does not refresh view mode

**Cell:** `nav.f-snaps-selection-back-to-live.behavioral.real.test.ts`
(currently `it.todo` pending product fix).

**Location:** `src/hosts/two-pane/pane-map/right-pane-controller.ts:422-456`.

**Behavior:** Pressing `f` to "snap to live" calls `followLive()`, which
swaps the right pane back to the truly-live source (correct), but does NOT
call `setViewMode({ mode: 'live' })`. The left-pane footer therefore
remains stuck on `⏸ viewing <step> · f live · …` even though the right
pane shows the live step's output. Other paths into live (e.g.
`dispatchEnter` on a running step, line 506) DO call `setViewMode` — so
the bug is local to `followLive`.

**Expected fix (one line):** Append `await setViewMode({ mode: 'live' })`
inside `followLive()` right after the successful `showSource(key)` call.

**Manual repro:**
1. Launch `behavioral-three-step-linear` via the harness, run plan to
   completion (so step 2 is the live step).
2. Select the completed plan row and press Enter — footer flips to
   `⏸ viewing plan`, right pane shows plan's transcript.
3. Press `f`.
4. Observe: right pane swaps to the live execute source (correct), footer
   stays on `⏸ viewing plan` (bug).

**Disposition:** Cell stays `it.todo` with explanatory comment. Restore
the cell body and remove the todo once `followLive` is patched.

---

## Cells deferred (not a product bug, but cannot run today)

### D-1 Interactive badge

**Cell:** `launch.interactive-badge-renders-on-interactive-step.behavioral.real.test.ts`
(`it.todo`).

**Reason:** ScriptedFakeRunner declares `supports.interactive = false`. A
fixture wired through scripted-fake will fail at construction when a step
is declared `mode: 'interactive'`. Tier 5 does not exercise real
Claude/Codex — that's Tier 4's job (`canRunRealTmuxE2E('codex' | 'claude')`).

**Options to restore:**
- Promote the cell to Tier 4 with the real Codex/Claude binary.
- Add a PTY-capable fake runner (out of scope for behavioral batch).

---

## Batch 2 + 3 — new findings

### F-5 Error banner unobservable at Tier 5

**Cell:** `banner.error-banner-persists-until-escape.behavioral.real.test.ts`
(`it.todo`).

**Reason:** The only `kind: 'error'` banner emit in two-pane host today
is `step:failed` (`src/hosts/two-pane/tmux-host.ts:740`). The CLI's
`execute-with-attach.ts:172-178` catch block calls `host.teardown()`
inside the same exception turn — tmux is destroyed within tens of
milliseconds, far below the probe's polling cadence (~75ms). The
behavior IS covered at Tier 1 with the in-process host
(`tests/integration/hosts/two-pane/tier-1/right-pane-visibility.test.ts`
and friends).

**To restore at Tier 5:** either expose a separate `emitBanner({ kind:
'error', ... })` test seam (would constitute a behavior change — out of
scope) or grow a `--keep-tui-on-failure` product mode that pauses
teardown until a user gesture.

### T-2 End-of-run + failure summary moved to durable signals

Group E (failures) and Group G (end-of-run) cells originally targeted the
visible pane state, but `--no-attach` + `execute-with-attach.ts` always
tears the host down within milliseconds of the workflow's terminal
status. The visible-pane assertion is intrinsically racy at Tier 5.

**Disposition:** the affected cells now assert against the durable
on-disk signals that prove the same code paths fired:

- `lifecycle.ndjson` `step:failed` + `run-ended` records;
- `state.json` `status` + per-step `endedAt`;
- per-step `formatted_output.ansi` tee file for failure-pane payload.

The visible-pane equivalents remain covered by Tier 1 (in-process host
tests). This is a Tier 5 charter clarification, not a product bug.

### F-6 (DSL) Stale `step:failed` shadowed completed steps on resume

**Symptom:** After resume, `awaitStepStatus('execute', 'completed')` and
the snapshot reader both reported `failed`, even though the resumed run
re-executed `execute` to completion. Root cause: the snapshot's lifecycle
augmentation treated *any* `step:failed` entry in `lifecycle.ndjson` as
authoritative.

**Fix:** state.json is now authoritative — a step with `endedAt` set is
`completed` regardless of prior `step:failed` lines. The lifecycle augmen-
tation only fires when state.json has no successful entry. Applied to
`snapshot.ts:readStateJson` and `awaits.ts:readStepStatus`.

**Files:** `tests/helpers/behavioral-dsl/internal/snapshot.ts`,
`tests/helpers/behavioral-dsl/awaits.ts`.

### F-7 (DSL seam) `initTempGitRepo` broke when it copied the fixture config

**Symptom:** `orch.config.ts not found` errors when launching worktree /
commit / agent-then-commit fixtures with `initGitRepo: true`.

**Root cause:** The initial implementation copied the fixture's
`orch.config.ts` verbatim into the temp repo. That file imports
`defineConfig` via a relative path (`../../../src/config/index.ts`) and
references workflow files by relative paths — both break after the copy.

**Fix:** `initTempGitRepo` now *synthesizes* a new `orch.config.ts` in
the temp repo. The synthesized config uses an absolute path to
`src/config/index.ts` and absolute paths to each fixture workflow file.
Implemented as `synthesizeRepoConfig` + `parseFixtureWorkflows` in
`tests/helpers/behavioral-dsl/internal/subprocess.ts`.

### F-8 (DSL seam) Launcher resume support

New affordance: `resumeOrchWorkflow(fromHandle, fixtureName, opts)` and
`SpawnOrchOptions.resumeFrom`. Reuses the original handle's state base +
repo, invokes `orch resume <runId>`, picks up a fresh control-file
directory for puppet steps that re-execute, and skips the rm step in
teardown (the original handle is still the owner).

Also updated the runId regex in `subprocess.ts` to match both the
`Running workflow "..." (r-...)` line (orch run) and the
`Resuming run r-...` line (orch resume).

**Files:** `tests/helpers/behavioral-dsl/internal/subprocess.ts`,
`tests/helpers/behavioral-dsl/launch.ts`,
`tests/helpers/behavioral-dsl/index.ts`.

### F-9 (DSL) `hasStepFailed` matcher + snapshot step-status augmentation

`state-store.saveStep` is *not* called when a step throws
(`workflow.ts:1235-1252`), so a failed step's entry never lands in
`state.json`. The snapshot now augments per-step status by reading
`logs/lifecycle.ndjson` for `step:failed` lines and reporting `failed`.
A new `hasStepFailed(stepName)` workflow matcher reads cleaner in cells.

**Files:** `tests/helpers/behavioral-dsl/internal/snapshot.ts`,
`tests/helpers/behavioral-dsl/workflow-matchers.ts`,
`tests/helpers/behavioral-dsl/index.ts`.
