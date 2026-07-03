# Wave-2 review — plans 010, 013, 014, 017, 021

Read-only review of `git diff 0b1a37d..d521685`, with extra scrutiny on plan 013's unreviewed commit `c38c1e4`.
No source was changed; fixes (if any were warranted) are a later task.

## Per-plan verdict

- Plan 010 (log and persist fast-fail classifications): OK.
- Plan 013 (drain stderr before tail on abort): OK.
- Plan 014 (extract shared transcript-format helpers): OK.
- Plan 017 (per-command --help and --version): OK.
- Plan 021 (typed permissions option on claude()): OK.

No NEEDS-FIX findings. Details and the risks I checked are below.

## Plan 010 — OK

The `failed-fast` literal is added to `RecoveryOutcome` and the fail branch pushes exactly one entry (`src/core/recovery/loop.ts:33-36`, `:150-156`) before returning, so `recoveryLog.length > 0` and the existing `persistRecoveryFailure` gate now writes a `StepEntry` carrying `errorClass`.
The `orchLog(deps.logger, 'recovery-fail-fast', ...)` line fires only for `loop.failure.kind === 'fail'` (`src/core/workflow.ts:1589-1594`), matching the plan.
I confirmed the plan's own reviewer note: the new `failed-fast` entry cannot miscount attempts in `formatRecoveryFailure`, because that function returns early for `failure.kind === 'fail'` (`src/core/recovery/loop.ts:277-282`) and never reaches the `outcome !== 'gave-up'` count at `:285`; `failed-fast` only ever exists on the fail branch, so it and the give-up count are mutually exclusive.
The persisted-outcome schema is `z.string()`, so the new literal is forward-tolerant at the state boundary as the plan states.
No `any`, no `!`, no leaked runner import, no bypass of ProcessService.

## Plan 013 — OK (with one documented risk)

The single `await stderrDone` now sits after the `try/catch/finally` and before `const stderr = stderrTail.value()` (`src/runners/execute.ts:144`), and the old in-`try` await was removed — exactly the plan's preferred shape, and it flushes on both the normal and AbortError paths.
Ordering is correct: `safeKill(handle)` runs first in `finally` (`:137`), so the killed child's stderr pipe closes and `drainStream`'s `for await` terminates before the await; `stderrDone` is `.catch(() => {})`-guarded, so the await never rejects.
The regression test (`tests/unit/runners/execute.test.ts:203-286`) is well-constructed: the fake stderr yields its line one `setImmediate` macrotask AFTER the abort unwinds stdout, so a tail read that skips the drain await would see an empty tail — it asserts both `result.stderr` and the synthesized `finalEvent.message` contain the late line. This genuinely guards the fix.
Documented risk (not a fix, matches the plan's own maintenance note): extending the drain await to the abort path means that if a killed child leaves a grandchild holding the stderr write end open, the stream never EOFs and `await stderrDone` could hang on exactly the path the watchdog is trying to escape. This was already true on the success path; the plan consciously accepted the tradeoff and asked the reviewer to confirm `safeKill` closes the pipe first, which it does for a direct child. Worth remembering if a future runner spawns detached grandchildren that inherit stderr.

## Plan 014 — OK

`src/runners/transcript-format-utils.ts` is created with the top-of-file "Not on the public barrel" comment, named exports only, strict types, no `any` (`:1-78`).
Both formatters now import the moved helpers and constants and their local copies are deleted; the byte-identical `safeJson` was also correctly pulled up, while `numberField` / Codex `readNumber` (which legitimately diverge) stayed local.
`formatTokens` / `formatTurnComplete` were left per-runner as required.
`grep transcript-format-utils src/index.ts src/runners/index.ts` returns nothing — the module is not re-exported publicly, satisfying the done-criterion.

## Plan 017 — OK

`COMMAND_HELP` has an entry for all ten `COMMANDS` keys (run, resume, retry, runs, status, logs, dry-run, init, new, types) and both `COMMANDS` and `COMMAND_HELP` are exported for the coverage loop test (`src/cli/main.ts:162-227`, `:459`).
`--help` now routes through the resolved command (`:543-547`) falling back to global `HELP`, and `--version` is parsed (`:253`, `:311`) and printed before dispatch via `orchVersion()` (`:538-541`).
Ordering is correct: internal re-entry subcommands, then parse, then version, then help, then command dispatch — so `orch <cmd> --help` and `orch --version` both short-circuit to stdout with `EXIT.OK` before any command handler runs.
Tests cover the version flag (`tests/unit/cli/argv.test.ts:159-170`) and the full COMMAND_HELP-vs-COMMANDS coverage loop (`:189-195`).

## Plan 021 — OK

`ClaudeOptions.permissions?: 'bypass'` is added with the canonical `PERMISSION_FLAGS` map (`src/runners/claude/claude-runner.ts:94-104`).
`effectiveFlags` is computed once in the factory and threaded through every argv path — `buildCommand` interactive + autonomous (`:423-424`), the resume argv (`:450`), and `forkResumeCommand` / `buildForkArgv` (`:487`, `:490`) — so unattended runs never prompt on the fork-recovery path either, which was the plan's explicit reviewer concern.
`assertFlagAllowed` still runs over `effectiveFlags` and the `flags` escape hatch is preserved and appended after the expansion.
The scaffold switched to `permissions: 'bypass'` (`src/cli/commands/init-templates.ts:22`), and `docs/public/reference/runners.md` was reconciled to add the `permissions` signature line and update the bypass tip — satisfying the public-barrel/docs rule.
No `any`, no `!`; the map key type is derived via `NonNullable<ClaudeOptions['permissions']>`.

## Cross-cutting checks

No `any` types, no `!` non-null assertions, and no `noUncheckedIndexedAccess` gaps introduced across the five diffs.
No concrete-runner import leaked into `src/core/` (workflow.ts and loop.ts changes touch only recovery types and logging).
No subprocess call bypasses `ProcessService` (execute.ts still spawns only via `deps.processService`).
