# Brainstorm — replay step output in the right pane (drop window-1 design)

> Status: open question, no plan yet. Read this first, then decide whether to
> draft a plan or push back on the premise.

## What changes

Today the steps-view "Enter to inspect" flow creates a brand-new tmux window
(`window 1`) with a single pane and `select-window`s the client onto it. Both
of the user's panes (left = steps view, right = live agent) vanish; the user
sees only the replay content. `f` returns them to window 0.

We want **Enter to update the right pane in window 0 in place** — the steps
view stays visible on the left, the right pane swaps from "live" to
"replay-of-step-X". `f` restores the right pane to live (or to the post-run
idle state). No new tmux window. Single window, single layout, two panes
always.

Motivation: a real user (2026-05-06) hit Enter expecting the right pane to
update, was surprised by the layout takeover, and reported it as a bug. The
window-1 design also forces an awkward "press q to quit · ⏎ to inspect"
footer that hints at navigation but obscures the consequence.

## Where the current design lives

- `src/hosts/two-pane/right-pane-controller.ts` — owns window-1 lifecycle.
  `dispatchEnter` calls `tmux.newWindow → dispatchByKind(paneId in window 1) →
  selectWindow(window 1)`. `closeReplayWindow` does the inverse on `f`/`q`.
  The "window 0 (live) is never touched" invariant is in the file header.
- `src/hosts/two-pane/tmux-host.ts:240-280` — splits window 0 into
  `leftPaneId` and `rightPaneId`. `rightPaneId` runs the live agent /
  command for whichever step is currently executing. The live runner writes
  here via `runInteractive({ pane: 'right', ... })`.
- `src/hosts/two-pane/replay-transcript.ts` — autonomous agent replay
  (renders NDJSON transcript via `sendKeys`).
- `src/hosts/two-pane/replay-command-pane.ts` — command-step replay (reads
  `<stateDir>/logs/tmux/<rightPaneId>.log`, only present under `--debug`
  via `pipe-pane`).
- `src/hosts/two-pane/kind-details.tsx` — synchronous string renderer for
  commit / worktree / ask kinds.
- `src/hosts/two-pane/right-pane-controller.ts:dispatchAgentInteractive` —
  uses `tmux.respawnPane({ killRunning: true, argv: <claude --resume …> })`.
  This already does what direction B needs — it's the model to copy.
- `src/services/tmux/real-tmux-service.ts` — exposes `respawnPane`,
  `sendKeys`, and the window primitives we're trying to retire from this
  flow. `respawnPane` is the load-bearing primitive for direction B.
- `src/services/tmux/session-init.ts` — `set -g remain-on-exit on` keeps
  dead panes visible after the process exits. Relevant: when the live
  agent's process dies, the pane stays around showing the final output.
- `src/hosts/two-pane/steps-view/start-steps-view.ts` — tails
  `tui-intents.ndjson`, calls `onIntent` (which today goes to
  `right-pane-controller.onIntent`). The intent contract
  (`enter`/`follow-live`/`quit`) doesn't need to change.

## The hard part: live-vs-replay state on the right pane

The right pane is **not always idle**. Three cases:

1. **Run completed.** The right pane is sitting on the last live output (or
   `[exited]` thanks to `remain-on-exit on`). Safe to overwrite. `f`
   restores nothing — there's no live to follow.
2. **Run mid-flight, autonomous step.** Right pane is the autonomous agent's
   live stream. Killing it would interrupt the live run. The user pressed
   Enter expecting "see step X" — what should happen?
   - Option (a): refuse, show "can't inspect during a live run" footer.
   - Option (b): pause live → swap to replay → `f` resumes live (but the
     live process won't pause cleanly; we'd lose the buffer between
     "pause" and "resume").
   - Option (c): split a third pane on the right side just for replay
     (kills the "always-two-panes" simplification).
3. **Run mid-flight, interactive step.** Right pane IS the claude pty.
   Killing it kills the user's running agent. Refuse + footer is the only
   safe answer here.

Decision: **the simplest workable design is "Enter is only legal when no
step is currently live in the right pane."** During a live step the footer
should advertise "⏎ disabled while step running · q quit · f noop" and
the controller's `onIntent` is a no-op. Post-run (or between steps if we
add a "step finished but next not yet started" marker) Enter is enabled.

Open question for the next agent: is the "live vs idle" gate observable
from the right-pane-controller, or do we need a new state signal threaded
in? `tmux-host` knows when it's `runInteractive`-ing on the right pane; the
controller currently doesn't.

## What 'f' means in the new design

In the current design `f` kills window 1 and selects window 0 — easy. In
direction B `f` has three jobs depending on state:

- Replay shown, run still running → respawn-pane back to the live runner.
  But the live runner is a `runInteractive` host call, not a free-floating
  argv we can re-launch. We'd need the host to keep a reference to the
  most recent live argv and re-spawn it. That's a bigger plumbing change.
- Replay shown, run completed → render the post-run idle marker (whatever
  `remain-on-exit` was showing before we overwrote it). We'd need to
  re-capture that buffer **before** overwriting, then play it back. Tmux
  has `capture-pane -p` which returns the pane's visible buffer as text.
- Replay shown, between steps → same as the live-running case but the
  argv to respawn is "the next step's runner" — which the controller
  doesn't know about either.

Decision pressure: this is a lot of state. The "Enter only when run
completed" gate from the previous section makes 'f' trivial again — `f`
just respawns whatever placeholder the right pane was showing (`cat` or
nothing), or even is a no-op since the user can also press `q` to exit
once the run is over.

## The pty-echo doubling bug (out of scope but worth flagging)

The window-1 replay shows duplicate output for sendKeys-based dispatchers
because `cat` is used as the placeholder and the pty has echo on. The user
hit this on 2026-05-06 — saw "resume unavailable" twice in window 1.
Direction B inherits this bug if we keep using `cat` as the right-pane
placeholder + `sendKeys` to write replay text. Fixes:
  - swap the placeholder for `tail -f /dev/null` (no stdin echo loop), OR
  - run `stty -echo` on the pane before sendKeys, OR
  - use `tmux load-buffer` + `paste-buffer` (writes verbatim, no pty echo).

The third option is probably the cleanest. Worth pinning down before any
plan lands so the new flow doesn't ship the same papercut.

## What direction B does NOT solve

- **Interactive resume still needs `resumeRunner` wired through the CLI.**
  Today `host-registry.ts` doesn't pass `resumeRunner` from
  `HostFactoryInputs` (the slot doesn't even exist on the type).
  `WorkflowExecutor` doesn't expose a "primary runner" the CLI could
  forward. Phase 3 is half-implemented. Direction B doesn't fix this — but
  if we move forward with B AND wire the runner, the user can resume an
  interactive step in the right pane via `respawnPane` (the same
  `dispatchAgentInteractive` primitive, retargeted to `rightPaneId` in
  window 0 instead of a new window's pane). See
  `src/hosts/two-pane/right-pane-controller.ts:262` for the existing
  resume call site.
- **The diagnostic logging from the 2026-05-06 fix.** The `tui-intent →
  replay-intent → replay-window-opened/selected` log chain stays useful;
  in direction B the entry names should change from `replay-window-*` to
  `replay-pane-*` (it's the same pane, no window).

## Tests that constrain the redesign

- `tests/unit/hosts/two-pane/right-pane-controller.test.ts` — pins the
  `newWindow → sendKeys → selectWindow` ordering. **All of these change**
  in direction B; this file is the canary for the redesign.
- `tests/unit/hosts/two-pane/right-pane-resume.test.ts` — pins the
  `respawnPane` call shape for interactive resume. **Stays useful**, the
  call moves from "new window's paneId" to "right pane's paneId".
- `tests/integration/hosts/two-pane/two-pane-mocked.test.ts` — mocked tmux
  integration. May need updates if it asserts the window-1 dance.
- `tests/integration/hosts/two-pane/resume-launcher-mocked.integration.test.ts` —
  ditto, but for resume.

## What to evaluate in a plan

1. The "Enter only when run completed" gate — is that acceptable UX, or
   does the agent want to make Enter work mid-flight too? If yes, how?
2. Pre-overwrite buffer capture — should `f` restore the pre-replay state?
   `tmux capture-pane -p` is the primitive; cost is one shell exec per
   Enter.
3. Placeholder choice — keep `cat`, switch to `tail -f /dev/null`, or use
   `load-buffer`+`paste-buffer` to bypass the placeholder entirely.
4. Live-vs-idle signal — does the controller need a new "right-pane state"
   parameter from the host, or can it observe via `display-message` or by
   tracking `runInteractive` lifecycle on the right pane?
5. 'f' semantics — no-op post-run? Re-spawn live mid-run? What does it do
   if the user pressed `f` without a prior `enter`?
6. Logging — rename `replay-window-*` lifecycle entries to `replay-pane-*`
   and keep the same chain so the 2026-05-06 diagnostic remains
   actionable.
