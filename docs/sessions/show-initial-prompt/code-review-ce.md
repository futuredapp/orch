# Code Review — show-initial-prompt

**Scope:** New changes on the current branch (`develop`) for the *show-initial-prompt*
feature, diffed against the branch point `eddfc0f` (commits `c1fc8e7`..`137882c`).
Working tree is clean — all work is committed. Review covers only the feature diff
(`src/**`, `tests/**`); pre-existing/unrelated code was not flagged.

**Intent (from `brainstorm.md` / `acceptance-tests.md`):** For every autonomous
(non-interactive) agent step, show the exact assembled prompt orch sent the agent at
the top of that step's right pane — verbatim, control-escaped, marked with a `prompt:`
label + separator — both live and on replay, opening scrolled to the top of the prompt
(R9). Additive to display plus an always-on per-step prompt store (R8). Prompt
assembly, runner argv, and agent behavior are unchanged.

**Mode:** Report-only (findings written here; no fixes applied, per workflow contract).

**Reviewers:** correctness, reliability, maintainability, testing, project-standards,
kieran-typescript (6 parallel persona agents, model-tiered). Diff is TypeScript
two-pane host + tmux service; no auth/payments/DB/migrations, so security /
data-migration / API-contract personas were not selected.

**Verdict:** **Ready with fixes.** No P0/critical issues. The feature is unusually
well-documented and well-tested, and complies with every CLAUDE.md non-negotiable rule.
One **high** finding is a fidelity gap in the AT-6 acceptance test (the OSC 52
clipboard guarantee is asserted in a way that cannot fail). Two **medium** findings are
worth fixing before merge (a step-lifecycle attribution regression and a serial-FIFO
blocking write). The rest are low-severity hardening / coverage items.

---

## Findings

### High

#### H-1 · AT-6's OSC 52 "escaped, not executed" guarantee is not actually proven
- **Severity:** high (P1)
- **File:** `tests/full-host/fake-agent/prompt-preamble--control-sequences-escaped.test.ts:43-44`
  (assertions), supported by `tests/dsl/panes/right-pane.ts:74` (`assertNoOsc52`)
- **Reviewers:** testing
- **Problem:** AT-6's contract (`acceptance-tests.md:51-52`) requires the OSC 52
  sub-case to assert that the decoded clipboard payload does **not** land in the
  terminal clipboard — "plus a clipboard check (or harness clipboard stub)". The test
  only asserts (a) the base64 payload `52;c;Y2xpcGJvYXJkLXBheWxvYWQ=` shows as visible
  text and (b) `assertNoOsc52()`, which checks the raw `\x1b]52` introducer bytes are
  absent from the pane **text**. Because the escaper runs *before* the tee, raw OSC 52
  introducer bytes can never reach the pane as text regardless of correctness — so both
  assertions pass whether or not the sequence was executed against the clipboard. There
  is no observation of clipboard state anywhere in the suite.
- **Why it matters:** The silent-clipboard-write class is the *exact* threat AT-6 was
  written to guard, and this is the human-reviewed acceptance contract. Today, a
  hypothetical passthrough regression that wrote `clipboard-payload` to the watcher's
  real clipboard would leave the test green. The escaper itself is correct (verified —
  it converts the ESC/BEL introducers to Control Pictures), so this is a *test-fidelity*
  gap, not a product defect: the guarantee holds, but the test does not prove it.
- **Suggested fix:** Add a clipboard observation to the real-tmux harness and assert it
  is unchanged. After the run, read the tmux clipboard/paste buffer (e.g.
  `tmux -L <socket> show-buffer` / `save-buffer -`) and assert it does **not** contain
  the decoded payload `clipboard-payload`. Expose it as a real-tmux-only
  `RightPane.assertClipboardUnchanged(payload)` Pane Object method (`notImplemented` on
  other drivers). This converts AT-6's OSC 52 sub-case from unfalsifiable to a true
  negative guard.

### Medium

#### M-1 · Hoisting `assemblePrompt` outside `withStepLifecycle` drops step lifecycle events when prompt assembly throws
- **Severity:** medium (P2)
- **File:** `src/core/workflow.ts:1157` (autonomous) and `src/core/workflow.ts:773`
  (interactive)
- **Reviewers:** correctness (primary), maintainability (corroborating, as the
  double-call smell)
- **Problem:** `assemblePrompt()` is now called to carry the prompt onto `step:start`
  *before* `withStepLifecycle` is entered. `assemblePrompt` → `substitute()` throws on
  any template/var mismatch (missing var, extra var, malformed placeholder). At the base
  commit this call lived only inside `produceAgentStep` / `produceInteractiveStep`
  (`workflow.ts:1245` / `:814`) — i.e. inside the `body` executor of
  `withStepLifecycle`. A throw there is caught by the lifecycle wrapper
  (`step-lifecycle.ts:189`), which had already emitted `step:start` and then emits
  `step:failed` (`step-lifecycle.ts:190`) plus `step:parallel-branch-update: failed`
  (`:197`) inside `parallel()`. With the hoist, a prompt-assembly throw now escapes
  *before* `withStepLifecycle` runs, so **none** of `step:start` / `step:failed` /
  branch-update fire for that step. The error still propagates to the workflow-level
  catch and is classified `crashed` (same run-level status as before), but the per-step
  attribution is lost.
- **Why it matters:** The steps-view, failure panes, plain-host failure text, and cmux
  pills all consume `step:start` / `step:failed`. A prompt-assembly failure is a real,
  user-reachable input error (a `{{var}}` with a missing/extra binding); it now surfaces
  as a bare run crash with no failing-step row, where it previously showed the offending
  step as failed. This is a user-visible regression in failure diagnosability, and it is
  uncaught by the suite (no test asserts `step:failed` for a prompt-assembly throw). The
  hoisted call is also redundant work — `assemblePrompt` (including strict
  both-directions `substitute()` validation) now runs twice per step (see L-1).
- **Suggested fix:** Wrap the hoisted `assemblePrompt` call in try/catch and, on throw,
  still enter `withStepLifecycle` with a body that re-throws the caught error, so the
  `step:start` → `step:failed` trio fires and the step is attributed (preserving the
  existing `crashed` classification). Cleaner still: assemble once in `run*Step`, then
  thread the resulting string into `produce*Step` as a parameter so there is exactly one
  assembly per step and the displayed text is provably the sent text (addresses L-1
  too). Add a test asserting a template/var-mismatch step emits `step:failed` for that
  step.

#### M-2 · Awaited prompt-store write head-of-line-blocks the serial lifecycle FIFO at every autonomous `step:start`
- **Severity:** medium (P2)
- **File:** `src/hosts/two-pane/lifecycle-choreographer.ts:134` (the
  `await deps.promptStore.write(event.stepName, prompt).catch(deps.onSendError)`)
- **Reviewers:** reliability
- **Problem:** The always-on persistence write runs inside `process()`, which is chained
  behind the single `tail` FIFO that serializes all lifecycle events. `createPromptStore.write`
  performs `mkdir(..., {recursive:true})` then `writeFile(...)` (`prompt-store.ts:65-70`).
  Until both filesystem ops resolve, no later lifecycle event for **any** step can begin
  — including this step's own `registerSource` and downstream `step:complete` /
  parallel-rollup updates. The code this replaced at this point was a non-blocking
  `tee.write`.
- **Why it matters:** On a slow or stalled filesystem (full disk, slow/NFS-backed
  stateDir, fsync stalls) a single `step:start` stalls the whole right-pane
  choreography, not just one pane. The common case (small write to local stateDir) is
  fine — hence medium — but the blast radius is the entire FIFO for an additive display
  artifact whose live copy already lives in the embedded tee preamble; the store is read
  only by the logging-off replay *fallback* branch.
- **Suggested fix:** Fire-and-forget the persistence write so it does not sit on the
  FIFO: `void deps.promptStore.write(event.stepName, prompt).catch(deps.onSendError)`.
  The tee write immediately above already guarantees the live pane and the
  replay-from-tee path render the prompt, so the store need not complete before the pane
  registers or before later events proceed.

#### M-3 · DEL (0x7F) escaper branch has zero test coverage
- **Severity:** medium (P2)
- **File:** `tests/unit/hosts/two-pane/prompt-preamble.test.ts` (escaper describe
  block); production branch at `src/hosts/two-pane/prompt-preamble.ts:46-47`
  (`DEL → U+2421`)
- **Reviewers:** testing
- **Problem:** DEL (`0x7F`) has a dedicated, distinct escape branch in
  `escapeCodePoint` (it maps to `U+2421 SYMBOL FOR DELETE`, **not** `PICTURE_BASE + cp`
  like the C0 block) and is in the escaper regex `[\x00-\x08\x0B-\x1F\x7F-\x9F]`. The C0
  test covers NUL/CR/BEL and the C1 test covers `0x80–0x9F`, leaving `0x7F` as the one
  control branch with no coverage.
- **Why it matters:** Because DEL is its own code path, a regression that dropped the
  DEL case (e.g. fell through to `String.fromCodePoint(cp)`) would leak a raw DEL into
  the pane and no test would catch it.
- **Suggested fix:** Add an assertion: `escapeControlBytesToVisible('a\x7Fb')` does not
  contain `\x7F`, does contain `␡` (U+2421), and preserves `a`/`b`.

### Low

#### L-1 · `assemblePrompt` computed twice per step (display vs runner) with no equality guard
- **Severity:** low (P3)
- **File:** `src/core/workflow.ts:773`/`:814` (interactive), `:1157`/`:1245` (autonomous)
- **Reviewers:** maintainability
- **Problem:** `assemblePrompt` is now called once hoisted (to carry the prompt onto
  `step:start`) and once again inside `produce*Step` (to feed the runner). Both take
  identical inputs and the function is pure, so they agree today — but the feature's core
  correctness claim ("the pane shows the EXACT prompt orch sent the agent") rests on an
  unenforced convention that the two call sites stay in lockstep, with no test capturing
  both strings and comparing them.
- **Why it matters:** A future edit that makes the `produce*` call pass different inputs
  (or moves substitution) would silently desynchronize the displayed preamble from what
  the agent actually received, passing the whole suite.
- **Suggested fix:** Assemble once in `run*Step` and thread the resulting string into
  `produce*Step` (single source of truth — also fixes M-1's double-throw site). If
  threading is too invasive here, add a model-level test that captures the carried
  `step:start` prompt and the runner's received prompt for one step and asserts equality.

#### L-2 · `enterCopyModeTop` partial failure leaves the pane in copy-mode at the wrong position with a misleading log
- **Severity:** low (P3)
- **File:** `src/services/tmux/real-tmux-service.ts:466-477`
- **Reviewers:** reliability
- **Problem:** `enterCopyModeTop` issues two sequential tmux commands. If `copy-mode`
  (cmd 1) succeeds but `send-keys -X history-top` (cmd 2) fails, the method throws while
  the pane is already in copy-mode, parked at the live tail. The caller
  `pinSourceToPromptTop` (`right-pane-controller.ts:545`) catches and logs the throw as
  `prompt-pin-failed` (implying nothing happened) but issues no compensating
  `cancelCopyMode`.
- **Why it matters:** This degrades gracefully — in the intended success path the pane
  is deliberately left in copy-mode anyway, and the user's escape hatch (`f` /
  scroll-to-tail) works regardless of where copy-mode is parked, so it is not a hang or a
  step-open breaker (verified). The only residual issue is the `prompt-pin-failed` log
  misleadingly implying the pane was not mutated.
- **Suggested fix:** Optional hardening — in the cmd-2 failure branch attempt a
  best-effort `send-keys -X cancel` before rethrowing, so the partial state rolls back to
  the deterministic live-tail-not-in-mode state. At minimum acceptable as-is.

#### L-3 · AT-3 proves each step shows its own prompt only in the positive direction
- **Severity:** low (P3)
- **File:** `tests/full-host/fake-agent/prompt-preamble--each-step-shows-own-prompt.test.ts`
- **Reviewers:** testing
- **Problem:** AT-3 asserts the first step's pane shows `PROMPT-ALPHA` after revisiting
  but never asserts `PROMPT-BRAVO` is **absent** from it. The contract
  (`acceptance-tests.md:29`) is two-directional ("its own prompt, not the first step's
  prompt"). A per-run leak showing both prompts concatenated would still pass.
- **Why it matters:** The negative half is the part most likely to regress if prompt
  keying drifted from per-step to per-run.
- **Suggested fix:** After selecting the first step, add
  `await app.rightPane.assertDoesNotShow('PROMPT-BRAVO …')` (the Pane Object already
  exposes `assertDoesNotShow`, `right-pane.ts:52`).

#### L-4 · Surrogate-pair / astral char directly adjacent to a control byte is untested
- **Severity:** low (P3)
- **File:** `tests/unit/hosts/two-pane/prompt-preamble.test.ts:~85` (the F4
  "non-ASCII intact" test)
- **Reviewers:** testing, correctness
- **Problem:** The F4 test separates astral/emoji characters from control bytes with
  spaces, so it never exercises a surrogate-pair code unit immediately adjacent to an
  escaped control. The escaper is in fact correct here (its regex matches only single
  BMP control code units, so surrogate halves are never matched and `codePointAt` is
  only called on matched single-unit controls), but that safety is unpinned.
- **Why it matters:** A future refactor to byte/code-unit iteration would silently
  corrupt astral chars at the adjacency boundary with no test catching it.
- **Suggested fix:** Add `escapeControlBytesToVisible('🎉\x1b[2J🎉')` (emoji directly
  abutting the ESC, no spaces) and assert both 🎉 survive intact and the ESC became `␛`.

#### L-5 · `fromStart` source registration is unconditional while the preamble write is conditional
- **Severity:** low (P3)
- **File:** `src/hosts/two-pane/lifecycle-choreographer.ts:123-143`
- **Reviewers:** maintainability
- **Problem:** The live tee source is registered with `fromStart: true` unconditionally,
  while the preamble write just above is conditional on a non-empty prompt (else it
  writes the bare `[<step>] starting…` marker). For the empty-prompt fixture path the
  source is still `fromStart` and later top-pinned (`pinSourceToPromptTop` gates only on
  `fromStart === true`), so the pane opens pinned to a one-line `starting…` marker. The
  "has a prompt" and "should pin to top" decisions are split across two files and
  correlated only by luck.
- **Why it matters:** Acknowledged out-of-scope (empty prompt only reachable in
  fixtures), so low severity, but the implicit linkage is fragile if the marker path
  ever ships to real runs.
- **Suggested fix:** Gate the registration's `fromStart` on the same
  `prompt !== undefined` the preamble write uses, so "from-start + pin" tracks "preamble
  present" as one decision.

---

## Coverage notes & residual risks (not findings)

- **Replay opens at the tail, not pinned to the prompt top.** `pinSourceToPromptTop` is
  gated on `key.type === 'live' && fromStart === true`, so on replay the prompt is
  present in scrollback (primary tee branch is `fromStart`; fallback prepends the
  preamble) but the viewport opens at the bottom/live tail rather than pinned to the
  prompt. This matches AT-9 (scoped to the live open) and the in-code comments — flagged
  only for product confirmation that replay was intentionally not pinned.
- **Mirrored chrome constants** (`PROMPT_LABEL` / `PROMPT_SEPARATOR` in
  `prompt-preamble.ts` vs the `RightPane` Pane Object in `tests/dsl/panes/right-pane.ts`)
  are duplicated, not imported. This is **mandated** by CLAUDE.md's two-pane testing
  rule (importing would launder a production wording change into a green pass). The test
  asserts on substrings, so a separator-width change does not break it but a
  label-wording change does — the intended failure surface. Correct by policy.
- **CR escaping.** `escapeControlBytesToVisible` escapes CR (`\x0D`) to `␍` while
  preserving LF/TAB. A CRLF-authored prompt renders each line as `…␍` + newline. This is
  the deliberate R6-safe choice (a bare CR can do carriage-return overwrite tricks) and
  is asserted by the unit test — correct by design.
- **`tail -n +1 -F` (fromStart) is not a memory risk.** `tail -F` streams to a pane
  whose scrollback is bounded by tmux's history-limit; `tail` itself buffers a line, not
  the file. Cost of `+1` vs `5000` is a one-time larger backfill at step open.
- **Prompt-store path consistency is convention-only.** `createPromptStore`
  (`tmux-host.ts:676`) and the controller's replay-fallback read (`readPersistedPrompt`)
  independently derive `<basePath>/<runId>/agents/<step>/prompt.txt`. They agree today;
  a round-trip test (write via store, read via the controller's stateDir) would lock the
  contract. Step names are pattern-validated (`/^[a-z0-9][a-z0-9:>-]*$/`), so no path
  traversal is possible through the interpolated `<step>` segment.
- **God-module sizes are pre-existing.** `right-pane-controller.ts` (~1419) and
  `workflow.ts` (~2341) exceed CLAUDE.md's 300-line soft limit, but both were already
  over at the base commit; this change adds cohesive lines without newly crossing the
  threshold. Not flagged (warning, not error; pre-existing).
- **`project-standards` verdict:** clean — all 10 non-negotiable rules pass. The new
  tmux methods route through the existing `this.#run` seam (rule 1), `CopyModeTopOptions`
  /`CancelCopyModeOptions` are exported via the tmux barrel (rule 7), paths use the
  branded `Path` type (rule 9), and `bun run typecheck` + `bun run lint` are green.
- **`kieran-typescript` verdict:** no actionable findings — escaper code-point logic,
  the `PromptStore` null-object, the `fromStart?: boolean` union (narrowed with
  `=== true`), and the `prompt?: string` conditional-spread threading are all idiomatic
  under strict mode. The `ch.codePointAt(0) ?? 0` fallback is dead-but-defensible (the
  regex only matches BMP single units).

---

## Fix order (recommended)

1. **H-1** — add the OSC 52 clipboard-state assertion so AT-6's security guarantee is
   actually proven (acceptance-contract fidelity).
2. **M-2** — make the prompt-store write fire-and-forget off the lifecycle FIFO (one-line
   change, removes a whole-choreography stall risk).
3. **M-1** — restore `step:failed` attribution for prompt-assembly throws (and fold in
   L-1 by assembling once and threading the string).
4. **M-3 / L-3 / L-4** — close the escaper (DEL), keying (AT-3 negative), and
   surrogate-adjacency coverage gaps.
5. **L-2 / L-5** — optional hardening.
