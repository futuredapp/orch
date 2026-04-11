---
status: done
priority: p2
issue_id: "010"
tags: [code-review, data-integrity, reliability]
dependencies: []
---

# loadRun swallows all read errors as "not found"

## Problem Statement

`src/state/state-store.ts:72-74` — the bare `catch` block treats permission errors, I/O errors, and ENOENT identically as `undefined` (run not found). A permissions problem silently appears as a missing run, leading to data loss on the next `initRun` call which will overwrite the file.

## Findings

- Flagged by: Data Integrity Guardian (P2-5)

## Proposed Solutions

### Option A: Check for ENOENT specifically (Recommended)
- Rethrow errors that are not ENOENT/ENOTDIR
- **Effort:** Small
- **Risk:** Low

## Acceptance Criteria

- [ ] ENOENT returns undefined (run not found)
- [ ] Permission errors (EACCES) propagate as thrown errors
- [ ] I/O errors propagate as thrown errors

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-04-11 | Created from code review | |
| 2026-04-11 | Resolved | G2 shipped — loadRun narrows on `err.code === 'ENOENT'` (plus message-prefix fallback for FakeFsService); EACCES rethrown |
