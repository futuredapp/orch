---
status: done
priority: p3
issue_id: "018"
tags: [code-review, quality, testing]
dependencies: []
---

# FakeFsService uses Date.now() — non-deterministic in tests

## Problem Statement

`src/services/fs/fake-fs-service.ts:33` — `mtimeMs: Date.now()` in the fake service. A fake should not depend on real wall-clock time; this makes `stat().mtimeMs` non-deterministic in tests.

## Findings

- Flagged by: Architecture Strategist (P3)

## Proposed Solutions

Accept a `Clock` in the `FakeFsService` constructor, or use a fixed timestamp.

**Effort:** Tiny | **Risk:** None

## Acceptance Criteria

- [ ] `FakeFsService` does not call `Date.now()`
- [ ] Tests can control the reported mtime

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-04-11 | Created from code review | |
| 2026-04-11 | Resolved | G5 shipped — FakeFsService accepts optional Clock via constructor; writeFile uses clock?.now() ?? Date.now() |
