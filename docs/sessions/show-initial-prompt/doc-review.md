# Doc Review — Show the Initial Prompt in the Right Pane

Multi-persona review of `docs/sessions/show-initial-prompt/brainstorm.md` and its sidecar
`docs/sessions/show-initial-prompt/acceptance-tests.md`, reviewed together as the
human-reviewed acceptance contract.

**Review team (7 personas):**

| Persona | Why activated |
| ------- | ------------- |
| ce-coherence-reviewer | always-on — cross-doc consistency (R↔AE↔AT traceability, terminology) |
| ce-feasibility-reviewer | always-on — verified the doc's technical claims against the orch codebase |
| ce-design-lens-reviewer | TUI rendering: `prompt:` label, separator, scroll behavior |
| ce-security-lens-reviewer | rendering untrusted prompt bytes (ANSI/OSC) into a real terminal pane |
| ce-scope-guardian-reviewer | 8 requirements; R8 drags persistence into a "display-only" change |
| ce-adversarial-document-reviewer | greenfield brainstorm (no `origin:`) — premise scrutiny in scope |
| ce-product-lens-reviewer | solution-selection decisions with named trade-offs (verbatim vs truncation) |

The feasibility and adversarial reviewers read the actual codebase
(`src/hosts/*`, `src/runners/*`, lifecycle/tee/replay paths) and several findings are
grounded in concrete file references — those are the highest-signal items below.

---

## Auto-fixed (applied in place)

**AF-1 — Added AE6 covering R6 (control sequences).** `brainstorm.md` gave every
requirement an Acceptance Example except R6; AE1–AE5 covered R1–R5/R7/R8 but the
control-sequence requirement had no illustrative example even though it has a full
acceptance test (AT-6). Added `AE6` in the Acceptance Examples section, worded to match
R6 and AT-6 and deliberately neutral on the escape-vs-passthrough question (which AT-6
leaves to plan time). This is illustrative of an existing requirement — it neither
expands scope nor contradicts the sidecar.

No other auto-fixes were applied. The documents are clean — no typos, broken
cross-references, or stale counts.

---

## Resolved in discussion — applied with your direction

The four scope/design findings below were surfaced for decision (not changed
unilaterally). You chose, and the edits were then applied to `brainstorm.md` and
`acceptance-tests.md`:

| # | Decision you made | Edits applied |
| - | ----------------- | ------------- |
| FL-1 | Keep R8; fix wording + require an always-on sink | Reworded the "purely additive" success criterion to admit per-step persistence; tightened R8 to require an always-on store independent of the optional logger; updated the Dependencies bullet with the codebase reality; added a Key Decisions note. AT-7 appendix row now names the always-on sink. |
| FL-2 | Pin escape-all default in R6 | R6 now requires escaping all C0/C1 + CSI/OSC/DCS/APC to a visible form before bytes reach the pane (passthrough non-compliant); added a Key Decisions bullet; reframed the R6 Outstanding Question to "format only"; updated AT-6 with an OSC-52 clipboard sub-case + appendix/status rows. |
| FL-3 | Open at top (show the prompt) | Added R9 (pane opens scrolled to the top of the prompt, no auto-follow past it) + a Key Decisions bullet; added AT-9 with status + appendix rows; added AT-9 to the brainstorm's sidecar AT list. |
| FL-4 | Add an Outstanding Question | Added a Deferred-to-Planning question defining "the prompt" for retry/fork-resume steps (original vs `forkResumeCommand` nudge; per-pane idempotency). |

The detail for each is preserved below for the record.

---

## Findings detail (FL-1–FL-4 now resolved; FL-5, FL-6 still open)

Ordered by leverage. Confidence shown is the highest across the personas that raised it.

### FL-1 — "Purely additive to display" contradicts R8's persistence work · conf 100 · cross-persona (scope-guardian, coherence, feasibility, adversarial)

The Success Criteria claim *"The change is purely additive to display: prompt
construction, the argv handed to each runner, and agent behavior are unchanged."* But R8
(replay parity) requires the per-step prompt to be **persisted** in a replay-accessible
form, and the feasibility reviewer confirmed against the codebase that **it is not stored
anywhere the replay path reads today**:

- The only durable per-step output stream is the `SessionLogger` tee at
  `agents/<step>/formatted_output.{ansi,txt}` (`src/hosts/plain/per-step-tee.ts`), which
  returns a **no-op** tee when file logging is disabled. So a naive "prepend into the tee"
  approach silently shows **no prompt on replay for non-logging runs**.
- No `StepEntry` field carries a per-step prompt (`state-store.ts`); `args.prompt` is the
  run-level top prompt, not per-step.

So R8 is real persistence work, not display work. **Decision needed:** either (a) reword
the success criterion to admit a per-step persistence change and require an *always-on*
sink (independent of the optional logger), or (b) split R8 (replay) into a second
increment so increment-1 is genuinely additive-to-display and live-only.

### FL-2 — Sanitization strategy for control sequences is underspecified and could be unsafe · conf 75 · cross-persona (security, feasibility)

R6 says control sequences must be "displayed safely and not interpreted," but the exact
strategy (escape / strip / passthrough) is deferred to planning. Two concrete risks:

- **The render path interprets on screen even when the write is byte-faithful.** The
  autonomous live+replay path writes raw ANSI to `formatted_output.ansi` and tmux
  tails it via `file-tail` to preserve byte fidelity (`right-pane-controller.ts`). The
  acceptance doc's "tee write is raw-byte safe" is true for the *write* but does **not**
  satisfy R6's *display* semantics — a prompt containing `\x1b[2J` or cursor-control bytes
  corrupts the pane on both live and replay. **Sanitization must happen before bytes enter
  the tee**, not be assumed safe because the write is raw.
- **AT-6 can pass while a sequence is still interpreted.** OSC 52 (clipboard write) and
  OSC 8 (hyperlink) succeed *silently* — no visible token. A passthrough implementation
  could pass AT-6 (which checks one visible token) while writing the watcher's clipboard.

**Decision needed:** should R6 pin a safe default (escape all C0/C1 control bytes and
CSI/OSC/DCS/APC sequences to a visible representation, passthrough non-compliant), and
should AT-6 gain an OSC-52 sub-case that asserts the clipboard is untouched? Related but
lower stakes: the trust boundary of prompt content is undeclared (conf 50) — if prompts
ever incorporate third-party text (file/issue/PR content), this is an operational
injection surface, not a theoretical one.

### FL-3 — Showing the FULL assembled prompt may bury the task; initial scroll position undefined · conf 75 · cross-persona (adversarial, design, scope-guardian, product, coherence)

The goal is "tell what the agent was asked," but R2/AT-8 mandate the full assembled
prompt **including orch-injected scaffolding**, and AE5/AT-5 target several-hundred-line
prompts with no truncation/scroll-to affordance. For long prompts this pushes the actual
task *and all live agent output* far below the fold — working against the "watching a
**live** step" half of the goal. Two distinct sub-points:

- **Content (advisory):** is verbatim-assembled (fidelity) the right default vs. the task
  portion (scannability)? The trade-off is named in Key Decisions but never weighed
  against how often long injected context dominates real runs.
- **Scroll position (concrete gap, design reviewer, conf 75):** the doc rejects
  scroll-to-prompt affordances but never states **where the pane is scrolled when output
  begins streaming** — top (show the prompt, lose the live feed) or bottom (follow output,
  hide the prompt). An implementer must invent this, and the two choices give opposite
  watcher experiences. **This should be pinned at the requirements level.**

### FL-4 — "The prompt" is undefined for steps that retry / fork-resume · conf 75 · adversarial (codebase-grounded)

R1 promises "the prompt orch sent to the agent," grounded in `RunnerContext.prompt` at
launch. But the recovery path (`forkResumeCommand` / `buildForkArgv`) re-launches the
autonomous CLI with a one-line **nudge** against a forked checkpoint — **not** the
original assembled prompt. For a recovered/retried step, does the pane show the original
prompt (misleading — that's the first attempt), the nudge, or both? This is undefined at
exactly the point where R8 persistence and R3 per-step keying have to decide what to store
and display. **Decision needed:** define "the prompt" for re-run steps, and whether
injection is idempotent per pane vs. fires per (re-)launch.

### FL-5 — The no-echo premise is unverified per-runner · conf 75 · adversarial

The feature rests on "the CLI never echoes it" in non-interactive mode, asserted
uniformly for both runners. The adversarial reviewer confirmed it currently holds
(autonomous Claude uses `--output-format stream-json`, Codex uses `exec --json`; neither
echoes the prompt as plain text today), **but** that is an emergent property of the
current argv/output-format and the pane's event formatter, not a CLI contract. If a flag
or upstream change surfaces the submitted prompt in the first event, R1's blanket
injection produces the **double display** the doc says it avoids. **Suggested:** record
that the no-echo property is contingent on the current autonomous output mode and must be
re-verified if that changes.

### FL-6 — Separator form left to implementer invention · conf 75 · design

R5 mandates a "separator line" but defines neither its character (blank line? rule of
dashes? box-drawing?) nor width. AT-2 explicitly defers this to a co-located chrome
constant "decided at implementation." Two implementers will produce different separators
with no requirements-level standard to enforce. **Suggested:** fix the separator's
semantic form in R5 (e.g. "a blank line" or "a full-width rule") even though the exact
literal lives on the `RightPane` Pane Object. (The Pane-Object placement itself is correct
per CLAUDE.md — feasibility confirmed `assertShowsContent` + the Pane Object pattern
exist in `tests/dsl/`.)

---

## Doc-hygiene observations (lower stakes — your call, no edit made)

- **OBS-1 — AE list (5) vs AT list (8) (coherence, conf 100).** The brainstorm's
  Acceptance Examples now run AE1–AE6 after AF-1; the sidecar enumerates AT-1–AT-8.
  AT-7 (replay) maps to R8 (already illustrated by AE4) and AT-8 (assembled-not-template)
  maps to R2 (already illustrated by AE5), so the AE set already covers every *requirement*.
  Whether to add AE7/AE8 purely to mirror the AT list 1:1 is a structural choice, not a
  coverage gap — I did **not** add them. Flagging so you can decide if you want strict 1:1.
- **OBS-2 — Terminology: non-interactive / autonomous / headless (coherence, conf 75).**
  The docs use all three. They're defined as synonyms at brainstorm line 82 and the
  pairing "non-interactive (autonomous)" is used consistently, so this reads as
  intentional bridging vocabulary rather than drift. A sweeping find-replace on a
  human-reviewed contract felt riskier than the inconsistency, so I left it. Optional: one
  canonical term with a single parenthetical gloss.
- **OBS-3 — Outstanding Questions vs Feasibility appendix (coherence, conf 75).** The
  brainstorm defers "where to inject" and "is the prompt persisted" to planning, while the
  sidecar appendix has effectively answered both (inject at `step:start`, and persistence
  is a confirmed gap). Feasibility independently confirmed the clean injection point:
  `tee.write(stepName, …)` at step:start in `lifecycle-choreographer.ts`, already guarded
  by `if (event.mode !== 'autonomous') return` — so the autonomous-only guard (R4/AT-4)
  and the unified live+replay mechanism both already exist in the codebase. Optional:
  update the brainstorm's Outstanding Questions to point at the appendix's answers.

---

## What the codebase review confirmed as SOUND (no action)

- `RunnerContext.prompt` (`types.ts`) **is** the assembled post-injection prompt
  (`assemblePrompt` in `workflow.ts`) — the doc's core dependency claim is correct.
- The autonomous-only guard the doc relies on for R4 already exists
  (`lifecycle-choreographer.ts`, `event.mode !== 'autonomous'` early-return).
- Mode uniformity across Claude and Codex is feasible: both runners pass `ctx.prompt` to
  their CLIs and the tee/lifecycle injection keys on `mode`, not runner — runner-agnostic
  by construction.
- The product premise (non-interactive panes open mid-conversation; digging logs/workflow
  files is a real per-step cost) is sound; every requirement traces to the single goal.

---

## Residual risks carried forward to planning

- If R8 is implemented by prepending the prompt into the per-step output stream, the
  replay reader must distinguish prompt-preamble bytes from agent output, coupling display
  format to storage format (future display changes become storage migrations).
- The injected prompt entering the persisted stream changes what replay/transcript/
  run-analysis consumers see — they must tolerate a leading prompt region.
- AT-4 ("same wired step-start path") is a deliberate guard; if a future refactor splits
  the autonomous/interactive paths it could pass vacuously — keep the shared-path invariant
  in mind.

---

## Recommended next actions

1. ✅ **FL-1, FL-2, FL-3, FL-4** — resolved with you and applied to both docs (see the
   resolution table above). Ready for planning.
2. **Still open (your call, no edit made):**
   - **FL-5** (no-echo premise is contingent on current autonomous output mode) — a
     one-line assumption note; apply if you want it recorded, skip if you'd rather leave
     it to the planning verification step.
   - **FL-6** (separator form unspecified) — genuinely a product choice (blank line vs.
     full-width rule). Pin it in R5 or leave the literal to the `RightPane` Pane Object at
     implementation.
   - **OBS-1–3** — doc-hygiene (AE↔AT 1:1, terminology, Outstanding-Questions vs
     appendix). All optional; left as-is because each looked intentional or low-value.

The doc is in good shape: the premise is sound, scope is bounded, and the codebase backs
the core mechanism. With FL-1–FL-4 resolved, the remaining open items (FL-5, FL-6,
OBS-1–3) are all light and non-blocking.
