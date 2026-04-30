---
status: done
priority: p1
issue_id: "021"
tags: [code-review, worktree, bug, examples]
dependencies: []
---

# `examples/worktree-demo/index.ts` calls `BunGitService` with wrong args (bypasses typecheck)

## Problem Statement

The new demo file at `examples/worktree-demo/index.ts:47` constructs the git
service as `new BunGitService(processService)`, but the constructor signature
is `constructor(deps: { readonly processService: ProcessService })`. At runtime
`this.#processService` would be set to `processService.processService` —
`undefined` — and the very first git call would throw `Cannot read properties
of undefined`.

The plan (`docs/sessions/orch-git-helpers/plan.md` Phase 3 DoD) explicitly
required: *"the example must be a real workflow file under `examples/` so it
compiles in CI"*. CI does not compile it: `tsconfig.json` only includes
`["src", "tests"]`, so `examples/` is invisible to `bun run typecheck`. The
broken instantiation is real (`tsc --noEmit examples/worktree-demo/index.ts`
produces TS2345) and would only show up when a user actually runs the example.

**Why it matters:** The example is the documentation surface for
`createWorktree()` in `docs/getting-started.md`. A user copying it as a
starting point gets a runtime crash. It also signals that the plan's "compiles
in CI" gate was not actually wired up.

## Findings

- `examples/worktree-demo/index.ts:47` — `new BunGitService(processService)` instead of `new BunGitService({ processService })`
- `tsconfig.json:include` — `["src", "tests"]`, no `examples/`
- `bun run typecheck` exits 0 despite the bug
- `tsc --noEmit examples/worktree-demo/index.ts` — TS2345 confirms the type mismatch
- `src/cli/deps.ts:58` — the working pattern: `new BunGitService({ processService })`

## Proposed Solutions

### Option A: Fix the call AND extend tsconfig.include (Recommended)
- Change the call site to `new BunGitService({ processService })`
- Add `"examples"` to `tsconfig.json:include` so future examples are typechecked
- **Pros:** Restores the plan's DoD (compiles in CI). Catches the next broken example automatically.
- **Cons:** Bun's runtime supports `.ts` imports, but `tsc` emits errors for top-level await, `import.meta.dir`, etc. May need a `tsconfig.examples.json` with `"target": "ESNext"` and `"module": "ESNext"`.
- **Effort:** Small
- **Risk:** Low

### Option B: Fix the call only
- Just correct the constructor call; leave examples out of the typecheck path
- **Pros:** One-line fix
- **Cons:** Plan's "compiles in CI" gate stays vapor; the next broken example slips through the same way
- **Effort:** Trivial
- **Risk:** Repeats the failure mode

### Option C: Inline the example into `docs/getting-started.md` and delete the file
- Skip the executable-example path entirely
- **Pros:** No build surface to maintain
- **Cons:** Doc drifts from real API; user can't `bun run` the example
- **Effort:** Small
- **Risk:** Low but loses the working-reference value

## Recommended Action

(Triage)

## Technical Details

- **File:** `examples/worktree-demo/index.ts:47`, `tsconfig.json`
- **Trigger:** Anyone running `bun run examples/worktree-demo/index.ts`
- **Plan reference:** `docs/sessions/orch-git-helpers/plan.md` Phase 3 DoD

## Acceptance Criteria

- [x] `bun run examples/worktree-demo/index.ts` executes without throwing on git construction
- [x] CI fails if a future example regresses the constructor signature
- [x] No new TypeScript errors in `src/` or `tests/`

## Work Log

- 2026-04-30 — Discovered during code review of uncommitted worktree changes.
- 2026-04-30 — Fixed: changed `new BunGitService(processService)` → `new BunGitService({ processService })`; added `"examples"` to `tsconfig.json:include`. Adding `examples/` to typecheck surfaced three pre-existing bugs in sibling examples (compound: trailing-comma string-concat typo; hello-file: missing `fsService`/`gitService`/`host` on `WorkflowDeps`; riddle-solver: missing `host` on `WorkflowDeps`). Fixed all three inline so the new CI gate is actually green. `bun run check` exits 0.

## Resources

- `docs/sessions/orch-git-helpers/plan.md` — Phase 3 DoD requires compiling example
- `src/cli/deps.ts:58` — correct construction pattern
