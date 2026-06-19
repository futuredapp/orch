# Replay of a completed long-prompt step opens at the transcript tail, not the prompt top

**Source:** Codex review #2 (P2, confidence 75). Cross-checked against CE review's
"Coverage notes" (which flags the same behavior and calls it intentional).

**Status:** Not selected for fixing — this would **expand scope beyond the
acceptance contract**. Recorded for a product decision.

## What it is

When an autonomous step opens **live**, the controller pins the pane to the top of
the prompt: `registerSource` calls `pinSourceToPromptTop` only for
`key.type === 'live' && spec.kind === 'file-tail' && spec.fromStart === true`
(`src/hosts/two-pane/pane-map/right-pane-controller.ts:472`). On **replay**
(`dispatchEnter` → `showReplaySourceWithStaleRefresh`,
`right-pane-controller.ts:1078-1082`), the replay source is registered and shown
with **no** equivalent pin. The replay file is tailed from the start
(`tail -n +1 -F`), so the whole file streams into the pane, but tmux's live screen
lands at the **bottom** — the watcher sees the transcript tail, not the `prompt:`
label.

Net effect: a reviewer reloading a completed run with a long prompt has to scroll
back up to see what the agent was asked.

## Where

- `src/hosts/two-pane/pane-map/right-pane-controller.ts` — `dispatchEnter` /
  `showReplaySourceWithStaleRefresh` (~`:1011`-`:1082`); the live-only pin gate at
  `:472`; `pinSourceToPromptTop` at `:547`.

## Why it's an issue (and why it was NOT auto-fixed)

R9 says "When a non-interactive step **opens**, the pane MUST be scrolled to the
top of the prompt." Whether "opens" includes a *replay* open is genuinely
ambiguous, and the human-reviewed acceptance contract resolves it toward
**live-only**:
- **AT-9** (the scroll-to-top test) is scoped to "a real autonomous run with an
  over-height prompt" — a live open. It says nothing about replay scroll position.
- **AT-7** (the replay test) only requires "the same prompt appears above the
  replayed output" — presence, not viewport position.
- The plan's **Phase 3** deliberately pins only the live auto-swap, and the CE
  review explicitly reads replay-not-pinned as intentional ("This matches AT-9
  (scoped to the live open) ... flagged only for product confirmation").

So pinning replay opens to the prompt top would be a **scope expansion** /
product-behavior decision, not a defect against the contract. Fixing it silently
would contradict the "don't expand scope" rule for this pass.

## Suggested next step

A product call: should replay opens *also* pin to the prompt top for consistency
with live opens? If yes, this is a clean, well-bounded follow-up:
- After `showReplaySourceWithStaleRefresh` for an autonomous replay whose resolved
  spec is prompt-bearing/from-start, apply the same copy-mode top pin
  (`pinSourceToPromptTop`) — or factor the pin decision into `showSource` so both
  the live auto-open and the replay open can opt in.
- Add an AT-7/R9 regression: reload/select a completed long-prompt autonomous step
  and assert the copy-mode-aware viewport starts at the `prompt:` head.

If the answer is "live-only is intended," update R9/AT-9 wording to say so
explicitly and close this out.
