---
status: pending
priority: p2
issue_id: "005"
tags: [code-review, data-integrity, performance]
dependencies: []
---

# Read-modify-write race + deterministic tmp path in state store

## Problem Statement

`src/state/state-store.ts:98-123` — `saveStep` does `loadRun()` then `writeFile` with no lock. Concurrent calls lose writes. Additionally, `#tmpPath` returns the same deterministic path for all writers, so concurrent `writeFile` calls corrupt each other's tmp file. The existing TODO on line 159 acknowledges this for Phase 8.

**Why it matters:** Even today, if `initRun` and `saveStep` overlap, or `setStatus` races with `saveStep`, one write is silently lost.

## Findings

- Flagged by: Performance Oracle (P1-3), Data Integrity Guardian (P1-1), Architecture Strategist
- Line 159: TODO acknowledges the issue
- Line 170: `#tmpPath` is deterministic — same for all concurrent writers

## Proposed Solutions

### Option A: Unique tmp path + document serialization requirement (Recommended for now)
- Append PID + monotonic counter to tmp filename
- Document that callers MUST serialize calls per `runId`
- Add file locking before Phase 8
- **Effort:** Small (tmp fix), Medium (locking)
- **Risk:** Low

### Option B: Optimistic locking with version field
- Add `version` to RunState, compare-and-swap on write
- **Effort:** Medium — requires schema change
- **Risk:** Medium — schema migration needed

## Acceptance Criteria

- [ ] Concurrent `saveStep` calls use different tmp file paths
- [ ] Phase 8 blocking issue is tracked

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-04-11 | Created from code review | 3 agents flagged independently |
