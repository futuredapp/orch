# Plan Review — Re-open a finished run from the CLI

Reviewed:
- `docs/sessions/resume-completed-session/brainstorm.md`
- `docs/sessions/resume-completed-session/acceptance-tests.md`
- `docs/sessions/resume-completed-session/plan.md`
- Existing context in `docs/sessions/resume-completed-session/doc-review.md` and `docs/sessions/resume-completed-session/in-tui-failure-resume-brainstorm.md`

Overall, the plan is directionally sound and correctly identifies the main effort boundary:
`completed` read-only viewing is mostly a routing/purity problem, while `failed` retry/continue is
new execution and UI-control infrastructure. The plan is not obviously over-complicated for the
accepted behavior; the host-to-CLI action channel and single-step execution primitive are justified
by `[r]` retry-then-park. The main risks are not breadth, but a few missing contract details that
would leave implementers guessing in the hardest paths.

## Finding 1 — Retry-only success has no defined persisted state

**Severity:** critical

**Rationale:** `AT-R1` requires `[r]` to re-run exactly the failed step, mark it ok, and leave the
run parked ready to continue without running later steps. `AT-R10` then requires a later
`orch resume`/`orch retry` to load cleanly and show the correct view. The plan says no schema
migration is needed and tells U6 to "mark the step ok / re-park", but it never defines what the
run's persisted state is after this in-between outcome.

That state is not just an implementation detail. After a successful retry-only action, the run is
no longer a simple terminal `failed` run, but it is also not `completed`, and it must not be
treated like a normal `running` run unless the command is actually continuing. The plan also does
not define what happens if the user presses `[r]`, the step passes, then quits before pressing
continue: expected status, `endedAt`, lifecycle events, cmux pill state, logs, exit code, and the
next `orch resume <same-id>` behavior are all underspecified.

Without a concrete parked-after-retry state model, U5/U6 can satisfy a local runner invocation test
while still corrupting later resume semantics or rendering the wrong footer.

**Suggested change:** Add a required design/task before U5 or at the start of U5:

- Define the persisted representation of "failed step retried successfully, workflow parked before
  later steps".
- State whether `status` remains `failed`, becomes a new/reused paused state, or stays terminal
  with separate recovery metadata, and how `projectStepsView` distinguishes "failed and retryable"
  from "retry succeeded and ready to continue".
- Define `endedAt`, lifecycle event, cmux pill, log, and exit-code behavior for `[r]` success then
  quit.
- Add an explicit test scenario: `[r]` succeeds, user quits, then a later
  `orch resume <same-id>` opens in the expected ready-to-continue view without re-running anything
  until the user acts.

If the existing state model cannot represent this coherently, the plan should remove the "no schema
migration" assumption or narrow `[r]` semantics in the contract. As written, this is the largest
gap against `AT-R1` and `AT-R10`.

## Finding 2 — The instruction-source plan does not fully satisfy D7 / sibling D3

**Severity:** high

**Rationale:** The accepted brainstorm says retry and continue use the same configured source of
truth as the sibling feature, and the sibling contract is more specific: retry and continue have
distinct configured instructions, interactive mode may accept or override the configured default
with a typed nudge, and non-interactive mode always uses the configured default.

The plan's U4 mostly lifts the existing hardcoded `RECOVERY_NUDGE = 'continue'` into a single
parameter with a default. That is a useful low-level seam, but it is not yet the accepted
instruction model. It does not define:

- separate retry vs continue instruction values,
- config precedence across step/workflow/default,
- how the interactive failed view presents and accepts an override,
- how an override augments rather than replaces the retry framing,
- how `orch retry` deliberately avoids prompting while still using the same source.

U6 mentions "configured/overridable instruction", but no task, file, UI flow, or test scenario
implements the typed override. `AT-R5` checks instruction delivery, but the brainstorm contract is
broader than that one acceptance test.

**Suggested change:** Expand U4 into a minimal shared instruction-resolution unit, or add a U4b,
with concrete scope:

- `resolveRetryInstruction(...)` and `resolveContinueInstruction(...)`, with built-in defaults.
- Step/workflow/default precedence, even if the first implementation only has default + explicit
  override.
- Interactive override prompt flow for `orch resume <failed-id>` actions.
- Non-interactive behavior for `orch retry <failed-id>`: configured default only, no prompt.
- Tests for retry-vs-continue distinction, configured default, typed override, and headless
  no-prompt behavior.

This can stay small, but it should be a real contract-level task rather than a deferred sibling
assumption.

## Finding 3 — Phase 1 is described as shippable while `failed` keeps the unsafe old behavior

**Severity:** high

**Rationale:** Phase 1 says it "ships standalone value" and explicitly leaves
`orch resume <failed-id>` unchanged, meaning it still silently re-runs a failed step. That directly
contradicts the final contract in D2, D3, D6, D8, `AT-2`, `AT-R4`, and the failed half of `AT-20`.

The plan acknowledges the interim inconsistency under risks, but the wording "ships standalone
value" is dangerous because the user-visible command would be in a mixed semantic state:
`completed` is safe to observe, while `failed` remains the exact surprise mutation this feature is
meant to remove.

This is especially risky because both statuses are part of one mental model: "finished run
re-entry is observational until I act." Shipping only the completed branch can make the command
feel fixed while preserving the more destructive failed-run surprise.

**Suggested change:** Reclassify Phase 1 as an internal merge slice, not a releasable feature
slice, unless Phase 2 lands in the same release. Add an explicit release gate:

- Do not announce or release the finished-run re-entry behavior until U6 has flipped
  `orch resume <failed-id>` away from silent re-run.
- If incremental release is unavoidable, add a temporary guard for explicit failed finished runs
  that refuses with a clear message rather than silently re-running, but only if that behavior is
  acceptable to the contract owners. Otherwise keep Phase 1 behind a branch/feature flag.

The implementation phasing can remain, but the user-visible rollout boundary should move to after
U6, and likely after U7 for bare `resume`.

## Finding 4 — Headless `orch retry` needs an explicit non-TUI execution path

**Severity:** medium

**Rationale:** D8 and `AT-R8` require no-TTY `orch retry <failed-id>` to run retry-and-continue
using the configured default and never block. U8 says `orch retry` "opens and auto-triggers
retry-and-continue" for TTY and that headless "runs", but the implementation approach is framed as
sharing `resume`'s open/action path.

That is fine for interactive `orch retry`, but the headless path must not depend on:

- the two-pane host,
- the host-to-CLI action channel,
- `ConfirmService`,
- typed override UI,
- foreground shutdown outcomes.

Any accidental dependency on those pieces risks a CI hang, a no-TTY refusal copied from `resume`,
or a fake "open" side effect before execution.

**Suggested change:** In U8, define two separate branches:

- TTY: optionally attach/open and programmatically trigger the same retry-and-continue core as
  `[c]`.
- No TTY: call a core `retryAndContinue(runId, instructionSource)` service directly, with the
  configured default instruction and no host construction.

Add a test assertion that the no-TTY path does not instantiate the two-pane host or prompt service,
in addition to the existing no-hang/exit-code assertions.

## Finding 5 — Actioned retry side effects are under-specified compared with pure open side effects

**Severity:** medium

**Rationale:** The plan is very precise about suppressing side effects for un-actioned opens:
no `setStatus('running')`, no resume preamble, no lifecycle events, no cmux updates, no logs. It is
less precise about which side effects are expected once the user acts.

For `[c]` and `orch retry`, mutation is intentional. But implementers still need the expected
state/event/log boundaries:

- when the command should emit `run:resumed`, `run:ended`, or recovery-specific lifecycle events,
- whether `[r]` success emits any lifecycle event before the workflow continues,
- what log entries are expected for retry attempts,
- how cmux should behave for retry-fails-again and retry-only-success, not only successful
  failed-to-completed continue.

`AT-R11` covers the positive cmux transition for successful `[c]`, but the adjacent failure modes
are not spelled out. That leaves room for over-applying the pure-open suppression to actioned paths
or over-applying resume teardown side effects to retry-only paths.

**Suggested change:** Add an "actioned side effects matrix" to Phase 2:

| Action/outcome | status | lifecycle events | cmux | logs | exit |
| --- | --- | --- | --- | --- | --- |
| `[r]` passes then parks | define | define | define | define | define |
| `[r]` fails again | define | define | define | define | define |
| `[c]` completes | completed | define | failed→completed | define | 0 |
| `[c]` fails again | failed | define | define | define | non-zero or parked? |
| `orch retry` completes | completed | define | define | define | 0 |
| `orch retry` fails again | failed | define | define | define | non-zero |

The exact event names can be chosen during implementation, but the observable boundaries should be
fixed in the plan.

## Finding 6 — Test strategy claims full coverage but misses two contract behaviors

**Severity:** medium

**Rationale:** The AT map covers every acceptance-test ID, but the human-reviewed contract includes
two behaviors that are not represented as owning test scenarios:

1. Interactive configured instruction override for `orch resume <failed-id>` retry/continue.
2. `[r]` success followed by user quit, then a later resume/retry.

The first is from brainstorm D7 and sibling D3/D5. The second is the unresolved state transition
created by `AT-R1` but not directly tested by `AT-R10`, which only says a run retried via
`orch resume` "passing or failing-again" later loads cleanly; it does not force the retry-only
success-then-quit case.

**Suggested change:** Add explicit test rows or sub-scenarios:

- `AT-R5a`: interactive override is accepted, delivered to the runner, and does not replace the
  built-in "this is a retry/continue" framing.
- `AT-R10a`: `[r]` succeeds, the user quits before continuing, and a later
  `orch resume <same-id>` opens in the correct ready-to-continue state without stale replay.

These can be additions to the plan's test strategy without editing `acceptance-tests.md`, but the
plan should not claim exhaustive behavioral coverage until they are represented.

## Finding 7 — "Blocked-on-user-input" contains non-blockers

**Severity:** low

**Rationale:** Phase 2 lists final confirmation copy under "Blocked-on-user-input" and immediately
says it is "Not a blocker". Phase 3 does the same for `ResumeError` rename vs reuse. That blurs
the AI-vs-user-input separation the workflow asks the plan to make clear.

Both items are implementer choices already bounded by the contract:

- prompt copy must distinguish completed read-only vs failed interactive view,
- error handling must be non-zero and status-named without printing "cannot resume" for normal
  finished runs.

No user decision is required to proceed.

**Suggested change:** Move those entries out of "Blocked-on-user-input" and into "Implementation
choices" or "Assumptions". Keep "Blocked-on-user-input" empty unless a human decision is genuinely
needed before work can continue.

## Summary

The plan's broad architecture and phasing are mostly logical, and it does not propose unrelated
architecture churn. The necessary corrections are to pin down the state model for retry-only
success, make the instruction source match the accepted retry/continue/override contract, prevent
Phase 1 from being treated as a complete user-visible release, and make headless/actioned side
effects explicit.
