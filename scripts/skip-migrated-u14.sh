#!/usr/bin/env bash
# Skip-as-migrated for Phase 14 (group-B closeout). Unlike U10–U13 (which had a
# single MIGRATED marker per relocated file), the closeout dispositions group-B
# files as a MIX of `skip-as-covered` / `re-derive` / `demote-relocate` / `drop`,
# so the marker text varies per file. This helper therefore takes the FULL marker
# line per file rather than deriving a `tests/→tests-new/` mirror.
#
# Conversion mirrors skip-migrated-u13.sh exactly (R13: skipIf → skip on the OLD
# copy so U14 reconcile reads it as MIGRATED, not capability-skipped):
#   `^describe(` / `^describe.skipIf(..)(` → `describe.skip(`
#   `^it(` / `^test(`                       → `it.skip(` / `test.skip(`
#   `^it.skipIf(..)(` / `^test.skipIf(..)(` → `.skip(`
# `.test-d.ts` type-tests get the marker only (no runtime case).
#
# DRIVEN BY A TSV LIST: `<oldfile>\t<marker-line>` (tab-separated). Blank lines and
# `#` comments are ignored. Idempotent: a file already carrying a `// MIGRATED →`
# / `// COVERED BY →` / `// DROPPED →` marker is left untouched.
set -euo pipefail
cd "$(dirname "$0")/.."

LIST="${1:-tests-new/_migration/closeout/u14-skip-list.tsv}"
if [[ ! -f "$LIST" ]]; then
  echo "missing skip-list: $LIST" >&2
  exit 2
fi

skip_file() {
  local file="$1"
  local marker="$2"
  if [[ ! -f "$file" ]]; then
    echo "MISSING: $file" >&2
    exit 1
  fi
  if grep -qE "// (MIGRATED|COVERED BY|DROPPED) → " "$file"; then
    echo "skip (already marked): $file"
    return 0
  fi
  local tmp
  tmp="$(mktemp)"
  printf '%s\n' "$marker" > "$tmp"
  sed -E \
    -e 's/^describe\.skipIf\(.*\)\(/describe.skip(/' \
    -e 's/^describe\(/describe.skip(/' \
    -e 's/^it\.skipIf\(.*\)\(/it.skip(/' \
    -e 's/^test\.skipIf\(.*\)\(/test.skip(/' \
    -e 's/^it\(/it.skip(/' \
    -e 's/^test\(/test.skip(/' \
    "$file" >> "$tmp"
  mv "$tmp" "$file"
  echo "skipped + marked: $file"
}

while IFS=$'\t' read -r file marker; do
  [[ -z "${file:-}" || "$file" == \#* ]] && continue
  skip_file "$file" "$marker"
done < "$LIST"

echo "done."
