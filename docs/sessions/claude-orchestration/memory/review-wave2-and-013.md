# Diary — review-wave2-and-013

## What I did

Read-only review of the Wave-2 landed diff `git diff 0b1a37d..d521685` (plans 010, 013, 014, 017, 021), with extra scrutiny on plan 013's unreviewed commit `c38c1e4`.
Wrote findings to `docs/sessions/claude-orchestration/memory/review-wave2.md` (per-plan verdict + risks checked).
Changed no source, ran no git-mutating commands.

## Verdict

All five plans are OK. No NEEDS-FIX findings — nothing is queued for a fix task from this review.

## Key decisions / why

- I treated `git show` / `git diff` / `git log` as allowed (read-only inspection the task explicitly instructs); the "no git" rule is about mutating state (branch/worktree/commit/stash), none of which I touched.
- For 013 I verified the ordering claim directly in `src/runners/execute.ts`: the single `await stderrDone` (`:144`) sits after the `finally` that runs `safeKill` first, so the pipe closes before the drain await, and the await is `.catch`-guarded so it never rejects. The regression test genuinely fails without the fix (stderr line lands one macrotask after the abort unwind).
- For 010 I chased the plan's own reviewer note to ground: `formatRecoveryFailure` early-returns for `failure.kind === 'fail'` (`loop.ts:277`), so the new `failed-fast` entry can never reach the give-up attempt count. Confirmed benign, not just asserted.

## What I verified (commands run)

- `git show c38c1e4`, `git diff 0b1a37d..d521685 --stat`, and per-plan `git diff` slices — read the actual landed hunks.
- `grep -rn transcript-format-utils src/index.ts src/runners/index.ts` → empty (014 module not public).
- Read `tests/unit/cli/argv.test.ts` → confirmed the `--version` parse tests and the COMMAND_HELP-covers-COMMANDS loop test exist and that all ten COMMANDS keys have help entries.
- Did NOT run `bun run check` / `bun test` — this was a read-only review and the changes already landed behind the gate; I reviewed for correctness and plan-adherence, not re-ran the suite.

## Left for later / risks noted

- 013 documented risk (not a defect, already in the plan's maintenance note): extending the drain await to the abort path means a killed child that leaves a grandchild holding the stderr write-end open could hang `await stderrDone` on the very path the watchdog is escaping. True for a direct child today because `safeKill` closes the pipe; flagged for whoever adds a runner that spawns detached grandchildren inheriting stderr.
- No fixes to schedule from Wave-2. The next round can proceed to the Wave-3/4/5 builds without a Wave-2 fix task.
