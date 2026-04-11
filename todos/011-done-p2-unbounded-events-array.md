---
status: done
priority: p2
issue_id: "011"
tags: [code-review, performance]
dependencies: []
---

# Unbounded event accumulation in runRunner

## Problem Statement

`src/runners/execute.ts:29` — the `events` array grows without bound for the entire subprocess lifetime. A Claude run producing thousands of streaming events accumulates all of them in memory. At Phase 8 with parallel agents, this multiplies by concurrency.

## Findings

- Flagged by: Performance Oracle (P1-1)
- Line 29: `const events: RunnerEvent[] = []`
- Line 36: `events.push(evt)` — no cap, no streaming

## Proposed Solutions

### Option A: Stream events to a callback + retain only terminal (Recommended)
- Add optional `onEvent?: (evt: RunnerEvent) => void` to deps
- Only accumulate if caller explicitly needs the array
- **Effort:** Medium
- **Risk:** Low — API change but backward compatible with default

### Option B: Cap the events array size
- Keep last N events (ring buffer)
- **Effort:** Small
- **Risk:** May lose useful debug events

## Acceptance Criteria

- [ ] Memory usage does not grow linearly with subprocess output
- [ ] Terminal event is always retained
- [ ] Existing tests still pass

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-04-11 | Created from code review | Can defer to pre-Phase-8 |
| 2026-04-11 | G3: dropped events[] from RunnerResult; only finalEvent/exitCode/durationMs remain | Confirmed workflow.ts never consumed events |
