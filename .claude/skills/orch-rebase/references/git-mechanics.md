# Git mechanics & recovery for orch-rebase

Read this when a script surprises you, before resolving a non-trivial conflict,
or when deciding whether to bail on a branch.

## Why rebase runs inside the worktree

Git enforces one checkout per branch across all worktrees. If `feat/x` is checked
out in `...--feat--x`, then from the main repo `git rebase feat/x` or
`git branch -f feat/x ...` fails with *"fatal: 'feat/x' is already used by
worktree at ..."*. So:

- **Moving a feature branch's HEAD** (rebase, reset) → must use
  `git -C <that branch's worktree>`. `rebase.sh` and `restore-backup.sh` do this.
- **Moving main** (the ff-merge) → must use `git -C <main's worktree>`.
  `merge-to-main.sh` does this.

`main_worktree()` in `_lib.sh` resolves the main checkout from
`git rev-parse --git-common-dir` so it works no matter where you invoke from.

## Why --ff-only is safe and order doesn't affect correctness

The pipeline rebases each branch onto the *current* main immediately before
merging it. After a clean rebase, the branch's history starts exactly at main's
tip, so merging it into main is a pure fast-forward: main just moves up to the
branch tip, no merge commit, no merge conflict possible at the merge step.

This is why merge **order** only changes how much *rebase* conflict you hit
(branches touching the same files fight when the second rebases onto a main that
already contains the first), never whether the result is correct. `merge-to-main.sh`
asserts the fast-forward precondition (`merge-base --is-ancestor main <branch>`)
and refuses rather than silently creating a merge commit if something is off.

## Resolving a rebase conflict well

When `rebase.sh` returns `RESULT: CONFLICT`, the rebase is paused in the
worktree. The goal is to preserve the **intent of both features**, not just to
make git stop complaining.

1. `git -C <worktree> diff --name-only --diff-filter=U` — the conflicted files
   (also printed by `rebase.sh`).
2. For each, read the conflict markers. `ours` (`<<<<<<<`) is what main already
   has (often a previously-merged sibling branch); `theirs` (`>>>>>>>`) is the
   commit being replayed from this branch.
3. Combine both intents. If branch A renamed a function and branch B added a call
   to the old name, the resolution keeps A's rename *and* updates B's call — not
   one side wins. This is exactly the cross-worktree interaction the conflict
   matrix flagged via shared files.
4. `git -C <worktree> add <files>` then `git -C <worktree> rebase --continue`.
   More commits may conflict; repeat.
5. If you can't resolve safely, `abort-rebase.sh <branch>`, mark it skipped, and
   tell the user. A skipped branch is fine; a wrong resolution is not.

## Semantic conflicts (the verify step)

A clean rebase + clean merge can still break the build: two branches that each
compiled alone can collide (duplicate exports, a changed signature the other
branch calls the old way, a test asserting behavior the other branch changed).
That's what `verify.sh` (`bun run check`) catches after each merge.

Fix **only** integration-caused breakage. Litmus test: *would this failure exist
if I checked out this branch alone, rebased on the old main?* If yes, it's
pre-existing — don't touch it, report it. If it only appears now that both
branches are together, it's yours to fix. Use `bun run lint:fix` for formatting;
commit the fix on main before re-verifying.

## Recovery cheat-sheet

- **Rebase got messy** → `abort-rebase.sh <branch>` (local undo of the in-flight
  rebase only).
- **Whole run is wrong** → `restore-backup.sh <slug> <branch>...` resets main and
  every target branch to the backup tags, aborting any in-flight rebase/merge
  first.
- **Inspect a backup** → `git show orch-backup/<slug>/<branch>`,
  `git log orch-backup/<slug>/main`.
- **Clean up backups when satisfied** →
  `git tag --list 'orch-backup/<slug>/*' | xargs -n1 git tag -d`.

## merge-tree prediction is a heuristic

`conflict-matrix.sh` uses `git merge-tree` to predict textual conflicts. It does
a three-way *merge* of trees; rebase *replays commits* one by one, so prediction
and reality can differ — a multi-commit branch may conflict during replay even if
the final tree merges clean, and vice versa. Treat "predicted CLEAN" as "probably
smooth" and "predicted CONFLICT" as "expect to resolve", not as guarantees. The
**shared-files** signal is the more reliable one for spotting behavioral
interactions, since it doesn't depend on textual overlap at all.
