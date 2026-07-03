# Fix Plan — show-initial-prompt

> Derived from the two code reviews (`code-review-ce.md`, `code-review-codex.md`),
> cross-checked against the actual source and the human-reviewed acceptance
> contract (`brainstorm.md`, `acceptance-tests.md`). Each finding below was
> re-verified in the code, not taken on the reviewers' word.
>
> **Selection rule applied (the middle way):** include critical/high-priority
> correctness regressions, cheap high-value test-fidelity gaps, and one-line
> reliability wins. Exclude anything that would expand scope or contradict the
> acceptance contract (those are recorded under `issues/`), and skip low-value
> churn.
>
> Findings routed to `issues/` instead of fixed: Codex #2 (replay scroll-to-top —
> scope expansion beyond AT-9), CE L-2 (copy-mode partial-failure rollback —
> benign, "acceptable as-is"), CE L-5 (`fromStart` vs conditional preamble —
> fixture-only), plus a prompt-store path round-trip follow-up.

---

## Group A — Preserve step lifecycle on prompt-assembly failure (+ single-assembly guarantee)

Status: done

**Findings:** CE M-1 (medium) · Codex #3 (P2) · folds CE L-1 (low).

**What's wrong (verified):** `assemblePrompt` was hoisted ahead of
`withStepLifecycle` so the assembled prompt can ride on `step:start` —
`src/core/workflow.ts:1157` (autonomous) and `src/core/workflow.ts:773`
(interactive). `assemblePrompt` → `substitute()` throws on any template/var
mismatch (missing var, extra var, malformed placeholder). Before this change that
throw happened *inside* the lifecycle body (`produceAgentStep:1245` /
`produceInteractiveStep:814`), so the host saw `step:start` then `step:failed`.
Now the throw escapes *before* `withStepLifecycle` runs, so **none** of
`step:start` / `step:failed` / `step:parallel-branch-update: failed` fire for that
step. The error still reaches the workflow-level catch (run still classified
`crashed`), but the per-step attribution the steps-view / failure panes / cmux
pills consume is lost. A `{{var}}`-mismatch is a real, user-reachable input error,
so this is a user-visible regression in failure diagnosability.

Secondarily (CE L-1): `assemblePrompt` now runs twice per step (hoisted carrier +
re-derivation inside `produce*Step`). It is pure, so the two agree today, but the
feature's core claim ("the pane shows the EXACT prompt orch sent") rests on an
unenforced convention that the two call sites stay in lockstep, with no test
pinning it.

**Fix:**
- In `runAgentStep` and `runInteractiveStep`, wrap the hoisted `assemblePrompt`
  call so a throw still routes through the lifecycle envelope: on catch, enter
  `withStepLifecycle` (no `prompt` on the ctx) with a body that re-throws the
  captured error, so `step:start` → `step:failed` still fire and the step is
  attributed (preserving the existing `crashed` run classification).
- Eliminate the double assembly: thread the already-assembled string into
  `produceAgentStep` / `produceInteractiveStep` as a parameter instead of
  re-deriving it at `workflow.ts:1245` / `:814`. This makes "displayed prompt ==
  sent prompt" true by construction (closes L-1) and removes the redundant
  second `substitute()` pass.

**Tests (regression-guarding — per `docs/testing-strategy.md`, unit at the
`src/core` layer, no `mock.module`):**
- A workflow/`step-lifecycle` test where an autonomous step's prompt has a
  missing/extra `{{placeholder}}` asserts **both** `step:start` and `step:failed`
  are emitted for that step (today: neither fires — this is the regression guard).
- The same for an interactive step (the hoist exists on both paths).
- Assert the structured lifecycle record for that `step:failed` still omits the
  `prompt` field (KTD2 — do not regress the bloat guard).
- Because threading replaces a re-derivation, an existing test that a step's
  displayed/carried prompt equals the runner-received prompt is now true by
  construction; if none exists, add a focused assertion that the prompt carried on
  `step:start` is the same string handed to `produce*Step`.

---

## Group B — Replay fallback must read the prompt-bearing file from the start

Status: done

**Findings:** Codex #1 (P1).

**What's wrong (verified):** `resolveAutonomousReplaySpec`
(`src/hosts/two-pane/pane-map/right-pane-controller.ts`) prepends the prompt
preamble to the warm-cache fallback file (`${preamble}${text}` /
`${preamble}── … (no transcript) …`), but both fallback returns hand back a plain
`{ kind: 'file-tail', path: filePath }` (`:1254`, `:1264`) — **without**
`fromStart: true`. The primary branch (`:1227`) *does* set `fromStart: true`.
`commandForSpec` (`:373`) therefore spawns the bounded `tail -n 5000 -F` for the
fallback, so a logger-disabled (or cancelled-run) replay whose prompt+transcript
exceeds `TAIL_BACKFILL_LINES` (5000) drops the `prompt:` head — contradicting R2
(no truncation) and R8/AT-7 (replay parity). This is an inconsistency with the
primary branch and the stated KTD8, not a scope change.

**Fix:** Return `{ kind: 'file-tail', path: filePath, fromStart: true }` at both
fallback returns in `resolveAutonomousReplaySpec` (the `transcriptPath ===
undefined` branch and the rendered-transcript branch), so the prepended prompt
head always backfills regardless of stream length.

**Tests (model/controller layer, `FakeTmuxService` seam — extend
`tests/model/controller/right-pane-replay-prompt-fallback.test.ts`):**
- A regression that asserts the fallback-branch replay spawns `tail -n +1`
  (from-start), not `tail -n 5000`, when a persisted prompt is present (assert on
  the `createSession` command's `-n` argument, mirroring the existing
  `tailedPath` helper). This fails today.
- Keep the existing "primary branch not double-prefixed" test green (primary path
  untouched).

---

## Group C — Don't head-of-line-block the lifecycle FIFO on the persistence write

Status: done

**Findings:** CE M-2 (medium).

**What's wrong (verified):** the always-on prompt-store write at
`src/hosts/two-pane/lifecycle-choreographer.ts:134` is `await`ed inside
`process()`, which is chained behind the single `tail` FIFO that serializes
**all** lifecycle events. `createPromptStore.write` does `mkdir(...,{recursive})`
then `writeFile(...)`. Until both resolve, no later lifecycle event for **any**
step can begin (downstream `registerSource`, `step:complete`, parallel rollups).
On a slow/stalled filesystem a single `step:start` stalls the whole right-pane
choreography. The write's only consumer is the replay *fallback* branch, read long
after the step completes — it does not need to complete before the pane registers.

**Fix:** Fire-and-forget the persistence write so it leaves the FIFO:
`void deps.promptStore.write(event.stepName, prompt).catch(deps.onSendError)`.
The `tee.write` immediately above already gives the live pane and the
replay-from-tee path the prompt, so nothing downstream depends on the store write
having flushed.

**Tests:**
- The existing `step:start` choreographer tests assert the store call via
  `rec.calls.find(c => c.on === 'promptStore')` — the call is recorded
  synchronously on invocation, so `void` keeps them green. **Confirm** they assert
  the *call*, not write *completion* after `quiescent()`; if any asserts
  completion, make the fake's recording synchronous (record on call) so the
  assertion does not race the un-awaited promise.
- Add a focused assertion that a later lifecycle event in the same FIFO is not
  gated on the store write resolving (e.g. a slow/never-resolving fake store does
  not stall a subsequent `step:start`'s `registerSource`).

---

## Group D — Close escaper / keying test-fidelity gaps

Status: done

**Findings:** CE M-3 (medium) · CE L-3 (low) · CE L-4 (low). Pure test additions;
no production change, so no behavioral regression risk.

**What's missing (verified):**
- **M-3 (DEL):** `escapeCodePoint` has a dedicated DEL branch (`0x7F → U+2421
  ␡`, `prompt-preamble.ts:56`) that is in the escaper regex but has **zero**
  coverage — the unit test covers NUL/CR/BEL (C0) and `0x80–0x9F` (C1) but never
  `0x7F`. A regression dropping the DEL case (fall-through to
  `String.fromCodePoint(cp)`) would leak a raw DEL and no test would catch it.
- **L-3 (AT-3 negative):** `prompt-preamble--each-step-shows-own-prompt.test.ts`
  asserts step 1 shows `PROMPT-ALPHA` but never asserts `PROMPT-BRAVO` is
  **absent** from it. The contract (`acceptance-tests.md:29`) is two-directional;
  a per-run leak showing both prompts concatenated would still pass.
- **L-4 (surrogate adjacency):** the F4 unit test separates astral/emoji chars
  from control bytes with spaces, so a surrogate-pair code unit immediately
  adjacent to an escaped control is never exercised. The escaper is correct (regex
  matches only single BMP control units) but that safety is unpinned against a
  future byte/code-unit-iteration refactor.

**Fix (tests only):**
- In `tests/unit/hosts/two-pane/prompt-preamble.test.ts`: assert
  `escapeControlBytesToVisible('a\x7Fb')` does not contain `\x7F`, does contain
  `␡` (U+2421), and preserves `a`/`b`.
- In the same file: assert `escapeControlBytesToVisible('🎉\x1b[2J🎉')` (emoji
  directly abutting ESC, no spaces) keeps both 🎉 intact and turns the ESC into
  `␛`.
- In `prompt-preamble--each-step-shows-own-prompt.test.ts`: after selecting the
  first step, add `await app.rightPane.assertDoesNotShow('PROMPT-BRAVO carry out
  the plan')` (the Pane Object already exposes `assertDoesNotShow`).

---

## Group E — Make AT-6's OSC 52 "escaped, not executed" guarantee falsifiable

Status: done

**Findings:** CE H-1 (high). Highest-priority finding; closes an explicit
acceptance-contract clause rather than expanding scope.

**What's wrong (verified):** AT-6's contract (`acceptance-tests.md:51-52`)
requires the OSC 52 sub-case to assert the decoded clipboard payload does **not**
reach the terminal clipboard — "plus a clipboard check (or harness clipboard
stub)". The test
(`tests/full-host/fake-agent/prompt-preamble--control-sequences-escaped.test.ts:43-47`)
only asserts (a) the base64 payload shows as visible text and (b)
`assertNoOsc52()` (raw `\x1b]52` bytes absent from pane *text*). Because the
escaper runs *before* the tee, raw OSC 52 introducer bytes can never reach the
pane as text **regardless of correctness**, so both assertions pass whether or not
the sequence executed against a clipboard. The product behavior is in fact correct
(the escaper neutralizes the introducer before the tee — verified), so this is a
**test-fidelity** gap, not a product defect: the guarantee holds but the test
cannot fail if it were violated.

**Fix:** Add a clipboard observation to the real-tmux harness and assert it is
unchanged, fulfilling AT-6's parenthetical ("a clipboard check (or harness
clipboard stub)") in its lightest compliant form:
- Add a real-tmux-only Pane Object method (e.g.
  `RightPane.assertClipboardUnchanged(payload)`, `notImplemented` on other
  drivers) that, after the run, reads the tmux paste buffer (e.g. `show-buffer` /
  `list-buffers` over the test socket — routed through `ProcessService` /
  `RealTmuxService`, never a direct tmux call) and asserts the decoded payload
  `clipboard-payload` is **not** present.
- Wire it into the AT-6 scenario alongside the existing `assertNoOsc52()`.

**Scope/complexity note:** this is real-tmux harness infrastructure (a new tmux
service read method + driver plumbing) and is tmux-version/`set-clipboard`-config
sensitive — hence its own group. If a faithful buffer read proves brittle on the
enforced tmux floor, the contract permits a **harness clipboard stub** (assert the
sink the escaped bytes would have written to was never touched); prefer that over
forcing a flaky real-buffer assertion.

**Tests:** the AT-6 full-host scenario itself is the test; the new assertion is
the regression guard. Confirm it would go **red** under a hypothetical passthrough
(escaping disabled) — i.e. that it actually observes clipboard state, not pane
text — before considering AT-6 closed.
