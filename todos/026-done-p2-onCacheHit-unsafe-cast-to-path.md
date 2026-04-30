---
status: done
priority: p2
issue_id: "026"
tags: [code-review, types, worktree, robustness]
dependencies: []
---

# `onCacheHit` casts the cached value to `{ readonly path: Path }` without runtime validation

## Problem Statement

`src/core/step.ts:204-208` — the worktree branch of `onCacheHit` reads the
cached value as a typed shape:

```ts
case 'worktree': {
  if (!config.enter) return
  const result = cachedValue as { readonly path: Path }
  setWorkflowCwd(result.path)
  return
}
```

`cachedValue: unknown` is the value loaded from `state.json` (untrusted at
runtime — anyone can edit the file, an older orch version may have written
a different shape, a future version may add fields). The cast asserts the
shape without checking it. If `cachedValue.path` is `undefined`, `null`, or
a non-string, `setWorkflowCwd(undefined as any)` mutates the ALS store with
garbage, and the next step runs with a broken cwd. Failure mode is silent
until git or the runner errors with a confusing message.

The agent kind in the same dispatcher does runtime validation via
`config.returns.zodSchema.safeParse(cachedValue)`. The worktree kind
should hold itself to the same standard.

**Why it matters:**
- Replay across orch versions becomes brittle.
- `state.json` is on disk; a corrupted file produces a broken cwd, not a
  clear "schema mismatch" error.
- The unsafe cast is exactly the pattern this project's `Path` smart
  constructor exists to prevent.

## Findings

- `src/core/step.ts:204-208` — `as { readonly path: Path }` with no validation
- Compare with `src/core/step.ts:197-200` — agent kind validates with Zod
- `WorktreeResult` (from `src/core/worktree.ts:16-22`) is the canonical shape; it could be exported as a Zod schema for symmetry
- CLAUDE.md rule #6: "No `any`, no `!` non-null assertions." Casts achieve the same blind trust; this is a moral violation.

## Proposed Solutions

### Option A: Validate the cached shape (Recommended)
- Define a Zod schema for `WorktreeResult` (`z.object({ path: z.string().min(1), branch: z.string(), fromRef: z.string() })`)
- In `onCacheHit`, parse the cached value with `safeParse`; throw a clear `Error('worktree cache entry is malformed: ...')` on failure
- Apply the same treatment to the value flowing into `setWorkflowCwd`
- **Pros:** Mirrors the agent-kind pattern. Surfaces corrupted state with an actionable error.
- **Cons:** Adds a small dependency on Zod from step.ts (already imported via SchemaWrapper).
- **Effort:** Small
- **Risk:** Low

### Option B: Type guard with manual checks
- Hand-write `isWorktreeResult(v: unknown): v is WorktreeResult` and use it before the cast
- **Pros:** No Zod surface in the hot path
- **Cons:** Hand-written guards drift from the type; harder to maintain as `WorktreeResult` evolves
- **Effort:** Small
- **Risk:** Medium — easy to miss a field

### Option C: Document and accept
- Add a JSDoc note: "`state.json` is trusted; cached values are not validated on replay."
- **Pros:** Zero code change
- **Cons:** Inconsistent with how `agent` kind handles the same risk; a corrupted state.json then fails opaquely
- **Effort:** Trivial
- **Risk:** Medium

## Recommended Action

(Triage)

## Technical Details

- **File:** `src/core/step.ts:204-208`, possibly `src/core/worktree.ts` (export schema)
- **Test to add:** `'onCacheHit throws when cached worktree value is missing path'`

## Acceptance Criteria

- [x] `onCacheHit` rejects malformed cached values with a clear error
- [x] Existing onCacheHit tests still green
- [x] No `as` cast on `cachedValue` for the worktree kind

## Work Log

- 2026-04-30 — Discovered during code review of uncommitted worktree changes.
- 2026-04-30 — Replaced unsafe cast with WorktreeResultSchema.safeParse; malformed cache entries now throw explicit error.

## Resources

- `src/core/step.ts:194-215` — onCacheHit dispatcher
- `CLAUDE.md` rule #6 — no `any`, no `!`
