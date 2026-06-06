#!/usr/bin/env bash
# Skip-as-migrated for Phase 10 (parent U10): now that every core test has a
# green relocated twin under tests-new/{unit,integration}/core, wrap each OLD
# core test file `.skip` and prepend a `// MIGRATED → <new path>` marker (D2).
# The file stays on disk forever as a historical record (D2); it is never deleted.
#
# Two conversions (PD6):
#   `^describe(`            → `describe.skip(`         (the common case)
#   `^describe.skipIf(..)(` → `describe.skip(`         (capability-gated real files:
#                                                       commit-real, worktree-real)
# Flipping skipIf → unconditional .skip on the OLD copy is required so U14's
# reconcile AST scan reads it as MIGRATED, not merely capability-skipped (R13).
# The NEW copy keeps its skipIf (legitimate capability gating survives, D8).
#
# Scope: the 61 `test`-classified files only. It must NOT touch the 6 deferred
# `.test-d.ts` (→ U13, PD1) or the relocated `_worktree-test-helpers.ts` asset.
# Every core test file uses a top-level `describe(`/`describe.skipIf(` (verified),
# so no bare top-level `it(`/`test(` handling is needed.
#
# Idempotent: a file already carrying a MIGRATED marker is skipped.
set -euo pipefail
cd "$(dirname "$0")/.."

skip_file() {
  local file="$1"
  local newpath="${file/tests\//tests-new/}"
  if [[ ! -f "$file" ]]; then
    echo "MISSING: $file" >&2
    exit 1
  fi
  if [[ ! -f "$newpath" ]]; then
    echo "NO RELOCATED TWIN: $newpath (refusing to skip $file)" >&2
    exit 1
  fi
  if grep -q "MIGRATED → " "$file"; then
    echo "skip (already marked): $file"
    return 0
  fi
  local marker="// MIGRATED → $newpath (parent U10) — relocated verbatim (import paths only); kept skipped on disk (D2)."
  local tmp
  tmp="$(mktemp)"
  printf '%s\n' "$marker" > "$tmp"
  # describe.skipIf(<pred>)( → describe.skip(   AND   describe( → describe.skip(
  sed -E \
    -e 's/^describe\.skipIf\([^)]*\)\(/describe.skip(/' \
    -e 's/^describe\(/describe.skip(/' \
    "$file" >> "$tmp"
  mv "$tmp" "$file"
  echo "skipped + marked: $file"
}

for f in tests/unit/core/*.test.ts; do skip_file "$f"; done
for f in tests/unit/core/prompt-file/*.test.ts; do skip_file "$f"; done
for f in tests/integration/core/*.test.ts; do skip_file "$f"; done

echo "done."
