# `enterCopyModeTop` partial failure leaves the pane in copy-mode with a misleading log

**Source:** CE review L-2 (low / P3, reliability).

**Status:** Not selected for fixing — benign degradation, "acceptable as-is" per
the reviewer. Recorded as optional hardening.

## What it is

`enterCopyModeTop` (`src/services/tmux/real-tmux-service.ts:466-479`) issues two
sequential tmux commands: `copy-mode` (cmd 1), then `send-keys -X history-top`
(cmd 2). If cmd 1 succeeds but cmd 2 fails, the method throws while the pane is
**already in copy-mode**, parked at the live tail (not scrolled to the top). The
caller `pinSourceToPromptTop`
(`src/hosts/two-pane/pane-map/right-pane-controller.ts:547-553`) catches and logs
the throw as `prompt-pin-failed` but issues no compensating `cancelCopyMode`, so
the pane is left in copy-mode at the wrong position.

## Where

- `src/services/tmux/real-tmux-service.ts:466-479` (`enterCopyModeTop`).
- `src/hosts/two-pane/pane-map/right-pane-controller.ts:547-553`
  (`pinSourceToPromptTop`, the catch site).

## Why it matters (low)

It degrades gracefully: in the intended success path the pane is deliberately left
in copy-mode anyway, and the user's escape hatch (`f` / scroll-to-tail / Enter)
works regardless of where copy-mode is parked — so this is not a hang or a
step-open breaker (verified). The only real residual is that the
`prompt-pin-failed` log misleadingly implies the pane was **not** mutated, when in
fact it was left in copy-mode. cmd-2 failing on the enforced tmux floor is also
unlikely (`history-top` is the same copy-command bound to `g` in `session-init`).

## Suggested next step

Optional hardening, if touched later: in the cmd-2 failure branch of
`enterCopyModeTop` (or in `pinSourceToPromptTop`'s catch), attempt a best-effort
`send-keys -X cancel` before rethrowing, so the partial state rolls back to the
deterministic live-tail-not-in-mode state and the log no longer overstates the
no-op. Acceptable to leave as-is.
