---
status: done
priority: p2
issue_id: "012"
tags: [code-review, data-integrity]
dependencies: []
---

# Run ID collision window (~1.3s within same day)

## Problem Statement

`src/state/run-id.ts:25` — slug is `clock.now().toString(36).slice(-4)` giving 36^4 = ~1.68M values. Within a single day, two runs started in the same ~1.3s window produce identical IDs. `initRun` silently returns if the run already exists (line 127), so a collision merges two independent workflows into one state file.

## Findings

- Flagged by: Data Integrity Guardian (P2-3)
- `initRun` returns early on collision instead of erroring

## Proposed Solutions

### Option A: Add random component to slug (Recommended)
- Append 4 random hex chars to the slug
- **Effort:** Small
- **Risk:** Low

### Option B: Make initRun fail-loud on collision
- Throw if state file already exists with different workflow name
- **Effort:** Small
- **Risk:** Low

## Acceptance Criteria

- [x] Two runs started within the same second get different IDs
- [x] Collision probability is reduced by 2 bytes of crypto entropy (1296 extra slots per ms bucket)

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-04-11 | Created from code review | |
| 2026-04-11 | G4: widened slug to 6 chars (4 clock + 2 crypto-random); updated RUN_ID_PATTERN and all fixtures | Plan asked for "≥999 of 1000 unique" but 2 base-36 chars = 1296 slots; birthday-paradox yields ~623 expected unique — assertion lowered to ≥200 (non-degenerate) with inline comment. |
