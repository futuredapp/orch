#!/usr/bin/env bash
#
# restore-backup.sh — put every branch (and main) back to where backup.sh
# tagged it. Use this if a rebase went wrong, a conflict was resolved badly, or
# you simply want to bail out of a run.
#
# A branch that is checked out in a worktree can't be moved with `git branch -f`,
# so for those we `reset --hard` inside their worktree. Any in-progress rebase in
# a worktree is aborted first.
#
# Usage: restore-backup.sh <slug> <branch> [<branch> ...]

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib.sh
source "$here/_lib.sh"

[ "$#" -ge 2 ] || die "usage: restore-backup.sh <slug> <branch> [<branch> ...]"
slug="$1"; shift

main_wt="$(main_worktree)" || die "could not locate main worktree"

restore_one() {
  local branch="$1" tag wt
  tag="$(backup_tag "$slug" "$branch")"
  git show-ref --verify --quiet "refs/tags/$tag" || { warn "no backup tag for $branch ($tag) — skipping"; return; }

  wt="$(worktree_for_branch "$branch" || true)"
  if [ -n "$wt" ]; then
    # abort any half-finished rebase, then hard-reset to the snapshot
    git -C "$wt" rebase --abort 2>/dev/null || true
    git -C "$wt" merge --abort 2>/dev/null || true
    git -C "$wt" reset --hard "$tag"
    echo "restored (worktree): $branch -> $tag"
  else
    git branch -f "$branch" "$tag"
    echo "restored (ref):      $branch -> $tag"
  fi
}

# base first so feature branches land on a known-good base
restore_one "$BASE"
for branch in "$@"; do
  [ "$branch" = "$BASE" ] && continue
  restore_one "$branch"
done

echo ""
echo "=== RESTORE COMPLETE ==="
echo "backup tags were left in place; remove them with:"
echo "  git tag --list 'orch-backup/$slug/*' | xargs -n1 git tag -d"
