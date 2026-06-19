# Implementation Plan — Show the Initial Prompt in the Right Pane (Non-Interactive Runs)

> Phased implementation plan derived from
> [brainstorm.md](brainstorm.md) and the acceptance contract in
> [acceptance-tests.md](acceptance-tests.md). Reviewed against the codebase
> grounding in [doc-review.md](doc-review.md). Repo-relative paths throughout.

**Type:** `feat` · **Depth:** Standard · **Phases:** 3

---

## Summary

For every **autonomous (non-interactive)** agent step, render the exact assembled
prompt orch sent to the agent at the **top of that step's right pane** — full
verbatim text, control bytes escaped to a visible form, set off by a `prompt:`
label and a separator, above the agent's streamed output — both **live** and on
**replay**.

The mechanism is small and falls out of the existing architecture: orch already
holds the assembled prompt at launch (`RunnerContext.prompt` /
`assemblePrompt`), and both the live pane and the replay pane read the **same**
per-step tee file (`logs/agents/<step>/formatted_output.ansi`). Writing the
prompt preamble into that tee at `step:start` therefore serves live and replay
through one path. Three concerns separate cleanly: (1) the core display
mechanism, (2) always-on persistence for the logging-disabled replay path (R8),
and (3) the open-at-top-of-prompt scroll behavior (R9).

---

## Problem frame & approach

Today the `step:start` choreography in
`src/hosts/two-pane/lifecycle-choreographer.ts` opens the per-step tee and
writes a placeholder marker (`[<step>] starting…`) so the live `tail -F` pane
has bytes to show before the runner emits its first event. The right pane then
tails `formatted_output.ansi`. On replay,
`resolveAutonomousReplaySpec` in `src/hosts/two-pane/pane-map/right-pane-controller.ts`
tails the **same frozen file**. The prompt is never written into that stream, so
the pane opens mid-conversation.

**Core approach:** carry the assembled prompt on the `step:start` lifecycle
event; at `step:start`, the choreographer renders a *prompt preamble* (label +
escaped prompt + separator) and writes it into the tee **before** any agent
output. Because the replay path tails the same file, replay shows the same
preamble with no extra code (when file logging is on — i.e. every real run and
the full-host harness). Two follow-on concerns are isolated into their own
phases: an always-on persistence sink so replay works even if file logging is
ever disabled (R8), and pinning the pane's initial scroll position to the top of
the prompt (R9).

**Grounding (verified against the codebase):**
- `RunnerContext.prompt` is the assembled post-injection prompt
  (`assemblePrompt`, `src/core/workflow.ts:495`). Core dependency holds.
- The autonomous-only guard already exists: the choreographer early-returns on
  `event.mode !== 'autonomous'` (`src/hosts/two-pane/lifecycle-choreographer.ts:103`).
  This is the sole gate for R4/AT-4.
- Live and replay read the same tee: live registers a `file-tail` over
  `formatted_output.ansi` (`lifecycle-choreographer.ts:109-117`); replay's primary
  branch tails the frozen `formatted_output.ansi`
  (`right-pane-controller.ts:1171-1186`).
- File logging is **always on** in real `orch run` (`src/cli/deps.ts:102`,
  `createFileSessionLogger` sets `logsDir`) and in the full-host fake-agent
  harness (`tests/_support/real-tmux/workflow-driver.ts:211`). `logsDir === null`
  is only reachable in unit fixtures / the null adapter.
- `stripAnsi` (`src/hosts/plain/strip-ansi.ts`) *deletes* control sequences; R6
  needs *escaping to a visible representation*, so a new escaper is required.
  Note `stripAnsi` operates on a **JS string** via a regex over code points (not
  raw UTF-8 bytes) — the new escaper must do the same (KTD3 / FL-4 below).
- The `file-tail` source spawns `tail -n 5000 -F <path>`
  (`TAIL_BACKFILL_LINES`, `right-pane-controller.ts:72,368`) — a **bounded**
  backfill window, not unbounded. A prompt+output stream longer than 5000 lines
  loses its head (the prompt) when the source is (re)registered. R2/AT-5 ("no
  truncation") and AT-9 ("open at top") therefore require prompt-bearing sources
  to read from the start, not from the bounded tail window (KTD8 below).
- Recovery forks (`forkResumeCommand`) re-launch **inside** `produceAgentStep`
  after the single `step:start` (`src/core/workflow.ts:1135`, `1516-1552`), so the
  preamble is written **once per step** with the original assembled prompt — the
  nudge never reaches the pane preamble. This resolves doc-review FL-4 by
  construction.

---

## Key technical decisions (taken — adjustable at implementation)

- **KTD1 — Inject at `step:start`, into the per-step tee.** One mechanism covers
  live + replay because both tail the same file. No separate replay code path
  (see origin: [acceptance-tests.md](acceptance-tests.md) appendix; doc-review
  OBS-3). _(see origin: brainstorm Outstanding Questions — "where to inject")_
- **KTD2 — Carry the prompt on the `step:start` event, but exclude it from the
  structured lifecycle record.** The event is the natural per-step carrier into
  the host. `emitStepLifecycle` (`src/core/step-lifecycle.ts:44`) must **omit**
  the `prompt` field from the span/`lifecycle.ndjson` record (the same way it
  special-cases `error`) so a several-hundred-line prompt does not bloat the
  structured log.
- **KTD3 — Escape, do not strip, do not pass through (R6).** A new escaper
  operates on the assembled prompt **string** (code points, like `stripAnsi` —
  **never** raw UTF-8 bytes, or multi-byte non-ASCII text would be corrupted by
  its `0x80–0x9F` continuation bytes; doc-review FL-4). It converts every C0
  control code point (`U+0000–U+001F`) except `\n`/`\t`, DEL (`U+007F`), every C1
  (`U+0080–U+009F`), and the ESC introducer (`U+001B`) to a **visible**
  representation *before* the bytes reach the tee, leaving all other Unicode text
  unchanged. This neutralizes CSI/OSC/DCS/APC by escaping their introducer, so the
  remaining (printable) payload renders as literal text. **Recommended visible
  form:** Unicode Control Pictures (U+2400 block, e.g. `␛` for ESC, `␀`–`␟` for
  C0) — unambiguous and avoids colliding with the `^[`/`^M`/`^J` caret-echo smell
  that `assertNoCaretEcho` already flags. Caret notation (`^[`) is an acceptable
  alternative. _Format is a co-located concern; the exact glyphs are adjustable._
- **KTD4 — Light marking (R5).** A `prompt:` label line, the escaped prompt,
  then a separator line, then agent output. **Recommended separator:** a
  full-width rule of `─` (box-drawing horizontal). The literal label + separator
  live as **co-located chrome constants on the `RightPane` Pane Object**
  (`tests/dsl/panes/right-pane.ts`), per CLAUDE.md — never inline in a scenario,
  never imported from `src/`. The production literals live next to the renderer.
  _Separator/label glyphs adjustable (doc-review FL-6)._
- **KTD5 — Show the original assembled prompt for retried/fork-resumed steps; the
  preamble is idempotent per step.** Falls out of `step:start` firing once per
  step (KTD's grounding above). _(resolves doc-review FL-4)_
- **KTD6 — Open at the top of the prompt (R9).** When the step opens, the source
  pane is pinned to the top of the prompt (no auto-follow past it). Implemented as
  a pane-behavior concern in Phase 3.
- **KTD7 — Always-on persistence is a dedicated per-step prompt artifact rooted
  in `stateDir` (R8).** A small prompt-store dependency rooted in the run's
  `stateDir` (**not** `logger.logsDir`) writes the **raw** assembled prompt to a
  deterministic per-step artifact (`agents/<step>/prompt.txt` under the state
  dir), **unconditionally** at `step:start`, read by the replay **fallback**
  branch only. This is pinned, not an open choice: rooting in `stateDir` is what
  makes R8 hold when `logger.logsDir === null`, and a dedicated file keeps large
  prompt bodies out of `state.json`. If `StepEntry` records anything, it is a
  **relative pointer** to that file, never the prompt body (doc-review FL-5 /
  plan-review F5).
- **KTD8 — Prompt-bearing file sources read from the start, not the bounded tail
  (R2).** The default `file-tail` source uses `tail -n 5000 -F` (KTD grounding),
  which can drop the prompt's head once the stream exceeds the backfill window.
  Autonomous prompt sources (live) and replay sources must read from the
  beginning — `tail -n +1 -F` (or an equivalent `cat`-then-follow). Implemented as
  a "from-start" flag on the `file-tail` `PaneSpec` / source registration, set for
  the prompt-bearing sources only (the interactive `pty` path is untouched). This
  is required for R2/AT-5 ("no truncation") and AT-9 ("open at top of prompt"):
  the top cannot be shown if it was never backfilled. _(plan-review F1)_

---

## High-level mechanism

> Directional guidance for review, not implementation specification. The
> implementing agent should treat it as context, not code to reproduce.

```
runAgentStep / interactive produce
  └─ assemblePrompt(...)               # already exists; hoist so it's available pre-lifecycle
        │  prompt: string (assembled, post-injection)
        ▼
withStepLifecycle(ctx{ ..., prompt })  # src/core/step-lifecycle.ts
        │ emits step:start { mode, prompt }   ← prompt added to event
        │   (emitStepLifecycle strips `prompt` from the structured record — KTD2)
        ▼
LifecycleChoreographer.handle(step:start)     # src/hosts/two-pane/lifecycle-choreographer.ts
   if event.mode !== 'autonomous' → return     ← sole R4/AT-4 gate (unchanged)
   tee.open(step)
   tee.write(step, renderPromptPreamble(event.prompt))   ← NEW: label + escaped prompt + separator
   [Phase 2] promptStore.write(step, event.prompt)        ← NEW: always-on, logger-independent
   register file-tail source over formatted_output.ansi   ← live pane; FROM START (tail -n +1 -F), KTD8
   [Phase 3] pin source pane to top of prompt              ← R9

Replay (Enter on a past step):
   resolveAutonomousReplaySpec                  # right-pane-controller.ts
     primary:  tail frozen formatted_output.ansi FROM START → preamble already embedded ✓ (interim, logging on)
     fallback: NDJSON re-render → [Phase 2] prepend renderPromptPreamble(promptStore.read(step))
```

---

## Output structure (new / touched files)

```
src/hosts/two-pane/
  prompt-preamble.ts            (NEW)  escaper (code-point level) + renderPromptPreamble (pure)
  lifecycle-choreographer.ts    (MOD)  write preamble at step:start; register from-start source; Phase 2 always-on write
  pane-map/pane-spec.ts         (MOD)  from-start flag on file-tail PaneSpec (KTD8)
  pane-map/right-pane-controller.ts (MOD) from-start tail for prompt/replay sources; Phase 2 replay-fallback prepend; Phase 3 scroll
src/core/
  step-lifecycle.ts             (MOD)  add prompt to ctx + step:start; strip from record
  workflow.ts                   (MOD)  hoist assemblePrompt; thread prompt into lifecycle ctx
tests/dsl/panes/
  right-pane.ts                 (MOD)  chrome constants + semantic assertions (label/sep/no-OSC52)
tests/full-host/fake-agent/
  prompt-preamble--*.test.ts    (NEW)  AT-1..AT-9 scenarios
tests/unit/hosts/two-pane/
  prompt-preamble.test.ts       (NEW)  escaper + renderer unit tests
```

---

## Phase 1 — Prompt preamble: escape, render, and inject into the live tee

Status: done

Delivers the core feature: the assembled prompt rendered at the top of every
autonomous step's right pane, live, with control bytes escaped. As a side effect
the replay path (which tails the same frozen tee, with file logging on in every
real run and the full-host harness) also shows the preamble — but **R8/AT-7 are
NOT acceptance-closed by this phase**: the human-reviewed contract requires an
always-on per-step prompt store independent of the optional file logger, which
lands in Phase 2. Treat the Phase 1 logging-on replay behavior as a useful
*interim regression*, not the acceptance of R8.

**Covers (acceptance-closing):** R1, R2, R3, R4, R5, R6, R7 — AT-1, AT-2, AT-3,
AT-4, AT-5, AT-6, AT-8.
**Interim (not acceptance-closing):** logging-on replay regression toward AT-7;
R8 remains open until Phase 2.

### AI-implementable

#### U1. Control-byte-to-visible escaper + prompt-preamble renderer

**Goal:** A pure module that (a) escapes control bytes to a visible form and (b)
renders the `prompt:` label + escaped prompt + separator block.
**Requirements:** R5, R6 · **Dependencies:** none
**Files:**
- `src/hosts/two-pane/prompt-preamble.ts` (new)
- `tests/unit/hosts/two-pane/prompt-preamble.test.ts` (new)
**Approach:**
- `escapeControlBytesToVisible(text)`: operates on the prompt **string** (Unicode
  code points, exactly like `stripAnsi` — **not** raw UTF-8 bytes, or non-ASCII
  text whose UTF-8 encoding contains `0x80–0x9F` continuation bytes would be
  corrupted; plan-review F4 / doc-review FL-4). Preserve `\n` and `\t`; convert
  every other C0 code point (`U+0000–U+0008`, `U+000B–U+001F`), DEL (`U+007F`),
  every C1 (`U+0080–U+009F`), and the ESC introducer (`U+001B`) to a visible glyph
  (KTD3 — recommend U+2400 block); leave all other Unicode text unchanged.
  Escaping the introducer alone neutralizes CSI/OSC/DCS/APC sequences: the
  trailing payload bytes (`[2J`, `]52;c;…`) are printable and render as literal
  text. This is a code-point escaper, **not** a sequence parser — mirror
  `src/hosts/plain/strip-ansi.ts` (regex over the string) but emit a visible glyph
  instead of deleting.
- `renderPromptPreamble(prompt)`: returns the preamble bytes — a label line, the
  escaped prompt, a separator line — using `\r\n` line endings (tmux host
  convention; see `src/hosts/plain/per-step-tee.ts` header). Label/separator
  literals are the production source of truth; the test-side chrome constants
  (U3) must match them.
**Patterns to follow:** `src/hosts/plain/strip-ansi.ts` (control-byte regex
families; xterm ctlseqs table). Single public function exports, no import-time
side effects (CLAUDE.md §8).
**Test scenarios** (`tests/unit/hosts/two-pane/prompt-preamble.test.ts`):
- escaper converts a lone `\x1b` to its visible glyph and leaves following
  printable bytes (`[2J`) intact as text.
- `Covers AE6.` escaper renders an OSC 52 sequence (`\x1b]52;c;<base64>\x07`) as
  visible text — no raw `\x1b` or BEL survives in the output.
- escaper preserves `\n` and `\t` but converts `\r`, NUL, and other C0/C1 code points.
- escaper converts C1 code points (`U+0080–U+009F`) to visible form (8-bit CSI
  introducer cannot survive).
- `Covers F4.` a prompt mixing non-ASCII text (e.g. `café`, `日本語`, emoji) with
  embedded controls (ESC, OSC 52, a bare C1) renders the non-ASCII text **intact**
  while every control is escaped — proving the escaper works on code points, not
  UTF-8 bytes.
- `renderPromptPreamble` output begins with the `prompt:` label and ends with the
  separator line; a multi-line prompt keeps its internal newlines.
- a verbatim several-hundred-line prompt is rendered in full (nothing elided).

#### U2. Carry the assembled prompt on `step:start`; strip it from the structured record

**Goal:** Make the assembled prompt available to the host at `step:start` without
bloating `lifecycle.ndjson`.
**Requirements:** R1, R3, R4 · **Dependencies:** U1 (none hard; can parallelize)
**Files:**
- `src/core/step-lifecycle.ts` (modify — `StepLifecycleContext`, `step:start`
  emission, `emitStepLifecycle`)
- `src/core/workflow.ts` (modify — type of the `step:start` variant in
  `StepLifecycleEvent`; hoist `assemblePrompt`; thread `prompt` into the agent
  lifecycle ctx for **both** autonomous and interactive agent paths)
**Approach:**
- Add `readonly prompt?: string` to the `step:start` variant of
  `StepLifecycleEvent` (`src/core/workflow.ts:186`) and to
  `StepLifecycleContext` (`src/core/step-lifecycle.ts:88`).
- In `withStepLifecycle`, include `prompt` on the emitted `step:start` event when
  present.
- In `emitStepLifecycle` (`src/core/step-lifecycle.ts:44`), **exclude** `prompt`
  from the `record` written to the span (mirror the existing `error` special-case)
  so it never lands in `lifecycle.ndjson` (KTD2).
- Hoist `assemblePrompt(config.prompt, overrides, key)` so the assembled string is
  available **before** `withStepLifecycle` in `runAgentStep`
  (`src/core/workflow.ts:1135`) and the interactive produce path, and thread it
  both into the lifecycle ctx and down to `produceAgentStep` (avoid assembling
  twice; `assemblePrompt` is pure so a double call is also safe).
- Set `prompt` on the lifecycle ctx for **both** agent modes. Interactive carries
  it too so AT-4 is a real regression guard: only the choreographer's
  `mode !== 'autonomous'` early-return prevents the leak — drop the guard and the
  interactive pane leaks the prompt, failing AT-4. (`command`/`ask` steps never
  set `prompt`.) _This is deliberate and required: the acceptance contract pins
  AT-4 to fail (not pass vacuously) if the guard is dropped — see
  acceptance-tests.md AT-4 and the "Unwired-feature triage" note. Carrying the
  prompt on interactive events does **not** widen persistence: KTD2 strips it from
  the structured lifecycle record, and Phase 2's always-on sink writes for
  autonomous steps only — it stays an in-memory event field. (plan-review F3
  proposed dropping interactive carriage; rejected because it would make AT-4
  vacuous.)_
**Patterns to follow:** the `error`-field special-case in `emitStepLifecycle`;
existing optional-field spreads on lifecycle events (`...(x !== undefined ? …)`).
**Test scenarios:**
- (unit, `tests/unit/core/`) `emitStepLifecycle` for a `step:start` with `prompt`
  does **not** include `prompt` in the structured record it appends to the span.
- (unit) `withStepLifecycle` emits a `step:start` event carrying `prompt` when the
  ctx supplies it, and omits the field when it does not.

#### U3. RightPane Pane Object — chrome constants + semantic assertions

**Goal:** Give scenarios a semantic way to assert the prompt label, separator,
and (for AT-6) absence of an executed OSC 52, with chrome literals co-located.
**Requirements:** R5, R6 · **Dependencies:** U1 (label/separator literals must
match the renderer)
**Files:** `tests/dsl/panes/right-pane.ts` (modify); possibly the pane driver
interface it delegates to (`tests/_support/real-tmux/…pane-driver`).
**Approach:**
- Add a co-located `TEXT` constant (mirroring `LeftPane`'s pattern in
  `tests/dsl/panes/left-pane.ts:21`) holding the `prompt:` label and separator
  literal — matching U1's production output.
- Add semantic methods: `assertShowsPromptLabel()`, `assertSeparatorBetweenPromptAndOutput()`
  (or a single `assertPromptPreamble()`), built on the existing
  `assertShowsContent` capability.
- Add `assertNoOsc52()` (or `assertClipboardUntouched()`) modeled on
  `assertNoCaretEcho()` (`tests/dsl/panes/right-pane.ts:22`): assert no raw
  `\x1b]52;c;…` bytes survive in the captured pane and (where the harness can)
  the terminal clipboard was not written. No clipboard util exists today
  (Explore finding §6) — implement the byte-absence assertion at minimum;
  a clipboard stub is a stretch (see Risks).
**Patterns to follow:** `tests/dsl/panes/left-pane.ts` (co-located `TEXT`/`COLOR`
constant objects); `assertNoCaretEcho` in `tests/dsl/panes/right-pane.ts`.
**Test scenarios:** exercised transitively by U4 (the Pane Object methods are the
assertion surface). No standalone test for the Pane Object itself.

#### U4. Wire the preamble into the choreographer; full-host scenarios (AT-1..AT-8)

**Goal:** Write the preamble to the tee at `step:start` and prove the behavior
end-to-end through real tmux.
**Requirements:** R1, R2, R3, R4, R5, R6, R7 (R8 left open for Phase 2) ·
**Dependencies:** U1, U2, U3
**Files:**
- `src/hosts/two-pane/lifecycle-choreographer.ts` (modify — `step:start` branch)
- `src/hosts/two-pane/pane-map/pane-spec.ts` + `pane-map/right-pane-controller.ts`
  (modify — from-start `file-tail` flag, KTD8)
- `tests/full-host/fake-agent/prompt-preamble--*.test.ts` (new scenarios)
**Approach:**
- In the `step:start` branch (`lifecycle-choreographer.ts:102-129`), after
  `tee.open(event.stepName)`, write `renderPromptPreamble(event.prompt)` to the
  tee **before** registering the source — replacing the bare
  `[<step>] starting…` marker as the first visible bytes (the preamble now forces
  the file into existence with visible content). Guarded by the existing
  `event.mode !== 'autonomous'` early-return and `event.prompt !== undefined`.
- Register the autonomous prompt source as **from-start** (KTD8): add a flag to
  the `file-tail` `PaneSpec` so `commandForSpec` emits `tail -n +1 -F` instead of
  `tail -n 5000 -F` for prompt-bearing sources, so a prompt longer than the
  backfill window keeps its head. The interactive `pty` path and non-prompt
  file-tail sources are untouched (still bounded).
**Execution note:** Start with AT-4 as a failing guard (it is green today; keep
it from passing vacuously) and AT-1 as the first feature-driving scenario.
**Patterns to follow:** existing full-host scenarios —
`tests/full-host/fake-agent/follow-live--right-pane-swaps-source.test.ts`,
`multi-source--each-source-swaps-distinct-content.test.ts`,
`replay--revisit-shows-same-transcript.test.ts`. Scenario DSL imports from
`tests/dsl/index.ts`.
**Test scenarios** (`tests/full-host/fake-agent/prompt-preamble--*.test.ts`,
`full:fake` level):
- `Covers AT-1 / AE1.` autonomous step → right pane shows `prompt:`, the prompt
  text, separator, then agent output below.
- `Covers AT-2.` the prompt region is preceded by the label and a separator sits
  between prompt and the first agent-output line (semantic Pane Object assertion).
- `Covers AT-3 / AE2.` two autonomous steps with distinct prompts → each step's
  pane shows its own prompt (second shows the second prompt, not the first).
- `Covers AT-4 / AE3.` interactive step → no label/separator/prompt injected;
  pane behaves as today. Drives the **same wired step-start path** as AT-1.
- `Covers AT-5 / AE5.` several-hundred-line prompt → assert both the start and the
  far end of the prompt are present (nothing truncated).
- `Covers AT-5 (backfill regression) / F1.` a prompt whose preamble + output
  exceeds the `TAIL_BACKFILL_LINES` (5000) window → the prompt's **head** (the
  `prompt:` label / first lines) is still present, proving the source reads from
  start (KTD8), not from the bounded tail. (A focused unit asserting prompt
  sources do not use the bounded `tail -n 5000` path is an acceptable substitute
  if a 5000-line full-host scenario is too slow for the gate.)
- `Covers AT-6 / AE6.` prompt with ANSI/`\x1b[2J`/quotes/backslashes/newlines →
  a recognizable token appears as visible text; label/separator/output intact;
  `assertNoOsc52` for the OSC 52 sub-case.
- `Covers AT-7 / AE4 (interim, logging-on only — NOT R8 acceptance).` complete the
  autonomous run, reload, reselect the step → the same prompt appears above the
  replayed output via the frozen tee. This regresses the live-path embedding; R8
  acceptance (always-on store, logger-independent) is closed in Phase 2 / U6.
- `Covers AT-8.` assembled prompt carrying a distinguishing injected marker (e.g.
  `extraContext`/`extraPrompt`) → the pane shows the injected marker, not only the
  pre-assembly template text.
**Verification:** `bun run check` green; the new full-host scenarios pass at the
`:full:fake` level (`bun run test:two-pane:full:fake` or as wired into the gate).
A non-interactive run's right pane opens with the `prompt:` preamble above output.

### Blocked-on-user-input
- None. KTD3 (escape glyph) and KTD4 (separator/label form) are taken with
  recommended defaults and are adjustable co-located constants. If the team wants
  a specific separator glyph or escape notation pinned before coding, that is a
  one-line chrome choice — otherwise the defaults stand.

---

## Phase 2 — Always-on prompt persistence + replay parity (R8 / AT-7 acceptance)

Status: done

**This phase closes R8 / AT-7 acceptance** — Phase 1's logging-on replay is only
an interim regression. R8's human-reviewed contract requires the prompt persisted
in an **always-on** location *independent of the optional file logger*; this phase
adds that store and teaches the replay **fallback** branch (used when the tee is
empty/absent) to render the prompt. The full-host AT suite always runs with
logging on, so the logger-disabled path is proven by a focused integration test
rather than a full-host scenario (see Risks).

**Covers (acceptance-closing):** R8 (always-on clause) — AT-7.

### AI-implementable

#### U5. Always-on per-step prompt sink

**Goal:** Persist the assembled prompt per step at `step:start`, independent of
`logger.logsDir`.
**Requirements:** R8 · **Dependencies:** U2 (prompt on the event), U4 (write site)
**Files:**
- `src/hosts/two-pane/lifecycle-choreographer.ts` (modify — `step:start` branch;
  new always-on writer dep)
- `src/hosts/two-pane/prompt-store.ts` (new — small writer rooted in `stateDir`).
**Approach (pinned contract, KTD7 / plan-review F5):**
- Write the **raw** assembled prompt (not the rendered preamble) to a
  deterministic per-step artifact rooted in the run's `stateDir` —
  `agents/<step>/prompt.txt` — written **unconditionally**, **never** gated on
  `logger.logsDir`. The choreographer threads a `promptStore`/`stateDir` dep into
  `LifecycleChoreographerDeps` (the host already owns `stateDir`).
- The store does **not** depend on the optional file logger and does **not** put
  the prompt body into `state.json`. If `StepEntry` records anything it is a
  **relative pointer** to the file, not the body.
- Idempotent per step (truncate-on-open like the tee), consistent with KTD5.
**Patterns to follow:** `src/hosts/plain/per-step-tee.ts` (per-step
`agents/<step>/…` file layout, truncate-on-open).
**Test scenarios** (integration, mocked edges per CLAUDE.md):
- with file logging **disabled** (null logger / `logsDir === null`), a `step:start`
  for an autonomous step still writes the prompt to the always-on sink — and the
  written path is rooted in `stateDir`, not `logsDir`.
- the always-on sink holds the **raw** assembled prompt (escaping/marking happens
  at render time, not store time) so future display changes are not storage
  migrations (addresses a doc-review residual risk).
- the prompt body is **not** written into `state.json` (only a pointer, if any).
- interactive and `command`/`ask` steps write no prompt sink.

#### U6. Replay fallback prepends the persisted prompt

**Goal:** When the frozen tee is empty/absent (logging-disabled replay), the
autonomous replay source still leads with the prompt.
**Requirements:** R8, R2, R5, R6 · **Dependencies:** U5, U1 (renderer)
**Files:** `src/hosts/two-pane/pane-map/right-pane-controller.ts` (modify —
`resolveAutonomousReplaySpec`, the NDJSON-re-render fallback branch at
`:1187-1208`).
**Approach:**
- Only the **fallback** branch changes. The primary branch (frozen
  `formatted_output.ansi`, `:1178-1186`) already contains the preamble from
  Phase 1 — leaving it untouched avoids double-display.
- In the fallback, read the always-on prompt sink (U5); if present, prepend
  `renderPromptPreamble(prompt)` to the re-rendered transcript text before writing
  the warm-cache replay file.
**Patterns to follow:** the existing `writeReplayFile` /
`renderTranscriptToString` flow in `resolveAutonomousReplaySpec`.
**Test scenarios** (integration):
- `Covers AT-7 (logging-disabled).` a completed autonomous run **without** a
  populated tee, reselected on replay, renders the prompt preamble above the
  re-rendered transcript.
- a primary-branch replay (tee present) is **not** double-prefixed — the prompt
  appears exactly once.

### Blocked-on-user-input
- None. The persistence contract is now pinned (KTD7 / U5): a `stateDir`-rooted
  dedicated `agents/<step>/prompt.txt`, raw body, logger-independent — not an open
  implementation choice.

---

## Phase 3 — Open at the top of the prompt (R9 / AT-9)

Status: done

Pin the source pane's initial scroll position to the top of the prompt when an
autonomous step opens, with no auto-follow past it, so the `prompt:` label and
the start of a long prompt are visible the moment the step opens. The accepted
trade-off (R9): live output sits below the fold until the watcher scrolls down.

**Covers:** R9, AT-9.

### AI-implementable

#### U7. Pin the source pane to the top of the prompt at step open

**Goal:** The autonomous step's pane opens scrolled to the top of the prompt and
does not auto-tail past it.
**Requirements:** R9 · **Dependencies:** U4 (preamble written before output)
**Files:**
- `src/hosts/two-pane/pane-map/right-pane-controller.ts` (modify — the live
  source registration / swap-in for autonomous steps), and/or
  `src/hosts/two-pane/lifecycle-choreographer.ts` at the `step:start` swap.
- possibly `src/services/tmux/` if a new copy-mode/scroll command is needed
  (route via the tmux service — never call tmux directly, CLAUDE.md §1).
**Approach (directional — exact tmux incantation deferred to implementation):**
- The live source pane runs `tail -n <N> -F <tee>` and tmux auto-follows new
  output to the bottom. To open at the top of the prompt, after the preamble is
  written and the source is swapped in, put the source pane into tmux **copy-mode**
  positioned at the **top** of history (e.g. `copy-mode` + a `history-top` /
  `goto-line 0`-style `send-keys -X`). In copy-mode tmux pauses auto-follow, so
  new agent output accrues below the fold while the viewport stays at the prompt —
  exactly R9. `f` (follow-live) / scrolling returns to the tail.
- This is tmux-version-sensitive (the repo already gates real-tmux levels for
  3.4 vs 3.5+); the implementer must verify the copy-mode command set on the
  pinned version and add the capability to the tmux service if missing.
**Technical design note:** verify whether copy-mode survives the `swap-pane`
visible/hidden exchange, and whether it must be (re)applied to the *visible* pane
after the swap. This is the primary unknown.
**Patterns to follow:** `src/services/tmux/` adapter methods; the existing
`tail -F` source spawn in `right-pane-controller.ts:365-389`.
**Test scenarios** (`tests/full-host/fake-agent/`, `:full:fake`):
- `Covers AT-9.` autonomous step with a prompt taller than the pane → the top of
  the pane shows the `prompt:` label / start of the prompt, **not** the tail of
  agent output, once output begins streaming. Assert the top-of-pane content is
  the label/prompt start.
- (guard) a short-prompt autonomous step is unaffected — the pane still shows the
  preamble and following output normally.
- `(guard, plan-review F6)` after the pane opens at `prompt:` on an over-height
  step, drive the existing follow-live / scroll-to-tail action and assert the
  latest agent output becomes visible — the top-pin must not strand the watcher
  away from live output. (Edge-case usability guard, not a new acceptance gap;
  AT-9 itself only requires opening at the top.)
**Verification:** `bun run check` green; on an over-height prompt the pane opens
at the `prompt:` label and does not jump to the live tail, and follow-live still
returns to the tail.

### Blocked-on-user-input
- None expected. **Risk flag (not a blocker):** if real-tmux copy-mode cannot
  reliably pin scroll-to-top across the `swap-pane` exchange on the supported tmux
  version, the implementer should surface that as a finding before forcing a
  brittle workaround — but the requirement is sound and copy-mode is the standard
  mechanism.

---

## Requirements & acceptance-test traceability

| Item | Requirement(s) | Phase / Unit | Acceptance test |
| ---- | -------------- | ------------ | --------------- |
| Prompt above output, live | R1, R7 | P1 / U2, U4 | AT-1 |
| Label + separator marking | R5 | P1 / U1, U3, U4 | AT-2 |
| Per-step prompt (multi-step) | R3 | P1 / U2, U4 | AT-3 |
| Interactive injects nothing | R4 | P1 / U2, U4 | AT-4 |
| Long prompt verbatim, no truncation (incl. over-backfill) | R2 | P1 / U1, U4 (+ KTD8 from-start tail) | AT-5 |
| Control sequences escaped, pane intact | R6 | P1 / U1, U3, U4 | AT-6 |
| Replay shows the prompt — **acceptance** | R8 (always-on clause) | **P2 / U5, U6** | AT-7 |
| ↳ logging-on replay (interim regression, not R8 acceptance) | — | P1 / U4 | AT-7 (interim) |
| Assembled (injected) text, not template | R2 | P1 / U2, U4 | AT-8 |
| Open scrolled to top of prompt | R9 | P3 / U7 | AT-9 |

Every requirement R1–R9 is covered. AT-1–AT-9 each map to a driving unit and a
`full:fake` (or fallback-integration, for AT-7's always-on acceptance) scenario.
**AT-7 is only acceptance-closed by Phase 2** — Phase 1's logging-on replay is an
interim regression, not R8 acceptance.

---

## Risks & residual notes (carried from doc-review)

- **Prompt truncation via the bounded tail (plan-review F1, applied).** The
  default `file-tail` source uses `tail -n 5000 -F`; a prompt+output stream past
  that window would lose the prompt's head, violating R2/AT-5 and AT-9. Fixed by
  KTD8 (from-start read for prompt-bearing + replay sources) with an over-backfill
  regression in U4. Residual: a full 5000+-line full-host scenario may be too slow
  for the gate — U4 allows a focused "prompt sources don't use the bounded path"
  unit as a substitute.
- **R8's always-on clause has no reachable production failure mode and no
  full-host AT.** `logsDir === null` is unit-fixture-only (verified:
  `src/cli/deps.ts:102`, `tests/_support/real-tmux/workflow-driver.ts:211`). Phase 2
  is therefore covered by a **focused integration test** (U5/U6), not the
  full-host AT suite. This is honest scope, not a gap — flagged so a reviewer
  does not expect a full-host AT-7-logging-off scenario. **R8 is a human-reviewed
  contract requirement, so Phase 2 is required for acceptance, not optional
  hardening** (plan-review F2); the brainstorm (FL-1) explicitly requires the
  always-on sink, so the plan builds it.
- **Storage/display coupling.** The always-on sink stores the **raw** prompt
  (U5), and rendering (escape + marking) happens at display time (U1) — so a
  future display change is not a storage migration (addresses doc-review residual
  risk).
- **Lifecycle-log bloat avoided** by stripping `prompt` from the structured
  record (KTD2 / U2).
- **Persisted-stream consumers** (transcript/run-analysis) now see a leading
  prompt region in `formatted_output.ansi`. They already tolerate arbitrary
  leading bytes (the `[<step>] starting…` marker preceded them); confirm no
  consumer parses the head of that file positionally.
- **No-echo premise is contingent** (doc-review FL-5): the feature assumes the
  autonomous CLI does not itself echo the prompt. True today (Claude
  `--output-format stream-json`, Codex `exec --json`). If a future flag surfaces
  the submitted prompt in the first event, R1's injection would double-display —
  re-verify if the autonomous output mode changes.
- **AT-9 / copy-mode across `swap-pane`** is the single largest implementation
  unknown (U7) and is tmux-version-sensitive — see the Phase 3 risk flag.
- **OSC 52 clipboard assertion** has no existing harness util (Explore §6); U3
  implements byte-absence at minimum, with a clipboard stub as a stretch goal.
