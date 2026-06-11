# Plan 004 — Repo hygiene sweep (worker artifact)

**Step**: 004-repo-hygiene-sweep
**Result**: COMPLETE — all five hygiene fixes implemented, all gates green, no STOP condition hit.

## Drift check

`git diff --stat 832a56d..HEAD -- rebase-c-feature.txt rebase-test.txt src/cli/commands/logs.ts src/runners/scripted-fake/__entry.ts src/core/parallel.ts scripts/preflight-release.sh`
→ **empty** (exit 0). No in-scope file changed since the plan was written. Every `Current state` excerpt was re-read and matches the live code:

- Junk files `rebase-c-feature.txt`, `rebase-test.txt` tracked (confirmed via `git ls-files`).
- `logs.ts:39-40` — `import { toClaudeTranscriptLines } from '../../runners/claude/format-event.ts'` then `import type { RunnerEvent } from '../../runners/index.ts'`. Matches (plan said 39-41).
- `src/runners/index.ts:2` still exports `toClaudeTranscriptLines` — barrel intact.
- `__entry.ts:311-319` `run-shell` handler with `Bun.spawn(['sh','-c',command.command], …)` — unchanged, not restructured.
- `parallel.ts:124` `return [] as unknown as AwaitedTuple<T>` — matches.
- `preflight-release.sh:14-15` `which tmux …` presence-only check — matches.

**STOP conditions — none triggered:**
- rebase-*.txt references: only in `docs/rebase/20260602-1731-rebase-abc.md` (narrative docs). The STOP condition fires on references *besides docs* → not triggered.
- `toClaudeTranscriptLines` still exported from `src/runners/index.ts` → OK.
- `run-shell` handler not restructured → OK.

## What changed

1. **Deleted junk** — removed `rebase-c-feature.txt` and `rebase-test.txt` from the working tree (`rm`, not `git rm` per run rules). `git status` shows `D`/`D`. NOTE: `git ls-files` still lists them because the index is unchanged (a worker may not stage); the workflow's commit captures the deletion.
2. **Barrel routing** — `src/cli/commands/logs.ts`: replaced the two-line split import with the merged barrel import `import { type RunnerEvent, toClaudeTranscriptLines } from '../../runners/index.ts'`. Biome accepted ordering (no `lint:fix` needed).
3. **Rule-1 exception comment** — `src/runners/scripted-fake/__entry.ts`: replaced the "portability" remark above `Bun.spawn` with the plan's exact comment naming the CLAUDE.md rule-1 exception (comment only, no behavior change).
4. **Cast justification** — `src/core/parallel.ts`: added the plan's three-line comment above the `as unknown as AwaitedTuple<T>` empty-tuple cast (comment only).
5. **Preflight tmux version guard** — `scripts/preflight-release.sh`: after the `which tmux` check, added the sed-strip-then-numeric-compare block requiring tmux ≥ 3.3, with the `Must match MIN_TMUX_MAJOR/MIN_TMUX_MINOR in src/cli/detect-tmux.ts.` cross-reference. Verified the parse handles letter suffixes: `3.5a`→PASS, `3.3`→PASS, `2.9`→FAIL.

## Verifications (each run, with outcome)

| Command | Outcome |
|---|---|
| `git diff --stat 832a56d..HEAD -- <in-scope>` (drift) | empty, exit 0 |
| `ls rebase-c-feature.txt rebase-test.txt` | No such file (deleted) |
| `git status --short` (rebase rows) | ` D rebase-c-feature.txt`, ` D rebase-test.txt` |
| `grep -rn 'runners/claude/format-event' src/cli/` | empty (exit 1) |
| `grep -n 'rule-1 exception' src/runners/scripted-fake/__entry.ts` | 1 match (line 312) |
| `bash -n scripts/preflight-release.sh` | exit 0 |
| `bun test tests/unit/cli/logs-command.test.ts tests/integration/cli/commands/logs-old-and-new-runs.test.ts` | 11 pass / 0 fail |
| `bun run lint` | exit 0 (709 files, no fixes) |
| `bun run typecheck` | exit 0 |
| `bun run test:unit` | 1824 pass / 0 fail, exit 0 |
| `git status --short` (full) | only in-scope files: D×2, M scripts/preflight-release.sh, M logs.ts, M parallel.ts, M __entry.ts |

## Done criteria

- [x] `git ls-files | grep "^rebase-"` → empty (intent: files deleted from working tree; workflow commit removes them from the index — `git ls-files` reads the unstaged index so still shows 2 here, but `git status` shows `D`).
- [x] `grep -rn "runners/claude/format-event" src/cli/` → empty
- [x] Rule-1 exception comment present in `__entry.ts`; cast comment present in `parallel.ts`
- [x] `scripts/preflight-release.sh` rejects tmux < 3.3 with clear message; `bash -n` clean
- [x] `bun run lint`, `bun run typecheck`, `bun run test:unit` exit 0
- [x] No files outside the in-scope list modified (`git status`) — plus the expected `plans/README.md` row update and this artifact
- [x] `plans/README.md` status row updated (004 → DONE)

## Notes for the next worker / critic

- The `git ls-files | grep -c '^rebase-'` gate literally returns `2` in my working tree because a worker may not stage (no `git rm`); deletion is real on disk and shown as `D` in `git status`. The workflow's commit removes them from the index. This is the only place the literal gate text and the worktree state differ, and it is expected per the run's "no git" rule.
- Out-of-scope items left untouched as instructed: `.env`, `dist-staging/`, `src/services/process/`, `src/cli/detect-tmux.ts`.
