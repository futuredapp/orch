#!/usr/bin/env bash
#
# merge-to-main.sh — fast-forward main up to a branch that has ALREADY been
# rebased onto main (run rebase.sh first). Because the branch sits directly on
# main's tip, --ff-only moves main forward with no merge commit and no chance of
# a surprise conflict here — if it's not a fast-forward, something is wrong and
# we stop loudly rather than inventing a merge.
#
#   RESULT: MERGED   — main now points at the branch tip.
#   RESULT: REFUSED  — not a fast-forward, or a precondition failed. main
#                      untouched.
#
# Usage: merge-to-main.sh <branch>

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib.sh
source "$here/_lib.sh"

[ "$#" -eq 1 ] || die "usage: merge-to-main.sh <branch>"
branch="$1"
branch_exists "$branch" || { echo "RESULT: REFUSED (no such branch: $branch)"; exit 2; }

main_wt="$(main_worktree)" || die "could not locate main worktree"

if worktree_has_tracked_changes "$main_wt"; then
  echo "RESULT: REFUSED (main worktree has uncommitted tracked changes: $main_wt)"
  git -C "$main_wt" status --short --untracked-files=no
  exit 2
fi

# main must be the branch checked out in the main worktree.
cur="$(git -C "$main_wt" rev-parse --abbrev-ref HEAD)"
[ "$cur" = "main" ] || { echo "RESULT: REFUSED (main worktree is on '$cur', not main)"; exit 2; }

# Sanity: the branch should be ahead of main and contain it (true ff candidate).
if ! git -C "$main_wt" merge-base --is-ancestor main "$branch"; then
  echo "RESULT: REFUSED ($branch does not contain current main — rebase it first)"
  exit 2
fi

before="$(git -C "$main_wt" rev-parse main)"
if git -C "$main_wt" merge --ff-only "$branch"; then
  after="$(git -C "$main_wt" rev-parse main)"
  echo "RESULT: MERGED (main $before -> $after via $branch)"
  exit 0
fi

echo "RESULT: REFUSED (fast-forward of main to $branch failed)"
exit 1
