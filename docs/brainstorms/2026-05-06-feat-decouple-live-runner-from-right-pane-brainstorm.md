---
date: 2026-05-06
topic: decouple-live-runner-from-right-pane
status: superseded
superseded_by: docs/brainstorms/2026-05-11-feat-decouple-live-runner-unified-pane-map-brainstorm.md
---

# Decouple the Live Runner From the Visible Right Pane

## What We're Building

Two related changes to the two-pane host so users can freely view past step output (and other transient status) while a step is running, without corrupting the live agent's stream.

1. **Left-pane banner primitive.** A small Ink banner slot in `steps-view` for transient status messages ("viewing step 3 — press f for live", "replay loaded", errors, gate refusals). Replaces the current anti-pattern of writing UI messages directly into the right pane via `tmux.sendKeys()`.
2. **Live runner / right-pane decouple (Approach B).** Free past-step viewing while the current step keeps running.
   - **Phase 1 — autonomous (`tail -f` the tee).** Switch the live display for autonomous runners from `send-keys → cat` to `tail -f <step.tee>`. The runner subprocess already runs in the orchestrator process (not in tmux), so its survival is independent of the visible pane. Past-step Enter respawns the right pane to `cat <past-tee>`; `f` respawns to `tail -f <live-tee>`.
   - **Phase 2 — interactive (hidden-pane swap).** Spawn interactive (resume) runners into a hidden tmux pane. The visible right pane swaps with that hidden pane (via a new `swap-pane` wrapper) when the user wants to attach to live; swaps back to surface a replay. The interactive runner's PTY survives the swap because its pane is never killed.

## Why This Approach

Tail-f alone (Approach A) was attractive for its simplicity but doesn't cover interactive runners — those subprocesses own the tmux pane PTY directly, so there's nothing for the orchestrator to tail. Approach B addresses both modes at the cost of one new tmux primitive (`swap-pane`) and a hidden-pane lifecycle.

A per-step tmux session model (Approach C) was rejected as YAGNI: too much session lifecycle for the current usage pattern.

The banner is built as its own concern because it's a useful primitive independent of the runner-decouple work, and because writing UI text into a runner's stdout via `send-keys` is fundamentally wrong.

## Key Decisions

- **Live autonomous display = `tail -f <step.tee>`.** The per-step tee file (`tmux-host.ts:638`) becomes the single source of truth. The `send-keys`-into-`cat` mechanism for autonomous output is removed. Decision: simpler, removes the corruption seam, makes past↔live swapping symmetric (both are just `respawn-pane -- <cat|tail>`).
- **Live interactive display = hidden pane swapped into view.** Interactive runner argv goes to a tmux pane in a hidden location (window 1 or a scratch window — chosen at plan time). Visible right pane uses `swap-pane` to exchange with it. Decision: keeps the interactive PTY untouched across all UX swaps.
- **Past-step Enter is no longer gated** for autonomous-while-live. For the interactive-while-live case, Phase 1 keeps a soft gate (banner-displayed) until Phase 2 lands; Phase 2 removes the gate entirely.
- **Banner state is a single field on `StepsViewState`.** Simple `{ banner?: { kind: 'info' | 'error', text: string, ttlMs?: number } }`. The host writes it via the same projection path that already feeds `StepsViewState` — no new event channel.
- **Phase 1 ships independently.** The banner + autonomous-tail-f changes are useful on their own; the hidden-pane swap (Phase 2) lands as a follow-up plan.

## Resolved Questions

- **Auto-follow on new step start?** Stay on the past view; surface a banner ("step N running — press f to follow"). Respects user intent over auto-jumping.
- **Tail position on `f` back-to-live.** `tail -f` from head — show the full transcript scrollback for the live step, matching today's behavior.

## Open Questions (deferred to Phase 2 plan)

- **Hidden-pane location for interactive.** Window 1 vs scratch session vs hidden window in the same session? Trade-offs around layout preservation and tmux client behavior.
- **Resize handling for the swapped interactive pane.** Live interactive PTY may have been sized to the hidden pane's dimensions; on swap into the visible spot, does it need a `resize-pane` or `refresh-client` nudge?
- **Behavior when interactive runner exits while user is on a replay.** Banner the completion and stay on the replay, or auto-swap back? (Default leaning: banner only.)

## Next Steps

→ `/workflows:plan` for Phase 1 (banner + tail-f autonomous decouple).
→ Separate planning pass for Phase 2 (hidden-pane swap for interactive) once Phase 1 lands and the open questions above have UX evidence.
