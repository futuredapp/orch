# Build 018: `orch logs` accepts a runId prefix

## What I did

Made `orch logs <prefix>` resolve a runId prefix the same way `orch status`/`orch resume` do.
In `src/cli/commands/logs.ts`, replaced the exact-match `parseRunId(idArg)` block inside `resolveRunId` (the non-`--latest`, non-empty-idArg path) with prefix resolution mirroring `status.ts:31-44`:

- `await deps.registry.findByPrefix(idArg)`.
- `length === 0` → `No run found matching "<id>"`, exit `CONFIG_ERROR`.
- `length > 1` → `Ambiguous run ID prefix "<id>" matches <n> runs: <list>`, exit `CONFIG_ERROR` (matches status's exact wording).
- Otherwise re-parse `matches[0]` through `parseRunId` to preserve the validated `RunId` return type.

Added 3 tests to `tests/unit/cli/logs-command.test.ts` under a new `describe('orch logs <prefix>')` block: unique prefix streams the transcript, ambiguous prefix (2 matches) exits `CONFIG_ERROR` with the ambiguous message, no-match prefix exits `CONFIG_ERROR` with the not-found message.

## Key decisions

- `resolveRunId` was already `async` and its call site already `await`s it, so no async cascade - no refactor needed (a STOP condition that did not fire).
- `deps.registry.findByPrefix` is reachable: `CliDeps.registry` is a `RunRegistry`, the same dep `status.ts` uses. STOP condition did not fire.
- `findByPrefix` returns `readonly RunId[]`, so under `noUncheckedIndexedAccess` `matches[0]` is `RunId | undefined`.
  Rather than `status.ts`'s `matches[0] as RunId` cast (repo bans `!` but allows `as`), I used an explicit `if (match === undefined)` guard then `parseRunId(match)`.
  This keeps the validated `RunId` type with no `as`/`!`, and the re-parse never throws because the id came from the registry's known ids. Left status.ts/resume.ts untouched per scope.
- Kept the empty-`idArg` usage message and the `--latest` branch fully untouched; did not weaken the path-traversal guard.

## Drift check

`git diff --stat 0265592..HEAD -- src/cli/commands/logs.ts src/cli/commands/status.ts` showed logs.ts changed (4 insertions, 1 deletion) and status.ts unchanged.
Compared the plan's 'Current state' excerpts against live code: the `resolveRunId` try/parseRunId block and status.ts:31-44 both matched the plan verbatim, so no adjustment was needed.

## Verified

- `bun test tests/unit/cli/logs-command.test.ts` → 13 pass, 0 fail (10 existing + 3 new).
- `bun run typecheck` → exit 0.

Did not run `bun run check` or bare `bun test` per hard constraints (path-scoped only).

## Left for later / notes

- Files touched: only `src/cli/commands/logs.ts` and `tests/unit/cli/logs-command.test.ts`.
- Did NOT update `plans/README.md` row 018 (the plan's Done-criteria asks for it, but the task's hard constraints forbid editing `plans/README.md`) - flag for the master.
- Follow-up noted in the plan's maintenance notes (out of scope here): a shared `resolveRunTarget(deps, idArg, { latest })` helper for `logs`/`status`/`resume`/`retry` (CLI-05).
