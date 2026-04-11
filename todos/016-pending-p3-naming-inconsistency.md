---
status: pending
priority: p3
issue_id: "016"
tags: [code-review, quality, naming]
dependencies: []
---

# SystemClock vs Bun* naming inconsistency

## Problem Statement

Real service implementations use inconsistent naming prefixes:
- `BunFsService`, `BunProcessService` (prefix = `Bun`)
- `SystemClock` (prefix = `System`)

## Findings

- Flagged by: Pattern Recognition (naming)

## Proposed Solutions

Standardize to one convention. Options:
- Rename `SystemClock` to `BunClock` (matches other adapters)
- Or rename all to `Real*` (`RealFsService`, `RealProcessService`, `RealClock`)

**Effort:** Small | **Risk:** Low — find-and-replace

## Acceptance Criteria

- [ ] All real service adapters use the same naming prefix

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-04-11 | Created from code review | |
