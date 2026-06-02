#!/usr/bin/env bash
#
# abort-rebase.sh — bail out of an in-progress rebase in a branch's worktree,
# returning it to where it was before rebase.sh started. Use when conflicts are
# too gnarly to resolve now and you'd rather skip this branch for the run.
# (The branch content is also recoverable from the backup tag; this is just the
# quick, local undo.)
#
# Usage: abort-rebase.sh <branch>

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib.sh
source "$here/_lib.sh"

[ "$#" -eq 1 ] || die "usage: abort-rebase.sh <branch>"
branch="$1"
wt="$(worktree_for_branch "$branch" || true)"
[ -n "$wt" ] || die "$branch is not checked out in any worktree"

wt_gitdir="$(git -C "$wt" rev-parse --absolute-git-dir)"
if [ -d "$wt_gitdir/rebase-merge" ] || [ -d "$wt_gitdir/rebase-apply" ]; then
  git -C "$wt" rebase --abort
  echo "aborted rebase of $branch (worktree restored: $wt)"
else
  echo "no rebase in progress for $branch — nothing to abort"
fi
