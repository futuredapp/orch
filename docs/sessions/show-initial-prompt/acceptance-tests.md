# Acceptance Tests — Show the Initial Prompt in the Right Pane (Non-Interactive Runs)

> High-level **behavioral acceptance criteria** for showing the agent's prompt in the
> right pane during non-interactive runs, derived from
> [brainstorm.md](brainstorm.md). Each is meant to become a real, executing test.
> They describe behavior, not implementation — read them to know the feature works
> without reading the code. Track implementation by AT-ID in the status table below.

## Tests

### AT-1 — A non-interactive step shows its prompt above the agent's output (live)

- **Given** a workflow with one autonomous (non-interactive) agent step
- **When** the step starts running
- **Then** the step's right pane shows the prompt orch sent to the agent, positioned above the agent's streamed output
- **Observable through** a real autonomous run driven by a fake agent + the right pane's rendered content (true tmux bytes)

### AT-2 — The prompt is set off from the agent's output by a label and separator

- **Given** an autonomous step whose pane is showing the prompt and the agent's output
- **When** the pane is read
- **Then** the prompt region is preceded by a `prompt:` label and a separator line sits between the end of the prompt and the first line of agent output, so a reader can tell where the prompt ends and the agent's output begins
- **Observable through** a real autonomous run + the right pane's rendered content

### AT-3 — In a multi-step run, each step shows its own prompt

- **Given** a workflow with two autonomous steps that were sent different prompts
- **When** each step runs and its pane is viewed
- **Then** each step's pane shows that step's own prompt (the second step shows the second prompt, not the first step's prompt)
- **Observable through** a real two-step autonomous run + each step's right pane content

### AT-4 — An interactive step injects no prompt

- **Given** a workflow with an interactive-mode step
- **When** the step runs
- **Then** orch adds no prompt label, separator, or prompt text to the pane — the pane behaves exactly as it does today (the interactive CLI's own output is the first thing shown)
- **Observable through** a real interactive run + the right pane's rendered content. This run must exercise the **same wired step-start path** that AT-1 drives (just in interactive mode), so the test fails if the autonomous-only guard is dropped and the prompt leaks into interactive panes — not pass vacuously because interactive steps happen to take a separate code path that never calls the injector.

### AT-5 — A long prompt is shown in full, nothing truncated

- **Given** an autonomous step whose assembled prompt is several hundred lines long
- **When** the step runs
- **Then** the entire prompt is shown verbatim in the pane (the agent's output is pushed below it), with no part elided or replaced by a truncation marker
- **Observable through** a real autonomous run + the right pane content, asserting both the start and the far end of the prompt are present

### AT-6 — A prompt containing control sequences is shown as text without corrupting the pane

- **Given** an autonomous step whose prompt text contains escape/control sequences (e.g. an ANSI escape, a screen-clear `\x1b[2J`, quotes, backslashes, newlines)
- **When** the step runs
- **Then** the literal sequence content is visibly present as part of the displayed prompt text (not silently dropped) rather than being interpreted as terminal control codes, and the pane (label, separator, and following agent output) remains intact and readable
- **And (OSC 52 sub-case)** given a prompt containing a syntactically valid OSC 52 clipboard-write sequence with a known payload, when the step runs, then the terminal clipboard does **not** contain the decoded payload (the sequence was escaped, not executed) and the raw OSC 52 bytes appear as visible text in the pane
- **Observable through** a real autonomous run with a control-sequence-laden prompt + the right pane content (asserting a recognizable token from the sequence is shown as text, not only that the separator and output survive), plus a clipboard check (or harness clipboard stub) for the OSC 52 sub-case

### AT-7 — Replaying a completed non-interactive run shows the prompt above the replayed output

- **Given** a completed autonomous run whose step was sent a known prompt
- **When** that step's right pane is replayed later (run reloaded, step reselected)
- **Then** the same prompt appears above the replayed agent output for that step, consistent with what was shown live
- **Observable through** completing a real autonomous run, reloading the run, selecting the step, + the replayed right pane content

### AT-8 — The displayed prompt is the assembled text the agent received, not the raw task template

- **Given** an autonomous step whose prompt orch assembles from the task text plus injected context/overrides
- **When** the step runs and the pane shows the prompt
- **Then** the displayed prompt includes the orch-injected portion (it matches what the agent actually received), not only the pre-assembly task text
- **Observable through** a real autonomous run whose assembled prompt contains a distinguishing injected marker + the right pane content

### AT-9 — A long-prompt step opens scrolled to the top of the prompt

- **Given** an autonomous step whose assembled prompt is long enough to exceed the pane height
- **When** the step opens and the agent begins streaming output
- **Then** the pane is scrolled to the top so the `prompt:` label and the start of the prompt are visible, and it does not auto-scroll past the prompt to the latest agent output (the live output sits below the fold until the viewer scrolls down)
- **Observable through** a real autonomous run with an over-height prompt + the right pane's rendered content, asserting the top of the pane shows the `prompt:` label / start of the prompt rather than the tail of the agent's output

## Status

| ID   | Behavior                                             | Status | Test file | Notes |
| ---- | ---------------------------------------------------- | ------ | --------- | ----- |
| AT-1 | Prompt shown above output (live)                     | ✅ implemented | `tests/full-host/fake-agent/prompt-preamble--shows-prompt-above-output.test.ts` | Preamble injected at step:start; verified through real tmux |
| AT-2 | Prompt set off by label + separator                  | ✅ implemented | `tests/full-host/fake-agent/prompt-preamble--shows-prompt-above-output.test.ts` | Chrome constants co-located on `RightPane` (`assertShowsPromptPreamble`) |
| AT-3 | Each step shows its own prompt                        | ✅ implemented | `tests/full-host/fake-agent/prompt-preamble--each-step-shows-own-prompt.test.ts` | Prompt is step-keyed (carried per `step:start`) |
| AT-4 | Interactive step injects no prompt                   | ✅ implemented (unit) | `tests/unit/hosts/two-pane/lifecycle-choreographer.test.ts` | See Notes: full-host:fake-agent CANNOT drive a real interactive pane (FakeRunner argv `:fake:` isn't executable), so the autonomous-only guard is proven at the choreographer unit level with a prompt carried; the real interactive proof layer is `full-host:real-agent`. |
| AT-5 | Long prompt shown in full                             | ✅ implemented | `tests/full-host/fake-agent/prompt-preamble--long-prompt-verbatim.test.ts` | Full-host asserts verbatim tail+separator+output (viewport follows the tail pre-R9); head-preservation covered by the plan-sanctioned from-start unit substitute (choreographer registers `fromStart: true`; renderer renders 400 lines in full) |
| AT-6 | Control sequences shown as text, pane intact         | ✅ implemented | `tests/full-host/fake-agent/prompt-preamble--control-sequences-escaped.test.ts` | Escape (not passthrough) before the tee; OSC 52 sub-case via `assertNoOsc52` + escaped-payload-visible + `assertClipboardUnchanged` (reads the real tmux paste buffer via `TmuxService.showPasteBuffers`; falsifiable — goes red under passthrough since `set-clipboard on` would populate the buffer) |
| AT-7 | Replay shows the prompt                               | ✅ implemented | `tests/full-host/fake-agent/prompt-preamble--replay-shows-prompt.test.ts` (logging-on, real tmux) · `tests/model/controller/right-pane-replay-prompt-fallback.test.ts` (logging-disabled fallback, R8 acceptance) | Phase 2: always-on `stateDir`-rooted prompt store (`agents/<step>/prompt.txt`) written unconditionally at step:start; replay **fallback** prepends `renderPromptPreamble` from it; primary (frozen-tee) branch untouched (no double-prefix) |
| AT-8 | Displayed prompt is the assembled (injected) text    | ✅ implemented | `tests/full-host/fake-agent/prompt-preamble--assembled-not-template.test.ts` | Base prompt + `extraPrompt` injection both shown |
| AT-9 | Long-prompt step opens scrolled to top of prompt     | ✅ implemented | `tests/full-host/fake-agent/prompt-preamble--opens-at-top-of-prompt.test.ts` (over-height + short-prompt guard) · `tests/model/controller/right-pane-controller-sources.test.ts` (pin/cancel decisions) | Phase 3: on the initial live auto-swap the controller enters tmux copy-mode + `history-top` on the (from-start) autonomous source pane, pinning the viewport to the prompt; `f`/follow-live cancels copy-mode to snap to the live tail. **Observation finding:** tmux `capture-pane -p` reports the live screen even when the pane is scrolled up in copy-mode, so AT-9 is observed through a copy-mode-aware viewport capture (reconstructed from `#{scroll_position}` / `#{pane_height}`) — the pin itself works headless and survives `swap-pane` (verified empirically). |

Legend: ⬜ todo · ✅ implemented · 🚫 won't implement (reason in Notes)

## Feasibility appendix

The **Driving surface** is what triggers the behavior in the test (prefer the real
entry point — launch a real run via the two-pane `full-host` scenario DSL with a fake
agent, not a synthetic internal event); the **Observation surface** is where the result
is read (the right pane's real rendered content). All nine behaviors are two-pane
`full-host:fake-agent` scenarios: a behavior whose risk is "do these bytes reach the
real pane" must be driven through real tmux, not asserted on a controller projection.

| ID   | Testable today | Driving surface | Observation surface | Gap & suggested change |
| ---- | -------------- | --------------- | ------------------- | ---------------------- |
| AT-1 | partial        | `full-host:fake-agent` run, autonomous (default mode) | Right pane content (`rightPane.assertShowsContent`) | Feature not built. Prompt must reach the pane at step start (e.g. carried on the `step:start` event and written ahead of agent output). |
| AT-2 | no             | Same as AT-1                                          | Right pane content + a semantic `RightPane` assertion for the prompt label/separator | Add a co-located chrome constant + assertion method on the RightPane Pane Object (per CLAUDE.md: chrome literals live on the Pane Object, never inline in a scenario). |
| AT-3 | no             | `full-host:fake-agent` run, two autonomous steps, distinct prompts | Each step's right pane content | Once AT-1's mechanism exists, confirm the prompt is keyed per step, not per run. |
| AT-4 | yes            | `full-host:fake-agent` run, `mode: 'interactive'`    | Right pane content shows no prompt preamble | None — the autonomous-only guard at the injection point already excludes interactive steps. This is the primary negative; keep it even though it's green today, so a future change that drops the guard fails. |
| AT-5 | partial        | `full-host:fake-agent` run, autonomous, prompt of several hundred lines | Right pane content (assert start + far end present) | None structural (output path is unbounded); blocked only on AT-1's feature. |
| AT-6 | partial        | `full-host:fake-agent` run, autonomous, prompt with ANSI/escape/newline + an OSC 52 sequence | Right pane content (sequences present as text; separator + output still intact) + clipboard check | **Decided: escape, not passthrough.** Per R6, all C0/C1 + CSI/OSC/DCS/APC must be escaped to a visible form *before* the bytes enter the per-step tee — the tee write being raw-byte safe is exactly why passthrough would let tmux interpret them on screen. The OSC 52 sub-case guards the silent-clipboard-write class: assert the clipboard is untouched and the raw bytes show as text. Blocked on AT-1's feature. |
| AT-7 | no             | Complete a `full-host:fake-agent` autonomous run, reload the run, reselect the step | Replayed right pane content | **Persistence gap.** The assembled per-step prompt is not stored anywhere the replay path reads today; the existing per-step tee (`agents/<step>/formatted_output.*`) is a no-op when file logging is disabled. Persist it to an **always-on** sink independent of the optional logger (a dedicated per-step prompt file or a StepEntry field written unconditionally at step:start) that the replay path is taught to read. |
| AT-8 | partial        | `full-host:fake-agent` run, autonomous, assembled prompt containing a distinguishing injected marker | Right pane content includes the injected marker | None structural; blocked only on AT-1's feature. Drives the real run so the displayed text is necessarily the prompt the runner received, not a re-rendered template. |
| AT-9 | no             | `full-host:fake-agent` run, autonomous, prompt taller than the pane | Right pane content (top of pane shows the `prompt:` label / start of prompt, not the output tail) | Once AT-1's mechanism exists, the pane's initial scroll position must be pinned to the top of the prompt with no auto-follow past it (R9). If the pane today auto-tails output, this requires overriding that for the prompt region at step open. |

**Gate note:** these become two-pane `full-host` scenarios run under the real-tmux harness; AT-1–AT-3, AT-5, AT-6, AT-8, AT-9 land on the `:full:fake` level and AT-7 exercises the replay pipeline. They must pass `bun run check` once implemented. AT-4 is testable today and should be written first as a guard.

**Unwired-feature triage:** every test above drives a real autonomous (or interactive) run and observes the real right pane — none would pass if the prompt-injection were never wired into the `step:start` path, and none asserts on a controller projection or internal port. AT-4 is the deliberate exception in spirit (it asserts *absence*), but it still drives a real interactive run through the real pane — and through the *same* wired step-start path AT-1 uses — so it fails if the guard is removed and the prompt leaks into interactive panes.

**Deliberately out of scope — empty/whitespace prompt.** A non-interactive run is always launched *with* a prompt (the assembled task text plus injected context); launching an autonomous step with no prompt is not a state orch can reach, so "what does the `prompt:` preamble look like with an empty body" is not a real behavior to pin down. No acceptance test covers it, by decision (confirmed with the author during this pass), not by omission. If a future change ever makes an empty assembled prompt reachable, revisit this.
