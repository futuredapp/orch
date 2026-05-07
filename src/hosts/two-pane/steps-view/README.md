# steps-view — two-pane left-pane navigator

The Ink-rendered driver's-seat that replaces the text-painted `status-pane`
under `--mode=two-pane`. Reads on-disk run state and emits user keypress
intents to a single file the parent watches.

## Component / IPC seam / failure mode

- **Component (`steps-view.tsx`).** `<StepsView>` + `<StepRow>` +
  `<HelpOverlay>` rendered into the left pane's TTY. Selection is
  sticky-on-`stepName` once arrows are pressed; `f` snaps back to the live
  step. Adaptive layout drops the elapsed column below width 70.

- **IPC seam (file-based intents, `tui-intents.ndjson`).** The Ink child
  writes one JSON line per keypress to `<stateDir>/tui-intents.ndjson`.
  The parent's `start-steps-view.ts` watches that file via
  `tail-ndjson.ts` (`startAtEnd: true` so stale lines from a prior run
  don't replay) and dispatches each parsed `Intent` to its consumer
  (Phase 2 wires `right-pane-controller`; Phase 1 ignores them).

- **Failure mode (no watchdog).** If the Ink child exits before the
  parent calls `stop()`, the parent appends a `tui-crashed` lifecycle
  record and writes `"TUI unavailable — detach + reattach to retry, run
  continues"` to the left pane via `PaneQueue`. The live run in window 0
  is unaffected.
