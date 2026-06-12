#!/usr/bin/env bash
#
# _lib.sh — shared helpers for the orch-rebase scripts.
# Sourced, never run directly. All functions print errors to stderr and use
# return codes; callers decide whether to exit.
#
# The one git fact that shapes everything here: a branch that is checked out in
# a worktree CANNOT be rebased or reset from another worktree — git refuses with
# "is already checked out". So anything that moves a feature branch's HEAD must
# run with `git -C <that branch's worktree>`, and anything that touches main
# must run with `git -C <main's worktree>`.

set -euo pipefail

# Base branch every feature branch is rebased onto and merged into. Defaults to
# `main` (the original, hardcoded behaviour). Override with ORCH_BASE=<branch>
# to integrate onto a different base (e.g. develop, or an integration branch
# checked out in its own worktree). When the base is itself checked out in a
# worktree, the merge happens in THAT worktree, not the primary repo.
BASE="${ORCH_BASE:-main}"

die() { echo "error: $*" >&2; exit 1; }
warn() { echo "warning: $*" >&2; }

# Absolute path of the main repository's working tree (the one with .git as a
# real directory), regardless of which worktree we were invoked from.
main_worktree() {
  local common_dir
  common_dir="$(git rev-parse --git-common-dir 2>/dev/null)" || return 1
  ( cd "$common_dir" && cd .. && pwd )
}

# Path of the worktree that currently has $1 checked out, or empty + return 1.
worktree_for_branch() {
  local target="$1" path="" branch=""
  while IFS= read -r line; do
    case "$line" in
      "worktree "*) path="${line#worktree }" ;;
      "branch "*)
        branch="${line#branch }"
        branch="${branch#refs/heads/}"
        [ "$branch" = "$target" ] && { echo "$path"; return 0; }
        ;;
      "") path=""; branch="" ;;
    esac
  done < <(git worktree list --porcelain)
  return 1
}

branch_exists() { git show-ref --verify --quiet "refs/heads/$1"; }

# True if the working tree at $1 has uncommitted changes (staged or not, incl.
# untracked). Empty output from --porcelain means clean.
worktree_is_dirty() {
  [ -n "$(git -C "$1" status --porcelain)" ]
}

# True if the working tree at $1 has uncommitted *tracked* changes (staged or
# not), ignoring untracked files. A `--ff-only` merge is safe in the presence of
# untracked files — git itself refuses only if an incoming tracked file would
# clobber an untracked one — so the merge gate uses this looser check. That lets
# the run-doc and any unrelated untracked work coexist with the merge instead of
# blocking it. Tracked, uncommitted edits still block: those can be lost by a
# checkout-style fast-forward and are the user's to resolve.
worktree_has_tracked_changes() {
  [ -n "$(git -C "$1" status --porcelain --untracked-files=no)" ]
}

# Path of the worktree where the merge into BASE must happen. If BASE is checked
# out in a worktree (the develop/integration-branch case), that worktree wins;
# otherwise fall back to the primary repo (the classic `main` case where main is
# not separately checked out).
base_worktree() {
  worktree_for_branch "$BASE" 2>/dev/null || main_worktree
}

# Commits on $1 that are not on BASE (three-dot range from the merge base).
ahead_count() { git rev-list --count "$BASE..$1"; }
behind_count() { git rev-list --count "$1..$BASE"; }

# Sanitize a branch name for use inside a tag path component is unnecessary —
# tags accept slashes — but we expose the backup tag name in one place so every
# script agrees on the convention.
backup_tag() { echo "orch-backup/$1/$2"; }   # <slug> <branch-or-main>
