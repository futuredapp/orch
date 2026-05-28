---
date: 2026-05-26
status: open
area: src/runners
type: architecture
recommendation: speculative
dependency-category: in-process
---

# Shared transcript-format helpers across Claude and Codex runners

## Problem

`src/runners/claude/format-event.ts` and `src/runners/codex/format-event.ts`
carry byte-identical string primitives — 7 helper functions and 6 limit
constants:

- helpers: `truncate`, `middleEllipsis`, `firstLine`, `firstNonEmptyLine`,
  `readString`, `readObject`, `safeJson`
- constants: `MAX_BASH_COMMAND`, `MAX_FILE_PATH`, `MAX_GENERIC_INPUT`,
  `MAX_TOOL_RESULT_LINE`, `MAX_ERROR_TEXT`, `MAX_ASSISTANT_TEXT`

A fix to `middleEllipsis` (or a limit) needs two synchronised edits. The
category→`TranscriptLine` *mapping* is genuinely per-runner; only these
primitives are shared.

## Files

- `src/runners/claude/format-event.ts:216-288` (helpers), `:21-26` (constants)
- `src/runners/codex/format-event.ts:205-277` (helpers), `:23-28` (constants)

## Solution

A shared `format-helpers` module both adapters import.

## Contradicts the team's own trigger

`codex/format-event.ts` carries an explicit `PROMOTE-WHEN` note: extract these
*"when a third runner needs these."* There are two adapters today. This is
surfaced only so the deferral stays a conscious choice — **defer unless you are
about to add a third runner.** Note also CLAUDE.md states "there is no
`src/runners/_shared/`"; a shared helpers module would need a deliberate home
decision.

## Recommendation strength

**Speculative.** Real duplication, but the team has already chosen to wait, and
the trigger is reasonable.
