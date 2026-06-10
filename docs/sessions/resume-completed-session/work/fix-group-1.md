# Fix Group 1 — Parked-after-`[r]` run mis-projects as `completed`

**Status: done.** Group 1 of `docs/sessions/resume-completed-session/fix-plan.md` is implemented and
`bun run check` is green.

## What was wrong

`finalizeView` (`src/hosts/two-pane/steps-view/project-steps-view.ts`) decided the failed-vs-completed
terminal status purely from the step-row count (`summary.stepsFailed > 0`), ignoring the persisted
`runStatus`. After a successful `[r]` retry (KTD-8), the executor leaves `run.status === 'failed'`,
persists the previously-failed step as a **successful** entry, and leaves later steps unrun — so the
parked run has **zero** failed step rows. `finalizeView` therefore projected it as `completed`, and
`StepsView` (which gates `failureActions` on `state.status === 'failed'`) dropped the `[c]` continue
affordance — violating AT-R1 and AT-R10a.

## What I fixed

- **`src/hosts/two-pane/steps-view/project-steps-view.ts`** — changed the terminal split in
  `finalizeView` from `if (summary.stepsFailed > 0)` to
  `if (runStatus === 'failed' || summary.stepsFailed > 0)`, so a persisted `failed` run stays `failed`
  regardless of step-row count. Added an explanatory comment tying it to the KTD-8 parked shape. The
  `running` branch still returns earlier; `crashed`/`completed` are unaffected; the existing
  "live-failed step flips an otherwise-completed run to failed" behavior is preserved (that path keeps
  `stepsFailed > 0`).

## Tests added (both would fail before the fix)

- **Unit / model (no tmux)** — `tests/unit/hosts/two-pane/steps-view/steps-view-model.test.ts`: a new
  case "keeps a persisted failed run failed when a retry left every step ok and later steps unrun"
  builds the parked-after-retry `RunState` (`status: 'failed'`, all steps `ok`, later steps absent) and
  asserts `projectStepsView(...).status === 'failed'` with `summary.stepsFailed === 0`. This is the
  inverse of the existing line-132 case and was previously uncovered.
- **Integration (AT-R10a strengthening)** — `tests/integration/cli/commands/open-failed.test.ts`: the
  reopen-after-passed-`[r]` test now feeds the parked `state.json` through `projectStepsView` and
  asserts the **projected** status is `failed` (so `[c]` is still offered). Previously the test asserted
  only on-disk status; the comment at the old line 339 ("still parked-failed → [c] still offered")
  asserted nothing about the projector — the actual regression surface. Added the `projectStepsView`
  import from the steps-view barrel.

## Verification

- `bun test tests/unit/hosts/two-pane/steps-view/steps-view-model.test.ts` → 13 pass.
- `bun test tests/integration/cli/commands/open-failed.test.ts` → 7 pass.
- `bun run check` → exit 0 (lint + typecheck + unit + mocked-integration + two-pane fast + lifecycle +
  migration parity all green).

## Issues hit

None. The fix is a one-line predicate change plus comment; both regression tests went red→green as
expected.

## Remaining

Groups 2–6 of the fix plan are still `not-started`.
