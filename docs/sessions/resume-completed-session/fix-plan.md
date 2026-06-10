# Fix Plan — Re-open a finished run (`resume` + `retry`)

Source reviews: [`code-review-ce.md`](code-review-ce.md), [`code-review-codex.md`](code-review-codex.md).
Contract: [`brainstorm.md`](brainstorm.md) (D1–D8), [`acceptance-tests.md`](acceptance-tests.md).

Every finding below was re-checked against the actual working-tree code before being selected.
Findings that would expand scope or contradict the acceptance contract are **not** here — they live
under [`issues/`](issues/) instead. Testing follows [`docs/testing-strategy.md`](../../testing-strategy.md):
projector/keymap logic is covered at the `model`/unit layer (no tmux); routing/behavior at the
integration-CLI layer; every behavior-changing fix carries the test that would catch its regression.

Selected: **6 groups**, ordered by value (correctness → reliability → hygiene → test rigor).

---

## Group 1 — Parked-after-`[r]` run mis-projects as `completed`, losing the continue action

**Status: done**

**Severity: high (correctness — breaks the retry-then-continue workflow).** Codex Finding 2, verified.

**What's wrong.** `finalizeView` decides the failed-vs-completed terminal status purely from the
step-row count, ignoring the persisted run status:

- `src/hosts/two-pane/steps-view/project-steps-view.ts:294` — `if (summary.stepsFailed > 0) return { status: 'failed', … }` else `'completed'`. `runStatus` is honored for the `'running'` and `'crashed'` branches (lines 285–292) but **not** for the failed/completed split.

After a successful `[r]` retry, `executor.retryStep` (KTD-8, `src/core/workflow.ts:2222-2249`) deliberately
leaves `run.status === 'failed'`, persists the previously-failed step as a **successful** `StepEntry`,
and leaves later steps unrun. That parked state has **zero** failed step rows → `summary.stepsFailed === 0`
→ `finalizeView` returns `{ status: 'completed' }` even though `run.status === 'failed'`.

`StepsView` gates the affordances on the projected status: `src/hosts/two-pane/steps-view/steps-view.tsx:184`
`const failureActions = actionsEnabled && state.status === 'failed'`. With the projector returning
`'completed'`, `[c]` is never offered and the view renders read-only — directly violating AT-R1 ("the
run stays parked, the continue affordance is available") and AT-R10a (reopen the parked failed view
with `[c]` still offered).

**Why a test didn't catch it.** AT-R10a (`tests/integration/cli/commands/open-failed.test.ts:289-342`)
asserts only on-disk state (`stateStore.loadRun().status === 'failed'`, step values, zero re-runs) and the
runner boundary — it uses a scripted fake host whose `awaitForegroundShutdown` returns `'quit'` without
ever running `projectStepsView`. The rendered/projected status is never observed. The comment at line 339
(`// still parked-failed → [c] still offered`) asserts nothing.

**Fix.**
- In `finalizeView` (`project-steps-view.ts:294`), treat a persisted failed run as failed regardless of
  the step-row count:
  ```ts
  if (runStatus === 'failed' || summary.stepsFailed > 0) {
    return { status: 'failed', run: header, steps, summary, view, ...bannerSlot }
  }
  ```
  This honors KTD-8's parked state and leaves the existing "a live failed step flips a completed run to
  failed" behavior intact (that path already has `stepsFailed > 0`). A `completed`/`crashed` run is
  unaffected (`runStatus` differs); a `running` run returns earlier.

**Regression tests (would fail today).**
- `model`/unit on the projector (no tmux): given a `RunState` with `status: 'failed'` whose steps are all
  `ok` and later steps absent (the parked-after-retry shape), assert `projectStepsView(...).status === 'failed'`.
  This is the inverse of the existing `steps-view-model.test.ts:132` case and is currently uncovered.
- Strengthen AT-R10a in `tests/integration/cli/commands/open-failed.test.ts` so the reopen actually
  observes the projected state (or add a sibling model test that feeds the post-retry `state.json` through
  the projector) and asserts `[c]` is offered — closing the blind spot, not just the bug.

---

## Group 2 — `[r]`/`[c]` actions are logged as a false `tui-crashed` and write a "TUI unavailable" pane message

**Status: done**

**Severity: medium (reliability / log + UX correctness).** Codex Finding 3, verified.

**What's wrong.** The Ink child exits on `quit`, `retry`, **and** `retry-continue`
(`src/hosts/two-pane/steps-view/steps-view-runner.tsx:136-141`), but the parent only treats `quit` as a
planned stop:

- `src/hosts/two-pane/steps-view/start-steps-view.ts:160` — `if (parsed.data.type === 'quit') stopped = true`.

When the child exits after `[r]`/`[c]`, `stopped` is still `false`, so the `childExitPromise` branch
(`start-steps-view.ts:189-206`) records a false `tui-crashed` lifecycle entry **and** enqueues the
`TUI_UNAVAILABLE` ("TUI unavailable — detach + reattach to retry, run continues") write to the left pane —
on every retry action. The retry itself still works (it resolves through the separate `shutdownDeferred`
channel, `tmux-host.ts:664-667`), so this is **not** a control-flow break, but it pollutes the lifecycle
logs used for debugging/acceptance and flashes a misleading message at the exact moment the CLI is acting
on the user's choice.

**Fix.** Mirror the child's exit condition in the parent at `start-steps-view.ts:160`:
```ts
if (
  parsed.data.type === 'quit' ||
  parsed.data.type === 'retry' ||
  parsed.data.type === 'retry-continue'
) {
  stopped = true
}
```

**Regression test (would fail today).** Add a parent-side `start-steps-view` unit test: emit a `retry`
(and `retry-continue`) intent, let the child exit resolve, and assert **no** `tui-crashed` lifecycle entry
was appended and **no** `TUI_UNAVAILABLE` pane write was enqueued. (The existing test at
`start-steps-view.test.ts:263` only proves `tui-crashed` *is* recorded on a genuine unexpected exit.)

---

## Group 3 — `[r]` single-step retry executes detached: blank screen, and interactive retried steps run into unattached panes

**Status: done**

**Severity: medium (reliability — latent bug for interactive steps).** CE M3, verified
(raised by both the correctness and reliability reviewers).

**What's wrong.** `runSingleStepRetry` (`src/cli/commands/open-failed.ts:229-308`) builds a full two-pane
host via `hostFactory`, then calls `loaded.executor.retryStep(wfDeps)` **directly** and `host.teardown()` —
it never goes through `executeWithAttach`/`attachForeground`. The `tmux attach-session` only happens inside
`attachForeground`, so `[r]` runs in a **detached** session: the viewer unmounts, the step re-executes with
nothing on screen, then the loop reopens a fresh read-only viewer with the result. Contrast `[c]`
(`runResumeExecution`, `resume-execution.ts:242`) and `orch retry`, which both attach and are visible.

Resource-wise this is safe (`wrappedTeardown` reaps the session/child idempotently — confirmed). The real
defect is behavioral: an **interactive** retried step would `runInteractive` into panes no human is attached
to (no input surface, possible hang), and even for autonomous steps the blank-screen-then-reopen is not the
"re-execute the failed step in place" the brainstorm D3 describes.

**Fix.** Route `runSingleStepRetry` through `executeWithAttach` (workflow = `loaded.executor.retryStep(wfDeps)`,
`readOnly: false`, no cmux host, no `beforeTeardown` so a retry-only action still fires no `run:ended`/pill —
per the Phase-2 actioned-side-effects matrix), so the user watches the retry exactly as `[c]` does. Keep the
`failed-again` vs genuine-crash classification (`mapResumeError`) intact.

> **Bounded alternative (if the team deems autonomous-only detached retry acceptable):** at minimum add a
> comment at `open-failed.ts:229` stating `[r]` runs detached by design, **and** guard against an interactive
> retried step running into unattached panes. The attached route above is preferred; this is the floor.

**Regression test.** Integration test in `tests/integration/cli/commands/open-failed.test.ts` driving `[r]`
with a `FakeRunner`: assert the retry attaches the foreground (e.g. `host.attachedForeground()` recorded, as
`open-finished.test.ts` already asserts for the read-only path) rather than tearing down without an attach.
Re-run the AT-R1/AT-R2 cases to prove pass/fail-again behavior is unchanged.

---

## Group 4 — Barrel-rule violation, missing public type, and misleading/misplaced comments

**Status: done**

**Severity: low (hygiene — but M1 is a CLAUDE.md non-negotiable rule).** CE M1, L1, M2, L6, L4 — all verified.

Small, near-zero-risk corrections; no behavior change except L4 (copy only).

- **M1 — `WorkflowDeps` imported from the internal file instead of the barrel.** `WorkflowDeps` **is**
  exported from `src/core/index.ts:151`, yet `src/cli/commands/open-failed.ts:38` and
  `src/cli/commands/resume-execution.ts:31` import it from `../../core/workflow.ts`, violating CLAUDE.md
  rule 7. Both files already import other symbols from `../../core/index.ts` — move `WorkflowDeps` into that
  existing import in both files.
- **L1 — `RetryStepResult` is a public return type missing from the barrel.** `retryStep` is on the
  barrel-exported `WorkflowExecutor` interface, but its result type `RetryStepResult` is not re-exported.
  Add it to the `export type { … } from './workflow.ts'` block in `src/core/index.ts` (verified: only
  `WorkflowDeps` is currently exported from there among these).
- **M2 — wrong file named in a doc-comment.** `src/hosts/host-registry.ts:71` says the
  `enableFailureActions` flag is "Set only by the CLI re-entry `failed` open (`open-finished`)". It is set in
  `src/cli/commands/open-failed.ts:170`, **never** in `open-finished.ts` (the read-only completed view, which
  must *not* enable actions). Change `(open-finished)` → `(open-failed)`. Actively misleading as-is.
- **L6 — dangling comment in `open-finished.ts`.** The "raw (un-instrumented) process service…" comment
  (~`open-finished.ts:441-443`) sits above `const resumeRegistry = …`; the `processService` it explains is
  ~8 lines down inside the `hostFactory({…})` call. Move it to the `processService: deps.processService`
  line (or reword as a top-of-`try` note).
- **L4 — misleading no-TTY refusal copy.** The read-only/finished open refuses whenever
  `opts.mode !== 'two-pane'` (`src/cli/commands/resume.ts` ~`:127`), which also fires for a real TTY with
  `--mode=plain`, yet the message says "no TTY / tmux unavailable." Exit code (`CONFIG_ERROR`) is correct
  and satisfies AT-6/AT-20; only soften the copy, e.g. "requires two-pane mode (got mode=plain / no TTY /
  tmux unavailable)."

**Tests.** M1/L1/M2/L6 are caught by `bun run check` (typecheck/lint) — no new test. For L4, if a no-TTY
refusal assertion exists (`resume-finished.test.ts`/`open-failed.test.ts`), update the asserted substring to
match the new copy.

---

## Group 5 — Reliability edge cases: a lost action on teardown failure, and a corrupt run defeating the new fallback

**Status: done**

**Severity: low (reliability).** CE L2, L3 — verified.

- **L2 — `onReadOnlyShutdown` dropped if `host.teardown()` throws.** In `executeWithAttach`'s `readOnly`
  branch (`src/cli/commands/execute-with-attach.ts:191-192`), `await opts.host.teardown()` runs **before**
  `onReadOnlyShutdown(reason)`. If teardown throws (tmux socket gone mid-command — a documented failure
  mode), the callback never fires; `openFailedView`'s captured `action` stays `undefined`, the loop treats a
  decided `[r]`/`[c]` as `dismissed`, and the command exits non-zero. Fix: capture `reason` and invoke
  `onReadOnlyShutdown(reason)` **before** teardown (or otherwise so a teardown failure cannot discard an
  already-decided action). Logger close stays in the caller's `finally` — no leak either way.
- **L3 — `findResumableRun` crashes bare `orch resume` on a corrupt recent run.**
  `src/cli/commands/resume.ts` `findResumableRun` calls `deps.stateStore.loadRun(rid)` with no try/catch, so
  a `StateCorruptionError` on any recent run aborts bare `orch resume` before it reaches the new
  finished-run fallback. Its new sibling `findNewestFinishedRunId` deliberately catches and skips
  `StateCorruptionError`; the asymmetry means one corrupt recent run silently defeats the D5 fallback. Fix:
  mirror the corruption-skip (catch `StateCorruptionError`, `continue`).

**Regression tests.**
- L2: unit/integration where the read-only `host.teardown()` is scripted to throw after an action intent;
  assert the captured action survives (the loop still acts on `[r]`/`[c]`), not silently `dismissed`.
- L3: integration on bare `orch resume` with a corrupt most-recent run plus a valid finished run; assert the
  corrupt run is skipped and the finished-run fallback is still offered (mirrors the existing
  `findNewestFinishedRunId` corruption-skip coverage).

---

## Group 6 — Test rigor: prove routing/rendering, not stderr substrings

**Status: done**

**Severity: low–medium (coverage accuracy — closes blind spots, no product code change).** CE H1, H2 — verified.

These tests pass today for weaker reasons than their AT claims; they should assert the behavior, not an
implementation detail, so a real regression is caught.

- **H1 — AT-1 "opens in the read-only viewer" is proven only by an stderr substring.** The AT-1/AT-6
  completed-open test (`tests/integration/cli/commands/resume-finished.test.ts`) asserts `stderr` contains
  `'read-only view'` — the literal `process.stderr.write('… read-only view…')` at
  `src/cli/commands/open-finished.ts:435`. That proves only the routing **branch** was entered; a viewer
  that rendered nothing would still pass. Fix: rename it a **routing** test and assert
  `host.attachedForeground()` (as `open-finished.test.ts` already does) instead of the stderr literal, so it
  survives a copy change. Keep the rendered-view assertion in the gated real-tmux test the Notes already
  point to; reflect the split in the AT-1 status row rather than a bare `✅`.
- **H2 — AT-R10 "a later `orch resume` re-routes to the right view" is bypassed by calling leaf commands
  directly.** The AT-R10 tests (`open-failed.test.ts` ~`:699`/`:644`, `retry.test.ts` ~`:1517`) re-invoke the
  leaf command with a hand-passed `status`, bypassing the thing AT-R10 protects: that a subsequent
  `resumeCmd` **re-loads** the now-`completed` state and re-routes it to `openFinished` (not
  `openFailed`/re-run). Fix: add one cheap test (no real tmux) that, after the `[c]`/`retryRun` completion,
  calls `resumeCmd(deps, FAILED_ID, {}, TWO_PANE_OPTS, VIEWER_HOST_FACTORY)` and asserts it took the
  read-only branch (stderr `(completed) … read-only view`, runner untouched).

These pair naturally with Group 1's strengthened AT-R10a assertion (all three are "assert the projected
view, not a proxy").

---

## Not selected (recorded as issues)

Findings that change scope, contradict the contract, or are deferred-by-design are written up individually
under [`issues/`](issues/):

- **Manual retry does not deliver the retry instruction on the first attempt** (Codex F1 / CE M6, HIGH) —
  real, but matches the documented 🟡-partial AT-R5 / gated real-CLI status; completing it is net-new
  executor work. → [`issues/manual-retry-instruction-not-delivered.md`](issues/manual-retry-instruction-not-delivered.md)
- **`resume <failed>` can't show the failure if the workflow no longer loads** (Codex F4) — splitting
  view-from-act is a design change beyond U6's "load once" shape. → [`issues/failed-view-requires-workflow-load.md`](issues/failed-view-requires-workflow-load.md)
- **Single-step retry can run multiple branches in heterogeneous `parallel([run(...)])`** (Codex F5) — the
  end-outcome matches KTD-7's whole-block intent, but the mechanism is an unverified race and the code
  comment is wrong. → [`issues/heterogeneous-parallel-retry-granularity.md`](issues/heterogeneous-parallel-retry-granularity.md)
- **Observation-guarantee tests assert structural absence, not behavior** (CE M4 + M7) — re-scoping the
  "no logs / no cmux" guarantee needs a reword-vs-gate decision. → [`issues/observation-guarantee-tests-assert-structure.md`](issues/observation-guarantee-tests-assert-structure.md)
- **Host-construction block duplicated 4×, driving the over-length files** (CE M5) — real drift hazard;
  a pure refactor deferred to keep this pass correctness-focused. → [`issues/host-construction-duplication.md`](issues/host-construction-duplication.md)
- **Single-step park assumes the failed step is the first non-cache-hit step** (CE L5, stale-`ask` edge). →
  [`issues/single-step-park-stale-ask-assumption.md`](issues/single-step-park-stale-ask-assumption.md)
- **Forward-scaffolding exported through the public barrel with no consumer** (CE L7). →
  [`issues/recovery-instructions-barrel-surface.md`](issues/recovery-instructions-barrel-surface.md)
- **`makeConfirmSpy` asserts against a service the headless-retry path never consults** (CE L8). →
  [`issues/confirm-spy-asserts-unreachable-service.md`](issues/confirm-spy-asserts-unreachable-service.md)
- **Host-fake duplication across four test files** (CE L9). →
  [`issues/host-fake-test-duplication.md`](issues/host-fake-test-duplication.md)
