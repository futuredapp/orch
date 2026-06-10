# Code Review — Codex

Scope reviewed: current branch diff from `main` (`8d76881`) through `HEAD`, with emphasis on the resume/retry feature contract in `docs/sessions/resume-completed-session/brainstorm.md` and `docs/sessions/resume-completed-session/acceptance-tests.md`.

Targeted verification run:

```sh
bun test tests/integration/cli/commands/open-failed.test.ts tests/integration/cli/commands/retry.test.ts tests/model/failure-actions--retry-keymap.test.tsx
```

Result: 23 pass, 0 fail. The findings below are gaps those tests do not currently cover.

## Finding 1 — Manual retry/continue does not deliver the retry instruction to the retried agent

**Severity:** high

**File:line:** `src/core/workflow.ts:1206` (autonomous prompt construction), `src/core/workflow.ts:784` (interactive prompt construction), `src/core/workflow.ts:1518` (resolver only used inside autonomous recovery fork)

**Description:** The new manual retry paths pass an `instructionResolver` into `WorkflowDeps`, but the actual first re-run of the failed step still uses the original step prompt. `produceAgentStep()` builds `runnerCtx.prompt` from `assemblePrompt(config.prompt, overrides, key)`, and `produceInteractiveStep()` does the same. The only place `deps.instructionResolver` is read is `buildRecoveryCommand()`, which runs later only if that retried autonomous attempt itself enters the recovery loop.

**Rationale:** The acceptance contract requires `[r]`, `[c]`, and `orch retry` to tell the agent it is retrying/continuing using the configured/default instruction source (D7, AT-R5, AT-R8). In the normal successful retry case, the agent receives no retry/continue nudge at all. It also does not resume/fork from the prior failed session for the manual retry attempt; it starts from the standard step execution path with the original prompt. This is especially visible for `orch retry <failed-id>`: `retry.ts` injects `defaultInstructionResolver`, but the resolver is not consulted before the failed step is re-run.

**Suggested fix:** Thread explicit manual retry context into the executor, including `kind: 'retry' | 'continue'` and the previous failed step/session metadata. When the failed step is the one being re-driven, build the first attempt from the configured instruction:

- Prefer runner `forkResumeCommand` / `resumeCommand` with the prior step session/checkpoint id and `instructionResolver(kind)` where available.
- Define a fallback for runners without resume support, such as appending or otherwise composing the retry instruction into the prompt, so AT-R5 is still testable.
- Use `kind: 'retry'` for `[r]` and `kind: 'continue'` for `[c]` / `orch retry`; do not route both through the autonomous recovery-only `buildRecoveryCommand()` path.
- Add prompt/command-recording tests for `[r]`, `[c]`, and `orch retry` that fail if the retried runner sees only the original step prompt.

## Finding 2 — A run parked after successful `[r]` projects as completed, so the user loses the continue action

**Severity:** high

**File:line:** `src/hosts/two-pane/steps-view/project-steps-view.ts:294`

**Description:** `finalizeView()` returns a failed `StepsViewState` only when `summary.stepsFailed > 0`. After `[r]` succeeds, the implementation intentionally leaves the run status as `failed` while saving the previously failed step as a successful `StepEntry` and leaving later steps unrun. In that parked state there are no failed step rows, so the projector returns `{ status: 'completed', ... }` even though `run.status === 'failed'`.

**Rationale:** AT-R1 and AT-R10a require the run to stay parked in the interactive failed view after a successful retry-only action, with continue still available. But `StepsView` enables `[r]`/`[c]` only when `state.status === 'failed'`. The reopened view after a successful `[r]` therefore renders as completed/read-only and does not expose `[c]`, breaking the retry-then-continue workflow.

**Suggested fix:** Make terminal projection honor the persisted run status first. For example, in `finalizeView()`, return `status: 'failed'` whenever `runStatus === 'failed'`, regardless of `summary.stepsFailed`. Keep `summary.stepsFailed` as an informational count; it can legitimately be `0` for the parked-after-retry state. Add a projector/component regression test with `RunState.status === 'failed'`, the retried step saved successfully, and later steps absent, asserting the projected state is `failed` and the footer exposes retry/continue when actions are enabled.

## Finding 3 — Retry actions are treated as an unexpected TUI crash by the steps-view parent

**Severity:** medium

**File:line:** `src/hosts/two-pane/steps-view/start-steps-view.ts:160`

**Description:** The Ink child intentionally exits after `retry` and `retry-continue` intents (`steps-view-runner.tsx` treats them like `quit`), but the parent-side `startStepsView()` only sets `stopped = true` for `quit`. When the child exits after a retry action, the `childExitPromise` branch still sees `stopped === false` and records `tui-crashed`, then writes `TUI unavailable — detach + reattach to retry, run continues` to the left pane.

**Rationale:** `[r]` and `[c]` are expected control-flow outcomes, not TUI crashes. The false crash log and possible left-pane message make the retry path look broken at exactly the moment the CLI should be acting on the user's choice. This also pollutes lifecycle logs used for debugging and acceptance verification.

**Suggested fix:** Treat retry intents as planned stops in `startStepsView()`:

```ts
if (
  parsed.data.type === 'quit' ||
  parsed.data.type === 'retry' ||
  parsed.data.type === 'retry-continue'
) {
  stopped = true
}
```

Add a parent-side test that emits `retry` / `retry-continue`, lets the child `runInteractive()` resolve, and asserts no `tui-crashed` lifecycle entry and no TUI-unavailable pane write occur.

## Finding 4 — `resume <failed>` cannot show the failure if the workflow no longer loads

**Severity:** medium

**File:line:** `src/cli/commands/open-failed.ts:81`

**Description:** `openFailed()` loads the workflow before mounting the failed-run viewer. If the workflow file was renamed, deleted, or its config is temporarily invalid, `orch resume <failed-id>` exits with the load error and never shows the saved failure view.

**Rationale:** The accepted behavior is "see the failure first, then choose" for `orch resume <failed-id>` (D3 / AT-2). Pure observation of an existing failed run should be possible from persisted state in the same way completed read-only viewing is possible without loading the workflow. Loading is required to act, but not to inspect or quit.

**Suggested fix:** Split failed viewing from failed acting. Open the failed viewer first using only persisted state. Lazily load the workflow only after the user presses `[r]` or `[c]`; if loading fails then, surface the error and either return to the failed view with actions still available or exit with a clear non-zero error. Add a regression test where the failed `state.json` exists but `loadWorkflow()` fails; `resume <failed>` should still render/quit without mutation.

## Finding 5 — Single-step retry can execute more than one branch in heterogeneous `parallel([run(...)])`

**Severity:** medium

**File:line:** `src/core/workflow.ts:1824`, `src/core/parallel.ts:119`

**Description:** The single-step retry guard parks only at the start of `runStepOnce()` when `realStepRan.current` is already true and `!isInsideParallel()`. In the heterogeneous `parallel([run(A), run(B)])` form, the `run()` calls are started before `parallelHeterogeneous()` can establish any branch context, so they are not `insideParallel`. Multiple uncached branches can all pass the park check before any one of them flips `realStepRan.current`, then execute concurrently.

**Rationale:** The plan resolves parallel retry granularity as "same as resume" / whole-block behavior, and AT-R1 says `[r]` re-invokes exactly the failed step before parking. With heterogeneous parallel runs, `[r]` can re-run multiple failed/missing branches in one retry action. That is surprising mutation for a command whose core safety property is "one step then park."

**Suggested fix:** Add retry-aware parallel handling instead of relying only on `isInsideParallel()`. Options include making heterogeneous `parallel()` wrap branch execution in a parallel execution context before `runStepOnce()` starts, or introducing a block-level retry claim so the whole current parallel block is deliberately retried and no unrelated later top-level steps can start. Add integration coverage for a failed heterogeneous parallel block with two failed branches to pin the intended granularity.
