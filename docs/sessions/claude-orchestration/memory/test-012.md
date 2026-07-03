# test-012 — exit-code regression tests for `mapResumeError`

Test-only task, plan 012. No production code touched.

## What I did
- Created `tests/unit/cli/map-resume-error.test.ts`, a table-driven unit test over the pure `mapResumeError` function.
- Confirmed zero prior coverage first: `grep -rn "mapResumeError" tests/` returned nothing.

## Branches covered (all 9 rows the plan lists)
- `RunNotFoundError` -> `EXIT.CANNOT_RESUME` (3).
- `ResumeError` -> `EXIT.CANNOT_RESUME` (3).
- `ViewResolutionError` -> `EXIT.CONFIG_ERROR` (2).
- `StateCorruptionError` -> `EXIT.CONFIG_ERROR` (2).
- `StepError` -> `EXIT.STEP_FAILURE` (1).
- `SchemaValidationError` -> `EXIT.STEP_FAILURE` (1).
- `ParallelError` -> `EXIT.STEP_FAILURE` (1).
- `HostUnavailableError` -> `EXIT.STEP_FAILURE` (1).
- `new Error('unmapped')` -> `undefined` fallthrough.
- Plus one `reason === err.message` assertion (via `ViewResolutionError`). 10 tests total.

## Key decisions
- Assert against the imported `EXIT` constants, never raw `1/2/3`, so a future renumbering stays honest (plan's maintenance note).
- No mocks (testing-strategy rule 3): the function is pure and every error is a plain value class, so each case constructs a real instance and calls `mapResumeError` directly.
- Branded types constructed by cast (`'r-...' as RunId`, `'plan' as StepName`), mirroring `tests/unit/cli/logs-command.test.ts`.
- `SchemaValidationError` needs a `ZodError` — used `new ZodError([])` (value import from `zod`); empty issue list is enough since the branch only checks `instanceof`.
- `ParallelError` needs a `SettledEntry[]` — passed one `{ status: 'error', error: new Error(...) }` entry (contextually typed, so the `'error'` discriminant narrows).
- `StateCorruptionError` needs a `Path` — used `path('/tmp/state.json')` and `[]` for zodIssues.

## Drift check
- `git diff --stat 0265592..HEAD -- src/cli/commands/resume-execution.ts src/cli/main.ts` showed `main.ts` changed (+83) but `resume-execution.ts` unchanged.
- Verified the `main.ts` change did NOT touch the `EXIT` map (`OK:0, STEP_FAILURE:1, CONFIG_ERROR:2, CANNOT_RESUME:3, ...`) nor `mapResumeError`. The contract in the plan's table still matches the live code, so no table adjustment was needed.

## Verified
- `bun test tests/unit/cli/map-resume-error.test.ts` -> 10 pass, 0 fail.
- `bun run typecheck` -> exit 0 (clean).
- Did NOT run `bun run check` (per task scope). No `src/` files modified — only the new test file.

## Left for later / gotchas
- Did not edit `plans/README.md` (task forbade it); the master/committer should flip row 012 if desired.
- No STOP conditions hit: every assertion passed, so the live mapping matches the plan — no drift, no production bug.
