---
status: pending
priority: p2
issue_id: "006"
tags: [code-review, data-integrity]
dependencies: []
---

# Orphaned .tmp file on write failure in state store

## Problem Statement

`src/state/state-store.ts:120-122` — if `writeFile` succeeds but `rename` fails (permissions, cross-device), or if `writeFile` fails partway (disk full), the `.tmp` file remains on disk with no cleanup. No `try/finally` block wraps the write+rename sequence.

## Findings

- Flagged by: Data Integrity Guardian (P1-2)
- Lines 120-122 (saveStep), 140-142 (initRun), 155-156 (setStatus) — all three write paths lack cleanup

## Proposed Solutions

### Option A: try/finally cleanup (Recommended)
- Wrap write+rename in try/finally that removes the tmp file on failure
- **Effort:** Small
- **Risk:** Low

## Acceptance Criteria

- [ ] If rename fails, tmp file is cleaned up
- [ ] If writeFile fails, tmp file is cleaned up (if it exists)

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-04-11 | Created from code review | |
