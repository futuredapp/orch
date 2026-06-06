#!/usr/bin/env bash
# Move shared real-tmux + behavioral-dsl test infra into tests-new/_support/ (D13),
# leaving thin re-export shims at the old tests/helpers/** paths so the still-green
# old suite keeps resolving (R11). Idempotent: re-running is a no-op once moved.
#
# Why per-file shims and not just a barrel shim: the old suite DEEP-imports several
# internal files (real-tmux/fixture.ts in ~33 files, socket.ts, agent-handle.ts,
# keys.ts; behavioral-dsl internals). A barrel-only shim would not cover those.
#
# Structural note: tests/helpers/<X>/ and tests-new/_support/<X>/ are both exactly
# three directories deep from the repo root, so every `../../../src/...` and
# cross-helper relative import inside the moved files is preserved unchanged — the
# move is purely mechanical (git mv), no internal import edits required.
set -euo pipefail
cd "$(dirname "$0")/.."

move_dir() {
  local from="$1" to="$2"
  if [ -d "$to" ]; then
    echo "skip: $to already exists"
    return 0
  fi
  mkdir -p "$(dirname "$to")"
  git mv "$from" "$to"
  echo "moved: $from -> $to"
}

# Move a single helper FILE and leave a re-export shim at its old path. Both
# tests/helpers/<X>.ts and tests-new/_support/<X>.ts are two dirs deep from the
# repo root, so the moved file's own `../../src/...` imports are preserved
# unchanged (the same invariant as move_dir). Idempotent: once the target exists
# (and the old path is the shim) it is a no-op.
move_file() {
  local from="$1" to="$2" shim_target="$3"
  if [ -f "$to" ]; then
    echo "skip: $to already exists"
    return 0
  fi
  mkdir -p "$(dirname "$to")"
  git mv "$from" "$to"
  shim "$from" "$shim_target"
  echo "moved+shim: $from -> $to"
}

# A shim re-exports everything from the moved file at $2 (a path relative to the
# shim's own directory). Whole-module `export *` carries both values and types.
shim() {
  local shim_path="$1" target="$2"
  mkdir -p "$(dirname "$shim_path")"
  cat > "$shim_path" <<EOF
// MOVED → ${target#../}
// Thin re-export shim (D13/R11): the real module now lives under
// tests-new/_support/. This shim keeps still-green old-suite consumers that
// import this path resolving. Delete when the last old consumer is skipped.
export * from '${target}'
EOF
  echo "shim:  $shim_path"
}

move_dir tests/helpers/real-tmux       tests-new/_support/real-tmux
move_dir tests/helpers/behavioral-dsl  tests-new/_support/behavioral-dsl

# --- real-tmux shims (barrel + every deep-imported file) --------------------
RT='../../../tests-new/_support/real-tmux'
shim tests/helpers/real-tmux/index.ts        "$RT/index.ts"
shim tests/helpers/real-tmux/fixture.ts      "$RT/fixture.ts"
shim tests/helpers/real-tmux/socket.ts       "$RT/socket.ts"
shim tests/helpers/real-tmux/agent-handle.ts "$RT/agent-handle.ts"
shim tests/helpers/real-tmux/keys.ts         "$RT/keys.ts"

# --- behavioral-dsl shims (barrel + every deep-imported file) ---------------
BD='../../../tests-new/_support/behavioral-dsl'
shim tests/helpers/behavioral-dsl/index.ts             "$BD/index.ts"
shim tests/helpers/behavioral-dsl/outcome-matchers.ts  "$BD/outcome-matchers.ts"
shim tests/helpers/behavioral-dsl/pane-matchers.ts     "$BD/pane-matchers.ts"
shim tests/helpers/behavioral-dsl/user-actions.ts      "$BD/user-actions.ts"
shim tests/helpers/behavioral-dsl/workflow-matchers.ts "$BD/workflow-matchers.ts"

BDI='../../../../tests-new/_support/behavioral-dsl/internal'
shim tests/helpers/behavioral-dsl/internal/external-tmux-probe.ts "$BDI/external-tmux-probe.ts"
shim tests/helpers/behavioral-dsl/internal/invariants.ts          "$BDI/invariants.ts"
shim tests/helpers/behavioral-dsl/internal/lifecycle-handle.ts    "$BDI/lifecycle-handle.ts"
shim tests/helpers/behavioral-dsl/internal/mouse-events.ts        "$BDI/mouse-events.ts"
shim tests/helpers/behavioral-dsl/internal/snapshot.ts            "$BDI/snapshot.ts"

# --- single-file helper moves (parent U10 / PD2) ----------------------------
# fake-host (46 importers) and temp-git-repo (2) are needed by the relocated
# core tests under tests-new/, which may never import from tests/ (D13). They
# still have LIVE non-core consumers in the old suite, so each move leaves a
# shim until those consumers relocate (R11). Both already keep their internal
# `../../src/...` imports valid post-move (two dirs deep before and after).
move_file tests/helpers/fake-host.ts     tests-new/_support/fake-host.ts     ../../tests-new/_support/fake-host.ts
move_file tests/helpers/temp-git-repo.ts tests-new/_support/temp-git-repo.ts ../../tests-new/_support/temp-git-repo.ts

echo "done."
