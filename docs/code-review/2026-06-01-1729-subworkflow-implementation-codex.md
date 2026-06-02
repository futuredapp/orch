# Code review: subworkflow implementation

Reviewed range: `0847b17cb598077b7ce10f4d03b1b8403c2ccefc..1c59ad41e8d40187398b727171f25b14fe099076`

## Findings

### [P2] Preserve sub paths for live-only rows

In `src/hosts/two-pane/steps-view/project-steps-view.ts:107`, overlay-only rows are always projected with `subPath: []`. While a subworkflow step is still running, it exists only in the lifecycle overlay, and its persisted `StepEntry.subPath` is not available until completion. For a long-running `runWorkflow(simple-feature)` step, the two-pane view therefore renders `simple-feature>plan` as a root row and appends the subworkflow boundary as a stepless tail until the step finishes, so live subworkflow grouping is wrong during the period when users most need it.

### [P2] Detect repeated subworkflow calls after resume

In `src/core/workflow.ts:1301`, the collision guard only runs for keys written during the current process. If a run crashes after the first invocation of a subworkflow that is later invoked a second time, `resume()` replays the first invocation from cache without adding the key to `keysWrittenThisExecution`; the second invocation then sees the same cached key and returns the first call's value instead of throwing `StepNameCollisionError`. This makes the documented “same workflow invoked twice” guard disappear specifically on resume paths.

### [P2] Key boundary bookkeeping by full sub path

In `src/hosts/two-pane/steps-view/project-steps-view.ts:168`, rendered/suppressed boundary bookkeeping uses only the leaf workflow name. Valid nested compositions can reuse the same subworkflow name under different parents, e.g. `api>ship` and `web>ship`, because their persisted step keys are distinct. After the first `ship` boundary is rendered, the second is skipped (and suppression/overlay lookup can also bleed across both), so the two-pane tree becomes incorrect for reusable subworkflows in different branches.

## Recommendation

Request changes for the findings above before relying on subworkflow UI/resume behavior.
