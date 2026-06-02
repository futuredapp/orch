#!/usr/bin/env bash
#
# backup.sh — snapshot every branch involved (and main) as a tag before any
# history is rewritten. This is the undo button: rebase rewrites commits, and a
# bad rebase or a wrong conflict resolution is otherwise hard to recover. Tags
# are cheap, durable, and survive branch deletion.
#
# Tags are named  orch-backup/<slug>/<branch>  so they group in `git tag --list
# 'orch-backup/<slug>/*'` and are trivial to clean up later.
#
# Usage: backup.sh <slug> <branch> [<branch> ...]
#   <slug> is the run identifier, e.g. 20260602-1530-three-feats

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib.sh
source "$here/_lib.sh"

[ "$#" -ge 2 ] || die "usage: backup.sh <slug> <branch> [<branch> ...]"
slug="$1"; shift

made=()
for branch in "$@" main; do
  branch_exists "$branch" || die "branch does not exist: $branch"
  tag="$(backup_tag "$slug" "$branch")"
  if git show-ref --verify --quiet "refs/tags/$tag"; then
    warn "backup tag already exists, leaving it: $tag"
  else
    git tag "$tag" "$branch"
    made+=("$tag")
  fi
done

echo "=== BACKUP COMPLETE ==="
echo "slug: $slug"
echo ""
echo "tags created:"
printf '  %s\n' "${made[@]}"
echo ""
echo "to restore everything from this backup, run:"
echo "  scripts/restore-backup.sh $slug $*"
