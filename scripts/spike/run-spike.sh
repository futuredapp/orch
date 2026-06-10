#!/usr/bin/env bash
#
# run-spike.sh — end-to-end gate for the binary-packaging spike.
#
# Proves R7 / AE1: a `bun build --compile` standalone binary can, with NO Bun
# and NO node_modules on disk, dynamically import a user's TypeScript
# orch.config.ts + workflow + steps files (each doing `import ... from 'orch'`)
# and execute the workflow to completion.
#
# It simulates the whole Homebrew-user round:
#   1. compile the binary (scripts/build-binary.ts)
#   2. `orch init`            in a clean temp project (scaffold config+steps+hello)
#   3. add a deterministic `command` step           (no Claude/Codex CLI needed)
#   4. `orch run hello`       with `bun` REMOVED from PATH
#   5. assert the workflow produced its file and never told the user to install Bun
#
# Exit 0 = gate GREEN. Any failure exits non-zero with a diagnostic.
#
# Usage: bash scripts/spike/run-spike.sh
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo"

bin_dir="$(mktemp -d)"
bin="$bin_dir/orch"
proj="$(mktemp -d)"

note() { printf '\n=== %s ===\n' "$1"; }
fail() { printf '\nSPIKE FAILED: %s\n' "$1" >&2; exit 1; }

note "1/5 compile standalone binary"
bun scripts/build-binary.ts --outfile "$bin"
[ -x "$bin" ] || fail "binary was not produced at $bin"
size=$(du -h "$bin" | cut -f1)
echo "binary: $bin ($size)"

# A PATH with system tools (/bin/sh lives here) but deliberately WITHOUT bun.
# Proves the embedded runtime — not a system Bun — handles the TS imports.
clean_path="/usr/bin:/bin:/usr/sbin:/sbin"
if PATH="$clean_path" command -v bun >/dev/null 2>&1; then
  fail "bun is reachable on the clean PATH; cannot honestly simulate a no-Bun host"
fi
echo "clean PATH has no bun: ok"

cd "$proj"

note "2/5 orch init (clean project, no node_modules)"
init_out="$(PATH="$clean_path" "$bin" init 2>&1)" || fail "orch init exited non-zero"
echo "$init_out"
[ -f "$proj/.orch/orch.config.ts" ] || fail ".orch/orch.config.ts was not scaffolded"
[ -f "$proj/.orch/steps.ts" ] || fail ".orch/steps.ts was not scaffolded"
[ -f "$proj/.orch/workflows/hello.ts" ] || fail ".orch/workflows/hello.ts was not scaffolded"

note "3/5 add a deterministic command step (still imports from bare 'orch')"
# Append a shell `command` step to the scaffolded steps.ts. It writes a marker
# file — observable proof the workflow body actually executed. Still uses the
# bare `'orch'` import, exercising the runtime resolver transitively.
cat >> "$proj/.orch/steps.ts" <<'EOF'

import { command } from 'orch'
export const WRITE_MARKER = command('write-marker', {
  argv: ['/bin/sh', '-c', 'printf "spike-ran-in-compiled-binary" > ./spike-marker.txt'],
  onFailure: 'halt',
})
EOF
# Rewrite the workflow to run our command step. Keeps the bare 'orch' import
# AND the relative '../steps.ts' import — the full transitive chain.
cat > "$proj/.orch/workflows/hello.ts" <<'EOF'
import { workflow } from 'orch'
import { WRITE_MARKER } from '../steps.ts'

export default workflow('hello', async (run) => {
  const r = await run(WRITE_MARKER)
  console.log(`[spike] command exit=${r.exitCode}`)
})
EOF

note "4/5 orch run hello (plain mode, NO bun on PATH)"
run_out="$(PATH="$clean_path" "$bin" run hello --mode=plain 2>&1)" || {
  echo "$run_out"
  fail "orch run exited non-zero"
}
echo "$run_out"

note "5/5 assert success criteria"
marker="$proj/spike-marker.txt"
[ -f "$marker" ] || fail "workflow did not produce spike-marker.txt — body never executed"
content="$(cat "$marker")"
[ "$content" = "spike-ran-in-compiled-binary" ] || fail "marker content unexpected: '$content'"
echo "marker file present with expected content: ok"

# AE1: orch must never prompt the user to install Bun.
if printf '%s' "$init_out$run_out" | grep -qi "install.*bun\|bun is not installed\|bun.sh"; then
  fail "output told the user to install Bun (violates AE1)"
fi
echo "never prompted to install Bun: ok"

printf '\n================  SPIKE GATE: GREEN  ================\n'
echo "A no-Bun, no-node_modules compiled binary scaffolded, loaded, and ran"
echo "a TypeScript workflow that imports from the bare 'orch' specifier."
