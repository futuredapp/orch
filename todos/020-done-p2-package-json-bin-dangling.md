---
status: done
priority: p2
issue_id: "020"
tags: [code-review, packaging]
dependencies: []
---

# package.json `bin.orch` points at a file that does not exist

## Problem Statement

`package.json:8` declared `"bin": { "orch": "./src/cli/index.ts" }` but `src/cli/` does not exist in the tree — Phase 12 is the phase that actually delivers the CLI entry point. Any consumer that installed the package (directly or via `bun pm pack`) would see a dangling executable, and `npm pack --dry-run` flagged the file as missing. This is a Review-2-only finding (R2-N2).

## Findings

- Flagged by: Review 2 (R2-N2)
- `package.json` declared an executable that cannot resolve
- No tree under `src/cli/` exists at `feat/phase-5-claude-runner`

## Proposed Solutions

### Option A: Remove the `bin` block entirely (Recommended)
- Delete the `bin` field from `package.json`; Phase 12 will reinstate it when `src/cli/index.ts` actually ships.
- **Effort:** Trivial
- **Risk:** None — the current tree has no CLI to expose.

### Option B: Stub `src/cli/index.ts`
- Create a placeholder that exits with "not yet implemented".
- **Effort:** Small
- **Risk:** Dishonest packaging; ships a CLI binary that does nothing.

## Acceptance Criteria

- [x] `bin` field removed from `package.json`
- [x] `bun pm pack --dry-run` output contains no `bin` reference
- [x] No other metadata references the non-existent `src/cli/index.ts`

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-04-11 | Created from Review 2 finding (R2-N2) | |
| 2026-04-11 | G4: removed `bin` block from package.json; verified `bun pm pack --dry-run` no longer references it | Option A chosen — Phase 12 will re-add `bin` alongside the real CLI entry point. |
