---
date: 2026-05-07
topic: decouple-live-runner-from-right-pane-second-pass
status: brainstorm — addendum to 2026-05-06-feat-decouple-live-runner-from-right-pane-brainstorm.md
extends: 2026-05-06-feat-decouple-live-runner-from-right-pane-brainstorm.md
---

# Decouple Live Runner From Right Pane — Second Pass

## What This Is

A targeted second pass over [`2026-05-06-feat-decouple-live-runner-from-right-pane-brainstorm.md`](./2026-05-06-feat-decouple-live-runner-from-right-pane-brainstorm.md), re-reading the design with one explicit lens the first pass under-explored:

**Future-proofing for parallel runs and any other Phase-N right-pane content swap.**

The original brainstorm picks the right end-state (Phase 1: tail-f autonomous; Phase 2: hidden-pane swap for interactive) but treats each phase as inventing its own mechanism. Parallel runs add 1+ more "source kinds" (rollup, per-branch transcripts), and we don't want each new source to require ad-hoc wiring in `right-pane-controller`.

The original brainstorm stands. This addendum names the abstraction the original implies, pins ownership of "currently displayed source" state, and resolves a handful of Phase-1 wrinkles the first pass left open (failure summary placement, banner lifecycle, view indicator).

## What Changes vs. the Original

### 1. Name the abstraction now: `RightPaneSource` (new)

The original brainstorm describes Phase 1 = tail-f and Phase 2 = swap-pane as if they were two different mechanisms. They aren't — they're two values of the same idea: "the visible right pane is a viewer of some swappable source." Naming it now costs ~10 lines and means Phase 2 + parallel are additive (new variants), not migrations.

```ts
type RightPaneSource =
  | { kind: 'cat-file'; path: Path }   // replay, kind-details, command-pane log
  | { kind: 'tail-file'; path: Path }  // live autonomous (Phase 1)
  // Phase 2 adds:
  // | { kind: 'swap-pane'; hidden: PaneId }
  // Parallel pass later adds:
  // | { kind: 'tail-file'; path: <rollup-tee> }   // already covered by tail-file
  // | { kind: 'tail-file'; path: <branch-tee> }   // already covered by tail-file
```

The controller exposes one seam:

```ts
controller.showSource(src)   // resolve src → respawn-pane (cat | tail) or swap-pane
controller.followLive()       // pick the latest registered live source
```

Phase 2 adds the `swap-pane` variant and the case in `showSource`. Parallel adds nothing new to the union — branch tees and rollup tees are just more `tail-file` sources.

### 2. Pin ownership: controller owns `currentSource`; host registers live sources (new)

The original brainstorm threads `isRightPaneBusy()` from host to controller as a single boolean. That works for the singleton-live-step case but doesn't scale to parallel (N live steps → N live sources). Replace it with a registration model:

```ts
// Host side (per-step lifecycle, keyed by stepName so parallel fans out naturally):
ctrl.registerLiveSource(stepName, { kind: 'tail-file', path: teePath })  // step:start (autonomous)
ctrl.unregisterLiveSource(stepName)                                       // step:complete | step:failed

// Phase 2 (interactive):
ctrl.registerLiveSource(stepName, { kind: 'swap-pane', hidden: hiddenPaneId })

// Controller side:
ctrl.showSource(src)
ctrl.followLive()  // resolve to most-recently-registered live source today
```

The `liveSources` map is keyed by stepName from day one. Sequential runs have ≤1 entry; parallel runs have N entries; the abstraction doesn't care.

`followLive()` is documented as **"pick latest registered"** for v1. When parallel work happens, this is the extension point for a switcher UI (`1`/`2`/`3` cycling among live sources). No keybind change in Phase 1; no contract change later.

### 3. Phase 1 leaves the parallel rollup alone (new)

Today, `RollupAggregator` (in-memory, in `tmux-host.ts:529`) renders snapshots and pushes them to the right pane via `enqueueRight(...)` (sendKeys). Per-branch transcripts also flow via sendKeys; both interleave with each other on the same pane (acknowledged at `tmux-host.ts:603` as v1 behavior).

Phase 1 explicitly **does not touch rollup**. Reasons:

- Rollup correctness is unchanged from today — Phase 1 doesn't make it worse.
- Reifying rollup into a tee-file source pulls in decisions about rollup-vs-replay coexistence and rollup-vs-branch view selection that Phase 1 doesn't otherwise need.
- The `RightPaneSource` abstraction is forward-compatible: when parallel work starts, rollup gets its own tee, branches get registered as `tail-file` sources, and a switcher UI is layered on top. **No existing Phase-1 code has to be torn out.**

Future "switcher for multiple live panes" UX (your note): rollup is the default `f` target during a parallel block; `←/→` (or `1`/`2`/`3`) cycles to one specific branch's live tee. Same source union; additive UI.

### 4. `step:failed` summary lands in the per-step tee (new)

Today `enqueueRight(renderFailurePanePayload(summary))` pushes the failure summary to the right pane via sendKeys. After Phase 1 the right pane is `tail -f <step.tee>`, so sendKeys to that pane fights `tail`.

Decision: failure summary is appended to the per-step tee as the last bytes before `tee.close(stepName)`. The `tail -f` viewer renders it naturally; replay (`cat <tee>`) shows it too — failure becomes part of the step's transcript instead of a separate side-channel.

```ts
onLifecycleEvent(step:failed):
  tee.write(stepName, renderFailurePanePayload(...))
  tee.close(stepName)
  // No more enqueueRight for the failure summary.
```

### 5. Banner lifecycle: last-write-wins, info has TTL, errors persist (new)

The original brainstorm pinned the data shape (`{ kind: 'info' | 'error', text: string, ttlMs?: number }`) but left lifecycle open. Pinning now:

- Single banner slot. New banner replaces old. No queue, no stack.
- `kind: 'info'` auto-clears after `ttlMs` (default ~4s).
- `kind: 'error'` stays until **either** replaced by the next banner **or** dismissed by `Esc`.
- Host writes banners via the same projection path that feeds `StepsViewState` (no new event channel).

Triggers covered: resume failure, replay-blocked refusal (interim Phase-1 only), "step N running — press f to follow," replay dispatch errors.

### 6. Separate the persistent view indicator from the transient banner (new — supersedes original §Key Decisions banner state)

The original brainstorm conflated two things in the banner field:

- "Resume failed" / "step N running" → **transient message** (banner).
- "Viewing step 3 — press f for live" → **persistent view state** (until you press `f`).

A TTL-expiring banner that represents persistent state will disappear while still being true. Split them:

```
footer:  ⏸ viewing step 3 · f live · q quit          ← persistent, derived from view.mode
banner:  ⚠ resume failed — binary not on PATH         ← transient, user-acknowledgeable
```

`StepsViewState` projection adds:

```ts
view: { mode: 'live' } | { mode: 'replay'; stepName: string }
banner?: { kind: 'info' | 'error'; text: string; ttlMs?: number }
```

Footer/header reads `view.mode`; banner is independent. The Ink renderer composes both.

## New Resolved Questions

- **Q: How do we name the producer-vs-viewer split so future swaps are cheap?**
  A: `RightPaneSource` discriminated union. Phase 1 ships `cat-file` + `tail-file`. Phase 2 adds `swap-pane`. Parallel adds nothing new — branch tees and rollup tee are just more `tail-file` sources.

- **Q: Where does "currently displayed source" live?**
  A: Right-pane-controller owns `currentSource`. Host registers/unregisters live sources keyed by stepName via `registerLiveSource(stepName, src)` / `unregisterLiveSource(stepName)`. The `liveSources` map naturally fans out from 1 (sequential) to N (parallel) without a contract change.

- **Q: Does Phase 1 need to fix the parallel rollup?**
  A: No. Rollup keeps using sendKeys-into-pane; correctness is unchanged from today. Parallel pass later adds rollup-tee + per-branch sources to the same union; switcher UI is additive.

- **Q: Where does the `step:failed` summary go after autonomous becomes tail-f?**
  A: Appended to the per-step tee as the last bytes before tee close. Replay carries it; tail -f renders it; no sendKeys race against tail.

- **Q: What's the banner's lifecycle?**
  A: Last-write-wins single slot. `kind: 'info'` auto-clears after `ttlMs` (~4s default). `kind: 'error'` persists until replaced or Esc.

- **Q: Is "viewing step 3" a banner or an indicator?**
  A: Indicator. Persistent footer reads `view.mode` from the projection. Banner is transient only.

## New Open Questions (carry over from original or surfaced here)

1. **`registerLiveSource` semantics during cached steps.** Cached steps don't run on the right pane (per `tmux-host.ts:582-587`). Should `register` be called for them at all? Leaning: no — cached steps are a no-op for the controller. Confirm in plan.

2. **`Esc` to dismiss error banners.** Plan needs to wire `Esc` into the steps-view input handler. Conflicts with no current binding. Confirm `Esc` is free.

3. **Rollup-during-parallel + Phase 1 view indicator.** While parallel rollup is writing to the visible pane via sendKeys (unchanged from today) and the user is "viewing live," what does the footer say? Leaning: `▶ live (parallel: 3 branches)` as a derived label; no new state needed because all branches are registered as live sources. Confirm in plan once the projection contract is sketched.

4. **Carryover from original — still deferred to Phase 2 plan:** hidden-pane location for interactive, resize handling for swapped pane, behavior when interactive runner exits while user is on a replay.

## What's Explicitly NOT Explored Here

- **Phase 2 internals.** Hidden-pane lifecycle, resize semantics, swap-pane-vs-paneQueue interactions — all deferred to the Phase 2 plan as the original brainstorm intends.
- **Switcher UI for parallel.** Designed-around (the source abstraction supports it) but not specified. Lives with the parallel-pass work.
- **Banner queue / priority.** YAGNI — single slot covers all known triggers.

## Next Steps

→ `/workflows:plan` for Phase 1, incorporating decisions from **both** brainstorms:

- Original: tail-f autonomous decouple, banner primitive, Phase 1/2 split.
- This addendum: `RightPaneSource` union, controller-owned `currentSource`, host-registered live sources keyed by stepName, leave rollup alone, failure summary into tee, last-write-wins banner with `info`/`error` distinction, separate persistent view indicator from transient banner.

→ Phase 2 plan stays a separate pass once Phase 1 lands and the carryover open questions have UX evidence.
