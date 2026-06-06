#!/usr/bin/env bash
# Skip-as-migrated for Phase 12 (parent U12): now that every relocated
# services(excl tmux)/state/validators/workflows/config/codegen/hosts(non-two-pane)
# test has a green twin under tests-new/{unit,integration}, wrap each OLD file
# `.skip` and prepend a `// MIGRATED → <new path>` marker (D2). The file stays on
# disk forever as a historical record (D2); it is never deleted.
#
# Two conversions (PD7), identical to skip-migrated-u11.sh:
#   `^describe(`            → `describe.skip(`         (the common case)
#   `^describe.skipIf(..)(` → `describe.skip(`         (capability-gated file:
#                                                       ink-prompt-service-real)
# Flipping skipIf → unconditional .skip on the OLD copy is required so U14's
# reconcile AST scan reads it as MIGRATED, not merely capability-skipped (R13).
# The NEW copy keeps its skipIf (legitimate capability gating survives, D8).
#
# HARD EXCLUSIONS (PD5/PD8) — these are pruned from the file walk and must NEVER
# be touched by this script:
#   - tests/{unit,integration}/services/tmux/**     (→ U13 tmux classification)
#   - tests/integration/hosts/two-pane-*.test.ts    (→ group B / U14 closeout)
#   - tests/**/two-pane/**                            (already migrated by group B)
#   - tests/helpers/make-step-entry.ts (the shim) + any tests-new/_support file
#
# Idempotent: a file already carrying a MIGRATED marker is skipped. A file with
# no relocated twin under tests-new/ aborts the run (refuses to skip blindly).
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
  local marker="// MIGRATED → $newpath (parent U12) — relocated verbatim (import paths only); kept skipped on disk (D2)."
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
  find \
    tests/unit/services tests/unit/state tests/unit/validators \
    tests/unit/workflows tests/unit/config tests/unit/codegen tests/unit/hosts \
    tests/integration/services tests/integration/state tests/integration/validators \
    tests/integration/workflows tests/integration/codegen tests/integration/hosts \
    -type f \( -name '*.test.ts' -o -name '*.test.tsx' \) \
    -not -path '*/tmux/*' \
    -not -path '*/two-pane/*' \
    -not -name 'two-pane-*.test.ts' \
    | sort
)

echo "done."
