# Phase 1 — implementation report

**Feature:** Show the Initial Prompt in the Right Pane (Non-Interactive Runs)
**Phase:** 1 — Prompt preamble: escape, render, inject into the live tee
**Status:** done · all four units (U1–U4) implemented and verified end-to-end through real tmux.

## What shipped

For every **autonomous** agent step, orch now renders the exact assembled prompt
it sent the agent at the **top of that step's right pane** — a `prompt:` label,
the control-escaped prompt, a separator rule — above the agent's streamed output,
both live and (interim) on replay.

### U1 — escaper + renderer (`src/hosts/two-pane/prompt-preamble.ts`, new)
- `escapeControlBytesToVisible(text)` — operates on Unicode **code points** (like
  `strip-ansi`, never raw UTF-8 bytes, so `café` / `日本語` / emoji survive). Converts
  every C0 control except `\n`/`\t`, DEL, and every C1 to a visible Unicode Control
  Picture (U+2400 block). Escaping the ESC introducer + C1 introducers neutralizes
  CSI/OSC/DCS/APC by construction — no sequence parser.
- `renderPromptPreamble(prompt)` — `prompt:` label + escaped prompt + a `─`×60
  separator, CRLF-terminated (tmux convention). `PROMPT_LABEL` / `PROMPT_SEPARATOR`
  exported as the production source of truth.
- Unit tests: `tests/unit/hosts/two-pane/prompt-preamble.test.ts` (9 tests, incl.
  AE6 OSC 52 escape + F4 non-ASCII-intact).

### U2 — carry the prompt on `step:start`, strip from the structured record
- `src/core/workflow.ts`: added optional `prompt` to the `step:start` event
  variant; hoisted `assemblePrompt(...)` in **both** `runAgentStep` (autonomous)
  and `runInteractiveStep` so the assembled string is available before
  `withStepLifecycle`. Carried on the lifecycle ctx for both modes; an **empty**
  assembled prompt (fixtures only) is carried as `undefined` so it never pollutes
  the event or renders an empty preamble.
- `src/core/step-lifecycle.ts`: `StepLifecycleContext.prompt`, emitted on
  `step:start`; `emitStepLifecycle` **strips** `prompt` from the span record (same
  spirit as the existing `error` special-case) so a several-hundred-line prompt
  never bloats `lifecycle.ndjson`.
- Unit tests added to `tests/unit/core/step-lifecycle.test.ts` (carries-when-set /
  omits-when-absent; not-in-structured-record but reaches the host).

### U3 — RightPane Pane Object (`tests/dsl/panes/right-pane.ts`)
- Co-located `TEXT` chrome constants (mirroring, never importing, the production
  label/separator) + `assertShowsPromptLabel` / `assertShowsPromptSeparator` /
  `assertShowsPromptPreamble` / `assertNoOsc52` (modeled on `assertNoCaretEcho`).

### U4 — choreographer wiring + from-start tail + full-host scenarios
- `src/hosts/two-pane/lifecycle-choreographer.ts`: at `step:start` (autonomous
  branch) writes `renderPromptPreamble(event.prompt)` as the **first** tee bytes,
  replacing the bare `[<step>] starting…` marker; falls back to that marker when
  no prompt is carried (empty-prompt fixtures) so the pane is never blank.
- `src/hosts/two-pane/pane-map/pane-spec.ts`: added a `fromStart?` flag to the
  `file-tail` `PaneSpec`.
- `src/hosts/two-pane/pane-map/right-pane-controller.ts`: `commandForSpec` emits
  `tail -n +1 -F` when `fromStart` is set (KTD8 — a prompt longer than the bounded
  `tail -n 5000` window keeps its head). The live autonomous source and the
  autonomous-replay primary branch are registered `fromStart: true`.
- DSL plumbing for per-step prompts: `FullHostSpec.prompts` (per-step) +
  `extraPrompt` (AT-8 injection), threaded through `full-host-static-app.ts`,
  `full-host-fake-agent-driver.ts`, and the real-tmux `workflow-driver.ts`
  (`HarnessStep.extraPrompt` → `overrides.extraPrompt`).
- New full-host scenarios (`tests/full-host/fake-agent/prompt-preamble--*.test.ts`):
  AT-1/2, AT-3, AT-5, AT-6, AT-7 (interim), AT-8.

## Verification

All run locally and green (real tmux 3.6a available, so the `:full:fake` level
**actually executed** rather than skipping):

- `biome check .` — clean (743 files)
- `tsc --noEmit` — clean
- `bun run test:unit` — 1909 pass
- `bun run test:two-pane:fast` — 287 pass
- `bun run test:two-pane:full:fake` — 18 pass (incl. the 6 new prompt-preamble scenarios, through real tmux)
- `bun run test:two-pane:lifecycle` — 26 pass
- `bun run test:two-pane:screen` — 41 pass
- `tests/unit/core`, `tests/integration/core`, `tests/integration/workflows` — 757 pass
- `tests/integration/real-tmux/pane-map-source-session.test.ts` — 7 pass

I did **not** run the full `bun run check` (it pulls in the entire e2e + real-CLI
matrix); the slices above cover every file Phase 1 touched.

## Issues & surprises

1. **AT-4 is infeasible at the `full-host:fake-agent` level — covered at the unit
   level instead.** The acceptance doc assumed an interactive fake run could drive
   the real pane. It cannot: `FakeRunner.buildCommand` returns argv `[':fake:', …]`,
   and an interactive step makes the tmux host `respawn-pane` that argv as a real
   process — `:fake:` is not an executable, so the pane can't spawn. So AT-4 is
   proven where the guard actually lives: a choreographer unit test now carries a
   prompt on an **interactive** `step:start` and asserts **zero** side effects
   (no tee.open/write/register) — drop the autonomous-only guard and it goes red.
   The real interactive proof layer remains `full-host:real-agent`. This is a
   minor harness limitation worked around, not a feature gap, so I did not raise a
   blocker. The acceptance-tests status table records the deviation.

2. **Empty assembled prompt is reachable in fixtures.** `emits()`-style fake
   scenarios set no prompt, so `assemblePrompt` returns `''`. Two adjustments kept
   existing behavior intact: (a) the workflow carries an empty prompt as
   `undefined` (so promptless `step:start` events are byte-identical to before —
   this caught one failing assertion in `interactive-mode.test.ts`), and (b) the
   choreographer falls back to the `[<step>] starting…` marker when the prompt is
   absent/empty, so marker-dependent multi-step scenarios still pass. The
   acceptance contract explicitly puts empty/whitespace prompts out of scope.

3. **AT-5 head-visibility vs. viewport.** Real-tmux capture reads the **visible**
   viewport, and pre-R9 the pane auto-follows to the tail, so a several-hundred-line
   prompt's head is above the fold. The full-host AT-5 therefore asserts the
   prompt's **tail** + separator + output verbatim (bottom-visible), and the
   "no head truncation" guarantee is carried by the plan-sanctioned from-start
   unit substitute (choreographer registers `fromStart: true`; the renderer unit
   renders a 400-line prompt in full). Open-at-top is AT-9 / Phase 3.

## Not in this phase (left for later phases)
- **Phase 2 (R8/AT-7 acceptance):** always-on, logger-independent per-step prompt
  store + replay-fallback prepend. AT-7 here is the interim logging-on regression
  only.
- **Phase 3 (R9/AT-9):** pin the pane to the top of the prompt at step open.

No blockers raised. No tasks were `blocked-on-user-input`.
