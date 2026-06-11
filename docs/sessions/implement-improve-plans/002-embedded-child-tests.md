# Step 002 — Unit-test the embedded-binary launch contract

**Plan**: `plans/002-embedded-child-launch-contract-tests.md`
**Result**: DONE — no STOP condition hit.

## What changed

- **Added** `tests/unit/services/process/embedded-child.test.ts` (the only
  source/test file touched).
- **Updated** plan 002's status row in `plans/README.md` (TODO → DONE).

No other files modified. `src/services/process/embedded-child.ts`, its callers
(`start-steps-view.ts`, `ink-prompt-service.ts`), and `tests/binary-smoke/`
were left untouched, per scope.

## Drift check

Command: `git diff --stat 832a56d..HEAD -- src/services/process/embedded-child.ts tests/unit/services/process`

Outcome: **no output** — no in-scope file changed since the plan was written.
Read `embedded-child.ts` directly and confirmed both exported pure functions
(`isEmbeddedRunnerPath`, `embeddedChildArgv`) match the plan's "Current state"
excerpt verbatim (detection rule `runnerScript.includes('/$bunfs/')`; argv
`[execPath, head, ...trailing]` with `head` = subcommand when embedded, else
runnerScript). No drift.

## Test file

Modeled structurally on `merge-env.test.ts`: header comment naming the
dev-checkout vs compiled-binary launch contract and the `/$bunfs/` →
"Unknown command" production incident; full-sentence `it(...)` names;
Arrange-Act-Assert with blank-line separators; `import { describe, expect, it }
from 'bun:test'`; relative import into `src/`.

6 tests covering all required cases:

1. `isEmbeddedRunnerPath` true for a `/$bunfs/` path.
2. `isEmbeddedRunnerPath` false for an absolute dev-checkout path.
3. `isEmbeddedRunnerPath` false for a relative path and the empty string.
4. `embeddedChildArgv` dev checkout → exact `[execPath, runnerScript, ...trailing]`.
5. `embeddedChildArgv` compiled binary → exact `[execPath, subcommand, ...trailing]`
   **plus** `expect(argv).not.toContain(runnerScript)`.
6. `embeddedChildArgv` preserves trailing args verbatim/in order in both modes,
   including empty `trailing: []`.

## Verification commands

| Command | Outcome |
|---|---|
| `git diff --stat 832a56d..HEAD -- …` (drift) | no output — no drift |
| `bun test tests/unit/services/process/embedded-child.test.ts` | **6 pass, 0 fail** (10 expect() calls) |
| `bun run test:unit` | **1824 pass, 0 fail** across 172 files — no other unit test broken |
| `bun run lint` (`biome check .`) | exit 0 — 709 files checked, no fixes |
| `bun run typecheck` (`tsc --noEmit`) | exit 0 |
| `git status --porcelain` | only `?? tests/unit/services/process/embedded-child.test.ts` new (before README/artifact writes) |

No test written per the case list failed → documented contract and code agree.

## Done criteria

- [x] `tests/unit/services/process/embedded-child.test.ts` exists with ≥6 tests (6)
- [x] `bun test tests/unit/services/process/embedded-child.test.ts` exits 0
- [x] `bun run test:unit` exits 0
- [x] `bun run lint` and `bun run typecheck` exit 0
- [x] `git status` shows no files modified outside the in-scope list (test file;
      plus the in-task README row update and this artifact)
- [x] `plans/README.md` status row updated (TODO → DONE)

## Notes for the next worker / critic

- Pure-function unit coverage only. The downstream dispatcher half of the
  contract stays covered by `tests/binary-smoke/`; an integration test asserting
  the *callers* pass the right subcommand constants (`__steps-view`, `__ask`)
  is explicitly deferred (plan's maintenance notes), not done here.
- Changes left in the working tree, uncommitted, for the workflow to commit.
