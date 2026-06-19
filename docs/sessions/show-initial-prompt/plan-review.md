# Plan Review - Show the Initial Prompt in the Right Pane

Reviewed:
- `docs/sessions/show-initial-prompt/brainstorm.md`
- `docs/sessions/show-initial-prompt/acceptance-tests.md`
- `docs/sessions/show-initial-prompt/doc-review.md`
- `docs/sessions/show-initial-prompt/plan.md`

This review is limited to the soundness of `docs/sessions/show-initial-prompt/plan.md`
against the human-reviewed acceptance contract. No code exists for the feature yet, and
this file does not propose unrelated architecture work.

## Overall assessment

The plan is directionally sound: injecting a prompt preamble at `step:start`, escaping
control sequences before terminal rendering, and persisting the raw assembled prompt for
replay are the right core moves. The three major concerns are not about the product
direction; they are about whether the proposed tee/tail mechanism can actually satisfy
"full prompt, no truncation", whether Phase 1 overstates replay completion before the
always-on store exists, and whether the plan expands interactive-mode data flow just to
make a test stronger.

The plan is somewhat over-specified in places, especially around exact implementation
shape before the persistence mechanism is chosen, but it is not fundamentally
over-complicated. The simpler correct path is to tighten the source-tail semantics and
pin the always-on prompt store, not to redesign the feature.

## Findings

### 1. File-tail backfill can truncate the prompt

**Severity:** high

**Rationale:** The plan promises R2/AT-5: the full assembled prompt is shown with no
truncation. But the planned mechanism writes the preamble into
`formatted_output.ansi` before registering a `file-tail` source, and the existing
`file-tail` contract uses `tail -n 5000 -F`. That means any prompt/preamble stream
longer than the backfill window can lose its start when the live source is registered.
Replay has the same problem because static replay files are also shown through the same
`file-tail` source. This directly conflicts with R2's "no truncation" requirement and
also undermines AT-9, because the pane cannot open at the top of the prompt if the top
was never backfilled into the hidden pane.

AT-5's current "several hundred lines" scenario may not catch this if it stays under
the backfill limit, but the brainstorm contract says the full assembled prompt is shown
with no truncation, not "up to the tail backfill limit".

**Suggested change:** Make prompt-bearing file sources read from the beginning, not from
a bounded tail window. Concretely, extend the pane source spec or registration call with
a "from start" mode for autonomous prompt sources and replay sources, implemented with
an unbounded start offset such as `tail -n +1 -F` or an equivalent `cat`-then-follow
strategy. Then add a regression scenario whose prompt exceeds the current backfill
limit, or at minimum a focused test that asserts prompt sources do not use the bounded
`TAIL_BACKFILL_LINES` path.

### 2. Phase 1 overclaims replay/R8 completion

**Severity:** medium

**Rationale:** The acceptance contract requires replay parity through an always-on
per-step prompt store that does not depend on optional file logging. The plan correctly
adds Phase 2 for that, but Phase 1 still says it covers AT-7 and R8 for
"logging-on replay", and the traceability table maps "Replay shows the prompt
(logging on)" to AT-7.

This creates an implementation hazard: an agent could finish Phase 1, see AT-7 marked
as covered, and treat replay as accepted even though the human-reviewed R8 clause is not
satisfied until Phase 2. The plan's final state is acceptable, but the phase labels and
coverage language blur a hard contract requirement into a hardening step.

**Suggested change:** Reword Phase 1 as covering only live display plus a useful
logging-on replay regression. Treat R8/AT-7 as incomplete until Phase 2 lands. In the
traceability table, make the AT-7 row point to Phase 2 as the acceptance-closing unit,
with Phase 1 listed only as an implementation detail or interim regression.

### 3. Interactive prompts should not be carried on real interactive lifecycle events

**Severity:** medium

**Rationale:** U2 says to thread `prompt` into the lifecycle context for both
autonomous and interactive agent paths so AT-4 fails if the choreographer's
autonomous-only guard is dropped. That is a test-driven implementation trick, but it
widens real interactive-mode data flow for no product benefit.

The brainstorm says interactive-mode steps are unchanged and no prompt is injected
because the CLI already echoes it. The visible pane is the main concern, but carrying a
possibly large or sensitive prompt through interactive lifecycle events still increases
surface area and makes "interactive unchanged" less true internally. It also conflicts
with the plan's own effort to keep prompts out of structured lifecycle records.

**Suggested change:** Only attach `prompt` to real `step:start` events for autonomous
agent steps. Keep the shared choreographer path for all modes, so the mode guard remains
real, but do not make production interactive events carry prompt text solely for AT-4.
To guard the failure mode, add a focused choreographer/unit test with a synthetic
interactive `step:start` event that includes a prompt and asserts no preamble is written.
The full-host AT-4 can then remain the real interactive behavior test.

### 4. The control-byte escaper needs a precise Unicode boundary

**Severity:** medium

**Rationale:** U1 describes `escapeControlBytesToVisible` as a byte-level escaper that
converts C0/C1 bytes, DEL, and ESC. In this codebase the assembled prompt is a string.
If an implementer literally escapes UTF-8 bytes `0x80-0x9F`, ordinary non-ASCII text can
be corrupted because those values can appear as continuation bytes inside valid UTF-8
characters. If the implementer escapes JavaScript string code points instead, the plan
should say that explicitly.

R6/AT-6 depends on this boundary being correct: unsafe terminal controls must be
neutralized, while normal prompt text still needs to render as the prompt the agent
received.

**Suggested change:** Specify that the escaper operates on the prompt string before it is
encoded for terminal output. Escape Unicode control code points U+0000-U+001F except
LF/TAB, U+007F, U+0080-U+009F, and ESC; preserve all other Unicode text unchanged. Add a
unit test with non-ASCII prompt text plus embedded controls, proving the non-ASCII text
survives while ESC/OSC/BEL/C1 controls do not.

### 5. The always-on prompt store is still too implementation-loose

**Severity:** medium

**Rationale:** Phase 2 identifies the right requirement, but U5 leaves the storage
choice as "dedicated file under `logs/agents/<step>/prompt.txt` OR `StepEntry` field" to
be verified during implementation. That choice is not purely cosmetic: it determines
whether the feature really works with `logger.logsDir === null`, whether `state.json`
gets large prompt bodies, and whether replay has a stable raw-prompt source independent
of display-formatted transcript bytes.

The recommended dedicated file is likely the simpler and safer path, but the plan still
allows a future implementer to satisfy the unit wording while accidentally tying the
store back to the optional logger or bloating the run state.

**Suggested change:** Pin the persistence contract more tightly. For example: create a
small prompt-store dependency rooted in `stateDir`, not in `logger.logsDir`, and write
the raw assembled prompt to a deterministic per-step artifact such as
`agents/<step>/prompt.txt` or `prompts/<step>.txt`. Keep `StepEntry` to a relative
pointer at most, not the prompt body. The existing U5 tests should then assert the path
is written when file logging is disabled and that replay reads this raw store rather than
the formatted output stream in the fallback path.

### 6. AT-9 needs a way back to live output

**Severity:** low

**Rationale:** Phase 3 correctly recognizes that R9 likely requires tmux copy-mode or an
equivalent scroll pin. The accepted trade-off is that live output sits below the fold
until the watcher scrolls. The plan says `f` / scrolling returns to the tail, but it does
not make that a testable part of the phase.

This is an edge case, not a core acceptance gap: AT-9 only requires opening at the top.
Still, a copy-mode implementation that pins the pane successfully but leaves the watcher
without a reliable way back to live output would make the feature frustrating during
long-running steps.

**Suggested change:** Add a small guard to U7's test scenarios: after verifying the pane
opens at `prompt:`, drive the existing "follow live" or equivalent scroll-to-tail action
and assert the latest agent output is visible. This keeps R9's top-open behavior while
protecting the normal live-follow workflow.

## Acceptance-test coverage check

- AT-1, AT-2, AT-3, AT-4, AT-6, and AT-8 are covered by the planned units once Finding 3
  is addressed.
- AT-5 is not fully covered until Finding 1 is fixed; otherwise it only covers prompts
  smaller than the tail backfill limit.
- AT-7 is not acceptance-complete until Phase 2's always-on prompt store is implemented;
  Phase 1's logging-on replay behavior is useful but insufficient for R8.
- AT-9 is directionally covered by Phase 3, with the residual usability guard in
  Finding 6.

## Phasing and AI-vs-user separation

The phase order is mostly logical: render/escape/inject first, persist raw prompt second,
scroll behavior third. The main correction is to stop presenting Phase 2 as hardening
and instead treat it as required for R8 acceptance.

The plan generally makes reasonable implementation decisions without blocking on user
input. The exception is U2's interactive prompt threading, where a testing concern leaks
into production event shape. Separator glyph and escape glyph choices are acceptable as
AI-chosen defaults because the brainstorm already fixed the semantic behavior: light
marking plus visible escaping.
