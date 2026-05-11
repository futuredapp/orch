---
title: Decouple Live Runner From Right Pane — Unified Pane-Map
type: feat
status: active
date: 2026-05-11
origin: docs/brainstorms/2026-05-11-feat-decouple-live-runner-unified-pane-map-brainstorm.md
supersedes:
  - docs/plans/2026-05-07-feat-decouple-live-runner-from-right-pane-phase-1-plan.md
---

# Decouple Live Runner From Right Pane — Unified Pane-Map

## Summary

Replace today's three right-pane mechanisms (`cat <file>`, `sendKeys <bytes>`, runner-`respawnPane`) with **one mechanism** (`tmux swap-pane`) and **two pane archetypes** (`file-tail` and `pty`). Every piece of content the user sees on the right is owned by a hidden pane in a sibling scratch tmux session; the visible right pane swaps with one of those hidden panes whenever the controller decides "show source X." Past-step replay, live autonomous tee, interactive runner PTY, parallel rollup, and the empty placeholder all collapse into one `Map<SourceKey, PaneId>` indexed by a discriminated `SourceKey` (see origin: `docs/brainstorms/2026-05-11-feat-decouple-live-runner-unified-pane-map-brainstorm.md`).

The work is **one delivery**, no Phase 1 / Phase 2 split — the staged plan's "ship sooner" benefit doesn't apply at orch's current scale (single user, agent-driven implementation, ~one week either way). It lands as ordered sub-phases inside a single feature branch. Each behavior-changing unit (U5, U6, U7, U8) migrates its own previously-passing tests in the same commit so `bun run check` stays green at every commit — U9 narrows to a single invariant-guard test rather than a centralized end-of-plan migration.

## Problem Frame

Today (`src/hosts/two-pane/tmux-host.ts:540-647`, `src/hosts/two-pane/right-pane-controller.ts`):

- **Three mechanisms cohabit one pane.** Autonomous transcript goes via `sendKeys` (`tmux-host.ts:639-647`). Past-step replay goes via `respawnPane(['cat', file])` (`right-pane-controller.ts:273`). Interactive runners go via `respawnPane(runnerArgv)` directly on `rightPaneId` (`tmux-host.ts:674`). Failure summaries piggyback on `enqueueRight` (`tmux-host.ts:596`). Rollup payloads piggyback on `enqueueRight` (`tmux-host.ts:611`). Each new content kind invents its own seam.
- **Past-step Enter is gated mid-flight** (`right-pane-controller.ts:140-145`). The `isRightPaneBusy` boolean (`right-pane-controller.ts:67-68`, backed by `tmux-host.ts:582-587` `inFlight` set) refuses Enter while a live step is rendering, because un-gated `respawnPane(['cat',…])` would kill the live `cat` placeholder mid-stream.
- **UI text corrupts runner streams.** `writeBusyFooter` (`right-pane-controller.ts:123-136`) and the resume-failure refusal at `:347-351` deliver UI strings via `sendKeys` into the right pane. They corrupt whatever transcript is rendering and have no lifecycle (the user can't dismiss them; the next respawn just hides them).
- **Rollup-vs-replay corruption hazard is latent.** Today rollup sendKeys lands on the live right pane unconditionally; the user never has anything else swapped in, so corruption is invisible. The moment any swap-pane–style replay arrives, rollup's `enqueueRight(renderRollupPayload(...))` (`tmux-host.ts:611`) writes into the replay.
- **Two pty-echo / sendKeys bugs are baked in.** The repro test at `tests/integration/hosts/two-pane/right-pane-live-doubling.real.integration.test.ts` documents the `send-keys -l` echo-doubling that bites ANSI-bearing transcripts. Moving live autonomous to `tail -f <file>` (no pty stdin) sidesteps it.

The staged Phase 1 plan (`docs/plans/2026-05-07-feat-decouple-live-runner-from-right-pane-phase-1-plan.md`) named the abstraction (`RightPaneSource = cat-file | tail-file`) but kept two mechanisms (`respawn-pane` for content, plus a future `swap-pane` for interactive in Phase 2). The unified design observes that "what content" (`file-tail` vs `pty`) and "what mechanism" (`respawn-pane` vs `swap-pane`) were two ideas glued together — when everything lives in a hidden pane, mechanism disappears as a variable.

---

## Out of Scope

These are explicitly **not** part of this plan, per the origin's "Out of Scope" section:

- **Switcher UX for parallel live panes** (`[1][2][3]` cycling, "3 live branches" footer treatment). The pane map supports it structurally; the keybind scheme and Ink rendering ship separately when parallel work starts.
- **LRU eviction for replay panes.** Bounded-by-step-count is fine at orch's scale.
- **Hot-recover if the scratch session dies.** Assume stability; fail loud on crash.
- **Picture-in-picture** (preview of a live interactive while user is on replay).
- **Plain-host changes.** This plan only touches `src/hosts/two-pane/`. The plain host stays on its `renderTranscriptLine` → stdout path.

### Deferred to Follow-Up Work

- **Solution doc for the pane-queue multi-pane lock semantics** (deadlock ordering, lock granularity). Worth writing once the design has stabilized in production — captured via `/ce-compound` as a follow-up.

---

## Key Technical Decisions

1. **One scratch session per run, sibling to the user-attached `orch` session.** Session name `orch-scratch` inside the per-run socket `orch-<runId>` (`tmux-host.ts:198`). Created right after `splitPane` returns the visible right pane; killed before the `orch` session at teardown so hidden panes can't outlive their swap target. Per-run is safer than stable-across-runs (clean teardown, no cross-run leaks); the per-run socket already isolates state, so a per-run session is the matching scope.
2. **Two pane archetypes at spawn time.** `PaneSpec = { kind: 'file-tail'; path: Path } | { kind: 'pty'; argv: readonly string[]; env?; cwd? }`. After spawn, the controller doesn't branch on archetype — it just owns a `Map<SourceKey, PaneId>` and a `swapPane` call. `file-tail` covers autonomous live, completed-step replays, kind-details, rollup, placeholder, **and command-step live** (command bytes already flow to the per-step tee at `tmux-host.ts:563`). `pty` covers interactive runners only.
3. **`SourceKey` is a discriminated union, not a string.** Variants: `{type:'live',stepName}`, `{type:'replay',stepName}`, `{type:'rollup'}`, `{type:'interactive',stepName}`, `{type:'placeholder'}`. The Map keys on a structural-equality function (or a deterministic stringify helper) — type-safety bias over string-comparison bugs.
4. **Lifecycle: spawn on `step:start`, kill on `step:complete`/`step:failed`.** Autonomous and interactive share lifecycle hooks. Interactive's "until user double-Ctrl-Cs" semantics are implicit — the runner exits, the global `pane-died` hook (`session-init.ts:117-122`) fires `pane-exit-<paneId>` cross-session, and the host's existing `tmux.waitFor` unblocks normally.
5. **Replay panes are warm-cached.** Spawn on first view (Enter on a past step); kept alive until session teardown. Subsequent revisits are O(1) — `panes.has(key)` → `swapPane`. Bounded by step count.
6. **Failure summary lives in the tee, not a side channel.** Append `renderFailurePanePayload(summary)` to `<logsDir>/agents/<stepName>/formatted_output.ansi` before `tee.close`. The hidden `tail -f` picks it up naturally; replay sees the same bytes. No more `enqueueRight(renderFailurePanePayload(...))`.
7. **Rollup gets its own hidden pane and tee.** Tee location: `<logsDir>/agents/_rollup/formatted_output.ansi` (sibling to per-step tees). Registered as `{type:'rollup'}` source at parallel-block start. `RollupAggregator.apply` continues to produce `renderRollupPayload(snapshot)`, but the host writes the payload to the rollup tee instead of `enqueueRight`. Critical: under the swap model, the old `enqueueRight(rollup)` would land on whatever is currently visible — including a replay pane.
8. **PaneQueue is unchanged in v1.** `showSource` issues swaps via sequential single-pane `enqueue` calls (visible then hidden) rather than a new pair-lock primitive. v1 has no concurrent `showSource` path — all swaps are dispatched serially from the controller in response to lifecycle/intent events — so pair-locking is YAGNI until the parallel-switcher UX ships. When that work begins, `enqueuePair` is added at that point with its callers.
9. **TmuxService gains two methods (was four).** `swapPane({socket, src, dst})` and `splitPane` gains an `argv: readonly string[]` overload that also accepts `env?: Readonly<Record<string,string>>` and `cwd?: Path` (today's `command: string` stays for compatibility; new hidden-pane spawns use argv to avoid shell-token concatenation for `tail -n 5000 -F <path>` and to carry interactive-runner env/cwd). `createSession` is reused for the scratch session — no new method needed. `resizeWindow` is **not** added in v1 (see Decision 10).
10. **No active resize handling in v1.** Scratch-session dimensions are set at create time to match the visible right pane (~70% of cols × full rows). On terminal resize the main `orch` session re-renders via tmux's `window-size latest` option (`session-init.ts:144`); the hidden scratch panes may temporarily run at stale dimensions until the next swap. Since hidden panes are invisible until swapped, a transient mismatch is only observable at the moment of swap-in, and tmux's per-swap redraw handles the common case. If render glitches are observed in practice, follow up with a `tmux refresh-client` after each swap or add `resizeWindow` as the brainstorm's Risk-4 mitigation suggested — explicitly deferred from v1.
11. **Cached-step UX: banner-only, no pane swap.** No pane registered, visible pane stays where it was, `info` banner reads "step N — cached (no transcript captured)."
12. **Prior docs annotated, not moved.** Update `docs/brainstorms/2026-05-06-…`, `docs/brainstorms/2026-05-07-…`, and `docs/plans/2026-05-07-…` frontmatter with `status: superseded` and `superseded_by:` pointing at this plan + brainstorm. Keeps grep / git locality; future readers see the redirect.

### Decisions Carried Forward (Unchanged from Origin)

- Banner state shape `{kind:'info'|'error', text, ttlMs?}`, single-slot, last-write-wins; info default TTL 4s, errors persist until replaced or `Esc`.
- Persistent `view.mode` field separate from `banner`. Footer derives from `view.mode`; banner is independent.
- Auto-follow on new step start = **no**. Stay on the user's view; emit info banner "step N running — press f to follow."
- `Esc` dismisses errors with priority below help-overlay-close.
- `f` keybind → `controller.followLive()` → `showSource(latest-registered-live-source)` or placeholder if none.

---

## High-Level Technical Design

This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.

### Pane map architecture

```
User's terminal (attached client)
        │
        ▼ tmux client renegotiates dims on resize
┌─────────────────────────────┐         ┌────────────────────────────────────────┐
│  orch session  (visible)    │         │  orch-scratch session  (no clients)    │
│                             │         │                                        │
│  ┌────────┬──────────────┐  │         │  hidden:placeholder    (cat /dev/null) │
│  │ left   │ visible      │  │ swap    │  hidden:live:<stepA>   (tail -F tee)   │
│  │ pane   │ right (slot) │◄─┼────────►│  hidden:replay:<step2> (tail -F tee)   │
│  │        │              │  │  pane   │  hidden:rollup         (tail -F tee)   │
│  └────────┴──────────────┘  │         │  hidden:interactive:<stepB> (PTY runner│
└─────────────────────────────┘         │                              argv)    │
        ▲                               └────────────────────────────────────────┘
        │ host writes via                          ▲
        │ pane-map seam                            │ host writes tee bytes to disk;
        │ (no direct sendKeys/respawn)             │ tail -f mirrors into pane
        ▼
RightPaneController
  panes: Map<SourceKey, PaneId>
  currentKey: SourceKey
  viewMode: 'live' | {mode:'replay', stepName}
  registerSource(key, spec)  // splitPane in scratch session, store paneId
  showSource(key)            // swapPane src=panes.get(key), dst=visiblePaneId
  unregisterSource(key)      // killPane, delete from map; swap to placeholder
                             //  if currently showing it
  followLive()               // showSource(latest live or interactive key)
```

### Source lifecycle

```mermaid
sequenceDiagram
    participant H as TmuxHost
    participant C as RightPaneController
    participant T as TmuxService
    participant S as Scratch session

    Note over H,S: step:start (autonomous)
    H->>C: registerSource({live,stepName}, {file-tail, teePath})
    C->>T: splitPane(scratch, argv=['tail','-n','5000','-F',teePath])
    T-->>C: hiddenPaneId
    Note over C: panes.set({live,stepName}, hiddenPaneId)
    alt view.mode === 'live'
        C->>T: swapPane(hiddenPaneId, visiblePaneId)
    else view.mode === 'replay'
        C->>H: emit info banner "step N running — press f to follow"
    end

    Note over H,S: runner emits transcript lines
    H->>H: tee.write(stepName, bytes)
    Note right of S: tail -f mirrors bytes into hidden pane;<br/>if swapped in, user sees them live

    Note over H,S: step:complete / step:failed
    alt step:failed
        H->>H: tee.write(stepName, renderFailurePanePayload(...))
    end
    H->>C: unregisterSource({live, stepName})
    C->>T: killPane(hiddenPaneId)
    Note over C: panes.delete; if currentKey was this,<br/>swap to placeholder
    H->>H: tee.close(stepName)
```

### What replaces the old seams

| Old path | Where it lived | New path |
|---|---|---|
| `enqueueRight(renderTranscriptLine bytes)` for autonomous | `tmux-host.ts:639-647` | `tee.write` only; `file-tail` hidden pane tails the file |
| `enqueueRight(renderFailurePanePayload(summary))` | `tmux-host.ts:596` | `tee.write(stepName, summary)` before `tee.close` |
| `enqueueRight(renderRollupPayload(snapshot))` | `tmux-host.ts:611` | `tee.write('_rollup', snapshot)`; `{type:'rollup'}` hidden pane tails it. New `step:parallel-start`/`step:parallel-complete` events drive register/unregister. |
| `enqueueOnPane(rightPaneId, commandBytes)` | `tmux-host.ts:565` | `tee.write` only (already happens at `:563`); command-step `file-tail` pane tails it |
| `respawnPane(['cat', replayFile])` from controller | `right-pane-controller.ts:273, 285` | `splitPane` in scratch with `argv=['tail','-n','5000','-F',replayFile]` → `swapPane` |
| `respawnPane(runnerArgv, …)` for interactive | `tmux-host.ts:674` | `splitPane` in scratch with `pty` archetype argv → `swapPane` → `waitFor` → `killPane` |
| `sendKeys(busy-footer)` UI text | `right-pane-controller.ts:127` | Banner emit on `StepsViewState.banner` |
| `respawnCatInline` for resume failure | `right-pane-controller.ts:347-351` | Banner emit (error kind) |
| `isRightPaneBusy: () => inFlight.size > 0` | `right-pane-controller.ts:67-68`, `tmux-host.ts:584-587` | Deleted — past-step Enter is safe by construction |

---

## Output Structure

New / restructured files under `src/hosts/two-pane/` after this plan lands:

```
src/hosts/two-pane/
├── index.ts                     # extended barrel
├── pane-map/                    # NEW subdirectory
│   ├── index.ts                 # barrel
│   ├── pane-spec.ts             # PaneSpec, SourceKey, sourceKeyToString
│   ├── scratch-session.ts       # createScratchSession / teardownScratchSession (small file; module-local helpers for the controller)
│   └── right-pane-controller.ts # rewritten controller around the map; owns scratch lifecycle
├── pane-queue.ts                # unchanged in v1
├── parallel-rollup.ts           # extended: writes to existing per-step tee under '_rollup' key
├── tmux-host.ts                 # slimmed: register/unregister at lifecycle hooks
├── failure-pane.ts              # unchanged renderer; new caller writes to tee
└── steps-view/
    ├── step-types.ts            # +ViewMode, +Banner
    ├── project-steps-view.ts    # +view, +banner pass-through
    ├── start-steps-view.ts      # +dismiss-banner intent
    └── steps-view.tsx           # footer reads view.mode; banner box; Esc handler
```

The existing single-file `src/hosts/two-pane/right-pane-controller.ts` is replaced by the `pane-map/` subdirectory because the controller now owns the pane map, lifecycle wiring, and scratch-session bootstrap helpers — keeping them as siblings in `pane-map/` (rather than a separate top-level `scratch-session.ts`) keeps scratch lifecycle co-located with its only caller. Rollup re-uses the existing `per-step-tee` infrastructure with a fixed `'_rollup'` step key rather than introducing a parallel `rollup-tee.ts`.

Implementer may adjust the structure if implementation reveals a better layout. The per-unit `**Files:**` sections remain authoritative.

---

## Implementation Units

### U1. Extend `TmuxService` with `swapPane` and argv-form `splitPane` (with env/cwd)

**Goal:** Add the two tmux primitives the pane-map needs to the service port and both adapters (real + fake). Extend `splitPane`'s argv variant to carry interactive-runner env/cwd so U6 can spawn pty panes without losing `ANTHROPIC_API_KEY`, OAuth keychain vars, `FORCE_COLOR`, or the project cwd.

**Requirements:** Decision 9. Foundational for U3 onward.

**Dependencies:** none.

**Files:**
- `src/services/tmux/tmux-service.ts` — add `SwapPaneOptions`. Extend `SplitPaneOptions` with optional `argv: readonly string[]` (mutually exclusive with `command: string`), optional `env?: Readonly<Record<string,string>>` (only valid with `argv`), and optional `cwd?: Path` (only valid with `argv`). Add `swapPane` to the `TmuxService` interface.
- `src/services/tmux/real-tmux-service.ts` — implement `swapPane` (`tmux -L <socket> swap-pane -s <src> -t <dst>`) and the `argv` branch of `splitPane` (apply env via `-e KEY=VALUE` flags before the argv; apply cwd via `-c <cwd>`; pass argv after the existing flags). Reject argv elements containing `\0`. Reject env keys containing `=` or `\n`, mirroring the existing `respawnPane` regex at `real-tmux-service.ts:311-322`. The `swap-pane` command takes cross-session pane ids natively because `PaneId` is server-wide (`%N`).
- `src/services/tmux/fake-tmux-service.ts` — extend the `RecordedCall` union with `swapPane` and the `splitPane`-with-argv shape (including env / cwd fields). Each recorder appends to `#calls`. `nextPaneId`/scripted-return scheme unchanged.
- `src/services/tmux/index.ts` — re-export new option types.

**Approach:** Mirror `respawnPane`'s argv contract for the new `splitPane` overload (array-only, no shell composition; env-key regex; argv null-byte rejection). `swapPane` accepts two `PaneId`s — no socket-affinity check needed since both panes live on the same tmux server.

**Patterns to follow:**
- `respawnPane` env-rejection regex at `real-tmux-service.ts:305-327`.
- `newWindow` argv shape at `tmux-service.ts:272-296` for the `splitPane` overload.
- `FakeTmuxService.respawnPane` recorder shape at `src/services/tmux/fake-tmux-service.ts:45-66`.

**Test scenarios** (`tests/integration/services/tmux/tmux-real.integration.test.ts` for real, `tests/unit/services/tmux/fake-tmux-service.test.ts` for fake):
- `swapPane` exchanges the contents of two panes (real-tmux test, env-gated): create session, split pane, capture left + right contents pre-swap, call `swapPane`, capture post-swap, assert content has crossed.
- `swapPane` works cross-session (real-tmux test): create two sessions on the same socket, swap a pane from session A with a pane in session B, assert success and that both panes still exist.
- `swapPane` throws `TmuxCommandError` when either pane id is invalid.
- `splitPane` with `argv: ['tail', '-n', '5000', '-F', '/tmp/some.log']` (real-tmux): create a file, split pane with the argv, assert the new pane is running `tail` (via `display-message` with `#{pane_current_command}`).
- `splitPane` with `argv` + `env: {FORCE_COLOR:'3'}` + `cwd: '/tmp'` (real-tmux): assert the pane inherits the env (via a probe argv that writes `$FORCE_COLOR` to a file) and the cwd (via `display-message` with `#{pane_current_path}`).
- `splitPane` with both `argv` and `command` set: adapter throws a typed error (validated at the port boundary, not adapter).
- `splitPane` with `env` or `cwd` set without `argv`: adapter throws (env/cwd only valid in the argv branch).
- `FakeTmuxService.swapPane` records the call with `src` and `dst` paneIds in the order received.
- `FakeTmuxService.splitPane` records the `argv` variant separately from the `command` variant (`RecordedCall` discriminator), including env and cwd fields.

**Verification:** New tmux methods exist on the port and adapter; `bun run test tests/unit/services tests/integration/services` is green; real-tmux integration test passes when `tmux` is on PATH (skipped otherwise).

---

### U2. (Deferred) PaneQueue pair-lock — not needed in v1

**Status:** Deferred until the parallel-switcher UX ships.

**Rationale:** v1 has no concurrent `showSource` path. The controller dispatches lifecycle events (step:start, step:complete, step:failed) and user intents (Enter, `f`) serially; each call sequentially enqueues `visible` then `hidden`. No two `showSource` invocations race in v1. Pair-lock is the right primitive when the parallel-switcher introduces user-driven swaps that can overlap with auto-swaps from lifecycle events — at which point `enqueuePair` lands together with its first real caller. Designing the canonical-ordering rule plus deadlock-safety tests now would commit to lock semantics before the calling shape is known.

**In v1, `showSource` uses sequential single-pane `enqueue` calls:**

```ts
await paneQueue.enqueue(visiblePaneId, () => Promise.resolve());
await paneQueue.enqueue(hiddenPaneId, () => tmux.swapPane({src: hiddenPaneId, dst: visiblePaneId}));
```

The visible-pane `enqueue` is a synchronization point only (no work) to ensure any in-flight write to the visible pane settles before the swap. The hidden-pane `enqueue` carries the swap.

**Follow-up:** the deferred solution doc on pair-lock semantics (already in Deferred to Follow-Up Work) ships when the parallel-switcher pass is planned, not via `/ce-compound` after v1.

---

### U3. Build the pane-map controller and scratch-session lifecycle

**Goal:** Replace `right-pane-controller.ts` with a controller that owns the scratch session, a `Map<SourceKey, PaneId>`, and the four public methods (`registerSource`, `showSource`, `unregisterSource`, `followLive`). Wire scratch-session create at host construction and kill at teardown. **No host call sites change yet** — the new methods exist, but the old `inFlight` busy gate and the old `respawn-on-rightPaneId` paths still run. This unit is a pure refactor; behavior is identical at the surface level (autonomous still uses `enqueueRight`, replay still uses old `dispatchByKind`). Visible behavior changes land in U5–U8.

**Requirements:** Decisions 1, 2, 3, 5, 8. The structural backbone.

**Dependencies:** U1 (`swapPane`, argv `splitPane` with env/cwd).

**Files:**
- `src/hosts/two-pane/pane-map/pane-spec.ts` (new) — `PaneSpec`, `SourceKey`, `sourceKeyToString(key)`, optional smart constructors.
- `src/hosts/two-pane/pane-map/scratch-session.ts` (new, module-local helpers) — `createScratchSession(deps)` and `teardownScratchSession(handle)`. Owns session name `orch-scratch` and the initial dimensions (mirror the visible right pane). Sets `destroy-unattached off` on the session at create time so a user's `~/.tmux.conf` with `destroy-unattached on` cannot kill it (no client ever attaches).
- `src/hosts/two-pane/pane-map/right-pane-controller.ts` (new — replaces the old top-level file) — controller body. Imports the two helpers from `./scratch-session`.
- `src/hosts/two-pane/pane-map/index.ts` (new) — barrel re-exporting `PaneSpec`, `SourceKey`, `RightPaneController`, `createRightPaneController`.
- `src/hosts/two-pane/index.ts` — re-export from `./pane-map`. Remove the old `./right-pane-controller` re-export.
- `src/hosts/two-pane/right-pane-controller.ts` — **delete**.
- `src/hosts/two-pane/tmux-host.ts` — **bootstrap order:** create scratch session FIRST, then `splitPane` the visible right pane, then `createRightPaneController`. If scratch creation fails, the visible right pane has not yet been split, so no orphaned UI exists; the error bubbles up cleanly. Add scratch teardown to `teardown()` before `tmux.killSession({session: SESSION})`. Drop the `isRightPaneBusy` option from the controller's options object (the new controller doesn't have a busy gate). The `inFlight` set stays for now (U5 deletes it).

**Approach:**
- `SourceKey` is a TS discriminated union with `type` discriminator + per-variant fields. The Map keys on the result of `sourceKeyToString(key)` — a deterministic string serializer (e.g. `live:<stepName>`, `rollup`, `interactive:<stepName>`) — so structural equality works.
- **Controller state** includes a mutable `visiblePaneId: PaneId` field. After every `swapPane`, the visible slot's pane id has changed (tmux swap-pane exchanges pane positions; pane ids stay attached to their original processes). The controller updates `visiblePaneId` after each swap so subsequent `swapPane` calls target the correct destination. This is the single non-obvious invariant of the swap model — document it in the controller's JSDoc.
- **Hidden-pane death subscription:** for every registered source (`file-tail` AND `pty`), subscribe `tmux.waitFor({channel: 'pane-exit-<hiddenPaneId>'})`. On fire, remove the entry from `panes` and (if it was `currentKey`) swap to placeholder. Invariant: `panes.get(key)` is either undefined or a live pane id, never a dead one.
- `registerSource(key, spec)`:
  - If `panes.has(stringKey)` → no-op (idempotent).
  - For `spec.kind === 'file-tail'` → `tmux.splitPane({session: 'orch-scratch', argv: ['tail', '-n', '5000', '-F', spec.path]})`. `-n 5000` bounds the first-view backfill to roughly the last 5000 lines (~500KB of ANSI) so a cold-view replay of a long step doesn't scroll through 10MB of bytes on first swap; `-F` (capital) retries on inode changes so a tee re-open mid-run does not break the follow.
  - For `spec.kind === 'pty'` → `tmux.splitPane({session: 'orch-scratch', argv: spec.argv, env: spec.env, cwd: spec.cwd})`.
  - Store the returned hidden pane id in `panes`. Update `lastRegisteredLive` if the key type is `'live'` or `'interactive'`.
  - Subscribe the hidden pane's `pane-exit` channel (see above).
  - Append `{type:'pane-spawned', sourceKey, paneId}` to the lifecycle log.
- `showSource(key)`:
  - Resolve hidden pane id from `panes`. If missing → log + early return (race-safe).
  - If `currentKey === key` → no-op.
  - Sequential single-pane enqueue (see U2): `enqueue(visiblePaneId, noop)` then `enqueue(hiddenPaneId, () => tmux.swapPane({src: hiddenPaneId, dst: visiblePaneId}))`.
  - After the swap settles, swap `visiblePaneId` and the entry in `panes` for `key`: the pane id formerly at the hidden slot is now visible; the pane id formerly visible is now hidden under `key`. Update `currentKey = key`. Emit `{type:'right-pane-swap', from, to}` lifecycle log.
- `unregisterSource(key)`:
  - Resolve hidden pane id. If missing → no-op.
  - **The single rule** (no exceptions, no refinements):
    - For `{type:'live', stepName}` or `{type:'live-command', stepName}` → transform key. `panes.delete(liveKey)`; `panes.set(replayKey, sameHiddenPaneId)`. No `killPane`. The hidden pane continues to tail the (now-frozen) tee; subsequent revisits are O(1). The frozen final transcript stays visible if the user was watching it.
    - For `{type:'interactive', stepName}` → `killPane`; remove from `panes`. No warm cache for interactive (each view re-spawns the runner via the resume path).
    - For `{type:'rollup'}` → `killPane`; remove from `panes`.
  - **If `currentKey === key`** and the rule kills the pane → swap to placeholder FIRST so the visible slot doesn't reference a dead pane, then kill. For the live-transform case, no swap-out is needed (the same pane id is now under the replay key, and the visible slot's view of it is still correct).
- **Frozen-transcript UX cue.** When `step:complete` fires for the source currently in `currentKey`, after the live→replay transform, emit `controller.emitBanner({kind:'info', text:'step ${stepName} complete', ttlMs:4000})` AND transition `viewMode` to `{mode:'replay', stepName}` so the footer flips from `▶ live` to `⏸ viewing ${stepName}`. This is the user-visible signal that the transcript on screen is now frozen, not active. (See U5 for failure-case banner.)
- `followLive()` → if `panes.has({type:'rollup'})` → `showSource({type:'rollup'})` (prefer the aggregated view during parallel work); else if `lastRegisteredLive !== null` → `showSource(lastRegisteredLive)`; else `showSource({type:'placeholder'})`. Set `viewMode = {mode:'live'}`.
- `onIntent(intent)`:
  - `enter` → resolve step → if step is `cached` → emit info banner only, NO viewMode change, no pane swap; else if `panes.has(replayKey)` → `showSource(replayKey)`; else `registerSource(replayKey, file-tail spec)` then `showSource(replayKey)`. On register/show, set `viewMode = {mode:'replay', stepName}`.
  - `follow-live` → `followLive()`.
  - `dismiss-banner` → clear banner state (U4 introduces the projection seam).
  - `quit` → `followLive()` (existing behavior, swap back to live before teardown).
- Replay source spec resolution: use the same per-kind dispatch logic that exists today (`dispatchByKind` at `right-pane-controller.ts:207-250`), refactored into a pure `resolveReplaySpec(opts, step): Promise<PaneSpec>` helper. For autonomous, points at the persisted tee path `<logsDir>/agents/<stepName>/formatted_output.ansi`. For command, points at the existing command pane log. For commit/worktree/ask, writes `<stateDir>/.replay/<safeStepName>.txt` synchronously before returning the spec, then a `file-tail` over it (`tail -F` of a static file idles after the initial backfill).
- **Placeholder source** is registered at controller construction: `registerSource({type:'placeholder'}, {kind:'file-tail', path: '/dev/null'})`. `tail -F /dev/null` blocks indefinitely with no output — a blank pane. Initial `currentKey = {type:'placeholder'}` and the controller calls `showSource({type:'placeholder'})` once at boot so the visible right pane gets the placeholder hidden pane swapped in. The placeholder is always present so every state of the visible slot is a swap target; no special-case "no source yet" rendering path.
- **No active resize handling.** See Decision 10. Scratch dimensions are fixed at create time; resize is deferred to a follow-up.

**Patterns to follow:**
- `tmux-host.ts:245-251` — pane creation via `splitPane`.
- `session-init.ts:117-122` — global `pane-died` hook (server-global; covers `orch-scratch` because hooks are not session-scoped when set with `-g`).
- The old controller's `replayFilePath` helper (`right-pane-controller.ts:252-258`) and `dispatchByKind` (`:207-250`) — extract to `resolveReplaySpec`.
- Logging conventions per `right-pane-controller.ts:85-103` (`replay-pane-closing` etc.).

**Test scenarios** (`tests/unit/hosts/two-pane/pane-map/right-pane-controller.test.ts`, `tests/integration/hosts/two-pane/pane-map-scratch-session.real.integration.test.ts`):
- `registerSource(liveKey, file-tail spec)` calls `splitPane` on `orch-scratch` with argv `['tail','-n','5000','-F', path]`; stores the returned paneId in the map.
- Calling `registerSource` twice with the same key is idempotent (only one `splitPane`).
- `registerSource` subscribes `pane-exit-<paneId>` for both file-tail and pty sources.
- `showSource(key)` calls `swapPane(src=hiddenPaneId, dst=visiblePaneId)` via sequential `enqueue` (visible then hidden); updates `visiblePaneId` after the swap.
- `showSource(key)` when `currentKey === key` is a no-op (no swapPane call).
- `showSource(key)` when the key is not in `panes` logs a miss and does not call `swapPane`.
- `unregisterSource({type:'live', stepName})` on `step:complete` transforms the entry: `panes.delete(liveKey)`, `panes.set(replayKey, sameHiddenPaneId)`. No `killPane`. If the live source was `currentKey`, `viewMode` flips to `{mode:'replay', stepName}` and an info banner fires.
- `unregisterSource({type:'interactive', stepName})` calls `killPane` (interactive does not auto-warm a replay).
- `unregisterSource({type:'rollup'})` calls `killPane`.
- External hidden-pane death: simulate a `pane-exit-<paneId>` channel fire on a registered source; `panes` entry is removed; if `currentKey` matched, visible swaps to placeholder.
- `followLive()` with a rollup source registered AND multiple live sources → picks rollup.
- `followLive()` with no rollup, no live sources → placeholder.
- `followLive()` with no rollup, one live source → that source.
- `followLive()` with no rollup, two live sources → `lastRegisteredLive` (most recent insertion).
- `onIntent('enter', stepName)` for a step with no prior replay registers a fresh `replay:` source and swaps to it; `viewMode` flips to `{mode:'replay', stepName}`.
- `onIntent('enter', stepName)` for a step that already has a warm replay skips `registerSource` and just `showSource`s — instant swap.
- `onIntent('enter', stepName)` for a CACHED step emits an info banner and does NOT change `viewMode` or call `swapPane`.
- `onIntent('follow-live')` calls `followLive()`.
- Past-step Enter while a live step is registered does NOT log `replay-blocked-busy` (no busy gate exists).
- Scratch session is created via `tmux.createSession({session: 'orch-scratch', width, height, …})` BEFORE the visible right `splitPane` returns and before the first `registerSource` call.
- Scratch session creation failure leaves no orphaned visible right pane (bootstrap-ordering invariant).
- Scratch session teardown calls `tmux.killSession({session: 'orch-scratch'})` strictly before `tmux.killSession({session: 'orch'})`.
- **Real-tmux integration:** create the orch-scratch session via the real adapter, register two file-tail sources, swap between them, assert via `capturePane` that the visible pane content matches the active source. Env-gated `skipIf(!Bun.which('tmux'))`.
- **Real-tmux destroy-unattached resilience:** set `destroy-unattached on` globally on a test tmux server, create the scratch session, sleep 1s, assert it survives (proves the explicit `destroy-unattached off` on the session works).

**Verification:** Controller file ≤ 300 LOC; scratch-session helper ≤ 100 LOC; `bun run check` green; real-tmux test passes when tmux is installed. Manual smoke: run an existing autonomous example (`bun run orch examples/single-autonomous.toml`) — behavior identical to today (still uses `sendKeys` for live, since U5 hasn't landed).

---

### U4. UI plumbing: banner + view-mode + `dismiss-banner` intent

**Goal:** `StepsViewState` carries `view: ViewMode` and optional `banner: Banner`. The Ink renderer reads both. `Esc` dismisses errors. Replace the existing `sendKeys`-into-pane UI text (busy footer, resume-failure refusal — already gone post-U3 but the replacement banner emit needs to exist) with banner emits via the projection.

**Requirements:** Origin "Banner + view indicator" section. Independent of U5–U8 but needed before host wiring tries to emit info/error banners.

**Dependencies:** U3 (controller owns the banner state slot it pushes through the projection).

**Files:**
- `src/hosts/two-pane/steps-view/step-types.ts` — add `ViewMode = {mode:'live'} | {mode:'replay', stepName}`; add `Banner = {kind:'info'|'error', text, ttlMs?, seq: number}` (the `seq` is a monotonic counter the controller assigns at emit time); extend each variant of `StepsViewState` with `view` (required) and `banner` (optional).
- `src/hosts/two-pane/steps-view/project-steps-view.ts` — accept `viewMode` and `banner` in the projector input; pass through to the output state.
- `src/hosts/two-pane/steps-view/start-steps-view.ts` — extend `StepsIntentSchema` with `dismiss-banner`.
- `src/hosts/two-pane/steps-view/steps-view.tsx` — derive footer text from `view.mode` (with stepName truncation); render banner box above the steps grid; wire `Esc` (priority: help-overlay-close > dismiss-banner > no-op); wire info-banner auto-dismiss via `useEffect`+`setTimeout` keyed on `state.banner?.seq` (NOT on `text`) so identical text from rapid successive banners reliably restarts the timer. Also update the help-overlay content (in the same file or its sibling help component) so `?` lists the new `f`/banner/view-mode behaviors.
- `src/hosts/two-pane/pane-map/right-pane-controller.ts` — controller owns `currentBannerState` and `currentViewMode`; maintains the monotonic `bannerSeq` counter; pushes them into the projection seam. Add `emitBanner(banner)` helper that bumps `bannerSeq` and assigns it to the emitted banner.
- `src/hosts/two-pane/tmux-host.ts` — replace any remaining UI-text `sendKeys`/respawnCatInline emit with `controller.emitBanner(...)`.

**Approach:**
- The projection-seam push: the controller writes to `tui-state.ndjson` (the existing IPC stream the steps-view daemon reads). Today the projector reads run state from `state-store.ndjson` and emits `StepsViewState`. The plan adds an in-memory "TUI overlay" state in the controller that the projector consumes alongside the persisted state — the controller pokes the projector when banner/view-mode changes (via the existing `LiveOverlay` plumbing pattern; the live-overlay mechanism in `steps-view/live-overlay.ts` is the analog).
- **Banner timer semantics.** Every `emitBanner` bumps the controller's `bannerSeq` counter (monotonic, never reused). The renderer's `useEffect` keys on `state.banner?.seq`. When a new banner arrives — even with identical text — the `seq` changes, the old timeout is cancelled, and a fresh `ttlMs` countdown starts. This is the rule even when two info banners arrive within milliseconds (e.g. a parallel block of 3 branches starting in quick succession): only the last one's timer is in flight; prior banners are replaced. The brainstorm's "single-slot last-write-wins" remains intact; the seq counter just makes the renderer-side timer behavior deterministic.
- **Multi-error banner UX.** "Single-slot last-write-wins" applies to errors too. If three parallel branches fail in rapid succession, the third error banner replaces the first two without the user reading them. This is intentional, not a loss: the steps-view grid is the durable signal — each failed step is visibly marked there, and the user can press Enter on any one to view its frozen replay. The banner exists as a transient "something just happened, look at the grid" cue, not as an error log. Document this rule in the controller's JSDoc and in the help overlay.
- Info-banner auto-dismiss is a renderer-side concern: the projector emits `{banner: {kind:'info', text, ttlMs:4000, seq}}`, the renderer sets a 4s timeout, on timeout dispatches `{type:'dismiss-banner'}` which the controller handles by clearing its banner state and re-emitting the projection (next emit has `banner: undefined`).
- Help-overlay precedence: in `steps-view.tsx:87` the `Esc` handler today is "close help overlay only." Restructure to: if help open → close; else if banner is `error` → dispatch `dismiss-banner`; else no-op. Info banners are NOT manually dismissable — they auto-clear, matching the brainstorm's single-slot semantics.
- **Footer text (with truncation).** stepName is truncated to 30 characters with a trailing ellipsis (`…`) when longer; the truncation applies only in the footer and banner copy, never to the underlying StepName identifier.
  - `view.mode === 'live'` → `▶ live · Enter view step · q quit · ? help` (the `f` shortcut is hidden in live mode since it's a no-op when already on the most-recent live source; deferred re-introduction will happen when the parallel-switcher UX ships and `f` carries cycle-between-branches semantics)
  - `view.mode === 'replay'` → `⏸ viewing ${truncate(stepName, 30)} · f live · Enter view another · q quit · ? help`

**Patterns to follow:**
- `LiveOverlay` machinery for the projector→Ink seam (search for `live-overlay.ts` and `useLiveOverlay` callers).
- Existing Ink `useInput` handler at `steps-view.tsx:76-118` for the `Esc` precedence change.

**Test scenarios** (`tests/unit/hosts/two-pane/steps-view/`):
- `StepsViewState` types: a `live` variant requires `view` and accepts optional `banner` (tsc-only test via type assertion).
- `projectStepsView` with `viewMode: {mode:'live'}` and no banner emits `state.view = {mode:'live'}` and `state.banner` is absent.
- `projectStepsView` with `banner: {kind:'info', text:'hi', ttlMs:4000, seq:1}` propagates the banner verbatim.
- Renderer (`steps-view.tsx`): when `state.view.mode === 'live'` the footer matches the live string (no `f follow` token); when `'replay'` the footer includes `viewing ${truncatedStepName}` and `f live`.
- Renderer: stepName longer than 30 chars is truncated to `${stepName.slice(0,29)}…` in the footer.
- Renderer: `state.banner = {kind:'info', text:'X', seq:1}` renders a cyan/dim single-line banner above the steps grid.
- Renderer: `state.banner = {kind:'error', text:'X', seq:1}` renders a red banner; persists across renders until explicitly dismissed.
- Renderer: two info banners with identical text but different `seq` restart the timer (verify via fake timers — the second banner is still visible after `ttlMs - 1ms`).
- `Esc` while help overlay is open closes the help overlay only.
- `Esc` while help is closed and `state.banner.kind === 'error'` dispatches `{type:'dismiss-banner'}`.
- `Esc` while help is closed and no banner is shown is a no-op.
- Auto-dismiss: `setTimeout` fires after `state.banner.ttlMs` for info banners only.
- Auto-dismiss does NOT fire for `error` banners regardless of `ttlMs`.
- `StepsIntentSchema.parse({type:'dismiss-banner'})` returns the intent; unknown types fail validation.
- Controller `onIntent({type:'dismiss-banner'})` clears banner state and triggers a projection re-emit.
- Controller `emitBanner({kind:'error', text:'resume failed'})` results in the next projection carrying that banner with a fresh `seq`.
- Help overlay text mentions `f` (follow live), banner behaviors, and view modes.

**Verification:** `bun run check` green; manual smoke shows a red banner appears on a forced resume failure and is dismissable with `Esc`; footer changes from `▶ live` to `⏸ viewing X` on Enter on a past step; long stepName truncates with `…`.

---

### U5. Wire autonomous + command-step live to `file-tail` sources

**Goal:** Drop `enqueueRight` for runner bytes and command-line bytes. Drop `enqueueRight(renderFailurePanePayload(...))`. Host registers a `{type:'live', stepName}` source on `step:start` for any non-cached step that produces a tee; unregisters (with the live→replay transformation from U3) on `step:complete`/`step:failed`. Delete the `inFlight` set and `isRightPaneBusy` plumbing.

**Requirements:** Decisions 2, 4, 6.

**Dependencies:** U3 (controller methods exist), U4 (banner emit for "step running — press f to follow" while user is on replay).

**Files:**
- `src/hosts/two-pane/tmux-host.ts`:
  - `onLifecycleEvent` for `step:start` (autonomous, !cached, **logsDir non-null**): after `tee.open`, derive the tee path via the new `teePathFor(logger, stepName): Path` helper exported from `per-step-tee.ts`, then `controller.registerSource({type:'live', stepName}, {kind:'file-tail', path: teePath})`. If `controller.viewMode === 'live'` the controller auto-swaps; if `replay`, the controller emits an `info` banner via U4's seam.
  - **logsDir-null guard.** `teePathFor` returns `null` when `logger.logsDir === null` (no file logging configured — the existing `NULL_PER_STEP_TEE` path at `src/hosts/plain/per-step-tee.ts:60-61`). In that case the host skips `controller.registerSource` entirely; the right pane stays on whatever was previously visible (placeholder or prior frozen-replay). An info banner `'step ${stepName} running (no transcript captured — file logging disabled)'` fires once per step so the user understands why no live view appeared. No fallback to `sendKeys` — the no-logger path was already a no-op for visible output today via `NULL_PER_STEP_TEE`.
  - `onLifecycleEvent` for `step:complete` (autonomous, !cached, logsDir non-null): `controller.unregisterSource({type:'live', stepName})` (transforms live → warm replay in U3). The controller's transform path additionally emits the "step complete" info banner and flips `viewMode` to replay when the live source was `currentKey` (per U3). Then `tee.close`.
  - `onLifecycleEvent` for `step:failed` (autonomous, !cached, logsDir non-null): `tee.write(stepName, renderFailurePanePayload(summary))` first, then `unregisterSource`, then `tee.close`. Additionally emit `controller.emitBanner({kind:'error', text:'step ${stepName} failed'})` unconditionally (regardless of viewMode) — the error banner is the durable signal that something went wrong, and the steps-view grid carries the per-step state.
  - `onLifecycleEvent` cached-step case: `controller.emitBanner({kind:'info', text:'step ${stepName} — cached (no transcript captured)', ttlMs:4000})`. No register/unregister. `viewMode` is unchanged (no pane swap occurred).
  - `onRunnerEvent`: remove the `deps.queue.enqueue(rightPaneId, sendKeys(payload))` call at `:639-647`. Keep `deps.tee.write` at `:638`.
  - `onCommandLine` at `:557-567`: same treatment. Remove `enqueueOnPane(target, payload)` at `:565`. Keep `deps.tee.write` at `:563`. **Command steps also register a `{type:'live', stepName}` source on `step:start`.** Verified: `src/core/workflow.ts:1053` shows command steps emit `step:start` with `mode: 'autonomous'`, so the register condition is simply `event.mode === 'autonomous'` — no separate `kind` discriminator needed. (Confirmed at plan time; covered by U5's command-step test scenarios.)
  - Delete the `inFlight: Set<string>` (`tmux-host.ts:584-587, 301`) and its propagation into `RightPaneControllerOptions`.
- **Test migration (inline with U5).** This unit also rewrites these test files to assert the new shape (rather than leaving them to a centralized U9):
  - `tests/integration/hosts/two-pane/right-pane-live-output.test.ts` — flip "no `respawnPane` on right pane during autonomous" assertions to assert `splitPane` on scratch + `swapPane` to visible.
  - `tests/integration/hosts/two-pane/right-pane-live-doubling.real.integration.test.ts` — ungate (drop `ORCH_REPRO_BUG=1`); convert to regression guard asserting doubling does NOT occur in the file-tail model.
  - `tests/integration/hosts/two-pane-mocked.test.ts` — drop `sendKeys` assertion on transcript bytes; tee writes remain authoritative.

**Approach:**
- `tee.write` for the failure summary must happen BEFORE `unregisterSource`. Ordering: under U3's chosen live→replay transformation, `unregisterSource` removes the live key but keeps the hidden pane. The user's live `tail -F` is still pumping bytes into the now-frozen tee; writes after `tee.close` won't show because the file stopped growing — but writes BEFORE `tee.close` will. So: write summary → tail picks it up → unregister (transforms key) → close.
- The "step running — press f to follow" info banner is emitted by the controller's `registerSource` when `viewMode === 'replay'` (U3). No host-side work needed.

**Patterns to follow:**
- The existing `tee.open` / `tee.close` lifecycle in `tmux-host.ts:576-580`.
- `renderFailurePanePayload` call site at `tmux-host.ts:589-598`.

**Test scenarios** (`tests/integration/hosts/two-pane/tmux-host-autonomous-pane-map.integration.test.ts`):
- On `step:start` for autonomous step: `controller.registerSource` is called with `{type:'live', stepName}` and `{kind:'file-tail', path: <expected tee path>}`. `FakeTmuxService.splitPane` is recorded with `session: 'orch-scratch'` and the expected `tail` argv.
- On `step:complete` for autonomous step: `controller.unregisterSource` is called with the matching live key. Hidden pane is NOT killed (warm replay).
- On `step:failed` for autonomous step: `tee.write(stepName, renderFailurePanePayload(summary))` is called BEFORE `controller.unregisterSource`, which is called BEFORE `tee.close`. If `viewMode === 'replay'`, `controller.emitBanner` is called with an `error` banner.
- On `step:start` for cached step: NO `registerSource` call; an info banner is emitted instead.
- `onRunnerEvent` for autonomous: `deps.tee.write` is called; `deps.queue.enqueue(rightPaneId, sendKeys(...))` is NOT called.
- `onRunnerEvent` for command (via `onCommandLine`): `deps.tee.write` is called; no `sendKeys` on the right pane.
- On `step:start` for command step (if the lifecycle event exists): `controller.registerSource` is called with `{type:'live', stepName}` and the command-step tee path.
- After all lifecycle hooks settle, the `inFlight` set is gone — `grep -n inFlight src/hosts/two-pane/tmux-host.ts` returns empty (asserted via a one-time check in the host's smoke test).
- **Real-tmux integration:** run an autonomous example (`examples/single-autonomous.toml`), let it finish, capture the visible pane's content (`tmux capture-pane -p`), assert it matches the persisted `formatted_output.txt` (modulo ANSI stripping). Env-gated.
- **Real-tmux failure case:** run an example that intentionally fails, assert the failure summary appears at the end of `formatted_output.ansi` and on the visible pane.

**Verification:** No `enqueueRight` calls remain in `onRunnerEvent` / `onCommandLine` / `step:failed`. `grep -n 'enqueueRight' src/hosts/two-pane/tmux-host.ts` returns zero hits in those handlers (the helper may still exist for any callers we haven't migrated yet — likely none after this unit). `bun run check` green.

---

### U6. Wire interactive runners to the `pty` archetype

**Goal:** `runInteractive` registers a `{type:'interactive', stepName}` source with a `pty` spec, swaps to it, waits for `pane-exit-<hiddenPaneId>`, and unregisters (kills the hidden pane — no warm cache for interactive). No more `respawnPane` on `rightPaneId` for interactive runners.

**Requirements:** Decisions 2, 4.

**Dependencies:** U3 (controller methods + scratch session). Independent of U5 mechanically (different code path).

**Files:**
- `src/hosts/two-pane/tmux-host.ts:659-720` — rewrite `runInteractive`:
  1. Build `sourceKey = {type:'interactive', stepName: spawn.stepName}`. `spawn.stepName` is already declared on `InteractiveSpawn` at `src/hosts/host.ts:54` (verified).
  2. `await controller.registerSource(sourceKey, {kind:'pty', argv: spawn.argv, env: spawn.env, cwd: spawn.cwd})`. The controller's `registerSource` for `pty` calls `splitPane` on `orch-scratch` with the runner argv, env, and cwd (U1 carries env/cwd through). The hidden pane id is returned and stored.
  3. `await controller.showSource(sourceKey)` — swap visible ↔ hidden interactive pane.
  4. `await tmux.waitFor({channel: 'pane-exit-<hiddenPaneId>'})` — global `pane-died` hook (`session-init.ts:117-122`) fires on cross-session pane death because the hook is server-global.
  5. In `finally`: `await controller.unregisterSource(sourceKey)`. The controller will swap to placeholder (if current) and kill the hidden pane.
  6. Return `{exitCode: 0, durationMs: …}` — same as today (the pane-died hook still doesn't surface exit codes through the channel).
- The `paneRole = 'left'` branch (for the steps-view daemon at `tmux-host.ts:661-662`) is UNTOUCHED. The left pane stays as today's main session; only the right-side interactive path moves to the scratch pty.
- The post-exit `respawnPane(['cat'], killRunning:true)` cleanup at `tmux-host.ts:702-712` is deleted — the visible pane never directly ran the runner argv, so there's nothing to clean up. The placeholder is restored via `controller.unregisterSource` (which swaps to placeholder if currentKey was interactive).
- `right-pane-controller.ts` (the old file) had `dispatchAgentInteractive` that called `runner.resumeCommand` and respawned directly on `rightPaneId` (`right-pane-controller.ts:317-353`). Migrate this into the new controller as part of `onIntent('enter')` for a past interactive step: resolve the resume argv, then `registerSource({type:'interactive', stepName}, {kind:'pty', argv: resumeArgv, env: resumeEnv, cwd})`, then `showSource`. On error, `emitBanner({kind:'error', text: refusal})`. This consolidates the resume path into the unified model.
- **Test migration (inline with U6):**
  - `tests/integration/hosts/two-pane-interactive.test.ts` — replace `respawnPane count == 2 (runner argv + cat restore)` with `splitPane(scratch, runner argv) + swapPane + killPane`. Cat-restore assertion is gone.
  - `tests/integration/hosts/two-pane-sequential-runs.test.ts` — real-tmux interactive; update assertions on `pane_current_command` to check the scratch session's hidden pane.
  - `tests/integration/hosts/two-pane/resume-launcher-mocked.integration.test.ts` — replace `respawnPane(resumeArgv) on right pane` with `splitPane(scratch, resumeArgv)` + `swapPane`.
  - `tests/integration/hosts/two-pane/resume-failure-mocked.integration.test.ts` — replace `respawnCatInline of refusal` with `controller.emitBanner({kind:'error', …})`.

**Approach:**
- The interactive `pane-died` hook is keyed by the *hidden* pane id, not the visible right pane id. Because tmux hooks are server-global (`session-init.ts:117-122` sets it with `-g`), and pane ids are server-wide, the channel `pane-exit-<hiddenPaneId>` fires correctly. Confirmed mechanically; add a real-tmux test as belt-and-suspenders.
- The runner's PTY is now genuinely a tmux pane — `isTTY === true`, arrow keys / Ctrl-R / Ctrl-C / resize reflow all work natively. This **closes the gap** that `docs/solutions/interactive-mode-colors.md` calls out as "escalate to full PTY if `FORCE_COLOR` proves insufficient." Validate each symptom in acceptance.
- `FORCE_COLOR=3` is still applied via the runner's `mergeEnv` extras slot (per `docs/plans/2026-04-27-feat-env-passthrough-plan.md`). Inside a tmux pane it's redundant but harmless. Do not strip it.

**Patterns to follow:**
- The existing `tmux.waitFor` usage at `tmux-host.ts:691-695`.
- `mergeEnv(process.env, extras, ctx.env)` pattern from `src/runners/_shared/merge-env.ts` for the env into the pty spec.

**Test scenarios** (`tests/integration/hosts/two-pane/tmux-host-interactive-pane-map.integration.test.ts`, `tests/integration/hosts/two-pane/right-pane-pty-pane.real.integration.test.ts`):
- `runInteractive({argv, env, cwd, stepName})` calls `controller.registerSource({type:'interactive', stepName}, {kind:'pty', argv, env, cwd})` and then `controller.showSource(...)`.
- After `tmux.waitFor` settles (mocked to resolve), `controller.unregisterSource` is called. `tmux.killPane` is called on the hidden pane id.
- `runInteractive` does NOT call `tmux.respawnPane` on `rightPaneId` anywhere in its flow.
- The post-exit `respawnPane(['cat'])` restore is GONE (regression guard).
- Resume-from-past-interactive Enter: `controller.onIntent({type:'enter', stepName})` for a past interactive step resolves `runner.resumeCommand` and registers a new `{type:'interactive', stepName}` source. (This is the "view a past interactive step" path — implements what `dispatchAgentInteractive` did in the old controller.)
- Resume-failure: `runner.resumeCommand` throws → `controller.emitBanner({kind:'error', text: 'resume failed — …'})`. NO `respawnCatInline`.
- Resume-refusal (no runner, no resumeCommand, no sessionId): same — banner emit, no pane operation.
- `paneRole === 'left'` path is unchanged (steps-view daemon spawn): `respawnPane` is still called on `leftPaneId`; the pane-map seam is bypassed.
- **Real-tmux integration:** spawn a fake interactive (`bash -c 'sleep 0.5; exit 0'`) via `runInteractive`. Assert: hidden pane is created in `orch-scratch`, swapped into the visible right pane, `pane-died` fires, hidden pane is killed, visible right pane is back to placeholder. Env-gated.
- **Real-tmux resize-during-interactive:** start an interactive that doesn't exit, resize the terminal, assert the interactive pane resizes correctly (proxy: `display-message -p '#{pane_width}x#{pane_height}'` matches the new dims). Env-gated.

**Verification:** `grep -n 'respawnPane.*rightPaneId' src/` returns zero hits (the source-seam invariant — scoped to `src/`; the test-side grep is enforced by U9's invariant test). `bun run check` green; real-tmux interactive integration test passes; manual smoke shows interactive runners work with the same Ctrl-C / resize / color behavior as today.

---

### U7. Wire rollup to its own hidden pane; add parallel-block lifecycle events

**Goal:** Move parallel-rollup output off `enqueueRight` and into a dedicated `{type:'rollup'}` hidden pane. The visible pane shows the rollup whenever it's swapped in (auto-promoted by `followLive()` when a rollup source is registered, per U3).

**Requirements:** Decision 7.

**Dependencies:** U3 (controller exists), U5 (autonomous already migrated — rollup interleave behavior changes from "rollup + per-branch on same pane" to "rollup on its own pane").

**Files:**
- `src/hosts/plain/per-step-tee.ts` — open the existing `createPerStepTee` API to a `'_rollup'` step key. The sink path for `_rollup` resolves to `<logsDir>/agents/_rollup/formatted_output.ansi` (the leading underscore sorts above step names; matches the project's "meta entry" convention). No new module is added; rollup reuses the existing tee infrastructure with a fixed step key.
- `src/core/workflow.ts` — emit two new lifecycle events: `step:parallel-start` (fired once at the top of the `parallel(...)` wrapper before any branch starts) and `step:parallel-complete` (fired once after all branches in the block have settled, regardless of pass/fail). The event payload carries the block id (e.g., a deterministic counter or the source step name) so handlers can correlate start with complete. Existing `step:parallel-branch-update` events continue to fire per-branch as today.
- `src/hosts/two-pane/parallel-rollup.ts` — add `reset()` call site at `step:parallel-complete` (the aggregator already has a `reset()` method; this just wires it). Without reset, sequential parallel blocks in the same run would accumulate stale branch entries.
- `src/hosts/two-pane/tmux-host.ts`:
  - On `step:parallel-start`: `tee.open('_rollup')` then `controller.registerSource({type:'rollup'}, {kind:'file-tail', path: teePathFor(logger, '_rollup')})`. The controller's `followLive()` auto-prefers rollup when it's registered (per U3) so a user in live mode auto-swaps to rollup; a user on replay stays put and gets an info banner.
  - In the `step:parallel-branch-update` handler: replace `enqueueRight(renderRollupPayload(snapshot))` with `tee.write('_rollup', renderRollupPayload(snapshot))`.
  - On `step:parallel-complete`: `controller.unregisterSource({type:'rollup'})`, `tee.close('_rollup')`, `rollup.reset()`. The unregister kills the hidden rollup pane (per U3's rule for `{type:'rollup'}`).
  - The teardown sequence already drains all tee step keys including `'_rollup'`; no separate drain wiring needed.
- **Test migration (inline with U7):** no existing test files specifically target rollup-on-right-pane assertions today (rollup currently piggybacks on `enqueueRight`), so U7 adds new tests rather than migrating prior ones. Listed below.

**Approach:**
- `RollupAggregator` is otherwise unchanged. The only behavioral change is the new `reset()` call and the output sink.
- The lifecycle events are the right scope boundary — `core/workflow.ts` already knows when a `parallel()` block starts and ends; reverse-engineering it from `runningCount()` would embed parallel-state knowledge in the host. Adding the two events is a one-emission-each change in `core/workflow.ts`.
- Block-id correlation lets future code (e.g., a switcher UX) distinguish nested or sequential parallel blocks. For v1 the host only uses start/complete as register/unregister triggers; block-id is informational.

**Patterns to follow:**
- Existing `per-step-tee.ts` lifecycle in `tmux-host.ts:576-580` — `_rollup` is just another step key.
- The existing `rollup.apply / renderRollupPayload` flow in `tmux-host.ts:599-612`.

**Test scenarios** (`tests/integration/hosts/two-pane/tmux-host-rollup-pane-map.integration.test.ts` + `tests/unit/core/workflow-parallel-lifecycle.test.ts`):
- `core/workflow.ts`: a `parallel([a,b,c])` block emits exactly one `step:parallel-start` before the first branch's `step:start` and exactly one `step:parallel-complete` after the last branch's `step:complete`/`step:failed`.
- Two sequential parallel blocks emit two start/complete pairs with distinct block ids.
- On `step:parallel-start`: `tee.open('_rollup')` is called; `controller.registerSource({type:'rollup'}, {kind:'file-tail', path: <expected '_rollup' tee path>})` is called.
- `step:parallel-branch-update` events: `tee.write('_rollup', renderRollupPayload(snapshot))` is called; `enqueueRight` is NOT called.
- On `step:parallel-complete`: `controller.unregisterSource({type:'rollup'})`, `tee.close('_rollup')`, `rollup.reset()` are all called in that order.
- After `rollup.reset()`, a subsequent `step:parallel-start` opens a fresh aggregator state (no stale branches).
- If the user is on a replay when `step:parallel-start` fires, the controller emits an info banner instead of swapping (same path as `{type:'live'}` per U3).
- **Real-tmux integration:** run a parallel example (audit `examples/` for an existing one; add a minimal `examples/parallel-rollup.toml` if none exists). Assert the `_rollup` tee file accumulates rollup payloads and the rollup hidden pane content matches the file.
- **Rollup-corruption-on-replay regression guard:** register a rollup source, register a replay source, swap to replay, fire several `step:parallel-branch-update` events, capture the visible pane content — it should still show the replay, NOT rollup bytes. The `_rollup` tee should still receive the writes (verify by reading the file).

**Verification:** No `enqueueRight(renderRollupPayload(...))` call remains. New `step:parallel-start` / `step:parallel-complete` events fire as expected. Manual smoke on a parallel example shows rollup output in its own swap-able pane. `bun run check` green.

---

### U8. Past-step replay panes — warm cache verification + edge-case wiring

**Goal:** Verify and lock in the warm-replay-cache behavior introduced structurally in U3. Past-step Enter mid-flight works without a busy gate. Live-step transformation on `step:complete` makes subsequent revisits O(1). Re-Enter on a step whose hidden pane has been killed (because it was interactive — no warm cache for interactive) creates a fresh `replay:` source spawning a `tail -n 5000 -F` over the static persisted tee. For ask/commit/worktree steps, the controller writes a `.replay/<step>.txt` file (existing `respawnCatInline` shape) and registers a `file-tail` over it.

**Requirements:** Decisions 2, 5; origin's "Lifecycle for replay panes" section.

**Dependencies:** U3 (controller), U5 (autonomous live→replay transformation), U6 (interactive doesn't transform).

**Files:**
- `src/hosts/two-pane/pane-map/right-pane-controller.ts` — finalize `resolveReplaySpec(opts, step): Promise<PaneSpec>`:
  - Agent autonomous: `{kind:'file-tail', path: <logsDir>/agents/<stepName>/formatted_output.ansi}`. Direct persisted tee — no JSON re-render. (See U3 for the `tail -n 5000 -F` invocation that bounds first-view backfill.)
  - Agent interactive: resume-runner branch (U6 covers this).
  - Command: `{kind:'file-tail', path: <command pane log path>}` if log exists; otherwise inline placeholder.
  - Commit / worktree / ask: synchronously write `<stateDir>/.replay/<safeStepName>.txt` with `renderKindDetails(step)`, then `{kind:'file-tail', path: <that file>}`. The `tail -F` reads up to the last 5000 lines (typically the whole file for these step types) and idles.
- Existing helpers reused: `renderKindDetails`, `resolveCommandPaneSource`, `replayFilePath` (rename from `replayFilePath` if helpful but not required).
- **Test migration (inline with U8):**
  - `tests/integration/hosts/two-pane/right-pane-replay.integration.test.ts` — flip 6 `respawnPane` assertions on right pane to `swapPane(src=<scratch pane>, dst=<right pane>)` + initial `splitPane` on scratch.
  - `tests/integration/hosts/two-pane/right-pane-busy-gate.integration.test.ts` — flip "busy refusal during in-flight" assertions to "swap succeeded even though a live source is registered." Busy gate is gone.
  - `tests/integration/hosts/two-pane/kind-details.integration.test.ts` — `respawnPane(['cat', file])` becomes `splitPane(scratch, ['tail','-n','5000','-F', file])` + `swapPane`.

**Approach:**
- The migration from "JSON-NDJSON rendered to .replay/<step>.txt" (today's autonomous replay path) to "direct ANSI tee" sidesteps the `replay-transcript.ts` renderer for autonomous replays. The `transcriptRenderer` option becomes used only when the persisted tee is missing or partial — corner case worth a fallback path. Rule: if `formatted_output.ansi` exists and is non-empty, use it; else fall back to JSON re-render of `events.ndjson`. Document the fallback.
- Replay panes are warm-cached; the bound is "one pane per ever-viewed step." A 50-step run where the user views every step opens 50 hidden panes — well under tmux's default max-panes (256 per window). LRU eviction is explicitly out of scope.
- First-view backfill is bounded at `tail -n 5000` (~500KB of ANSI for a typical run); a step that generated more is truncated to its last 5000 lines on cold-view. This matches what a reader can absorb anyway. Warm-revisits don't re-backfill (they swap an already-running tail).

**Test scenarios** (`tests/integration/hosts/two-pane/right-pane-replay-pane-map.integration.test.ts`):
- Enter on a past autonomous step (cold): `controller.registerSource` is called with `{type:'replay', stepName}` and `{kind:'file-tail', path: <persisted tee>}`. `tmux.splitPane` recorded with `argv: ['tail','-n','5000','-F', path]`.
- Enter on the same step again: `registerSource` is NOT called (idempotent); only `showSource` is.
- Enter on a step whose live source just transformed to replay: `panes.has(replayKey)` is true; `registerSource` skipped; just `showSource`. Instant swap.
- Enter on a past commit/worktree/ask step: `.replay/<safe>.txt` is written; `registerSource` with `file-tail` over that path; `showSource`.
- Enter mid-flight on an unrelated past step: the live source remains registered and is unaffected. The replay swap is atomic. No busy-gate refusal (regression guard).
- Press `f` after viewing a replay with a rollup registered: returns to rollup (preferred over MRU). Without rollup, returns to MRU live source.
- Re-Enter on the same past step after pressing `f`: O(1) — no `splitPane` call, just `swapPane`.
- Step with no persisted tee (e.g. a cancelled step): falls back to JSON re-render path.
- **Real-tmux integration:** run a multi-step autonomous example, after completion press Enter on each step in order, assert each swap takes < 50ms (warm cache; first view takes longer due to `splitPane` + bounded backfill). Env-gated.
- **Real-tmux large-tee backfill:** generate a 10MB ANSI fixture file, register a file-tail source, swap to it, assert the visible pane content is bounded to the last ~5000 lines (proxy: capture-pane output is < 1MB). Env-gated.

**Verification:** Migrated past-step replay tests pass with `swapPane` assertions. Cold-vs-warm Enter latency observable; first-view backfill bounded. `bun run check` green.

---

### U9. Right-pane-source invariant guard test

**Goal:** Add a single regression-guard test that enforces the "no `respawnPane` on `rightPaneId`" invariant across the whole `src/hosts/two-pane/` surface. The per-test-file migrations have already landed inline with U5 (autonomous + command), U6 (interactive + resume), U7 (rollup new tests), and U8 (replay + kind-details + busy-gate). This unit's scope shrinks to the cross-cutting invariant test plus any straggler cleanup.

**Requirements:** Origin open Q3.

**Dependencies:** U3–U8. By the time U9 runs, no test file still asserts `respawnPane` on the right pane — those assertions have already flipped in their owning unit's commit. U9 just adds the static guard.

**Files:**
- `tests/integration/hosts/two-pane/right-pane-source-invariant.test.ts` (new) — invariant: after each fixture's host finishes, no `respawnPane` call in the FakeTmuxService recorder has `target === rightPaneId`. The only `respawnPane` calls allowed in the recorder are on the left pane (steps-view daemon) or on scratch-session panes. All right-pane state changes funnel through `swapPane`.
- Also add a small static check (in this test file or a sibling): a `grep`-style assertion at test time that `src/hosts/two-pane/` contains zero `respawnPane(.*rightPaneId)` invocations. Implemented via `Bun.file(...).text()` + regex, not actual shell `grep`, so it runs cross-platform.

**Approach:**
- The migrations were done inline so each commit (U5, U6, U7, U8) was green when it landed. U9 is the cross-cutting check that catches future regressions (e.g., a developer adds a new code path that respawns the right pane directly, bypassing `controller.showSource`). Without this test the invariant erodes silently.

**Patterns to follow:**
- Existing FakeTmuxService recorder assertion shape elsewhere in the test suite.

**Test scenarios:** the file IS the test. One assertion: the invariant holds across all `src/hosts/two-pane/` source files and all test fixtures.

**Verification:** New invariant test passes. `bun run check` green. The grep invariant is `grep -rn 'respawnPane.*rightPaneId' src/` returns zero hits; `tests/` may legitimately reference `respawnPane` for left-pane assertions but never for `rightPaneId`.

---

### U10. Cleanup, docs, and prior-doc archival

**Goal:** Delete dead code, update solution docs, mark prior brainstorms/plans as superseded.

**Requirements:** Origin "Next Steps" + open Q5.

**Dependencies:** U1–U9.

**Files:**
- `src/hosts/two-pane/tmux-host.ts` — remove any commented-out / unused helpers from U5–U7. **Final file-size posture:** `tmux-host.ts` is expected to remain above the project's 300-LOC warning cap after this plan (today 799; U5–U7 collectively remove ~150 lines, landing roughly 650). The 300-LOC rule is a warning, not an error; this plan explicitly accepts the violation rather than carving out a `lifecycle-handlers.ts` extraction whose only justification would be the LOC count. Leave a top-of-file comment naming the warning and the rationale (host is the natural integration seam between three subsystems — runners, lifecycle, pane-map — and splitting it for size alone would obscure the integration). Revisit if `tmux-host.ts` exceeds 700 LOC after the parallel-switcher pass.
- `src/hosts/two-pane/pane-map/right-pane-controller.ts` — confirm under 300 LOC.
- `docs/getting-started.md` — short paragraph: "The right pane in two-pane mode is a swap target. Live autonomous and command steps are visible via `tail -F` of their per-step tee in a hidden pane; interactive runners spawn a hidden PTY pane and swap in. Press Enter on a past step to swap in its replay (warm-cached after first view); press `f` to return to live."
- `docs/logging.md` — addendum: new lifecycle event types `pane-spawned`, `pane-killed`, `right-pane-swap`, `scratch-session-created`, `scratch-session-torndown`, `step:parallel-start`, `step:parallel-complete`.
- `docs/solutions/autonomous-transcript-rendering.md` — addendum: "As of 2026-05-11, the right pane reads from the tee via `tail -n 5000 -F` rather than receiving bytes via `sendKeys`. Same bytes, different delivery channel; first-view backfill bounded at the last 5000 lines."
- `docs/solutions/interactive-mode-colors.md` — frontmatter status flip: `shipped-partial` → `superseded` for the right-pane interactive case. Add a top-of-doc note: "For the two-pane host's right-pane interactive runners, see the unified pane-map design (2026-05-11). This doc remains authoritative for plain-host interactive paths."
- The new pane-map terminology (visible pane, hidden source pane, scratch session, swap target) goes into `src/hosts/two-pane/pane-map/scratch-session.ts` JSDoc + the `docs/getting-started.md` paragraph above. Avoid "attach" for the scratch session — it's deliberately unattached.
- `docs/brainstorms/2026-05-06-feat-decouple-live-runner-from-right-pane-brainstorm.md` — frontmatter: `status: superseded`, `superseded_by: docs/brainstorms/2026-05-11-feat-decouple-live-runner-unified-pane-map-brainstorm.md`.
- `docs/brainstorms/2026-05-07-feat-decouple-live-runner-from-right-pane-second-pass-brainstorm.md` — same.
- `docs/plans/2026-05-07-feat-decouple-live-runner-from-right-pane-phase-1-plan.md` — frontmatter: `status: superseded`, `superseded_by: docs/plans/2026-05-11-001-feat-decouple-live-runner-unified-pane-map-plan.md`.
- `docs/plans/implementation-phases.md` — update active-phase pointer once this plan lands.

**Approach:** Most of this is a single-commit cleanup. The archival annotations are 3-line frontmatter edits. The deferred solution doc on pane-queue pair-lock semantics ships when the parallel-switcher pass is planned (now also tied to dropping `enqueuePair` from v1 per U2), not as a follow-up to this plan.

**Test scenarios:** none — this is documentation and cleanup. Test expectation: none — pure docs/dead-code removal, no behavior change.

**Verification:** `bun run check` green; frontmatter of superseded docs reads `status: superseded`; `grep` for any removed helper names returns zero hits in `src/`.

---

## Risk Analysis & Mitigation

### Risk 1: Cross-session `swap-pane` has tmux-version-specific quirks

**Likelihood:** Low–medium. tmux `swap-pane` has supported cross-session targets for years, but specific terminal emulators (iTerm2, Ghostty, Alacritty, kitty) have varying redraw behavior after a swap — partial redraws, cursor position drift, alt-screen state confusion can all surface.

**Mitigation:**
- Real-tmux integration test that exercises a swap-pane between two sessions and captures pane content (`capturePane`) before / after. Sanity-checks bytes survive the swap; doesn't catch render glitches but catches the underlying mechanism.
- Document the dev environment (tmux version, terminal emulator) in the PR. The brainstorm explicitly accepts "if it works on the dev machine's tmux + iTerm/Ghostty combo, it'll work for the user."
- Fallback plan: if redraw glitches are observed in a specific emulator, add a `tmux refresh-client -t orch:0` after each swap. Cheap, well-supported, but adds latency.

### Risk 2: `tail -F` flickers / scrolls oddly, or first-view backfill is too large

**Likelihood:** Low. The tee receives complete `renderTranscriptLine`-rendered bytes per call. ANSI sequences are well-formed at write time. v1 uses `tail -n 5000 -F`: `-F` retries on inode changes (so tee re-open doesn't break the follow on macOS BSD tail), and `-n 5000` bounds the first-view backfill to roughly the last 500KB of ANSI — small enough that swap-in feels instant even for long-running steps.

**Mitigation:** If flicker is observed, narrow the `-n` further (e.g., `-n 2000`). If a long step's last-2000-lines truncates important state, surface that as a Acceptance Criteria revision rather than removing the bound — unbounded first-view backfill caused the original "10MB scrolls on swap" concern.

### Risk 3: PaneQueue pair-lock — n/a in v1

**Likelihood:** n/a. v1 does not introduce `enqueuePair` (see U2 — deferred). All swaps run via sequential single-pane `enqueue` calls dispatched serially from the controller. Risk re-emerges when the parallel-switcher pass adds concurrent user-driven swaps; the pair-lock primitive lands at that point with its first real caller.

**Mitigation:** None needed in v1.

### Risk 4: Scratch session dimensions drift from visible — explicitly deferred

**Likelihood:** Medium for noticeable drift, low for actual breakage. The user resizes the terminal; the scratch window stays at its create-time dimensions; the next swap may render at stale dims. tmux re-renders panes on swap so the dimensional mismatch is typically self-correcting at the moment of swap.

**Mitigation:** v1 has no active resize handling (see Decision 10). If observed in practice, follow up with either (a) a `tmux refresh-client` after each swap, or (b) the `resizeWindow` + debounced-handler approach the brainstorm originally proposed. Both are cheap to add post-hoc; neither is in v1's critical path.

### Risk 10: Scratch session creation fails at host construction

**Likelihood:** Low. tmux server is generally stable, but fd-limit exhaustion, server OOM, or socket EACCES could surface on heavily-loaded dev machines.

**Mitigation:**
- Bootstrap ordering (U3): create the scratch session FIRST, then split the visible right pane. If scratch creation fails, the visible right pane has not yet been split, so no orphaned UI exists — the error bubbles up cleanly to the run startup path.
- A stale `orch-scratch` session from a crashed prior run cannot collide because the per-run socket `orch-<runId>` is unique. (Verified at plan time: per-run socket isolation guarantees no cross-run state survives.)
- `destroy-unattached off` is set explicitly on the scratch session (U3) so a user's `~/.tmux.conf` cannot tear it down.

### Risk 5: `pane-died` channel collision between visible and hidden panes

**Likelihood:** Negligible. Channels are keyed by pane id, which is server-unique.

**Mitigation:** Test asserts the channel name format is `pane-exit-<paneId>` and that distinct panes get distinct channels (`session-init.ts` test already validates).

### Risk 6: Tee growth — replay panes hold `tail -f` open against ever-growing files

**Likelihood:** Low for short-running sessions. Medium for long-running parallel-heavy workflows.

**Mitigation:** Per-step tees are bounded by step duration (file size ≈ rendered transcript). Rollup tee is bounded by parallel-block count. None grow unbounded across the session lifetime.

### Risk 7: PTY pane interactivity edge cases (Ctrl-C, paste, terminal resize)

**Likelihood:** Medium. The brainstorm doesn't predict exhaustively how a tmux pane with a runner argv differs from `respawnPane` of the runner argv. The mechanism should be identical (both are `splitPane`/`respawnPane` calls into a pane with the same env). But the swap step is new.

**Mitigation:**
- The interactive pane is born in the scratch session; its `pane-died` hook fires there. Validate every interactive test exit path (clean exit, Ctrl-C, runner crash).
- Manual smoke matrix: each runner (Claude, Codex), each exit mode (clean exit, single Ctrl-C, double Ctrl-C). Document in PR description.

### Risk 8: Workflow lifecycle doesn't carry `stepName` into `InteractiveSpawn`

**Likelihood:** Resolved. `InteractiveSpawn` declares `readonly stepName: StepName` at `src/hosts/host.ts:54`. No upstream plumbing change required for U6.

**Mitigation:** None needed. Retained here as a verified-resolved note so the implementer doesn't re-walk the check.

### Risk 9: Existing real-tmux integration tests' fixtures assume the visible-pane-only model

**Likelihood:** High for any test that does direct `tmux list-panes` on the `orch` session and asserts pane count.

**Mitigation:** Audit and update such tests in U9. New invariant: `orch` session has 2 panes (left + right); `orch-scratch` has N panes (variable).

---

## Acceptance Criteria

### Functional

- [ ] `RightPaneController.registerSource / showSource / unregisterSource / followLive / emitBanner` public methods exist; `onIntent` dispatches to them.
- [ ] Scratch session `orch-scratch` is created at host start (on the same per-run socket) BEFORE the visible right pane is split; killed at teardown strictly before the `orch` session. `destroy-unattached off` is set explicitly so user tmux config cannot kill it.
- [ ] Every visible-right-pane content change is a `tmux swap-pane` issued by `controller.showSource`. No `respawnPane` is called on `rightPaneId` after this plan lands (excluding the left pane, which keeps its existing semantics for the steps-view daemon).
- [ ] Autonomous live: `controller.registerSource({type:'live', stepName}, {kind:'file-tail', path: teePath})` on `step:start`. `unregisterSource` on `step:complete`/`step:failed` transforms the entry to `{type:'replay', stepName}` (warm cache for revisits). On `step:complete` while the live source is `currentKey`, the controller emits an info banner and transitions `viewMode` to `{mode:'replay', stepName}` so the user sees the transcript is now frozen.
- [ ] Command-step live: same shape as autonomous.
- [ ] Interactive: `controller.registerSource({type:'interactive', stepName}, {kind:'pty', argv, env, cwd})` on `runInteractive`. After `tmux.waitFor('pane-exit-<hiddenPaneId>')` settles, `unregisterSource` kills the hidden pane (no warm cache for interactive). `env` and `cwd` flow through `splitPane`'s argv overload (U1).
- [ ] Rollup: own hidden pane at `<logsDir>/agents/_rollup/formatted_output.ansi` (reuses `createPerStepTee` with `'_rollup'` step key). `enqueueRight(renderRollupPayload(...))` is gone. `step:parallel-start`/`step:parallel-complete` lifecycle events drive register/unregister. `RollupAggregator.reset()` fires on each `step:parallel-complete`.
- [ ] Past-step Enter mid-flight succeeds without a busy refusal. The `isRightPaneBusy` option and `inFlight` set are deleted.
- [ ] `f` keybind → `controller.followLive()` → prefers `{type:'rollup'}` if registered; otherwise most-recently-registered live/interactive source; placeholder if none.
- [ ] `StepsViewState` carries `view: ViewMode` and optional `banner: Banner` (with monotonic `seq`). The Ink renderer keys the auto-dismiss timeout on `banner.seq` so identical-text successive banners restart the timer. Footer derives from `view.mode`; long stepName truncates to 30 chars + `…`.
- [ ] Banner: info auto-clears after `ttlMs ?? 4000`; error persists until replaced or `Esc`-dismissed (when help overlay is closed). Live-mode footer omits `f follow` (no-op token); replay-mode footer shows `f live`.
- [ ] `dismiss-banner` intent variant added to `StepsIntentSchema`.
- [ ] Cached steps: banner-only ("step N — cached (no transcript captured)"), no pane registered, no `viewMode` change.
- [ ] Failure summary: `tee.write(stepName, renderFailurePanePayload(summary))` BEFORE `unregisterSource` BEFORE `tee.close`. Error banner fires unconditionally on step:failed.
- [ ] Help overlay (`?`) lists the new `f`/banner/view-mode behaviors.
- [ ] No active resize handling in v1 (deferred per Decision 10).

### Non-functional (project rules)

- [ ] **Rule 1 (subprocess isolation):** No new `child_process` / `Bun.spawn` / `node-pty` imports outside `src/services/process/`. `tail` runs inside a tmux pane.
- [ ] **Rule 5 (file size ≤ 300):** `right-pane-controller.ts` ≤ 300 LOC. `tmux-host.ts` is *explicitly accepted* to stay above the warning cap (~650 LOC after U5–U7 trim) per U10; the rule remains a warning, not an error, and splitting for size alone would obscure the host's role as the runner/lifecycle/pane-map integration seam.
- [ ] **Rule 6 (strict TS):** No `any`, no `!`. All new types `readonly`-by-default.
- [ ] **Rule 7 (single barrel):** New exports through `src/hosts/two-pane/index.ts` and `src/hosts/two-pane/pane-map/index.ts`.
- [ ] **Rule 9 (Path branded):** `PaneSpec.path` and tee-path helpers are `Path`, not `string`.
- [ ] **Rule 10 (`bun run check`):** Green at every commit. Each behavior-changing unit (U5/U6/U7/U8) migrates its own tests in the same commit so check stays green throughout — not deferred to a centralized U9.

### Environment / version

- [ ] **tmux minimum version pinned** at host bootstrap: `tmux -V` parsed; if below `tmux 3.0`, the host fails fast with a clear error pointing at the version requirement. tmux 3.0+ is required for stable cross-session `swap-pane`, `resize-window -x/-y`, and global `pane-died` hook behavior under per-run sockets.
- [ ] `tail` resolves to a BSD-or-GNU-compatible binary on PATH (verified at bootstrap via `Bun.which('tail')`; no orch-side path-pinning required).

### Quality gates

- [ ] Real-tmux integration test exercising the scratch-session + swap-pane path passes when `tmux >= 3.0` is on PATH (skipped otherwise).
- [ ] `right-pane-live-doubling.real.integration.test.ts` is converted to a regression guard (asserts doubling does NOT occur in the new model); ungated. Lands in U5.
- [ ] Invariant test (U9): `respawnPane` calls in `src/hosts/two-pane/` never target `rightPaneId` (left pane and scratch-session panes are allowed targets).
- [ ] All previously-passing integration tests pass under the migrated shape — migrations land inline with U5/U6/U7/U8, not in a centralized U9.
- [ ] **Manual smoke matrix** — recorded as a checklist in the PR body by the developer who merges, before merge:
  - 3-step autonomous workflow: live `tail -F` on each step; Enter past steps mid-flight; `f` returns to live; step:complete flips footer to replay.
  - Single interactive workflow: full Ctrl-C + clean-exit + crash paths (Claude and Codex each).
  - Parallel block of 3 branches: rollup visible in its own swap-able pane; `f` from replay returns to rollup, not an arbitrary branch.
  - Cached step: info banner only, no pane swap, no viewMode change.
  - Resume from a past interactive step: hidden PTY pane swapped in.
  - Long stepName (>30 chars): footer shows truncation with `…`.
  - Forced step:failed: error banner appears; persists; `Esc` dismisses.
  - Three rapid info banners with identical text: each restarts the 4s timer (verifies `seq` key works).

---

## Success Metrics

This is internal infrastructure. Half the metrics are observable on day-of-merge; half are observable in the first week of use.

### Day-of-merge (verifiable in the PR)

- **Past-step Enter no longer refuses mid-flight.** The `right-pane-busy-gate` test, previously asserting refusal during in-flight, now asserts the swap succeeds — verified in CI.
- **`right-pane-live-doubling` regression guard ungated.** The test previously gated on `ORCH_REPRO_BUG=1` runs on every CI build and stays green, proving the `send-keys -l` echo-doubling bug cannot recur in the file-tail model.
- **One seam invariant holds.** `grep "respawnPane.*rightPaneId" src/` returns zero hits after this plan. Static check; the abstraction wasn't bypassed.
- **Interactive PTY symptoms resolved.** Manual smoke confirms arrow keys, Ctrl-R, Ctrl-C, color reflow, and resize reflow all work natively inside interactive runners — closing the four "escalate to full PTY" symptoms `docs/solutions/interactive-mode-colors.md` calls out.

### Week-1 / Forward-looking (observable in follow-up work)

- **Parallel-branch switcher UX** (deferred work) lands by adding a single switcher input handler plus an inner `liveSources` ordering — zero changes to `RightPaneController`'s contract.
- **`right-pane-controller.ts` stays ≤ 300 LOC** through the parallel-switcher pass and beyond.
- **No new busy gates.** Future features that need to gate the right pane reach for `currentKey` / `panes.has(...)` queries, not new booleans.

---

## Dependencies & Prerequisites

**External dependencies:**
- **tmux >= 3.0** on PATH. Required for stable cross-session `swap-pane`, the global `pane-died` hook under per-run sockets, and consistent `resize-window` semantics. Host bootstrap parses `tmux -V` and fails fast with a clear error if below this floor.
- **`tail`** on PATH (system `tail`; BSD-on-macOS and GNU-on-Linux are both supported by `-n N -F`).

**Internal prerequisites already shipped:**
- `per-step-tee.ts` `open/write/close/drain` (`src/hosts/plain/per-step-tee.ts`).
- `pane-queue.ts` single-pane serialization (`src/hosts/two-pane/pane-queue.ts`).
- `RollupAggregator` (`src/hosts/two-pane/parallel-rollup.ts`).
- `failure-pane.ts` `renderFailurePanePayload` (`src/hosts/two-pane/failure-pane.ts`).
- `StepsViewState` projection contract (`src/hosts/two-pane/steps-view/`).
- `tui-state.ndjson` / `tui-intents.ndjson` IPC stream.
- `pane-died` global hook (`src/services/tmux/session-init.ts:117-122`).
- Branded `PaneId` / `SocketName` / `Path` types.
- Per-run socket isolation (`tmux-host.ts:198`).

**Workflow-side prerequisite (verified):** `InteractiveSpawn.stepName` is already declared at `src/hosts/host.ts:54`. No plumbing change needed; U6 can consume `spawn.stepName` directly.

---

## References & Research

### Internal references

**Right-pane controller (current shape, to be replaced):**
- `src/hosts/two-pane/right-pane-controller.ts:36-69` — options including the `isRightPaneBusy` to be removed.
- `src/hosts/two-pane/right-pane-controller.ts:82-104` — `closeReplay` (replaced by `followLive`).
- `src/hosts/two-pane/right-pane-controller.ts:123-136` — `writeBusyFooter` (deleted).
- `src/hosts/two-pane/right-pane-controller.ts:138-179` — `dispatchEnter` (rewritten as `onIntent('enter')` path).
- `src/hosts/two-pane/right-pane-controller.ts:207-250` — `dispatchByKind` (becomes `resolveReplaySpec`).
- `src/hosts/two-pane/right-pane-controller.ts:260-281` — `respawnCatInline` (logic preserved in commit/worktree/ask replay path; output is a static file, not a respawn).
- `src/hosts/two-pane/right-pane-controller.ts:317-353` — `dispatchAgentInteractive` (resume-from-past path; migrates into the new controller).

**Host lifecycle hooks:**
- `src/hosts/two-pane/tmux-host.ts:198` — per-run socket `orch-<runId>`.
- `src/hosts/two-pane/tmux-host.ts:245-251` — visible right pane creation via `splitPane`.
- `src/hosts/two-pane/tmux-host.ts:540-555` — `enqueueOnPane` / `enqueueRight` (eliminated for right-pane-bound writes).
- `src/hosts/two-pane/tmux-host.ts:557-567` — `onCommandLine` (drops sendKeys; tee.write remains).
- `src/hosts/two-pane/tmux-host.ts:569-613` — `onLifecycleEvent` (rewired in U5, U7).
- `src/hosts/two-pane/tmux-host.ts:582-587` — `inFlight` (deleted in U5).
- `src/hosts/two-pane/tmux-host.ts:589-598` — `step:failed` handler (rewired in U5).
- `src/hosts/two-pane/tmux-host.ts:599-612` — `step:parallel-branch-update` rollup (rewired in U7).
- `src/hosts/two-pane/tmux-host.ts:615-648` — `onRunnerEvent` (rewired in U5; sendKeys dropped).
- `src/hosts/two-pane/tmux-host.ts:659-720` — `runInteractive` (rewired in U6).
- `src/hosts/two-pane/tmux-host.ts:742-776` — `teardown` (scratch session torndown first in U3).

**TmuxService:**
- `src/services/tmux/tmux-service.ts:215-243` — `RespawnPaneOptions` (template for new `SwapPaneOptions`).
- `src/services/tmux/tmux-service.ts:272-296` — `NewWindowOptions` argv shape (template for `splitPane` argv overload).
- `src/services/tmux/real-tmux-service.ts:108-140` — `splitPane` impl (extended in U1).
- `src/services/tmux/real-tmux-service.ts:305-327` — `respawnPane` impl (template for `swapPane`).
- `src/services/tmux/session-init.ts:117-122` — global `pane-died` hook (cross-session).
- `src/services/tmux/session-init.ts:125-146` — config file generation.
- `src/services/tmux/fake-tmux-service.ts:45-66` — `RecordedCall` union (extended in U1).

**PaneQueue:**
- `src/hosts/two-pane/pane-queue.ts:19-50` — current API (extended in U2).

**Per-step tee:**
- `src/hosts/plain/per-step-tee.ts:29-99` — full API (analog for new rollup tee in U7).
- `src/hosts/plain/per-step-tee.ts:67-74` — sink path layout `<logsDir>/agents/<step>/formatted_output.{ansi,txt}`.

**Steps-view:**
- `src/hosts/two-pane/steps-view/step-types.ts:75-94` — `StepsViewState` (extended in U4).
- `src/hosts/two-pane/steps-view/project-steps-view.ts:25-65` — projector (extended in U4).
- `src/hosts/two-pane/steps-view/start-steps-view.ts:34-40` — `StepsIntentSchema` (extended in U4).
- `src/hosts/two-pane/steps-view/steps-view.tsx:76-118` — Ink keypress handler (rewired in U4 for `Esc`).
- `src/hosts/two-pane/steps-view/steps-view.tsx:230` — keymap footer (rewired in U4 for view-mode-driven text).

### CLAUDE.md rules cited

- Rule 1 (subprocess isolation): `tail` runs inside a tmux pane via `splitPane`/`respawnPane`; no `child_process` / `Bun.spawn` / `node-pty` outside `services/process/`.
- Rule 3 (mock only at the edge): unit + integration tests mock `TmuxService`, `PaneQueue`, `StateStore`, `SessionLogger` ports only. No `mock.module` / `vi.mock` inside `src/hosts/`.
- Rule 5 (file size ≤ 300): pane-map controller split into multiple files; `tmux-host.ts` trends down.
- Rule 6 (strict TS): no `any`, no `!`; `SourceKey` and `PaneSpec` are `readonly`-by-default discriminated unions.
- Rule 7 (single barrel): new exports through `src/hosts/two-pane/index.ts` and `src/hosts/two-pane/pane-map/index.ts`.
- Rule 9 (`Path` branded): `PaneSpec.path` is `Path`, not `string`.
- Rule 10 (`bun run check`): green at every sub-phase commit.

### Solution docs cited

- `docs/solutions/autonomous-transcript-rendering.md` — renderer ownership; tee is the canonical artifact. **Honored:** the new file-tail panes read from the same tee that already exists.
- `docs/solutions/interactive-mode-colors.md` — `FORCE_COLOR=3` rationale; "escalate to full PTY" notes. **Superseded for the right-pane interactive case** by U6 (tmux pane = full PTY).
- `docs/solutions/two-pane-auto-attach.md` — nested-tmux guard; attach lifecycle; "named entities collide" lesson. **Honored:** scratch session is unattached; glossary update in U10.

### Origin brainstorm decisions honored

- One mechanism (`swap-pane`), two pane archetypes (`file-tail`, `pty`). ✓ (U3, U5, U6, U7, U8)
- Per-run scratch session, no client. ✓ (U3, Decision 1)
- Spawn on `step:start`, kill on `step:complete`/`step:failed` (autonomous + interactive). ✓ (U5, U6)
- Replay panes spawn on first view, warm-cached. ✓ (U3, U8)
- Failure summary appended to tee before close. ✓ (U5)
- Banner + view indicator. ✓ (U4)
- `f` keybind = `followLive()`. ✓ (U3, U4)
- Rollup moves into pane map. ✓ (U7)
- Cached steps: banner only. ✓ (U5, Decision 11)
- pane-queue multi-pane lock variant. ✓ (U2)
- Scratch session dimensions match visible right pane; resize plumbing. ✓ (U3, Decision 10)
