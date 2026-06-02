#!/usr/bin/env bash
#
# install.sh — prepare an orch checkout (the main repo OR a git worktree) for use.
#
# Run automatically by `ccwt` after it creates a worktree, or by hand:
#
#     bash install.sh
#
# What it does
#   1. Installs dependencies with bun. This regenerates node_modules, including
#      the self-bin (node_modules/.bin/orch -> ../orch/src/cli/main.ts) that makes
#      `bunx orch` resolve to *this* checkout's src/cli/main.ts.
#   2. Seeds .env. Worktrees do not inherit untracked files, so when this is a
#      worktree we copy .env from the main repo; otherwise we fall back to
#      .env.example or an empty file.
#   3. Verifies `bunx orch` runs from here.
#
# Why this matters for parallel worktrees
#   Each worktree has its own node_modules, so its own `bunx orch`. Inside
#   worktree A, `bunx orch` runs A's code; inside the main repo it runs main's.
#   They never collide — run as many in parallel as you like.
#
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$here"

if ! command -v bun >/dev/null 2>&1; then
  echo "error: 'bun' is not installed or not on PATH." >&2
  echo "       install it from https://bun.sh then re-run: bash install.sh" >&2
  exit 1
fi

# --- locate the main repo root (works whether we're in main or a worktree) ---
main_root=""
common_dir="$(git rev-parse --git-common-dir 2>/dev/null || true)"
if [[ -n "$common_dir" ]]; then
  # --git-common-dir can be relative to cwd; resolve it, then its parent is the
  # main working tree's root.
  common_dir="$(cd "$common_dir" && pwd)"
  main_root="$(dirname "$common_dir")"
fi

is_worktree=false
if [[ -n "$main_root" && "$main_root" != "$here" ]]; then
  is_worktree=true
fi

# --- 1. dependencies ---
echo "==> bun install"
bun install

# --- 1b. self-bin so `bunx orch` resolves to THIS checkout ---
# A fresh `bun install` does NOT link a package's own bin into node_modules/.bin,
# so `bunx orch` would otherwise fail ("could not determine executable") in a new
# worktree. We recreate the two symlinks the main repo already carries:
#   node_modules/orch        -> ..                      (self-link to checkout root)
#   node_modules/.bin/orch   -> ../orch/src/cli/main.ts (resolves to THIS src/)
# -n replaces an existing symlink instead of nesting inside it (idempotent).
echo "==> linking 'orch' bin to this checkout"
mkdir -p node_modules/.bin
ln -sfn .. node_modules/orch
ln -sfn ../orch/src/cli/main.ts node_modules/.bin/orch
chmod +x src/cli/main.ts 2>/dev/null || true

# --- 2. .env ---
if [[ -f .env ]]; then
  echo "==> .env already present — leaving it untouched"
elif [[ "$is_worktree" == true && -f "$main_root/.env" ]]; then
  echo "==> copying .env from main repo: $main_root/.env"
  cp "$main_root/.env" .env
elif [[ -f .env.example ]]; then
  echo "==> seeding .env from .env.example"
  cp .env.example .env
else
  echo "==> creating empty .env"
  : > .env
fi

# --- 3. verify worktree-local orch ---
echo "==> verifying 'bunx orch' resolves to this checkout"
if bunx orch --help >/dev/null 2>&1; then
  target="$(readlink node_modules/.bin/orch 2>/dev/null || echo '?')"
  echo "    ok — node_modules/.bin/orch -> $target"
else
  echo "    WARNING: 'bunx orch' did not run from here. Try 'bun install' again." >&2
fi

echo ""
echo "Ready. From inside this directory:"
echo "  bunx orch run <workflow>      # uses THIS checkout's orch"
echo "  bunx orch runs                # list recent runs"
echo "  bunx orch --help"
if [[ "$is_worktree" == true ]]; then
  echo ""
  echo "This is a worktree of $main_root."
  echo "Its 'bunx orch' is independent of the main repo's — safe to run in parallel."
fi
