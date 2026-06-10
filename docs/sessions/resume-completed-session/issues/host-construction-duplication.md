# Host-construction block duplicated 4×, driving the over-length files/functions

**Source:** CE M5 (MEDIUM). Verified against the code.
**Status:** Not a fix in this pass — a pure refactor deferred to keep this review pass correctness-focused.

## What the issue is

The `hostFactory({ runId, workflowName, stdout, stderr, clock, logger, processService, fs, stateStore,
resumeRegistry, … })` call plus its `catch (HostCreationError) → CONFIG_ERROR` handler is repeated verbatim
in four places; the only real variation is `enableFailureActions: true` in the failed-view open. The
`wfDeps: WorkflowDeps` literal is also duplicated between the two retry/continue paths.

## Where it is

- `src/cli/commands/open-finished.ts` (read-only completed open)
- `src/cli/commands/open-failed.ts` — `openFailedView` (`:155-178`) **and** `runSingleStepRetry` (`:241-261`)
- `src/cli/commands/resume-execution.ts` — `runResumeExecution` (`:182-202`)

The `wfDeps` literal is duplicated between `runSingleStepRetry` (`open-failed.ts:269-288`) and
`runResumeExecution` (`resume-execution.ts:221-240`); deltas are `host` vs `compositeHost`, `args`, and the
`instructionResolver` spread.

## Why it matters

Four copies is a real drift hazard (e.g. a new required `HostFactoryInputs` field must be added in four
places), and it is what pushes `open-failed.ts` past the 300-line file cap and
`runResumeExecution`/`runSingleStepRetry` past the 60-line function guideline — none of which carry the
explaining comment CLAUDE.md rule 5 asks for when a limit is exceeded. This is shared-by-3+ duplication, not
premature abstraction.

## Why it is recorded here, not fixed

It is maintainability churn, not a correctness or contract issue, and it interacts with the Group 3 change
(routing `runSingleStepRetry` through `executeWithAttach`) in the fix-plan — extracting the helpers is best
done **after** that behavioral change lands, so the extraction reflects the final shape rather than being
redone. Kept out of this pass to avoid bundling a broad refactor with the targeted fixes.

## Suggested next step

Extract two small factories and route all callers through them:
- `buildHostOrConfigError(deps, { targetId, workflowName, logger, processService, resumeRegistry, enableFailureActions? }): Promise<Host | number>`
- `buildWfDeps(...)` for the shared `WorkflowDeps` literal.

This also brings the files/functions back under the CLAUDE.md size limits. Re-run the existing
`open-finished` / `open-failed` / `retry` integration suites to confirm no behavior change.
