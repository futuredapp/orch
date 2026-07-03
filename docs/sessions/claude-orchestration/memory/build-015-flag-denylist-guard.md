# build-015: Extract shared runner flag-denylist guard

## What I did
Implemented plan 015: extracted the duplicated `assertFlagAllowed` guard from both runners into one shared factory.
Created `src/runners/flag-guard.ts` exporting `makeFlagGuard(runnerName, denylist)` which returns the guard closure.
Both runners now build their guard from it: `const assertFlagAllowed = makeFlagGuard('claude', CLAUDE_FLAG_DENYLIST)` and `makeFlagGuard('codex', CODEX_FLAG_DENYLIST)`.
Each runner keeps its own denylist CONTENT unchanged (Claude: `['--settings','--mcp-config']`; Codex: its 6-flag list).

## Drift check
`git diff --stat 0265592..HEAD` showed prior-commit churn, but the live `assertFlagAllowed` bodies were byte-identical to the plan's excerpts (same `--flag` vs `--flag=value` matching, same `${runner}(): flag "${flag}" is on the denylist` message).
No drift - proceeded.

## Key decisions
Placed the helper at `src/runners/flag-guard.ts` exactly as the plan directs - this is a runner-internal sibling like `execute.ts` / `runner-options.ts`, imported via `../flag-guard.ts`.
No `_shared/` deviation was needed: the plan never used `_shared`, so the CLAUDE.md "no src/runners/_shared" constraint was already respected.
This sibling-relative import is the established pattern inside the runners module (matches how `types.ts` / `runner-options.ts` are imported); it does NOT cross a module boundary, so the single-public-barrel rule is not violated.
Kept it off the public barrels (`src/index.ts`, `src/runners/index.ts`) per plan - it is internal.
Matching semantics (`=`-prefix, the security-relevant part) preserved verbatim.

## What I changed
- `src/runners/flag-guard.ts` (new, ~18 lines).
- `src/runners/claude/claude-runner.ts`: added import, replaced the standalone function with the factory-built const.
- `src/runners/codex/codex-runner.ts`: same.
- `tests/unit/runners/flag-guard.test.ts` (new): direct unit test of the factory - bare flag throws, `--flag=value` prefix throws, safe flag allowed, prefix-without-`=` (`--settings-extra`) allowed, runner-name prefixes the message.

## What I verified
`bun run typecheck` -> exit 0 (clean).
`bun test tests/unit/runners/claude tests/unit/runners/codex tests/unit/runners/flag-guard.test.ts` -> 237 pass, 0 fail (path-scoped; never ran bare `bun test`).
Existing runner build-command tests already cover both `--flag` and `--flag=value` forms plus safe-flag passthrough for both runners; they pass unchanged and are the real regression guard.
Done-criteria greps: no `function assertFlagAllowed` remains; no `flag-guard` on public barrels; both denylist constants still present per-runner.

## Left for later / gotchas
Did not run `bun run check` and did not touch `plans/README.md` (per task instructions - the workflow commits and the master handles the README row).
Plan's Maintenance note suggests updating the runner-author skill so new runners use `makeFlagGuard`; I did not touch that skill (out of footprint) - a later docs task could add it.
No git commands run; all changes left in the working tree.
