# Plan 004: Repo hygiene sweep — junk files, barrel bypass, undocumented rule exceptions, preflight tmux check

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 832a56d..HEAD -- rebase-c-feature.txt rebase-test.txt src/cli/commands/logs.ts src/runners/scripted-fake/__entry.ts src/core/parallel.ts scripts/preflight-release.sh`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tech-debt
- **Planned at**: commit `832a56d`, 2026-06-11

## Why this matters

Five small, independent hygiene defects, each verified by reading the code on
2026-06-11. Individually trivial; together they erode the repo's own declared
standards (CLAUDE.md rules 1, 5, 7) and leave one real release-pipeline gap
(preflight doesn't check the tmux version it depends on). All fixes are
mechanical and low-risk — one focused PR cleans them all.

## Current state

### (a) Tracked merge-test junk at repo root

`rebase-c-feature.txt` and `rebase-test.txt` are tracked by git
(`git ls-files` confirms). Contents (verbatim, they are tiny):

```
rebase-c-feature.txt: "this is a brand new file added only by branch C"
rebase-test.txt:      lines like "line 2: CHANGED BY BRANCH A" / "CHANGED BY BRANCH B"
```

They are leftover artifacts from a merge-conflict experiment; nothing in the
repo references them (`grep -rn "rebase-c-feature\|rebase-test.txt" src tests scripts docs` → only `docs/rebase/` narrative docs at most).

### (b) Barrel bypass in `logs.ts`

CLAUDE.md rule 7: cross-module imports go through `src/<module>/index.ts`.

```typescript
// src/cli/commands/logs.ts:39-41
import { toClaudeTranscriptLines } from '../../runners/claude/format-event.ts'
import type { RunnerEvent } from '../../runners/index.ts'
```

The barrel already exports the function:

```typescript
// src/runners/index.ts:2
export { claude, parseClaudeLine, toClaudeTranscriptLines } from './claude/index.ts'
```

### (c) Undocumented `Bun.spawn` rule exception in the scripted-fake entry

CLAUDE.md rule 1: no `Bun.spawn` outside `src/services/process/`. The
scripted-fake puppet's subprocess entry script violates it with only a
"portability" remark:

```typescript
// src/runners/scripted-fake/__entry.ts:311-318
    case 'run-shell': {
      // Use Bun.spawn for portability; await exit. Output is intentionally
      // discarded — `emit` is the side-channel for test-visible content.
      const proc = Bun.spawn(['sh', '-c', command.command], {
```

The exception is actually justified — `__entry.ts` is itself a spawned child
process (the fake-agent puppet), not part of orch's in-process tree, so the
ProcessService seam doesn't exist there — but rule 5's convention is that
deliberate rule departures carry an explanatory comment naming the rule.

### (d) Unexplained type-escape cast in `parallel.ts`

```typescript
// src/core/parallel.ts:124
    if (promises.length === 0) return [] as unknown as AwaitedTuple<T>
```

CLAUDE.md bans `any`/`!`; `as unknown as` is the same family of compiler
override and deserves a one-line justification.

### (e) Preflight doesn't check the tmux version it needs

`scripts/preflight-release.sh` checks tmux *presence* only:

```bash
which tmux > /dev/null 2>&1 \
  || fail "'tmux' binary not found on PATH (required for real-tmux tests)"
```

But the runtime gate in `src/cli/detect-tmux.ts` requires
`MIN_TMUX_MAJOR = 3`, `MIN_TMUX_MINOR = 3` (lines 12–13). An old tmux passes
preflight, then `check:release` fails mid-suite with an opaque render error
instead of a clear setup error.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Lint | `bun run lint` | exit 0 |
| Typecheck | `bun run typecheck` | exit 0 |
| Unit tier | `bun run test:unit` | all pass |
| Shell syntax | `bash -n scripts/preflight-release.sh` | exit 0, no output |
| CLI logs tests | `bun test tests/unit/cli/logs-command.test.ts tests/integration/cli/commands/logs-old-and-new-runs.test.ts` | all pass |

## Scope

**In scope**:
- `rebase-c-feature.txt`, `rebase-test.txt` (delete)
- `src/cli/commands/logs.ts` (one import line)
- `src/runners/scripted-fake/__entry.ts` (comment only)
- `src/core/parallel.ts` (comment only)
- `scripts/preflight-release.sh` (add version check)

**Out of scope** (do NOT touch):
- `.env` — local, untracked, gitignored; verified NOT in git history. Leave it.
- `dist-staging/` — it is tracked on purpose (Homebrew tap staging:
  `dist-staging/homebrew-orch/Formula/orch.rb` used by release tooling). Do
  not delete it even though it looks like a build artifact.
- `src/services/process/` — no behavior changes anywhere in this plan.
- `src/cli/detect-tmux.ts` — the runtime gate stays the single source of the
  minimum version constants for the TypeScript side; the shell script
  hardcodes its copy with a cross-reference comment (acceptable: shell can't
  import TS).

## Steps

### Step 1: Delete the junk files

`git rm rebase-c-feature.txt rebase-test.txt`

**Verify**: `git ls-files | grep -c "^rebase-"` → `0`.

### Step 2: Route `logs.ts` through the runners barrel

In `src/cli/commands/logs.ts`, delete the line
`import { toClaudeTranscriptLines } from '../../runners/claude/format-event.ts'`
and merge the symbol into the existing barrel import two lines below, making it:
`import { type RunnerEvent, toClaudeTranscriptLines } from '../../runners/index.ts'`
(biome will order/format it — run `bun run lint:fix` if lint complains about
import sorting).

**Verify**: `grep -n "runners/claude/format-event" src/cli/commands/logs.ts`
→ no matches; `bun run typecheck` → exit 0;
`bun test tests/unit/cli/logs-command.test.ts` → pass.

### Step 3: Document the `Bun.spawn` exception in `__entry.ts`

Replace the comment above the `Bun.spawn` call (line ~312) with one that names
the rule, e.g.:

```typescript
      // Deliberate CLAUDE.md rule-1 exception: this file IS a spawned child
      // process (the scripted-fake puppet's own entry point), not part of
      // orch's in-process tree — there is no ProcessService wired here to
      // route through. Output is intentionally discarded; `emit` is the
      // side-channel for test-visible content.
```

**Verify**: `grep -n "rule-1 exception" src/runners/scripted-fake/__entry.ts`
→ 1 match; `bun run lint` → exit 0.

### Step 4: Justify the cast in `parallel.ts`

Add above line 124:

```typescript
    // Empty input → empty tuple. TS can't prove `[]` satisfies the
    // heterogeneous AwaitedTuple<T> for an arbitrary T, so this is the one
    // sanctioned escape hatch in this file.
```

**Verify**: `bun run typecheck` → exit 0.

### Step 5: Add the tmux version check to preflight

After the existing `which tmux` check in `scripts/preflight-release.sh`, add:

```bash
# Must match MIN_TMUX_MAJOR/MIN_TMUX_MINOR in src/cli/detect-tmux.ts.
tmux_version=$(tmux -V | sed 's/^tmux //; s/[^0-9.].*$//')
tmux_major=${tmux_version%%.*}
tmux_minor=${tmux_version#*.}; tmux_minor=${tmux_minor%%.*}
[ "$tmux_major" -gt 3 ] || { [ "$tmux_major" -eq 3 ] && [ "${tmux_minor:-0}" -ge 3 ]; } \
  || fail "tmux >= 3.3 required for real-tmux tests (found: $(tmux -V))"
```

Note: tmux versions can carry letter suffixes (`3.5a`) — the `sed` strips
them before the numeric compare.

**Verify**: `bash -n scripts/preflight-release.sh` → exit 0. If tmux is
installed locally, run
`bash -c 'source /dev/stdin <<< "$(sed -n "1,5p" scripts/preflight-release.sh)"; true' 2>/dev/null; RUN_REAL_TMUX_E2E=1 bash scripts/preflight-release.sh`
— it should pass on a machine with claude + tmux ≥ 3.3, or fail with the new
clear message on an old tmux. If `claude` is absent locally, the script fails
on the earlier claude check — that's pre-existing behavior; confirm by reading
that your new block is syntactically after it and report.

### Step 6: Run the gates

**Verify**: `bun run lint && bun run typecheck && bun run test:unit` → all
exit 0.

## Test plan

No new tests — comments, deletions, and a shell guard. The existing
`tests/unit/cli/logs-command.test.ts` and integration logs tests protect
Step 2.

## Done criteria

- [ ] `git ls-files | grep "^rebase-"` → empty
- [ ] `grep -rn "runners/claude/format-event" src/cli/` → empty
- [ ] Rule-1 exception comment present in `__entry.ts`; cast comment present in `parallel.ts`
- [ ] `scripts/preflight-release.sh` rejects tmux < 3.3 with a clear message; `bash -n` clean
- [ ] `bun run lint`, `bun run typecheck`, `bun run test:unit` exit 0
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Anything besides docs references the rebase-*.txt files (grep first).
- `toClaudeTranscriptLines` is no longer exported from `src/runners/index.ts`.
- The `__entry.ts` `run-shell` handler has been restructured (the spawn moved
  or wrapped) since planning.
- You feel the urge to "fix" `dist-staging/` or `.env` — both are explicitly
  out of scope and intentionally present.

## Maintenance notes

- The preflight tmux constants are duplicated from `src/cli/detect-tmux.ts`
  by necessity (bash can't import TS). If the minimum ever changes, update
  both — the cross-reference comment in the script points the way.
- Deferred from the audit (not worth a plan, recorded here so it isn't
  re-audited): branded-`Path` gaps at two internal boundaries
  (`src/services/prompt/ink-runner.ts` returns `resultPath: string`;
  `src/runners/scripted-fake/interactive-core.ts:44` takes `path: string`) —
  internal orchestration paths, low risk, tighten opportunistically.
