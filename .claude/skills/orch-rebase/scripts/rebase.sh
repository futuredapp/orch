#!/usr/bin/env bash
#
# rebase.sh — rebase ONE feature branch onto the current main, run inside that
# branch's own worktree (git won't rebase a branch checked out elsewhere).
#
# Outcomes, all reported in a machine-greppable RESULT line so the driver can
# branch on them without re-running git:
#   RESULT: CLEAN     — rebase finished, branch now sits on top of main, ready to
#                       merge. Nothing left half-done.
#   RESULT: CONFLICT  — rebase is PAUSED mid-replay with conflicts. The worktree
#                       is left in that state on purpose so the conflicts can be
#                       resolved there; the conflicted files + git status are
#                       printed. Resolve, `git add`, `git rebase --continue` in
#                       the worktree (or abort-rebase.sh to bail).
#   RESULT: REFUSED   — a precondition failed (dirty tree, missing branch). No
#                       state changed.
#
# Usage: rebase.sh <branch>

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib.sh
source "$here/_lib.sh"

[ "$#" -eq 1 ] || die "usage: rebase.sh <branch>"
branch="$1"

branch_exists "$branch" || { echo "RESULT: REFUSED (no such branch: $branch)"; exit 2; }
wt="$(worktree_for_branch "$branch" || true)"
[ -n "$wt" ] || { echo "RESULT: REFUSED ($branch is not checked out in any worktree)"; exit 2; }

if worktree_is_dirty "$wt"; then
  echo "RESULT: REFUSED ($branch worktree has uncommitted changes — commit or stash first)"
  echo "--- git status ($wt) ---"
  git -C "$wt" status --short
  exit 2
fi

# Refuse if a rebase/merge is already in flight in that worktree. In a linked
# worktree .git is a file pointing at the real per-worktree git dir, so resolve
# that (absolute) and look for the rebase/merge state there.
wt_gitdir="$(git -C "$wt" rev-parse --absolute-git-dir)"
if [ -d "$wt_gitdir/rebase-merge" ] || [ -d "$wt_gitdir/rebase-apply" ] || \
   git -C "$wt" rev-parse -q --verify MERGE_HEAD >/dev/null 2>&1; then
  echo "RESULT: REFUSED ($branch worktree is mid-rebase/merge — finish or abort it first)"
  git -C "$wt" status --short
  exit 2
fi

echo "rebasing $branch onto $BASE (in $wt) ..."
if git -C "$wt" rebase "$BASE"; then
  echo "RESULT: CLEAN ($branch is now on top of $BASE)"
  exit 0
fi

# Rebase stopped with conflicts — leave it paused and report everything.
echo ""
echo "RESULT: CONFLICT ($branch rebase paused with conflicts)"
echo "--- conflicted files ---"
git -C "$wt" diff --name-only --diff-filter=U
echo ""
echo "--- git status ---"
git -C "$wt" status --short
echo ""
echo "resolve in: $wt"
echo "  then: git -C '$wt' add <files> && git -C '$wt' rebase --continue"
echo "  or bail: scripts/abort-rebase.sh $branch"
exit 1
