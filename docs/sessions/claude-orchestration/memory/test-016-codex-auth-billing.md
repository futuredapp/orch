# test-016: Codex auth/billing classification regression tests

## What I did

Added 5 regression cases to the existing `describe('codex().classifyError', ...)` block in
`tests/unit/runners/codex/recovery.test.ts`, reusing the file's `turnFailed`/`signal` helpers:

- 2 auth cases (`unauthorized: invalid api key`, `not logged in - run codex login`) asserting
  `category === 'auth'` and `transient === false`.
- 2 billing cases (`you have exceeded your quota`, `billing issue: payment required`) asserting
  `category === 'billing'` and `transient === false`.
- 1 negative word-boundary case (`cannot read /home/user/billingReport.json`) asserting
  `category !== 'billing'` - locks in the `\b(?:quota|billing)\b` guard.

No `src/` file was touched; test-only change.

## Drift check

`git diff --stat 0265592..HEAD -- src/runners/codex/classify-error.ts` shows +8 lines, but the
live `auth`/`billing` branches (classify-error.ts:67-86) match the plan verbatim:
`auth` = `/unauthorized|invalid api key|not logged in|authentication/` (transient false),
`billing` = `/\b(?:quota|billing)\b/` (transient false). No test-input adjustment needed.

The negative case falls through to `unknown` (turn.failed on stdout is not a launch failure, and
`billingReport` has no word boundary before `Report`), so `category !== 'billing'` holds without
pinning a specific fallthrough category.

## Verified

- `bun test tests/unit/runners/codex/recovery.test.ts` -> 16 pass, 0 fail.
- `bun run typecheck` -> exit 0.

Used only path-scoped commands; did not run `bun run check` or bare `bun test`, per the task's hard constraints.

## Left for later / notes

- No assertions failed, so no classifier bug surfaced - the STOP condition did not trigger.
- `plans/README.md` row 016 was intentionally NOT updated (hard constraint forbids editing it).
- The workflow commits the working-tree change; I ran no git commands.
