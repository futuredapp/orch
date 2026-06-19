---
date: 2026-06-19
topic: show-initial-prompt
---

# Show the Initial Prompt in the Right Pane (Non-Interactive Runs)

## Summary

When a Claude Code or Codex step runs in non-interactive (autonomous) mode, prepend the exact prompt orch sent to the agent at the top of that step's right pane — full text, verbatim, lightly marked — so the pane always shows what the agent was asked, both live and on replay.

---

## Problem Frame

orch's right pane streams whatever the runner CLI writes to stdout. In **interactive** mode the CLI's own TUI echoes the task back, so a watcher can see what the agent was asked. In **non-interactive / autonomous** mode the prompt is passed as a CLI argument (`claude -p <prompt>`, `codex exec -- <prompt>`) and consumed silently — the CLI never echoes it. The right pane therefore opens mid-conversation: the agent is already reasoning and acting, but the watcher has no visible record of the task that triggered it.

This costs the watcher context. Following a live autonomous step — or reviewing a completed one on replay — means inferring the task from the agent's behavior, or leaving the pane to dig the prompt out of logs or the workflow definition. In a multi-step run where each step has a different prompt, that gap repeats at every step. orch already has the exact assembled prompt in hand at launch time; it simply isn't rendered.

---

## Requirements

**Visibility and scope**
- R1. For every agent step that runs in **non-interactive (autonomous) mode**, the right pane for that step MUST display the prompt orch sent to the agent, positioned above the agent's own output.
- R2. The displayed prompt MUST be the **full assembled prompt verbatim** — the exact text the CLI received, including any orch-injected context/overrides — with no truncation, folding, or "show more" affordance.
- R3. In a multi-step workflow, **each** non-interactive agent step MUST show **its own** prompt at the top of its pane (not only the first step's prompt).
- R4. Interactive-mode steps MUST be left unchanged — no prompt is injected, since the interactive CLI already echoes it.

**Presentation**
- R5. The prompt MUST be presented **lightly marked**: the prompt text preceded by a minimal `prompt:` label and followed by a separator line, after which the agent's output flows normally. No heavy box/banner styling.
- R6. The prompt MUST be rendered as **plain text** — any control or escape sequences contained in the prompt are displayed safely and not interpreted as terminal control codes that could corrupt the pane. The safe default is **escaping, not passthrough**: all C0/C1 control bytes and CSI/OSC/DCS/APC escape sequences MUST be converted to a visible representation *before* the prompt bytes reach the pane (i.e. before they enter the per-step output stream the pane renders). Passthrough is not a compliant implementation, because the render path interprets control bytes on screen even when the underlying write is byte-faithful.
- R9. When a non-interactive step opens, the pane MUST be scrolled to the **top** of the prompt so the `prompt:` label and the start of the prompt are visible; it MUST NOT auto-scroll past the prompt to the latest agent output. For a long prompt this means live output sits below the fold until the watcher scrolls down — an accepted trade-off in favor of always showing what the agent was asked the moment the step opens.

**Live and replay parity**
- R7. The prompt MUST appear while the step is **running live**.
- R8. The prompt MUST also appear when **replaying** a completed non-interactive run, reconstructed for that step. This requires the prompt to be persisted per step in an **always-on** replay-accessible location — one that does not depend on optional file logging being enabled — so historical runs render it consistently with live runs.

---

## Acceptance Examples

- AE1. **Covers R1, R5, R7.** Given a workflow with a single autonomous Claude step, when the step starts, then the right pane shows `prompt:`, the full prompt text, a separator line, and then the agent's streamed output below it.
- AE2. **Covers R3.** Given a workflow with two autonomous steps that use different prompts, when each step runs, then each step's pane shows that step's own prompt above its output.
- AE3. **Covers R4.** Given an interactive step, when it runs, then no prompt is injected by orch and the pane behaves exactly as it does today.
- AE4. **Covers R8.** Given a completed autonomous run, when its right pane is replayed later, then the same prompt that was sent appears above the replayed output for that step.
- AE5. **Covers R2.** Given an assembled prompt of several hundred lines, when the step runs, then the entire prompt is shown verbatim (agent output is pushed below it), with nothing elided.
- AE6. **Covers R6.** Given an autonomous step whose prompt contains control or escape sequences, when the step runs, then the literal sequence content is shown as part of the displayed prompt text without being interpreted as terminal control codes, and the pane (label, separator, and following agent output) remains intact.

---

## Success Criteria

- A person watching a live or replayed non-interactive step can tell what the agent was asked without leaving the pane or consulting logs/workflow files.
- The prompt shown matches exactly what the CLI received for that step — same text, same step.
- The change leaves runtime behavior unchanged — prompt construction, the argv handed to each runner, and agent behavior are untouched. It is additive to **display** (the live pane) and to **per-step persistence** (R8 adds an always-on store of the assembled prompt so replay can reconstruct it); it does not change how the prompt is built or sent.
- A downstream implementer can build this without inventing product behavior — content (full verbatim), placement (top of pane, above output), marking (`prompt:` label + separator), mode scope (non-interactive only), and live+replay parity are all fixed by this doc.

---

## Scope Boundaries

- Interactive-mode prompt display — already native to the CLI's TUI; explicitly out of scope.
- Truncation, collapsing, scroll-to-prompt, or any "show more / show less" affordance for long prompts — full verbatim was chosen, accepting that a long prompt pushes agent output down.
- Any change to how the prompt is assembled, transformed, or passed to the runner — this is a display/visibility change only.
- Styled/boxed/colored prompt blocks — rejected in favor of light marking.
- Showing the prompt anywhere other than the right pane (e.g., the left steps pane, a separate prompt viewer, or status line).

---

## Key Decisions

- **Full verbatim over truncation**: the watcher should see exactly what the agent saw, even when the assembled prompt is long. Accepted trade-off: long prompts push live output further down the pane.
- **Light marking over a styled block**: a `prompt:` label plus a separator is enough to delineate prompt from agent output; heavier chrome was considered and rejected as unnecessary.
- **Non-interactive only**: interactive runs already surface the prompt via the CLI's own TUI, so injecting it there risks redundant/double display.
- **Live + replay parity**: a watcher reviewing history should get the same context as a live watcher; this makes "always know what was asked" a property of the pane rather than of timing. Achieving this means R8 adds an always-on per-step persistence sink (the change is no longer display-only — see Success Criteria).
- **Escape control sequences, do not pass them through**: a prompt can contain arbitrary control/escape bytes (cursor moves, screen-clear, OSC 52 clipboard writes, OSC 8 hyperlinks). The pane render path interprets these on screen even when the underlying write is byte-faithful, so R6 pins escaping (visible representation) as the safe default; passthrough is rejected because a passthrough prompt could corrupt the pane or silently act on the watcher's terminal.
- **Open at the top of the prompt**: when the step opens the pane shows the `prompt:` label and the start of the prompt rather than auto-following the latest output (R9). This favors the stated goal — know what was asked the moment the step opens — over keeping the live tail in view; the watcher scrolls down to follow output for long prompts.

---

## Dependencies / Assumptions

- orch holds the exact assembled prompt for each step at launch time (`RunnerContext.prompt`), so the displayed text can be the real sent prompt rather than a reconstruction.
- Replay (R8) requires the per-step prompt to be persisted for completed runs. The assembled per-step prompt is **not** stored anywhere the replay path reads today (the existing per-step output tee is a no-op when file logging is disabled), so adding an always-on persistence sink for it is part of this work.
- "Non-interactive mode" is the existing autonomous/headless runner mode for both Claude and Codex; the feature applies uniformly to both runners.

---

## Outstanding Questions

### Deferred to Planning

- [Affects R7, R8][Technical] Where to inject the prompt so that a single mechanism satisfies both live and replay (e.g., into the persisted per-step output stream the pane reads), versus separate live and replay code paths. Implementation choice for ce-plan.
- [Affects R8][Technical] Whether the per-step prompt is already persisted in a replay-accessible location, or whether new persistence is required. Verify against the codebase during planning.
- [Affects R6][Technical] The exact visible representation for escaped control bytes (e.g. `<ESC>`/caret notation/hex) and which library or hand-rolled escaper performs it. The *default* is decided — escape all C0/C1 + CSI/OSC/DCS/APC before render (R6) — so only the rendering format is a planning detail.
- [Affects R1, R3, R8][Technical] What "the prompt" means for a step that fails to start, is retried, or **fork-resumes**. The recovery path (`forkResumeCommand` / `buildForkArgv`) re-launches the autonomous CLI with a one-line nudge against a forked checkpoint, not the original assembled `RunnerContext.prompt`. Planning must decide whether such a step's pane shows the original prompt, the nudge, or both, and whether injection is idempotent per pane or fires per (re-)launch.

---

## Acceptance Tests

Behavioral acceptance criteria derived from this brainstorm live in the sidecar
[acceptance-tests.md](acceptance-tests.md) — read those to know the feature works
without reading the code. Each is meant to become a real, executing two-pane
`full-host` test, tracked by AT-ID in that file's status table.

- AT-1 — A non-interactive step shows its prompt above the agent's output (live)
- AT-2 — The prompt is set off from the agent's output by a label and separator
- AT-3 — In a multi-step run, each step shows its own prompt
- AT-4 — An interactive step injects no prompt
- AT-5 — A long prompt is shown in full, nothing truncated
- AT-6 — A prompt containing control sequences is shown as text without corrupting the pane
- AT-7 — Replaying a completed non-interactive run shows the prompt above the replayed output
- AT-8 — The displayed prompt is the assembled text the agent received, not the raw task template
- AT-9 — A long-prompt step opens scrolled to the top of the prompt
