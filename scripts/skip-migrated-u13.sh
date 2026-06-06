#!/usr/bin/env bash
# Skip-as-migrated for Phase 13 (parent U13): the FINAL relocation phase. Every
# old file U13 *fully* migrated (cli, observability, remaining e2e, type-tests,
# the classified tmux adapter/harness set, the behavioral-dsl helper tests, the
# stragglers, and the tui-overlay pure-codec demote) now has a green twin under
# tests-new/. Wrap each OLD file `.skip` and prepend a `// MIGRATED → <new path>`
# marker (D2). The file stays on disk forever as a historical record; it is never
# deleted.
#
# Conversions (PD7), mirroring skip-migrated-u11/u12.sh:
#   `^describe(`            → `describe.skip(`
#   `^describe.skipIf(..)(` → `describe.skip(`   (R13 — so U14 reconcile reads the
#                                                  OLD copy as MIGRATED, not merely
#                                                  capability-skipped; the NEW copy
#                                                  keeps its skipIf, legitimate D8)
#   `^it(` / `^test(`       → `it.skip(` / `test.skip(`   (top-level cases)
#   `^it.skipIf(..)(` / `^test.skipIf(..)(` → `.skip(`
# `.test-d.ts` type-tests have no runtime case to skip — they only get the marker.
#
# DRIVEN BY AN EXPLICIT LIST (not a directory walk) because U13's migrated files
# are scattered across many dirs that ALSO contain still-LIVE files (the mixed
# Category-A extracts adaptive-columns / subworkflow-parallel-suppression, the
# flagged real-tmux/host behavioral demotes auto-stop / per-step-artifacts /
# resume / command, and the Category-B group-B render leftovers). A walk would
# risk skipping a LIVE file; the explicit list is the safe contract. The list of
# files NEVER to touch is therefore simply "anything not on this list".
#
# Idempotent: a file already carrying a MIGRATED marker is skipped. A file with
# no relocated twin under tests-new/ aborts the run (refuses to skip blindly).
set -euo pipefail
cd "$(dirname "$0")/.."

LIST="${1:-tests-new/_migration/u13-skip-list.txt}"
if [[ ! -f "$LIST" ]]; then
  echo "missing skip-list: $LIST" >&2
  exit 2
fi

skip_file() {
  local file="$1"
  local newpath="${2:-${file/tests\//tests-new/}}"
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
  local marker="// MIGRATED → $newpath (parent U13) — relocated verbatim (import paths only); kept skipped on disk (D2)."
  local tmp
  tmp="$(mktemp)"
  printf '%s\n' "$marker" > "$tmp"
  # Greedy `.*\)\(` spans a skipIf predicate that itself contains parens
  # (e.g. `!canRunRealTmux()`), which a `[^)]*` class cannot.
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

# List format: one path per line — either "<old>" (mirror twin) or "<old>\t<new>"
# (explicit twin for non-mirror relocations). Blank lines / # comments ignored.
while IFS= read -r line; do
  [[ -z "$line" || "$line" == \#* ]] && continue
  old="${line%%$'\t'*}"
  new="${line#*$'\t'}"
  if [[ "$new" == "$old" ]]; then skip_file "$old"; else skip_file "$old" "$new"; fi
done < "$LIST"

echo "done."
