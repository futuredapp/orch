#!/usr/bin/env bash
# Relocate the core/** test cluster from tests/ into tests-new/ (parent U10).
#
# A relocation is NOT a re-derivation (parent D1): each file is COPIED to its
# mirror path under tests-new/{unit,integration}/core, its two-or-three cross-
# tree HELPER specifiers rewritten to the `@orch/test/*` alias, and every other
# import (notably `../../../src/...` and the prompt-file `../../../../src/...`)
# left byte-identical — both old and new live the same depth from the repo root,
# so the relative `src/` depth is unchanged (PD3). The old copy stays on disk
# untouched here; U10.5 wraps it `.skip` (D2).
#
# `.test-d.ts` type-tests are NOT relocated (deferred to U13, PD1). The asset
# `_worktree-test-helpers.ts` is COPIED as a sibling (its old copy must remain so
# the still-resolving old skipped tests keep importing it via the shim).
#
# Idempotent: a target that already exists is left as-is.
set -euo pipefail
cd "$(dirname "$0")/.."

# Rewrite the three known cross-tree helper specifiers to the @orch/test alias.
# tests-new/ may never import from tests/ (D13); the alias resolves to
# tests-new/_support/ (tsconfig paths), where U10.2 moved fake-host/temp-git-repo
# and U1 moved type-assertions.
rewrite() {
  sed \
    -e "s#'\(\.\./\)\{2,3\}helpers/fake-host\.ts'#'@orch/test/fake-host.ts'#g" \
    -e "s#'\(\.\./\)\{2,3\}helpers/temp-git-repo\.ts'#'@orch/test/temp-git-repo.ts'#g" \
    -e "s#'\(\.\./\)\{2,3\}helpers/type-assertions\.ts'#'@orch/test/type-assertions.ts'#g"
}

copy_one() {
  local from="$1" to="$2"
  if [ -f "$to" ]; then
    echo "skip (exists): $to"
    return 0
  fi
  mkdir -p "$(dirname "$to")"
  rewrite < "$from" > "$to"
  echo "relocated: $from -> $to"
}

# --- unit/core: 38 top-level .test.ts + 6 prompt-file + 1 asset --------------
for f in tests/unit/core/*.test.ts; do
  copy_one "$f" "tests-new/unit/core/$(basename "$f")"
done
for f in tests/unit/core/prompt-file/*.test.ts; do
  copy_one "$f" "tests-new/unit/core/prompt-file/$(basename "$f")"
done
copy_one tests/unit/core/_worktree-test-helpers.ts tests-new/unit/core/_worktree-test-helpers.ts

# --- integration/core: 17 .test.ts -------------------------------------------
for f in tests/integration/core/*.test.ts; do
  copy_one "$f" "tests-new/integration/core/$(basename "$f")"
done

echo "done."
