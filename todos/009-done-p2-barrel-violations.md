---
status: done
priority: p2
issue_id: "009"
tags: [code-review, architecture]
dependencies: []
---

# Cross-module barrel violations in source files

## Problem Statement

CLAUDE.md rule 7 requires importing from `src/<module>/index.ts` across module boundaries. Multiple source files violate this by importing from internal paths.

## Findings

- Flagged by: Pattern Recognition (P1), Architecture Strategist (P2)
- `src/runners/execute.ts:1-2` — imports from `../services/clock/clock.ts` and `../services/process/process-service.ts`
- `src/runners/types.ts:2` — imports from `../services/types.ts`
- `src/state/state-store.ts:3` — imports from `../services/types.ts`
- `src/state/run-registry.ts:2` — imports from `../services/types.ts`
- ~20 test files also import from deep internal paths

## Proposed Solutions

### Option A: Rewire all cross-module imports to barrels (Recommended)
- Update source files to import from `../services/index.ts`
- Update test files similarly (lower priority)
- **Effort:** Small — mechanical find-and-replace
- **Risk:** Low

## Acceptance Criteria

- [ ] Zero cross-module deep imports in `src/` files
- [ ] `bun run check` passes after rewiring

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-04-11 | Created from code review | |
| 2026-04-11 | G3: fixed execute.ts barrel import to use `../services/index.ts`; state-store.ts portion still owned by G2 | Partial fix — closing once G2 lands |
| 2026-04-11 | Resolved | G2 (state-store.ts) and G3 (execute.ts) both shipped — imports now go through `../services/index.ts` barrel |
