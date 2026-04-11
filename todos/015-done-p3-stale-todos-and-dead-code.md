---
status: done
priority: p3
issue_id: "015"
tags: [code-review, quality, cleanup]
dependencies: []
---

# Stale TODOs, dead code, and empty barrels

## Problem Statement

Several housekeeping items accumulated across phases:

1. `src/services/types.ts:1` — stale `TODO(phase-3): relocate to src/core/types.ts` (Phase 3 already landed)
2. `src/index.ts` — still `export {}` after 5 phases, no public API exposed
3. `tests/unit/placeholder.test.ts` — scaffolding test (`expect(true).toBe(true)`) still present
4. `src/runners/execute.ts:11,54` — `structuredOutput` field is always `undefined`, never populated

## Findings

- Flagged by: Pattern Recognition (P3), Architecture Strategist (forward-looking)

## Proposed Solutions

1. Remove stale TODO, update comment
2. Populate `src/index.ts` with `workflow`, `step`, `claude`, branded constructors
3. Delete placeholder test
4. Either populate `structuredOutput` or remove it from `RunnerResult`

**Effort:** Small | **Risk:** None

## Acceptance Criteria

- [ ] No stale phase TODOs in source
- [ ] src/index.ts exports the public API
- [ ] No placeholder tests
- [ ] `structuredOutput` is either used or removed

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-04-11 | Created from code review | |
| 2026-04-11 | Resolved | G5 shipped — src/index.ts re-exports module barrels; placeholder.test.ts deleted; structuredOutput capability comment added |
