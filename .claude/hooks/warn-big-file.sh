#!/usr/bin/env bash
# orch big-file guard: warns at 300 lines, blocks at 600 lines.
# Reads the Claude Code tool input JSON from stdin.
# Exit 0 = allow (with optional stderr warning). Exit 2 = block.
set -euo pipefail

INPUT=$(cat)
CONTENT=$(printf '%s' "$INPUT" | jq -r '.tool_input.content // empty')

if [ -z "$CONTENT" ]; then
  exit 0
fi

LINES=$(printf '%s\n' "$CONTENT" | wc -l | tr -d ' ')

if [ "$LINES" -gt 600 ]; then
  echo "[orch] BLOCKED: file would have $LINES lines (>600). Split it into smaller modules." >&2
  exit 2
elif [ "$LINES" -gt 300 ]; then
  echo "[orch] warn: file would have $LINES lines (>300). Consider splitting; justify in a comment if unavoidable." >&2
fi

exit 0
