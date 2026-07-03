# Fix Group A — Preserve step lifecycle on prompt-assembly failure (+ single-assembly guarantee)

Status: **done**

Findings addressed: CE M-1 · Codex #3 · folds CE L-1.

## What was wrong

`assemblePrompt` was hoisted ahead of `withStepLifecycle` in both step paths so
the assembled prompt could ride on `step:start` for the right-pane preamble. But
`assemblePrompt` → `substitute()` throws on any `{{var}}`/template mismatch
(missing var, extra key, typo). With the hoist, that throw escaped *before*
`withStepLifecycle` ran, so **none** of `step:start` / `step:failed` fired for the
step. The error still reached the workflow-level catch (run still classified
`crashed`), but the per-step attribution that the steps-view / failure panes /
cmux pills consume was lost — a user-visible regression in failure
diagnosability, since a `{{var}}` mismatch is a real user-reachable input error.

Secondarily (CE L-1), `assemblePrompt` ran twice per step (hoisted carrier +
re-derivation inside `produce*Step`). Pure, so they agreed, but the feature's
core claim ("the pane shows the EXACT prompt orch sent") rested on an unenforced
convention with no test pinning it.

## What was changed (production)

All in `src/core/workflow.ts`:

- **Added `failedAssemblyLifecycle` helper.** When the hoisted `assemblePrompt`
  throws, the failure is routed back through `withStepLifecycle` (no `prompt` on
  the ctx — there isn't one) with a body that re-throws the captured error, so
  `step:start` → `step:failed` still fire and the step keeps its attribution. The
  workflow-level catch still classifies the run `crashed`, and the structured
  record carries no `prompt` (KTD2 bloat guard untouched).
- **`runAgentStep` (autonomous)** and **`runInteractiveStep` (interactive)** now
  wrap the hoisted `assemblePrompt` in `try/catch` and delegate to the helper on
  throw.
- **Single-assembly:** the already-assembled string is threaded into
  `produceAgentStep` / `produceInteractiveStep` as a `prompt` parameter instead
  of being re-derived inside them. Removed the now-redundant second
  `assemblePrompt(...)` call at both produce sites. This makes "displayed prompt
  == sent prompt" true by construction (closes L-1) and removes the redundant
  `substitute()` pass.
- Dropped the now-unused `overrides` parameter from `produceInteractiveStep` /
  `produceAgentStep` (it was only used for the removed assembly), and updated
  their call sites.

## Tests added

New file `tests/unit/core/prompt-assembly-failure-lifecycle.test.ts` (src/core
layer, no `mock.module`, per `docs/testing-strategy.md`):

1. **Autonomous** step with an unresolved `{{topic}}` placeholder asserts both
   `step:start` and `step:failed` are emitted (the regression guard — neither
   fired before the fix), the runner never ran, and no `prompt` is carried.
2. **Interactive** step with an unresolved `{{name}}` placeholder — same
   assertions on the interactive hoist path.
3. **KTD2 bloat guard:** the structured `step:failed` (and `step:start`) records
   appended to the span on assembly failure carry no `prompt` field (captured via
   a recording `SessionLogger`).
4. **Single-assembly guarantee:** a successful step threads one assembled string,
   so the prompt carried on `step:start` is byte-identical to the prompt the
   runner receives (`ctx.prompt`).

The pre-existing
`tests/unit/core/workflow-vars-cache-key.test.ts` "throws missing-placeholder
before runner starts" test already pinned the *propagation*; the new file pins
the *lifecycle attribution* that was the actual regression.

## Verification

- `bun run typecheck` — clean.
- `bun run lint` (biome) — clean.
- `bun test tests/unit/core/` — 615 pass / 0 fail.
- `bun test --max-concurrency=4 tests/integration/core` — 119 pass / 0 fail.
- `bun run test:two-pane:fast` — 293 pass / 0 fail.

## Issues hit

None. The interactive `onInteractive` stub initially failed typecheck (missing
`sessionId` on `InteractiveResult`); added the field. The throw happens before
`onInteractive` / `buildCommand` is ever reached, so the stub is never invoked —
only the capability/view guards run ahead of the assembly.

## Remaining groups

B, C, D, E are still `Status: not-started`.
