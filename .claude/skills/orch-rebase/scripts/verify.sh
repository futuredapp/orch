#!/usr/bin/env bash
#
# verify.sh — run the project gate after a merge so integration breakage is
# caught before the next branch lands on top of it. Defaults to `bun run check`
# (lint + typecheck + test — the documented gate in CLAUDE.md); pass a different
# command to override.
#
# Output is tee'd to a log so the driver can read failures without re-running a
# multi-minute suite.
#
#   RESULT: PASS  — gate is green.
#   RESULT: FAIL  — gate failed; the log path is printed. The driver should fix
#                   ONLY breakage caused by this integration, then re-run.
#
# Usage: verify.sh [<log-path>] [-- <command...>]
#   verify.sh                              # bun run check, auto log path
#   verify.sh /tmp/v.log                   # bun run check, explicit log
#   verify.sh /tmp/v.log -- bun run test   # custom command

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib.sh
source "$here/_lib.sh"

main_wt="$(base_worktree)" || die "could not locate base ($BASE) worktree"

log=""
if [ "${1:-}" != "--" ] && [ -n "${1:-}" ]; then log="$1"; shift; fi
[ "${1:-}" = "--" ] && shift
cmd=("$@"); [ "${#cmd[@]}" -eq 0 ] && cmd=(bun run check)
[ -n "$log" ] || log="$(git -C "$main_wt" rev-parse --git-common-dir)/orch-rebase-verify.log"

echo "running: ${cmd[*]}   (cwd: $main_wt)"
echo "log: $log"
echo ""

set +e
( cd "$main_wt" && "${cmd[@]}" ) 2>&1 | tee "$log"
status="${PIPESTATUS[0]}"
set -e

echo ""
if [ "$status" -eq 0 ]; then
  echo "RESULT: PASS"
else
  echo "RESULT: FAIL (exit $status) — see $log"
fi
exit "$status"
