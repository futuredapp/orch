#!/usr/bin/env bash
# Skip-as-migrated for Phase 11 (parent U11): now that every runners/** test has
# a green relocated twin under tests-new/{unit,integration}/runners, wrap each OLD
# runner test file `.skip` and prepend a `// MIGRATED → <new path>` marker (D2).
# The file stays on disk forever as a historical record (D2); it is never deleted.
#
# Two conversions (PD6):
#   `^describe(`            → `describe.skip(`         (the common case)
#   `^describe.skipIf(..)(` → `describe.skip(`         (capability-gated real files:
#                                                       claude-real, claude-e2e-lite,
#                                                       claude-structured-real,
#                                                       codex-real, cross-runner-parallel)
# Flipping skipIf → unconditional .skip on the OLD copy is required so U14's
# reconcile AST scan reads it as MIGRATED, not merely capability-skipped (R13).
# The NEW copy keeps its skipIf (legitimate capability gating survives, D8).
#
# Scope: the 36 `test`-classified runner files only (21 unit + 15 integration).
# There are NO `.test-d.ts` type-tests under runners/** (every baseline entry is
# `test`), so none are deferred. The script must NOT touch the relocated
# `_support` fixture copies. Every runner test file uses a top-level
# `describe(`/`describe.skipIf(` (verified), so no bare top-level `it(`/`test(`
# handling is needed.
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
  local marker="// MIGRATED → $newpath (parent U11) — relocated verbatim (import paths only); kept skipped on disk (D2)."
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

while IFS= read -r f; do skip_file "$f"; done < <(
  find tests/unit/runners tests/integration/runners -type f \
    \( -name '*.test.ts' -o -name '*.test.tsx' \) | sort
)

echo "done."
