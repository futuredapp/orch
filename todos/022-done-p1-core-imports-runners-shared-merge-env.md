---
status: done
priority: p1
issue_id: "022"
tags: [code-review, architecture, worktree, module-boundaries]
dependencies: []
---

# `src/core/worktree-post-create.ts` reaches into `src/runners/_shared/merge-env.ts`

## Problem Statement

`src/core/worktree-post-create.ts:9` imports `mergeEnv` from
`../runners/_shared/merge-env.ts`. This violates the project's "Single public
barrel per module" rule (CLAUDE.md non-negotiable rule #7) — core must
import from `src/<module>/index.ts`, not from internal files of another
module. It also brushes against rule #2 ("the core never imports a concrete
runner"); `_shared/merge-env.ts` lives under `src/runners/`, so even though
it is not a Runner adapter, the import path crosses the boundary.

The import works at runtime because TS doesn't enforce module boundaries, but
it's exactly the kind of cross-cutting reach that the codebase has explicitly
called out as a smell (see `todos/009-done-p2-barrel-violations.md`). Worse,
the runners barrel does not currently re-export `mergeEnv`, so this is
genuinely a dive into another module's private file.

**Why it matters:** Every future "shared util I need from another module"
will follow this precedent unless we draw the line here. It also makes
refactoring the runners' env strategy unsafe — anyone touching
`merge-env.ts` thinks they're working inside the runners module and can
break a core dependency they didn't know existed.

## Findings

- `src/core/worktree-post-create.ts:9` — `import { mergeEnv } from '../runners/_shared/merge-env.ts'`
- `src/runners/index.ts` — does not re-export `mergeEnv`
- Function usage: builds the env for sugar `/bin/sh -c <line>` and the callback `exec()` wrapper, prepending `ORIGIN`/`TARGET`
- CLAUDE.md rule #7: "Single public barrel per module. Import from `src/<module>/index.ts` across module boundaries, not from internal files."
- Existing precedent: `todos/009-done-p2-barrel-violations.md` already cleaned a previous instance

## Proposed Solutions

### Option A: Move `mergeEnv` to `src/services/process/` (Recommended)
- It's a process-spawning helper at the seam between caller and `ProcessService.spawn`
- Re-export from `src/services/index.ts` so both core and runners go through the barrel
- **Pros:** Both consumers (runners and now core) reach it through the public API. Removes the architectural smell entirely.
- **Cons:** Touches more files. `mergeEnv` becomes part of the services public surface.
- **Effort:** Small (move file, update 2-3 import sites)
- **Risk:** Low — mechanical refactor, full test suite covers the existing behavior

### Option B: Inline the env merge in `worktree-post-create.ts`
- The merge is ~5 lines: `Object.fromEntries(Object.entries(process.env).filter(...))` plus `ORIGIN`/`TARGET` overlay
- Drop the import entirely
- **Pros:** Smallest diff. Zero cross-module coupling.
- **Cons:** Behavior drifts from the runners' env shape. If `mergeEnv` evolves (e.g., adds new precedence rules), the worktree path silently misses them.
- **Effort:** Small
- **Risk:** Medium — divergence over time

### Option C: Re-export `mergeEnv` from `src/runners/index.ts`
- Treat it as part of the runners public API
- Core imports via `import { mergeEnv } from '../runners/index.ts'`
- **Pros:** Smallest move; no file relocation
- **Cons:** Conceptually wrong — `mergeEnv` isn't a runner concept, it's process-spawn plumbing. Promotes an internal helper to public API for a non-runner caller.
- **Effort:** Trivial
- **Risk:** Low but masks the architectural issue

## Recommended Action

(Triage)

## Technical Details

- **Files:** `src/core/worktree-post-create.ts`, `src/runners/_shared/merge-env.ts`, `src/services/process/index.ts` (if Option A)
- **Affected callers:** `src/runners/_shared/*` (today), `src/core/worktree-post-create.ts` (new)
- CLAUDE.md non-negotiable rules #2, #7

## Acceptance Criteria

- [x] No file under `src/core/` imports from `src/runners/_shared/` or any other module's internal file
- [x] All cross-module imports go through `src/<module>/index.ts`
- [x] All worktree post-create tests still pass
- [x] `bun run check` green

## Work Log

- 2026-04-30 — Discovered during code review of uncommitted worktree changes.
- 2026-04-30 — Moved mergeEnv from src/runners/_shared/ to src/services/process/; updated 3 importers + relocated unit test through services barrel.

## Resources

- `CLAUDE.md` rules #2 and #7
- `todos/009-done-p2-barrel-violations.md` — prior cleanup of similar issue
- `src/runners/_shared/merge-env.ts` — current home of the helper
