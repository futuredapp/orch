#!/usr/bin/env bash
# Skip-as-migrated for Phase 7 (parent U7): wrap each fully-resolved old test
# file in `describe.skip` and prepend a `// MIGRATED → <new path>` marker (D2).
# A file is skipped ONLY when every child case is ledgered (D15) — so
# `subworkflow-parallel-suppression.test.ts` is intentionally NOT in this list
# (its end-to-end case is demote→integration for U10–U13; reconcile rule 3 keeps
# the file LIVE until that target exists).
#
# Idempotent: re-running is a no-op (skips files already marked).
set -euo pipefail
cd "$(dirname "$0")/.."

PM=tests/unit/hosts/two-pane/pane-map
SV=tests/unit/hosts/two-pane/steps-view

# old-file :: new-path(s) shown in the MIGRATED marker
mappings=(
  "$PM/right-pane-controller.test.ts::tests-new/model/controller/right-pane-controller-{sources,lifecycle}.test.ts"
  "$PM/right-pane-on-intent.test.ts::tests-new/model/controller/right-pane-on-intent.test.ts"
  "$PM/source-session.test.ts::tests-new/model/controller/source-session.test.ts"
  "$PM/right-pane-controller-banner.test.ts::tests-new/model/controller/right-pane-controller-banner.test.ts"
  "$PM/right-pane-controller-failure-recovery.test.ts::tests-new/model/controller/right-pane-controller-failure-recovery.test.ts"
  "$PM/right-pane-controller-session-lost.test.ts::tests-new/model/controller/right-pane-controller-session-lost.test.ts"
  "$PM/right-pane-controller-interactive-dead-pane.test.ts::tests-new/model/controller/right-pane-controller-interactive-dead-pane.test.ts"
  "$PM/right-pane-controller-replay-dead-pane.test.ts::tests-new/model/controller/right-pane-controller-replay-dead-pane.test.ts"
  "$PM/resume-refusal.test.ts::tests-new/model/controller/resume-refusal.test.ts"
  "$SV/subworkflow-boundary-projection.test.ts::tests-new/model/projector/subworkflow-boundary-projection.test.ts"
  "$SV/applySubworkflowEvent.test.ts::tests-new/model/projector/applySubworkflowEvent.test.ts"
  "$SV/subworkflow-collapse.test.tsx::tests-new/model/subworkflow--collapse-gutter.test.tsx"
  "$SV/subworkflow-boundary-selection.test.tsx::tests-new/model/subworkflow--boundary-selection.test.tsx"
)

for entry in "${mappings[@]}"; do
  file="${entry%%::*}"
  newpath="${entry##*::}"
  if [[ ! -f "$file" ]]; then
    echo "MISSING: $file" >&2
    exit 1
  fi
  if grep -q "MIGRATED → " "$file"; then
    echo "skip (already marked): $file"
    continue
  fi
  marker="// MIGRATED → $newpath (parent U7) — replaced by plain model/* category tests; kept skipped on disk (D2)."
  tmp="$(mktemp)"
  printf '%s\n' "$marker" > "$tmp"
  # Convert every top-level describe(...) to describe.skip(...).
  sed 's/^describe(/describe.skip(/' "$file" >> "$tmp"
  mv "$tmp" "$file"
  echo "skipped + marked: $file"
done
