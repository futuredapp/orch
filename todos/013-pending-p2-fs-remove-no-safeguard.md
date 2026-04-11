---
status: pending
priority: p2
issue_id: "013"
tags: [code-review, security]
dependencies: ["001"]
---

# BunFsService.remove() uses recursive+force with no scope check

## Problem Statement

`src/services/fs/bun-fs-service.ts:50` — `remove()` uses `{ recursive: true, force: true }` with no assertion that the path is under an expected base directory. Combined with the unvalidated `path()` constructor (todo 001), this could enable deletion of arbitrary paths.

Also: `tempDir` prefix (`line 54`) flows unsanitized into `os.tmpdir() + prefix` — a prefix containing `/` or `..` could place the temp directory outside the expected location.

## Findings

- Flagged by: Security Sentinel (P2-1, P2-3)

## Proposed Solutions

### Option A: Assert path is under expected basePath before rm
- Add a `basePath` field to BunFsService, reject paths outside it
- Strip path separators from tempDir prefix
- **Effort:** Small
- **Risk:** Low

## Acceptance Criteria

- [ ] `remove()` rejects paths outside the configured base
- [ ] `tempDir` rejects prefixes containing `/` or `..`

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-04-11 | Created from code review | Depends on path validation (001) |
