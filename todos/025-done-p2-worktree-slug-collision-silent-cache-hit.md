---
status: done
priority: p2
issue_id: "025"
tags: [code-review, worktree, ux, correctness]
dependencies: []
---

# Two different branches that slug to the same name silently collide as a cache hit

## Problem Statement

`createWorktree('feat/foo', { enter: true })` and
`createWorktree('feat/Foo', { enter: true })` both produce the step name
`worktree:feat-foo` (slugify lowercases and collapses non-alphanum). If both
appear in the same workflow, the second call is a **cache hit** on the first:
no branch is created, no error is thrown, and the caller receives a
`WorktreeResult` whose `branch` field is `'feat/Foo'` (the *first* call's
input — which is what got persisted in `StepEntry.value`).

The plan was explicit that `enter` is intentionally not part of the step
identity. But the *branch* should be — two materially different branches
should not silently merge into one cached entry.

This is a real footgun in workflows that derive branch names from external
input (env vars, CLI args, prompt outputs). The user gets a green run that
did the wrong thing.

**Why it matters:**
- Resume/replay invariant breaks: the step value reports a branch the user
  did not request.
- No error path: there's no signal to the workflow author that the second
  call was intercepted by the cache.
- Tests cover the desired slug behavior but not the collision case.

## Findings

- `src/core/worktree.ts:40-45` — `slugify()` is lossy by design (lowercase, collapse non-alphanumerics)
- `src/core/worktree.ts:97` — step name is `worktree:<slug>`
- `src/core/workflow.ts:951-958` — `runStepOnce` checks `state.steps[key]`; cache hit returns the cached value with no branch comparison
- `tests/unit/core/worktree.test.ts:91-114` — covers the slug derivation but not the collision case
- Same shape as commit() but commit collisions are less surprising (message text vs. branch identity)

## Proposed Solutions

### Option A: Detect collision at execution time (Recommended)
- In `runWorktreeStep` (or `runStepOnce` for worktree kind), when a cache hit fires, compare `cached.value.branch` to the *current call's* `config.branch`. If different, throw a clear error: `"createWorktree: step name 'worktree:feat-foo' already cached with branch 'feat/Foo'; cannot reuse for branch 'feat/foo'"`.
- **Pros:** No false positives — exact-match branch is still a cache hit (which is the resume case). Surfaces real collisions immediately.
- **Cons:** Adds a kind-specific check on the cache-hit path. Could fold into `onCacheHit` to keep the dispatcher pattern.
- **Effort:** Small
- **Risk:** Low

### Option B: Make the slug lossless
- Switch to a hash-based or escape-encoded slug (e.g., `feat-foo--abcd1234` where the suffix is a stable hash of the original branch)
- **Pros:** No collisions ever
- **Cons:** Step names become unreadable; breaks parity with `commit()`'s slug rules
- **Effort:** Medium
- **Risk:** Medium — readability regression

### Option C: Document and accept
- Add a JSDoc warning: "Two branches that sanitize to the same slug share a cache entry; subsequent calls return the first call's result."
- **Pros:** Zero code change
- **Cons:** The warning is invisible in the moment; the bug is exactly the kind that hides until production. The "strict policy" the rest of the design enforces argues against silent reuse.
- **Effort:** Trivial
- **Risk:** High — the failure mode survives

## Recommended Action

(Triage)

## Technical Details

- **Files:** `src/core/step.ts` (`onCacheHit` worktree case) or `src/core/worktree.ts`
- **Test to add:** `'createWorktree throws when two different branches slug to the same step name'`

## Acceptance Criteria

- [x] `createWorktree('feat/foo', ...)` followed by `createWorktree('feat/Foo', ...)` throws with a clear collision message
- [x] `createWorktree('feat/foo', ...)` followed by `createWorktree('feat/foo', ...)` (exact match) is still a cache hit (resume case)
- [x] Test covers both shapes
- [x] Existing tests green

## Work Log

- 2026-04-30 — Discovered during code review of uncommitted worktree changes.
- 2026-04-30 — Hardened: onCacheHit now throws collision error when cached branch/fromRef differ from current config; covered by new unit and executor tests.

## Resources

- `src/core/worktree.ts:40-45` — slugify
- `src/core/step.ts:194` — onCacheHit dispatcher
