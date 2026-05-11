---
date: 2026-05-11
topic: decouple-live-runner-unified-pane-map
status: brainstorm — supersedes the 2026-05-06 + 2026-05-07 brainstorms and the 2026-05-07 Phase 1 plan
supersedes:
  - docs/brainstorms/2026-05-06-feat-decouple-live-runner-from-right-pane-brainstorm.md
  - docs/brainstorms/2026-05-07-feat-decouple-live-runner-from-right-pane-second-pass-brainstorm.md
  - docs/plans/2026-05-07-feat-decouple-live-runner-from-right-pane-phase-1-plan.md
---

# Decouple Live Runner From Right Pane — Unified Pane-Map

## What This Supersedes

The earlier passes designed a staged Phase 1 (`tail -f` via `respawn-pane`) + Phase 2 (`swap-pane` for interactive), with a `RightPaneSource` discriminated union (`cat-file` | `tail-file` | `swap-pane`) tying them together. Two findings flipped that:

1. **The staged split is paying a complexity tax for a benefit that doesn't apply here.** The argument for shipping Phase 1 first is "land the autonomous win sooner, gather UX evidence, then commit to hidden-pane infrastructure in Phase 2." With an agent doing the implementation in roughly one week either way, and a single user (the author) for now, there's no audience to gather evidence from between phases. The split is pure carrying cost.
2. **The `RightPaneSource` union is two ideas glued together.** "What content shows in the pane" (cat / tail / PTY) is being conflated with "which tmux primitive moves it" (`respawn-pane` vs `swap-pane`). When you put everything in panes, mechanism disappears as a variable — there's exactly one move (`swap-pane`), and the union dissolves.

This brainstorm picks the unified design that the second-pass brainstorm was half-reaching for, and answers the open questions the prior passes deferred to "Phase 2 plan."

## Core Design

```
main session (attached to user):     scratch session (no clients):
┌──────┬──────────┐                  ┌──────────────────────────────┐
│ left │ visible  │                  │ hidden:placeholder           │
│ pane │ right    │  ◄── swap-pane ──┤ hidden:live:<step-A>         │
│      │ (slot)   │                  │ hidden:replay:<step-2>       │
└──────┴──────────┘                  │ hidden:interactive:<step-B>  │
                                     │ hidden:rollup                │
                                     └──────────────────────────────┘
```

**One mechanism.** Every change to "what the user sees on the right" is `tmux swap-pane -s <hidden> -t <visible>`. No more `respawn-pane` for content swaps. No more `sendKeys` for UI text into the visible slot.

**Two pane archetypes** at spawn time. After spawn, the controller doesn't branch on archetype — it just owns a `Map<SourceKey, PaneId>` and a `swap-pane` call.

```ts
type PaneSpec =
  | { kind: 'file-tail'; path: Path }   // tail -n +1 -f <path>
  | { kind: 'pty'; argv: readonly string[] }
```

`file-tail` covers everything non-interactive: live autonomous tees, completed-step replays, the empty/idle placeholder, kind-details payloads. `pty` is interactive runners only. The completed-tee case and the live-tee case use the *same* command — `tail -n +1 -f` idles harmlessly after the file is closed, so revisiting a finished step's replay is a no-op swap onto an already-warm pane.

## Resolved Questions

- **Q: How many phases?**
  A: One. No Phase 1/Phase 2 split. The "ship sooner" benefit is illusory at this project's scale; the staged abstraction is speculative complexity.

- **Q: Where do hidden panes live?**
  A: A scratch tmux session, sibling to the user-attached main session. No clients ever attach to it. `swap-pane` works cross-session with full address syntax. Invisible from the user's window list.

- **Q: What runs inside each pane?**
  A: Two archetypes — `file-tail` (`tail -n +1 -f <path>`) and `pty` (runner subprocess). Replaces today's three (`cat`, `tail`, runner-sendKeys-to-pane).

- **Q: Lifecycle for live panes?**
  A: Spawn on `step:start`, kill on `step:complete` / `step:failed`. Autonomous and interactive use the same lifecycle hooks. Interactive's "until user double-Ctrl-Cs" semantics are implicit — the runner handles Ctrl-C, exits, and emits a normal lifecycle event the host already observes.

- **Q: Lifecycle for replay panes?**
  A: Spawn on first view (user presses Enter on a past step). Keep alive until orch session teardown. Subsequent revisits are instant swaps, no respawn. Bounded by step count — one pane per step opened, max.

- **Q: Failure summary placement?**
  A: Appended to the tee before close. `tail -f` inside the pane picks it up naturally. No separate side-channel. Carryover from the second-pass brainstorm, unchanged.

- **Q: Banner + view indicator?**
  A: Both ship on `StepsViewState` exactly as the second-pass brainstorm specified. Single-slot last-write-wins banner with `info` (TTL) and `error` (persists until replaced or `Esc`). Separate persistent `view: { mode: 'live' | { mode: 'replay'; stepName } }` indicator. Carryover, unchanged.

- **Q: `f` keybind?**
  A: `controller.followLive()` — swap to the most-recently-registered live source. If none, swap to the placeholder. Same semantics the second-pass brainstorm proposed; just the underlying move is `swap-pane`, not `respawn-pane`.

- **Q: Rollup (parallel branch fan-out)?**
  A: **Must move into the pane map.** Today's `enqueueRight(rollupPayload)` writes to the visible pane via `sendKeys`. Under the swap-model, when the user is on a swapped-in replay, those sendKeys would corrupt the replay. Fix: rollup gets its own hidden pane in the scratch session; the host renders rollup output by writing into a rollup tee file (same shape as autonomous tees) and the hidden pane `tail -f`'s it. The "leave rollup alone" carryover from the second-pass plan no longer applies — the unified model exposes the corruption hazard the staged model hid.

- **Q: Cached steps?**
  A: No pane spawned. UI shows "this step was cached — no transcript captured" without swapping. Trivial: footer / banner text rather than a backing pane.

- **Q: pane-queue?**
  A: Extend from single-pane locking to multi-pane locking for `swap-pane` (lock source + target, swap, release). Modest extension. No behavior change for callers that lock a single pane.

- **Q: Scratch session dimensions?**
  A: Sized to match the visible right pane at scratch-session creation. On terminal resize, the host's existing resize handler propagates to the scratch session in parallel. Ensures `tail -f`'d ANSI and PTY content render correctly after swap.

## Carry-Forward From Prior Passes (Unchanged)

These decisions stand exactly as the second-pass brainstorm framed them; the unified model doesn't disturb them:

- Banner state shape `{ kind: 'info' | 'error', text, ttlMs? }`. Info default TTL ~4s. Errors persist until replaced or `Esc`.
- Persistent `view.mode` field separate from transient `banner`. Footer derives from `view.mode`; banner is independent.
- Auto-follow-on-new-step-start = **no**. Stay on the user's current view, emit an info banner ("step N running — press f to follow").
- Resume-failure → `error` banner, not text-into-pane.
- `Esc` dismisses `error` banner, with priority below help-overlay-close.
- Cached steps are no-ops for live registration.

## What Replaces the `RightPaneSource` Union

```ts
// Source identity = a stable key chosen by the host.
type SourceKey =
  | { type: 'live'; stepName: string }
  | { type: 'replay'; stepName: string }
  | { type: 'rollup' }
  | { type: 'interactive'; stepName: string }
  | { type: 'placeholder' }

// Controller-owned state:
class RightPaneController {
  visiblePaneId: PaneId
  scratchSession: SessionId
  panes: Map<SourceKey, PaneId>   // hidden panes in scratchSession
  currentKey: SourceKey | null     // which source is swapped into visible
  viewMode: 'live' | { mode: 'replay'; stepName: string }

  registerSource(key, spec): Promise<void>   // spawn hidden pane
  showSource(key): Promise<void>             // swap-pane visible ↔ panes.get(key)
  unregisterSource(key): Promise<void>       // kill hidden pane
  followLive(): Promise<void>                // showSource(latest-registered-live-key)
}
```

The host (tmux-host) drives lifecycle:

- `step:start` (autonomous + !cached) → `registerSource({type:'live', stepName}, {kind:'file-tail', path:<tee>})`. If `view.mode === 'live'`, auto-`showSource` to the new key. Otherwise emit info banner.
- `step:start` (interactive) → `registerSource({type:'interactive', stepName}, {kind:'pty', argv})`. Same auto-promote rule.
- `step:complete` / `step:failed` → `unregisterSource(matching live or interactive key)`. Replay panes (if any) remain warm.
- Enter on a past step → if `panes.has({type:'replay', stepName})` then `showSource(key)`; else `registerSource(key, {kind:'file-tail', path:<past-tee>})` then `showSource`.
- `f` → `followLive()`.
- Parallel rollup → `registerSource({type:'rollup'}, {kind:'file-tail', path:<rollup-tee>})` once at parallel-start; host writes to the rollup tee instead of `enqueueRight`.

## Trade-offs Acknowledged

**What gets harder vs. the staged plan:**
- The hidden-pane host (scratch session) is now table stakes from day one. The staged plan deferred it.
- Resize semantics for the scratch session must be handled; the staged plan didn't have a hidden host so it didn't have to think about this.
- More tmux state in steady-state — one pane per active source. Bounded by step count + open replays + 1 rollup + 1 interactive + 1 placeholder. Well under any reasonable tmux limit.
- `pane-queue` grows a multi-pane lock variant.

**What gets easier:**
- One mechanism (`swap-pane`), not two. No discriminated union of "mechanism inside the source kind."
- Live and replay are the same pane shape — the file is the same file, just at different write states. No special-case code for "switching from live to replay" or vice versa.
- Past-step Enter mid-flight needs no busy gate by construction. `swap-pane` is atomic and never kills the live pane.
- Replay revisits are instant (warm pane), without a config dependency (`remain-on-exit`) or asymmetry.
- Command panes, rollup, and parallel-branch panes all fit the same map. The original plan had separate code paths for each.

**What stays risky:**
- If the scratch session approach has unforeseen edge cases (some tmux configs blocking cross-session swap, terminal-emulator-specific redraw glitches after swap, etc.), there's no graceful fallback — there's no "just respawn" path anymore. Mitigation: real-tmux integration test exercises the scratch-session + swap-pane path before merge; if it works on the dev machine's tmux + iTerm/Ghostty combo, it'll work for the user.
- Hidden pane dimensions can drift from visible if a terminal resize races a swap. Mitigation: re-resize hidden-host window on every terminal-resize event, before the next swap.

## Out of Scope (Explicit Non-Goals)

- **Switcher UX for multiple live panes** (parallel — `[1][2][3]` cycling, footer treatment for "3 live branches"). The map supports it; the keybinding scheme and UI ship separately when parallel work starts.
- **LRU eviction for replay panes.** Bounded-by-step-count is fine for orch's scale.
- **Hot-recover if scratch session dies.** Assume it's stable; if it crashes, fail loud with a clear error.
- **Live preview of an interactive runner while user is viewing a replay** (i.e., picture-in-picture). Just doesn't ship.

## Open Questions for the Planning Doc

These are implementation choices the brainstorm doesn't need to pre-decide:

1. **Scratch-session naming.** Per-run (`<runId>-scratch`) vs stable across runs (`orch-scratch`). Per-run is safer (clean teardown); stable saves a session start/stop per run. Lean: per-run.
2. **Where to write the rollup tee.** Sibling to per-step tees (`<logsDir>/agents/_rollup/formatted_output.ansi`) or its own location.
3. **Test fixture migration.** Every existing test that asserts a `respawnPane` argv on the right pane needs to flip to asserting a `swapPane` call instead. Audit + bulk refactor.
4. **Cached-step "no transcript" UX.** Banner-only, or also a placeholder pane swap? Lean: banner-only, no swap (visible pane stays where it was).
5. **Whether to keep the second-pass brainstorm + Phase 1 plan as `superseded` references or move them to a `docs/archive/` folder.** Author preference.

## Next Steps

→ `/ce-plan` against this brainstorm. The plan will cover scratch-session lifecycle, pane spawn/kill mechanics in the new tmux service operations needed, `pane-queue` multi-pane lock extension, resize plumbing, test-fixture migration, and the host's `registerSource`/`unregisterSource` wiring at each lifecycle event.

→ When planning is done, archive (or annotate as `superseded`) the prior two brainstorms and the Phase 1 plan so future readers don't follow the wrong thread.
