---
status: done
priority: p3
issue_id: "017"
tags: [code-review, quality, duplication]
dependencies: ["005", "006"]
---

# Atomic write logic duplicated 3 times in state store

## Problem Statement

`src/state/state-store.ts` — the `mkdir` + `writeFile(tmp)` + `rename(tmp, file)` pattern is repeated in `saveStep` (lines 120-122), `initRun` (lines 140-142), and `setStatus` (lines 155-156). Extract a private `#atomicWrite(runId, state)` helper to DRY this.

## Findings

- Flagged by: Pattern Recognition (duplication)
- Note: This naturally combines with fixes for 005 (unique tmp path) and 006 (try/finally cleanup)

## Proposed Solutions

Extract `async #atomicWrite(runId: RunId, state: RunState): Promise<void>` with:
- Unique tmp path (per-call)
- try/finally cleanup
- mkdir + writeFile + rename

**Effort:** Small | **Risk:** Low

## Acceptance Criteria

- [ ] Single `#atomicWrite` method used by all three callers
- [ ] Includes try/finally tmp cleanup (combines with 006)

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-04-11 | Created from code review | Natural to combine with 005 and 006 |
| 2026-04-11 | Resolved | G2 shipped — atomic write extracted to #atomicWrite; saveStep/initRun/setStatus all route through it |
