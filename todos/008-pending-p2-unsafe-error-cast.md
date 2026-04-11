---
status: pending
priority: p2
issue_id: "008"
tags: [code-review, quality, typescript]
dependencies: []
---

# Unsafe `(cause as Error).message` casts in catch blocks

## Problem Statement

`src/state/state-store.ts:81,115` — `catch (cause)` does not guarantee `cause` is an `Error`. If `JSON.parse` or `JSON.stringify` throws a non-Error, `(cause as Error).message` is undefined behavior.

## Findings

- Flagged by: TypeScript Reviewer (P1-5), Pattern Recognition (P2)

## Proposed Solutions

### Option A: Use guarded narrowing (Recommended)
- `cause instanceof Error ? cause.message : String(cause)`
- **Effort:** Small
- **Risk:** Low

## Acceptance Criteria

- [ ] No `as Error` casts in catch blocks
- [ ] Non-Error thrown values produce readable messages

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-04-11 | Created from code review | |
