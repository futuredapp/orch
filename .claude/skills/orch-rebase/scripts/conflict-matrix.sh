#!/usr/bin/env bash
#
# conflict-matrix.sh — predict, without touching the working tree, where rebase
# pain and behavioral interactions will come from. Two signals:
#
#   1. file overlap  — files changed by BOTH branches. Reliable and cheap. Even
#      when text doesn't conflict, two branches editing the same file (or one
#      editing what another renames/deletes) is where "feature A silently
#      changes feature B's behavior" hides. This is what the user most wants
#      flagged.
#   2. merge-tree    — `git merge-tree` does a real in-memory three-way merge and
#      reports textual CONFLICTs. A heuristic for rebase (rebase replays commits,
#      merge-tree merges trees) but a good early-warning for "this will fight".
#
# Both are computed vs main AND pairwise between branches. The pairwise section
# is what informs merge ORDER: land the branch that conflicts least with the
# others first, so the rest rebase onto a main that already contains it.
#
# Usage: conflict-matrix.sh <branch> [<branch> ...]

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib.sh
source "$here/_lib.sh"

[ "$#" -ge 1 ] || die "usage: conflict-matrix.sh <branch> [<branch> ...]"
branches=("$@")
for b in "${branches[@]}"; do branch_exists "$b" || die "branch does not exist: $b"; done

changed_files() { git diff --name-only "main...$1"; }

# Does an in-memory three-way merge of two refs conflict? Returns 0 = clean,
# 1 = conflict. We only trust the exit code, not the stdout: merge-tree's
# conflict report format varies across git versions (it interleaves
# "Auto-merging"/"CONFLICT" messages with paths), so for the actual file names
# we rely on the reliably-computed shared-file list instead.
merge_tree_conflicts() {
  git merge-tree --write-tree "$1" "$2" >/dev/null 2>&1
}

echo "=== VS MAIN (rebase difficulty per branch) ==="
for b in "${branches[@]}"; do
  n_files="$(changed_files "$b" | wc -l | tr -d ' ')"
  if merge_tree_conflicts main "$b"; then
    echo "  $b: $n_files files changed — predicted CLEAN onto main"
  else
    echo "  $b: $n_files files changed — predicted CONFLICTS onto main (changed files):"
    changed_files "$b" | sed 's/^/      /'
  fi
done
echo ""

echo "=== PAIRWISE (cross-worktree interactions) ==="
echo "(branches sharing files may change each other's behavior even without a"
echo " textual conflict — review these regions during integration)"
echo ""
n="${#branches[@]}"
for ((i = 0; i < n; i++)); do
  for ((j = i + 1; j < n; j++)); do
    a="${branches[$i]}"; b="${branches[$j]}"
    overlap="$(comm -12 <(changed_files "$a" | sort) <(changed_files "$b" | sort))"
    textual_conflict=no
    merge_tree_conflicts "$a" "$b" || textual_conflict=yes
    if [ -z "$overlap" ] && [ "$textual_conflict" = no ]; then
      echo "  $a  x  $b: independent (no shared files, no predicted conflict)"
    else
      echo "  $a  x  $b:"
      if [ -n "$overlap" ]; then
        echo "    shared files:"
        echo "$overlap" | sed 's/^/      /'
      fi
      echo "    predicted textual conflict: $textual_conflict"
    fi
  done
done
echo ""

echo "=== ORDERING HINT ==="
echo "Fewest shared-file entanglements first tends to minimize total conflict"
echo "work. Branches flagged 'predicted CONFLICTS onto main' above will need a"
echo "human (or careful agent) resolution step regardless of order."
