---
status: done
priority: p1
issue_id: "004"
tags: [code-review, performance, reliability]
dependencies: []
---

# No subprocess cleanup on error or cancellation in runRunner

## Problem Statement

`src/runners/execute.ts:14-55` — if the consumer of `runRunner` throws or the process is aborted, `handle.kill()` is never called. A spawned Claude process (which can run 10s-300s) becomes orphaned. There is no `try/finally` wrapping the stdout drain loop, and no `AbortSignal` support.

**Why it matters:** Orphaned processes consume resources (CPU, memory, API tokens) and may hold file locks. With parallel execution (Phase 8), this multiplies.

## Findings

- Flagged by: Performance Oracle (P1-2), Architecture Strategist (forward-looking)
- Lines 32-40: `for await` loop with no try/finally
- No `AbortSignal` parameter on `runRunner` or `RunnerContext`
- `SpawnHandle` exposes `kill()` but nothing calls it

## Proposed Solutions

### Option A: try/finally with handle.kill() (Recommended)
- Wrap the stdout drain loop in try/finally that calls `handle.kill()`
- Add optional `signal?: AbortSignal` to RunnerContext for cancellation
- **Effort:** Small
- **Risk:** Low

## Acceptance Criteria

- [ ] If caller throws during stdout drain, subprocess is killed
- [ ] If AbortSignal fires, subprocess is killed and function rejects
- [ ] Existing tests still pass (no behavioral change on happy path)

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-04-11 | Created from code review | |
| 2026-04-11 | G3: wrapped stdout drain and wait() in try/finally with handle.kill() | AbortSignal wiring deferred — kill() in finally covers throw paths |
