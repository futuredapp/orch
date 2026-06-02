#!/usr/bin/env bash
#
# analyze-worktree.sh — dump the raw material a subagent needs to describe ONE
# worktree: what files changed, how much, and the commit story. The subagent
# turns this into a human summary ("what it does / what it changes"); this
# script just gathers facts cheaply in one shot so the agent doesn't fire a
# dozen git commands itself.
#
# Usage: analyze-worktree.sh <branch>

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib.sh
source "$here/_lib.sh"

[ "$#" -eq 1 ] || die "usage: analyze-worktree.sh <branch>"
branch="$1"
branch_exists "$branch" || die "branch does not exist: $branch"

range="main...$branch"

echo "=== WORKTREE ANALYSIS: $branch ==="
echo "ahead of main:  $(ahead_count "$branch") commit(s)"
echo "behind main:    $(behind_count "$branch") commit(s)"
echo "merge base:     $(git merge-base main "$branch")"
echo ""

echo "--- commits (newest first) ---"
git log --no-merges --format='  %h  %s' "main..$branch"
echo ""

echo "--- changed files (status + churn) ---"
git diff --stat "$range"
echo ""

echo "--- name-status (A/M/D/R) ---"
git diff --name-status "$range"
echo ""

echo "--- full diff follows (read to understand behavior changes) ---"
git diff "$range"
