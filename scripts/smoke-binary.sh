#!/usr/bin/env bash
#
# smoke-binary.sh — prove a compiled `orch` binary actually works with NO Bun
# and NO node_modules on disk. This is the release gate that closes the
# brainstorm's cross-target carry-over (R7) and guards the built-in-embed fix
# (R-3): it is run on EACH native OS runner against that platform's freshly
# built binary.
#
# Usage: bash scripts/smoke-binary.sh <path-to-binary>
#
# Exit 0 = green. Any failure exits non-zero with a diagnostic.
set -euo pipefail

bin="${1:?usage: smoke-binary.sh <path-to-binary>}"
[ -x "$bin" ] || { echo "smoke: binary is not executable: $bin" >&2; exit 1; }
bin="$(cd "$(dirname "$bin")" && pwd)/$(basename "$bin")" # absolutise before cd

# A PATH with system tools (so /bin/sh resolves) but deliberately WITHOUT bun.
# setup-bun puts bun on PATH for the whole job, so running in the default env
# would prove nothing about the embedded-runtime guarantee. The guard below
# FAILS the job if bun still resolves on this PATH, so the smoke can't silently
# pass with bun present.
clean_path="/usr/bin:/bin:/usr/sbin:/sbin"
if PATH="$clean_path" command -v bun >/dev/null 2>&1; then
  echo "smoke: bun is reachable on the clean PATH; cannot honestly simulate a no-Bun host" >&2
  exit 1
fi
echo "clean PATH has no bun: ok"

proj="$(mktemp -d)"
cd "$proj"

echo "=== orch init (clean project, no node_modules) ==="
init_out="$(PATH="$clean_path" "$bin" init 2>&1)"
echo "$init_out"
[ -f .orch/orch.config.ts ] || { echo "smoke: init did not scaffold .orch/orch.config.ts" >&2; exit 1; }

echo "=== add a deterministic command step (still imports bare 'orch') ==="
cat >> .orch/steps.ts <<'EOF'

import { command } from 'orch'
export const WRITE_MARKER = command('write-marker', {
  argv: ['/bin/sh', '-c', 'printf smoke-ok > ./smoke-marker.txt'],
  onFailure: 'halt',
})
EOF
cat > .orch/workflows/hello.ts <<'EOF'
import { workflow } from 'orch'
import { WRITE_MARKER } from '../steps.ts'

export default workflow('hello', async (run) => {
  await run(WRITE_MARKER)
})
EOF

echo "=== orch run hello (plain mode, NO bun on PATH) ==="
run_out="$(PATH="$clean_path" "$bin" run hello --mode=plain 2>&1)"
echo "$run_out"
[ "$(cat ./smoke-marker.txt 2>/dev/null)" = "smoke-ok" ] \
  || { echo "smoke: workflow body never executed (no marker)" >&2; exit 1; }

echo "=== built-in workflow resolves AND imports, no bun (R-3) ==="
dry_out="$(PATH="$clean_path" "$bin" dry-run orch::work-cc --mode=plain 2>&1)"
echo "$dry_out"
echo "$dry_out" | grep -q "loaded successfully" \
  || { echo "smoke: built-in orch::work-cc failed to load — R-3 embed regression" >&2; exit 1; }

# AE1: orch must never prompt the user to install Bun.
if printf '%s' "$init_out$run_out" | grep -qiE "install.*bun|bun is not installed|bun\.sh"; then
  echo "smoke: output told the user to install Bun (violates AE1)" >&2
  exit 1
fi

echo "================  SMOKE GREEN: $bin  ================"
