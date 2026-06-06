#!/usr/bin/env bash
# Relocate test files old→new for Phase 13 (parent U13), reusing the U10–U12
# recipe (PD1/PD2): byte-copy each file into its new home, rewriting ONLY the
# cross-tree helper specifiers to the `@orch/test/*` alias. `src/` imports are
# depth-preserved for same-depth moves and stay unchanged; the import-parity
# guard (check:import-parity) is the per-file acceptance gate.
#
# Rewrites applied (PD2):
#   (../)+[tests/]helpers/X   → @orch/test/X          (make-step-entry, fake-host,
#                                                       real-tmux, type-assertions,
#                                                       behavioral-dsl/**)
#   (../)+setup/reap-test-sockets → @orch/test/setup/reap-test-sockets  (D13 setup move)
#
# Usage: scripts/relocate-u13.sh <old> <new> [<old> <new> ...]
set -euo pipefail
cd "$(dirname "$0")/.."

relocate_one() {
  local old="$1" new="$2"
  if [[ ! -f "$old" ]]; then
    echo "MISSING old: $old" >&2
    exit 1
  fi
  mkdir -p "$(dirname "$new")"
  sed -E \
    -e 's#(\.\./)+(tests/)?helpers/#@orch/test/#g' \
    -e 's#(\.\./)+setup/reap-test-sockets#@orch/test/setup/reap-test-sockets#g' \
    "$old" > "$new"
  echo "relocated: $old → $new"
}

if (( $# % 2 != 0 )); then
  echo "usage: $0 <old> <new> [<old> <new> ...]" >&2
  exit 2
fi

while (( $# >= 2 )); do
  relocate_one "$1" "$2"
  shift 2
done
echo "done."
