---
status: done
priority: p3
issue_id: "014"
tags: [code-review, quality]
dependencies: []
---

# Redundant condition / dead code in workflow.ts

## Problem Statement

`src/core/workflow.ts:120-122` — the outer `if` already narrows `result.finalEvent.type === 'error'`, but the inner ternary on line 122 re-checks the same condition. The `'unknown error'` fallback is dead code.

```ts
if (result.finalEvent.type === 'error') {
  const msg = result.finalEvent.type === 'error' ? result.finalEvent.message : 'unknown error'
  //          ^^^ always true at this point
```

## Findings

- Flagged by: Pattern Recognition (P2), Architecture Strategist (P2), TypeScript Reviewer (P2-6)

## Proposed Solutions

Replace with: `const msg = result.finalEvent.message`

**Effort:** Tiny | **Risk:** None

## Acceptance Criteria

- [ ] Redundant condition removed
- [ ] `bun run check` passes

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-04-11 | Created from code review | 3 agents flagged independently |
| 2026-04-11 | G3: collapsed unreachable msg ternary while fixing #019 | Resolved jointly with the non-zero-exit check |
