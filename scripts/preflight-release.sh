#!/usr/bin/env bash
# Release preflight: asserts the environment is ready for check:release.
# Fails fast if RUN_REAL_TMUX_E2E=1 is not set or required binaries are absent.
set -euo pipefail

fail() { echo "ERROR: $1" >&2; exit 1; }

[ "${RUN_REAL_TMUX_E2E:-}" = "1" ] \
  || fail "RUN_REAL_TMUX_E2E=1 must be set to run check:release (real-agent tests would silently skip otherwise)"

which claude > /dev/null 2>&1 \
  || fail "'claude' binary not found on PATH (required for real-agent tests)"

which tmux > /dev/null 2>&1 \
  || fail "'tmux' binary not found on PATH (required for real-tmux tests)"
