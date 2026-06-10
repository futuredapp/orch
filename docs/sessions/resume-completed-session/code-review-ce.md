# Code Review (ce) — Re-open a finished run from the CLI (`resume` + `retry`)

**Branch:** `workflow+resume+completed` · **Base:** `8d76881` (merge-base with `main`)
**Reviewed:** the feature diff only — `orch resume` read-only/interactive re-entry, the new
`orch retry` verb, the single-step retry primitive in the executor, and the host→CLI action
channel. Pre-existing unrelated code was not flagged.
**Mode:** multi-agent (correctness · reliability/async · standards+maintainability · testing),
merged and deduplicated.

**Verdict: Ready with fixes.** No P0s, no blocker. The implementation is faithful to the
acceptance contract (brainstorm D1–D8, the AT-* sidecar): the single-step park logic, error
classification, no-TTY refusal, pure-open guarantees, and bare-resume fallback are all correct.
The findings are one barrel-rule violation, real duplication, a few comment-accuracy bugs, two
test-rigor gaps where the status table reads stronger than the diff proves, and a couple of
acknowledged-partial intent gaps (AT-R5).

Repo-relative paths and `file:line` throughout. Line numbers are against the working tree.

---

## P1 / High

### H1 — AT-1 "opens in the read-only viewer" is proven only by an stderr substring, not a rendered view
- **`tests/integration/cli/commands/resume-finished.test.ts`** (the AT-1/AT-6 completed-open test)
- **Problem:** The test asserts `code === EXIT.OK` and `stderr` contains `'read-only view'`. That
  substring is the literal `process.stderr.write('Opening run … in read-only view...')` in
  `src/cli/commands/open-finished.ts:435`. So the assertion proves only that the
  `completed → openFinished` *branch was entered* — it would still pass if the viewer rendered
  nothing. AT-1's claim is a rendering claim ("the view is shown … rather than any error").
- **Why it matters:** The status table marks AT-1 `✅ implemented` against this routing test, which
  overstates what is proven at this layer. A viewer regression (no-op render) would not be caught.
- **Fix:** Rename this to a routing test ("routes a completed run into the read-only open path"),
  and assert `host.attachedForeground()` (as `open-finished.test.ts` already does) instead of the
  stderr literal so it survives a copy change. Keep the rendered-view assertion in the gated
  real-tmux test the Notes already point to, and make the AT-1 row reflect the split rather than a
  bare `✅`.

### H2 — AT-R10 "a later `orch resume` re-routes to the right view" is bypassed by calling leaf commands directly
- **`tests/integration/cli/commands/open-failed.test.ts`** (AT-R10 ~`:699`, AT-R10a ~`:644`),
  **`tests/integration/cli/commands/retry.test.ts`** (AT-R10 cross-verb ~`:1517`)
- **Problem:** AT-R10's behavior is "a *subsequent `orch resume <same-id>`* opens in the view
  matching its now-current status." The tests instead re-invoke the leaf command directly with a
  hand-passed `status` (e.g. `retry.test.ts:1543`, `open-failed.test.ts:736`), which bypasses the
  thing AT-R10 protects: that `resumeCmd` re-loads the now-`completed` state and *re-routes* it to
  `openFinished` rather than `openFailed`/re-run. The "loads cleanly / re-runs nothing" half is
  genuinely proven; the "routes to the correct view" half is decided by the test author.
- **Why it matters:** The status table is honest (🟡 partial, "real-`orch resume` prefix routing
  gated, pending"), so this is coverage-accuracy rather than a false `✅`. But test names like "a
  later read-only reopen loads cleanly" imply routing-after-retry is covered when it is not.
- **Fix:** Add one cheap test (no real tmux) that, after the `[c]`/`retryRun` completion, calls
  `resumeCmd(deps, FAILED_ID, {}, TWO_PANE_OPTS, VIEWER_HOST_FACTORY)` and asserts it took the
  read-only branch (stderr `(completed) … read-only view`, runner untouched).

---

## P2 / Medium

### M1 — Barrel violation: `WorkflowDeps` imported from `core/workflow.ts` instead of the `core/index.ts` barrel
- **`src/cli/commands/open-failed.ts:38`**, **`src/cli/commands/resume-execution.ts:31`**
- **Problem:** Both do `import type { WorkflowDeps } from '../../core/workflow.ts'`. CLAUDE.md
  rule 7 requires cross-module imports go through `src/<module>/index.ts`. Verified `WorkflowDeps`
  *is* exported from `src/core/index.ts:151`, so the direct-internal import is avoidable. (Contrast
  `load-workflow.ts` importing `bodyHandle`, which is deliberately module-private and legitimately
  not on the barrel.)
- **Why it matters:** Non-negotiable rule. Both files already import other symbols from
  `../../core/index.ts`, so the violation is gratuitous. (Note: the anti-pattern is pre-existing
  and widespread — `src/cli/commands/run.ts:10`, several host files — but new code should not add
  to it.)
- **Fix:** Move `WorkflowDeps` into the existing `../../core/index.ts` import in both files.
  Optionally file a follow-up under `docs/sessions/resume-completed-session/issues/` for the
  pre-existing offenders.

### M2 — `host-registry.ts` doc-comment names the wrong file for `enableFailureActions`
- **`src/hosts/host-registry.ts:71`**
- **Problem:** Comment says the flag is *"Set only by the CLI re-entry `failed` open
  (`open-finished`)"*. Verified: `enableFailureActions: true` is set in
  **`src/cli/commands/open-failed.ts:170`**, never in `open-finished.ts` (the read-only completed
  view, which intentionally never enables actions).
- **Why it matters:** Actively misleading — `open-finished` is precisely the path that must *not*
  enable retry/continue. A maintainer trusting the comment could wire actions into the wrong open.
- **Fix:** Change `(open-finished)` → `(open-failed)`. (The analogous comments in
  `tmux-host.ts` and `start-steps-view.ts` say "the CLI re-entry `failed` open" without naming a
  file and are correct — only this parenthetical is wrong.)

### M3 — `[r]` single-step retry executes invisibly: the host is built but never attached to the foreground
- **`src/cli/commands/open-failed.ts:310-389`** (`runSingleStepRetry`)
  *(raised independently by the correctness and reliability reviewers)*
- **Problem:** `runSingleStepRetry` builds a full two-pane host via `hostFactory`, calls
  `loaded.executor.retryStep(wfDeps)` **directly**, then `host.teardown()` — it never goes through
  `executeWithAttach`/`attachForeground`. The `tmux attach-session` only happens in
  `attachForeground`, so the `[r]` retry runs in a *detached* session: the user presses `[r]`, the
  viewer pane unmounts, the step re-executes with nothing on screen, then the loop reopens a fresh
  read-only viewer showing the result. Contrast `[c]` (`runResumeExecution`) and `orch retry`,
  which both attach and are visible. Resource-wise this is **safe** — `wrappedTeardown` fully reaps
  the session/child/steps-view idempotently, no tmux/pane/child leak.
- **Why it matters:** Behavioral/UX, not a leak. AT-R1 only asserts the runner boundary + the
  reopened view, so the contract passes — but "press r, screen goes blank while a possibly-long
  (and possibly *interactive*) agent step runs unwatched, then a new view appears" is likely not
  the intent, and there is no cancel/feedback surface mid-step. An interactive retried step would
  `runInteractive` into panes no human is attached to.
- **Fix:** Confirm the headless-then-reopen design is intentional. If a visible retry is wanted,
  route `runSingleStepRetry` through `executeWithAttach` (workflow = `retryStep(...)`,
  `readOnly: false`, no cmux, no `beforeTeardown`) so the user watches the retry. If intentional,
  add a comment stating `[r]` runs detached by design.

### M4 — AT-17 "no new run logs" is verified only against a non-logging fake/null logger, not the real host
- **`tests/integration/cli/commands/open-finished.test.ts`** (AT-17 cases) +
  **`src/cli/commands/open-finished.ts:440`** + **`src/hosts/two-pane/tmux-host.ts`** (construct/teardown lifecycle appends)
- **Problem:** AT-17's observable surface is "a before/after read of the run's `logs/`". The test
  injects a null/spy logger and asserts `appends === [] && writes === []`. Because the logger is
  null, nothing reaches disk regardless of intent, and `logs/` is never compared before/after. In
  production the host factory wires a real `FileSessionLogger`, and `createTmuxHost` appends
  `host-created`/`tmux-session-created`/`pane-created` (and teardown counterparts) to
  `logs/lifecycle.ndjson` + `logs/timeline.ndjson`. So a real `openFinished` pure open is **not**
  byte-for-byte log-silent — host bookkeeping still writes.
- **Why it matters:** The guarantee that actually holds is the narrower (and defensible) "the
  *orchestration layer* writes no `run:resumed`/`run.meta.json`/execution logs" — host lifecycle
  bookkeeping is not execution. But the status table's "✅ … zero logger writes" overstates it, and
  the test would not catch a regression that swapped in a real logger touching `logs/`. AT-14
  (`state.json`) *is* asserted byte-for-byte against the real file — good; only the `logs/` half is
  weak.
- **Fix:** Pick one: (a) reword AT-17's claim to "no execution/resume logs" and document that host
  bookkeeping still appends; or (b) if true log-silence is the contract, gate the host
  construction/teardown lifecycle appends behind a `readOnly`/`pureOpen` flag. At minimum add one
  assertion (real `FileSessionLogger`, `readdir(logs/)` + bytes before/after) that distinguishes
  "no execution logs" from "no logs at all."

### M5 — Host-construction block duplicated 4× (drives the over-length functions)
- **`src/cli/commands/open-finished.ts`**, **`open-failed.ts`** (`openFailedView` + `runSingleStepRetry`), **`resume-execution.ts`** (`runResumeExecution`)
- **Problem:** The `hostFactory({ runId, workflowName, stdout, stderr, clock, logger,
  processService, fs, stateStore, resumeRegistry, … })` call plus its `catch (HostCreationError) →
  CONFIG_ERROR` handler is repeated verbatim in four places; the only real variation is
  `enableFailureActions: true` in `openFailedView`. The `wfDeps: WorkflowDeps` literal is also
  duplicated between `runSingleStepRetry` and `runResumeExecution` (deltas: `host` vs
  `compositeHost`, `args`, the `instructionResolver` spread).
- **Why it matters:** Four copies is a real drift hazard and is what pushes `open-failed.ts` to
  308 lines (> 300 cap) and `runResumeExecution`/`runSingleStepRetry` past the 60-line function
  guideline — none of which carry the explaining comment CLAUDE.md rule 5 asks for. This is
  shared-by-3+ duplication, not premature abstraction.
- **Fix:** Extract `buildHostOrConfigError(deps, { targetId, workflowName, logger, processService,
  resumeRegistry, enableFailureActions? }): Promise<Host | number>` and a `buildWfDeps(...)`
  factory. This also brings the files/functions back under the size limits.

### M6 — AT-R5 / D7: the first manual re-attempt does not tell the agent it is a retry
- **`src/core/workflow.ts`** (`runStepOnce` real-execution path, ~`:1899-1905`),
  **`src/cli/commands/open-failed.ts:372`**, **`resume-execution.ts:737`**
- **Problem:** A manual `[r]`/`[c]`/`orch retry` re-run of the failed step is a cache miss, so it
  executes as a fresh step with the **original prompt**. The `instructionResolver` (and the
  fork/`checkpointSessionId` session-resume) are consumed only inside `buildRecoveryCommand` /
  the recovery loop — i.e. they fire only if the step has a recovery strategy *and* the first
  re-attempt also fails. So on the first manual re-attempt the agent is not told a prior attempt
  failed and the prior session is not forked. Both `InstructionKind`s also currently resolve to the
  same `'continue'` string, so `kind` is presently a no-op.
- **Why it matters:** AT-R5/D7 require the agent to "receive the configured retry/continue
  instruction … and … the prior failed session is resumed/forked." The resolver is threaded
  through `WorkflowDeps` but is inert for the first manual re-attempt — the wiring as built cannot
  satisfy AT-R5 without further work. This is consistent with the `🟡 partial` status, but the
  *mechanism* gap (re-run uses the original prompt, resolver reaches only the recovery loop) should
  be explicit so it is not mistaken for "wired, just untested."
- **Fix:** When a manual retry re-runs the failed step, build the initial command via the
  fork/resume primitive with the resolved instruction (the path the recovery loop uses), rather
  than re-issuing the original prompt — or document explicitly that AT-R5 is deferred to the
  sibling feature and the resolver is currently inert on the first attempt.

### M7 — AT-15/AT-16 (no lifecycle events / no cmux side effects) assert structural absence, not behavior
- **`tests/integration/cli/commands/open-finished.test.ts`** (AT-15/16 cases)
- **Problem:** The tests assert `logger.appends === []` (no `run:resumed`) and `fps.cmuxCalls() ===
  []` (no `cmux` subprocess). Because `openFinished` structurally installs no cmux host, an empty
  `cmuxCalls()` is nearly tautological — it asserts the implementation shape (no cmux subprocess)
  rather than the behavior (no pill cleared/changed, no notification fired). Verified the no-cmux
  design is correct, so the tests pass for the right reason today.
- **Why it matters:** "Would this still pass if the pill were wrongly cleared?" — only if clearing
  the pill happens to spawn `cmux`. Adequate given the design, but brittle to the `argv[0] ===
  'cmux'` convention.
- **Fix:** Acceptable as-is; strengthen the comment to state *why* it suffices (no cmux host is
  constructed). If a fake cmux surface that records pill transitions exists, prefer asserting zero
  pill transitions over zero subprocesses.

---

## P3 / Low

### L1 — `RetryStepResult` is a public return type but missing from the `core/index.ts` barrel
- **`src/core/workflow.ts`** (exports `RetryStepResult`) / **`src/core/index.ts`**
- **Problem:** `retryStep` is on the barrel-exported `WorkflowExecutor` interface, but its result
  type `RetryStepResult` is not re-exported from `core/index.ts`. Latent (today's only consumer
  discards the result), not a live break.
- **Fix:** Add `RetryStepResult` to the `export type { … } from './workflow.ts'` block in
  `src/core/index.ts`.

### L2 — `onReadOnlyShutdown` action is dropped if `host.teardown()` throws
- **`src/cli/commands/execute-with-attach.ts:191-192`**
- **Problem:** In the `readOnly` branch, `await opts.host.teardown()` runs *before*
  `onReadOnlyShutdown(reason)`. If teardown throws (e.g. tmux socket gone mid-command — a
  documented failure mode), the callback never fires; the throw propagates to the crash handler and
  returns `STEP_FAILURE`, while `openFailedView`'s captured `action` stays `undefined` and the loop
  treats it as `dismissed`. The user's `[r]`/`[c]` intent is silently lost and the command exits
  non-zero. Logger is still closed by the caller's `finally` — no leak.
- **Fix:** Capture `reason` and invoke `onReadOnlyShutdown(reason)` before teardown, or in a way
  that a teardown failure cannot discard an already-decided action.

### L3 — `findResumableRun` crashes bare `orch resume` on a corrupt run in the scan window
- **`src/cli/commands/resume.ts`** (`findResumableRun`, top of file)
- **Problem:** `findResumableRun` calls `deps.stateStore.loadRun(rid)` with no try/catch, so a
  `StateCorruptionError` on any of the most-recent runs aborts bare `orch resume` before it reaches
  the new finished-run fallback. The new sibling `findNewestFinishedRunId` deliberately catches and
  skips `StateCorruptionError`. The asymmetry means one corrupt recent run silently defeats the new
  D5 fallback. Pre-existing behavior, but newly adjacent and newly consequential.
- **Fix:** Mirror the corruption-skip in `findResumableRun` (catch `StateCorruptionError`,
  `continue`).

### L4 — Read-only/finished open refuses on `--mode=plain` even with a real TTY (misleading message)
- **`src/cli/commands/resume.ts`** (the `opts.mode !== 'two-pane'` guard, ~`:127`)
- **Problem:** The refusal fires whenever `opts.mode !== 'two-pane'`, which also triggers when a
  user on a real TTY passes `--mode=plain` (or has a plain default). The message then says "no TTY
  / tmux unavailable," which is inaccurate in that case. The exit code (`CONFIG_ERROR`, not
  `CANNOT_RESUME`) is correct and satisfies AT-6/AT-20.
- **Fix:** Soften the copy, e.g. "requires two-pane mode (got mode=plain / no TTY / tmux
  unavailable)."

### L5 — Single-step park assumes the failed step is the first non-cache-hit step (stale-`ask` edge)
- **`src/core/workflow.ts:1824-1826` + ~`:1905`**
- **Problem:** The park fires once `realStepRan` flips on the first *real* (non-cache) execution.
  In a normal `failed` run every prior step is cached-ok, so the first real run is the failed step
  — correct. The one way `realStepRan` could flip earlier is a **stale `ask`** entry
  (`isAskCacheValid` false) from editing the workflow's ask buttons/fields between the original run
  and the retry: the stale ask re-runs, flips `realStepRan`, and the actually-failed step parks
  before re-running — so `[r]` "retries" the wrong step. Requires editing the workflow between run
  and retry, contradicting the AT-R10 coherent-replay precondition; low likelihood.
- **Fix:** Add a guard or at least a comment: single-step park assumes the failed step is the first
  non-cache-hit step.

### L6 — Dangling/misplaced comment in `open-finished.ts`
- **`src/cli/commands/open-finished.ts`** (~`:441-443`)
- **Problem:** The comment "The raw (un-instrumented) process service: the read-only open spawns
  only tmux…" sits directly above `const resumeRegistry = createResumeRegistry()`; the
  `processService: deps.processService` it explains is ~8 lines down inside the `hostFactory({…})`
  call. Reads as leftover from an earlier edit.
- **Fix:** Move the comment to the `processService: deps.processService` line, or reword as a
  top-of-`try` note.

### L7 — Forward-scaffolding exported through the public barrel with no consumer
- **`src/core/recovery/instructions.ts`** → re-exported via `recovery/index.ts` and `core/index.ts`
- **Problem:** `resolveInstruction`, `ConfiguredInstructions`, and `InstructionKind` have no
  non-test consumer in `src/` (only `defaultInstructionResolver` and the `InstructionResolver` type
  are used). The module comment says this is intentional scaffolding for the sibling feature — so
  *not* accidental dead code, but it grows the public API surface ahead of need.
- **Fix (optional):** Keep `instructions.ts` as the seam but hold the unused symbols in the
  `recovery` barrel only, not `core/index.ts`, until the sibling lands. Low priority given the
  explicit design note.

### L8 — `makeConfirmSpy` asserts against a service the headless-retry path never consults
- **`tests/integration/cli/commands/retry.test.ts`** (~`:1363`, used ~`:1489`)
- **Problem:** AT-R8 asserts `confirm.calls() === 0`, but `retryRun → runResumeExecution` never
  references `deps.confirmService`, so the spy counts calls to a service the path structurally
  cannot reach. The test would pass identically with a plain `FakeConfirmService` (which throws on
  unscripted `confirm`). Lower-signal, not wrong.
- **Fix:** Drop the spy and rely on the throw-on-unscripted default, or adjust the comment to "no
  ConfirmService is consulted on the headless retry path."

### L9 — Host-fake duplication across four test files
- **`resume-finished.test.ts`**, **`bare-resume-fallback.test.ts`**, **`open-finished.test.ts`**
  (vs the shared `@orch/test/fake-host.ts` already used by `open-failed.test.ts` / `retry.test.ts`)
- **Problem:** Three files hand-roll the full `Host` interface inline while two newer files build
  on `createFakeHost`. When `Host` gains a method, the inline literals break in lockstep and drift.
- **Fix:** Migrate the three onto `createFakeHost({ mode: 'two-pane' })` plus the small
  `awaitForegroundShutdown`/spy overrides they actually need.

---

## Verified correct (no action — recorded so the next reviewer can skip)

- **Single-step park / parallel granularity:** park is suppressed via `!insideParallel`, so a
  failed parallel block re-runs at whole-block granularity (cached branches replay) then parks on
  the next top-level step — matches `resume` (KTD-7). Zero-steps / failed-step-is-last handled by
  the `if (singleStep) return` success path (no `run:ended`, status stays `failed`).
- **`retryStep` catch classification:** `StepError | ValidationError | SchemaValidationError |
  ParallelError → failed-again`, else rethrow — identical to `executeWorkflowFn`'s normal
  `isStepLevelFailure` set (including the intentional exclusion of `InteractiveParallelError` /
  `AskParallelError`, which are author-bug crashes in both paths). Consistent.
- **`runSingleStepRetry` ignoring `RetryStepResult` and returning `EXIT.OK`:** correct — both
  `retried-ok` and `failed-again` should reopen the view; only a genuine rethrown crash maps to a
  non-OK code and stops the loop.
- **`findNewestFinishedRunId` `.slice(-SCAN_CAP).reverse()`:** `listRuns` is chronological
  ascending, so last-50-reversed is newest-first. Correct.
- **No-TTY `orch retry` doesn't block:** routes through `runResumeExecution → executeWithAttach`;
  plain-mode `awaitForegroundShutdown` resolves immediately and the real exit code comes from
  `await trackedWorkflow` (AT-R8).
- **Pure open (D6):** `openFinished` / `openFailedView` install no cmux host, no `beforeTeardown`,
  and `readOnly: true` skips the workflow race, summary, and run-end. `fireRunEnd` is
  `runEndFired`-guarded so `[c]` can't double-fire. Only `resume-execution.ts` constructs a cmux
  host, so an un-actioned open and a `[r]` retry fire zero pill/notify side effects.
- **`composedIntent` / steps-view-runner double-resolve:** `shutdownDeferred` is a single-writer
  tagged deferred (`if (resolved) return`); the runner's `resolveExit` is `!resolved`-gated. A
  `[r]`-then-`q` resolves exactly once. No double-resolve, no double-unmount.
- **Logger lifecycle across the `openFailed` loop:** each `openFailedView` / `runSingleStepRetry`
  gets a fresh `sessionLoggerFor(targetId)` closed in its own `finally`; `FileSessionLogger` holds
  no eager fd and serializes per-category writes, so overlapping open/close against the same run
  dir is race-free; `close()` on a never-written logger is a no-op flush.
- **`runSingleStepRetry` teardown without attach:** `wrappedTeardown` stops the controller +
  steps-view child, then kills session + server, all idempotent — no tmux/pane/child leak even
  though the host is never attached (the *behavioral* concern is M3, not a resource leak).
- **Stale in-memory `state` threaded through `openFailed`:** read only for `state.args` /
  `state.startedAt` (neither mutates across retries); `resume()` / `retryStep()` reload + re-validate
  fresh from disk. Benign.
- **CLAUDE.md rules 1, 2, 6, 8, 9:** no `child_process`/`Bun.spawn`/`node-pty` outside
  `src/services/process/`; new core code imports no concrete runner; no `any` / no `!`; no
  module-import side effects; paths use the branded `Path` type.
- **Docs reconciliation:** `docs/public/reference/cli.md` is thoroughly updated for `retry` and the
  new resume behavior. The `feature:` entry added to `orch.config.ts` is a project-local workflow
  under `workflows/`, not a `src/index.ts` public-barrel change, so `api.md`/`runners.md` need no
  reconciliation.
- **Banned mocks / mock-only-at-the-edge:** no `mock.module`/`vi.mock`/`jest.mock` in any new or
  changed test; fakes enter via `*Service` ports / `FakeRunner` / `HostFactory`. The strongest
  pure-open claims that *are* well-asserted: AT-R4 (`open-failed.test.ts` reads `state.json` before,
  scripts a quit, asserts byte-for-byte equality + `runnerTouched() === false`) and AT-14
  (`open-finished.test.ts` byte-for-byte `state.json`).

---

## Scope note

The new `workflows/feature/*` files (the compound-engineering pipeline that orchestrated this
session, incl. `workflows/feature/index.ts`, 405 lines) are present in the diff but are pipeline
scaffolding orthogonal to the resume/retry feature under review; they were not audited in depth.
If a dedicated review of that workflow definition is wanted, run it separately.

## Suggested fix order

1. **M2** wrong-file comment (`host-registry.ts:71`) — actively misleading, one-word fix.
2. **M1** barrel import of `WorkflowDeps` — real rule violation, two-line fix.
3. **M5** extract the 4× host-construction duplication — also clears the size-limit warnings (M5
   subsumes the file/function-length issue).
4. **H1 / H2 / M4** test-rigor gaps — add the cheap routing/real-logger assertions and align the
   status table so `✅` matches what the diff proves.
5. **M3 / M6** decide-and-document the `[r]` detached-execution and AT-R5 first-attempt-instruction
   intents (fix or annotate).
6. L1–L9 at discretion.
