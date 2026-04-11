---
status: pending
priority: p2
issue_id: "007"
tags: [code-review, quality, typescript]
dependencies: []
---

# Double cast `as unknown as RunState` bypasses type safety

## Problem Statement

`src/state/state-store.ts:95` — `return result.data as unknown as RunState` bypasses the type system entirely. The Zod schema infers `id` as `string` (not branded `RunId`), so this silently drops brand verification at the type level.

## Findings

- Flagged by: TypeScript Reviewer (P1-1), Pattern Recognition (P2)
- `RunStateSchema.id` is `z.string().regex(...)` which infers as `string`, not `RunId`

## Proposed Solutions

### Option A: Use z.custom or .transform() (Recommended)
- Replace `z.string().regex(RUN_ID_PATTERN)` with `z.custom<RunId>()` or add `.transform(runId)` to produce the branded type
- **Effort:** Small
- **Risk:** Low

## Acceptance Criteria

- [ ] No `as unknown as RunState` cast
- [ ] Zod schema produces correctly branded types
- [ ] Existing tests still pass

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-04-11 | Created from code review | |
