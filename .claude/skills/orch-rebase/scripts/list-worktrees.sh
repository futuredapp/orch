#!/usr/bin/env bash
#
# list-worktrees.sh — show every worktree branch that is a candidate for
# rebase+merge into main, with the facts needed to confirm targets and spot
# problems before touching anything.
#
# Output is one block per worktree, plus a DIRTY summary at the end so the
# driver can refuse early. main itself and detached worktrees are skipped.
#
# Usage: list-worktrees.sh

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib.sh
source "$here/_lib.sh"

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "not inside a git repository"
git fetch --quiet 2>/dev/null || true   # refresh main if there's a remote; ignore if offline

dirty_list=()

path=""; branch=""
while IFS= read -r line; do
  case "$line" in
    "worktree "*) path="${line#worktree }" ;;
    "branch "*) branch="${line#branch }"; branch="${branch#refs/heads/}" ;;
    "")
      if [ -n "$branch" ] && [ "$branch" != "$BASE" ]; then
        ahead="$(ahead_count "$branch" 2>/dev/null || echo '?')"
        behind="$(behind_count "$branch" 2>/dev/null || echo '?')"
        files="$(git diff --name-only "$BASE...$branch" 2>/dev/null | wc -l | tr -d ' ')"
        dirty="clean"
        if worktree_is_dirty "$path"; then dirty="DIRTY"; dirty_list+=("$branch"); fi
        echo "branch:   $branch"
        echo "path:     $path"
        echo "ahead:    $ahead commit(s) ahead of $BASE"
        echo "behind:   $behind commit(s) behind $BASE"
        echo "files:    $files changed vs $BASE"
        echo "state:    $dirty"
        echo ""
      fi
      path=""; branch=""
      ;;
  esac
done < <(git worktree list --porcelain; echo "")

if [ "${#dirty_list[@]}" -gt 0 ]; then
  echo "=== DIRTY WORKTREES (must be committed or stashed before rebase) ==="
  printf '  - %s\n' "${dirty_list[@]}"
fi
