---
date: 2026-04-30
status: decided
topic: orch git helpers — `createWorktree()` step primitive
session: orch-git-helpers
related:
  - docs/brainstorms/2026-04-12-phase-10-git-commit-brainstorm.md
  - src/core/commit.ts
  - src/services/git/git-service.ts
---

# orch git helpers — `createWorktree`

## What We're Building

A new step factory in `src/core/` so workflow authors can create git worktrees as a first-class workflow step:

```ts
// Required: `enter` — true switches the workflow's cwd, false keeps it.
await run(createWorktree('feat/foo', { enter: true }))
await run(IMPLEMENT)            // runs inside the worktree
await run(commit('done'))       // commits inside the worktree

// Same factory; cwd stays in the original repo.
await run(createWorktree('feat/foo', { enter: false }))
```

Returns a `Step<WorktreeResult>` and composes with everything else (`run()`, `parallel()`, memoization, resume).

`commit()` already exists in `src/core/commit.ts` — **unchanged in this scope.**

## Why This Approach

Step primitive — not a setup helper — because:

- **Memoization comes free.** Replay/resume hits the cache; the worktree isn't recreated.
- **State is auditable.** Worktree creation lands in `state.json` alongside other steps.
- **Composes with `parallel()`** — branches can each create their own worktree.
- **Mirrors the existing `commit()` precedent** (Phase 10): same execution model, same security shape, same testing strategy.

`enter` is required (no default) so the side effect is explicit at every call site. One factory beats two — fewer concepts to remember, one place to evolve the API.

## Key Decisions

### 1. Single factory, `enter` is required
- `createWorktree(branch, { enter, ...rest })` is the only public surface.
- `enter: true`  → creates the worktree AND switches the workflow's cwd for every subsequent `run()` call.
- `enter: false` → creates the worktree, original cwd unchanged.
- TypeScript enforces presence (no default value, not optional in the opts type).

### 2. cwd switching uses AsyncLocalStorage
The executor already uses `AsyncLocalStorage` in `src/core/execution-context.ts` for parallel depth. We add a scoped "current workflow cwd" alongside it. When set, the executor reads the ALS cwd before falling back to `deps.cwd`. Runners and validators see the new cwd transparently — no changes to `step.define`, `RunOverrides`, or runner contracts.

### 3. Target resolution: parent dir + auto-named leaf
The leaf directory is **always** `<projectName>--<sanitizedBranch>`. The `target` option only controls the parent.

| `target` value | Resolves to (repo at `/home/me/projects/orch`, branch `feat/foo`) |
|---|---|
| `'sibling'` (default) | `/home/me/projects/orch--feat-foo` |
| relative path `'../wt'` | `/home/me/projects/orch/../wt/orch--feat-foo` |
| absolute path `'/tmp/wts'` | `/tmp/wts/orch--feat-foo` |

`'sibling'` is the default. Branch slashes → dashes in the directory name.

### 4. Conflict policy: STRICT
Any pre-existing branch or worktree path → throw. No silent reuse, no destructive recreate. Memoization is the only safety net for replay (cache hit → step body never executes).

Trade-off accepted: a fresh machine resume that hits no cache and finds a leftover branch/path will error. Documented as the expected behavior.

### 5. Branch base: HEAD by default, `from` overrides
`createWorktree('feat/foo', { enter: true })` → off `HEAD`. `createWorktree('feat/foo', { enter: true, from: 'main' })` → off `main` (or any ref/sha).

### 6. Cleanup: keep forever
Worktree persists after the workflow ends. User cleans up via `git worktree remove`. No automatic teardown in v1. A future `removeWorktree(branch)` step factory is plausible but explicitly out of scope.

### 7. `postCreate` hook — string[] sugar over a callback
Optional `postCreate` for setup work after the worktree exists (copy `.env`, install deps, etc.). The primary API is a callback; a string array is sugar.

```ts
// Sugar — each line is a shell command, run sequentially in the worktree.
// `$ORIGIN` and `$TARGET` are exposed as env vars.
await run(createWorktree('feat/foo', {
  enter: true,
  postCreate: ['cp $ORIGIN/.env .', 'bun install'],
}))

// Full control — callback receives explicit context.
await run(createWorktree('feat/foo', {
  enter: false,
  postCreate: async ({ origin, target, exec }) => {
    await exec(['cp', `${origin}/.env`, `${target}/.env`])
    await exec(['bun', 'install'])
  },
}))
```

- **Subprocess seam.** `exec` is a thin wrapper over `ProcessService` (cwd defaults to the worktree). Workflow authors never import `child_process` — non-negotiable rule #1.
- **Failure model.** Any non-zero exit / thrown error → the step fails (same as agent/commit steps). Strict conflict policy means a retry sees the existing worktree and errors; user must `git worktree remove` and rerun.
- **Memoization.** Hook is part of the step's atomic outcome. Cache hit on replay skips worktree creation AND the hook. `bun install` doesn't re-run on every resume.
- **Output streaming.** Hook stdout/stderr surfaces through the same observability path as agent steps (visible in plain host, captured by SessionLogger). Details deferred to plan.

### 8. Reserved step name prefix `worktree:`
Like `commit:` for `commit()`, the step name is generated as `worktree:<sanitized-branch>` — `enter` is part of the config, not the identity (so a workflow can't accidentally create two distinct cached entries for the same branch by toggling `enter`). `step.define()` rejects this prefix, same as `commit:`.

### 9. Return type
```ts
interface WorktreeResult {
  readonly path: Path        // absolute path to the worktree
  readonly branch: string    // canonical branch name (unsanitized)
  readonly fromRef: string   // ref the branch was created from
}
```

Never returns `null` — worktree creation either succeeds or throws.

## Surface area touched (high-level only)

- `src/core/worktree.ts` — new factory + internal builder.
- `src/core/step.ts` — `StepConfig` union grows a `kind: 'worktree'` variant.
- `src/core/execution-context.ts` — add scoped cwd ALS.
- `src/core/workflow.ts` — executor branch for the worktree step kind; reads ALS cwd before `deps.cwd`.
- `src/services/git/` — add `GitService` methods: `addWorktree`, `branchExists`, `worktreePathExists`, `repoRoot`, `repoName`. Real impl in `BunGitService`, fake in `FakeGitService`.
- `src/core/index.ts` — export `createWorktree`, `WorktreeResult`.

Detailed wiring belongs in the plan — not here.

## Open Questions (defer to plan)

1. **Cache-hit verification.** On replay, should the executor still verify the worktree path actually exists on disk before treating the step as a cache hit? (Strict-mode safety net for fresh-machine resumes.)
2. **`parallel()` interaction with `enter: true`.** Each parallel branch already gets its own ALS scope. Confirm that scoped cwd doesn't leak across branches when one of them calls `createWorktree({ enter: true })`.
3. **Branch sanitization rules.** `feat/foo` → `feat-foo` is clear. What about `@`, dots, non-ASCII? Probably collapse to `[a-z0-9-]` and reject empty results, mirroring `commit()`'s slug rules.
4. **Project name source.** Use the basename of the repo's working tree (`git rev-parse --show-toplevel` then `basename`). Confirm in plan.
5. **State persistence.** `WorktreeResult` is JSON-serializable, fits the existing `StepEntry` shape — no new state-store concerns expected. Verify in plan.
6. **Sandbox / nested git.** What if the project itself sits inside a parent git repo (sibling target lands outside the parent)? Not v1's problem; flag for users.
7. **`postCreate` cleanup on partial failure.** If the worktree is created but the hook fails halfway, the worktree dir stays on disk. Strict policy then blocks retry until manual cleanup. Acceptable for v1; revisit if it bites.
8. **Shell semantics for sugar form.** Sugar (`postCreate: ['cmd']`) needs to expand `$ORIGIN`/`$TARGET`. Decide in plan: invoke through `/bin/sh -c`, or pre-expand vars and pass argv. Sub-question: how to handle Windows (probably out of scope for v1).
9. **Workflow-level default `postCreate`?** Should `orch.config.ts` allow setting a project-wide default that every `createWorktree()` call inherits? YAGNI for now — every call passes its own. Revisit if every workflow ends up duplicating the same `cp .env && bun install`.

## Out of Scope

- Removing worktrees (future `removeWorktree` step).
- Pruning stale worktrees on workflow start.
- Pushing the branch to a remote.
- Switching back to the original cwd mid-workflow (would require a `leaveWorktree()` or scope block).
- Any change to `commit()`.

## Acceptance Sketch

- `createWorktree(branch, { enter: false })` creates a worktree; subsequent steps still run in the original repo.
- `createWorktree(branch, { enter: true })` creates a worktree and every subsequent `run()` in the workflow runs there until the workflow ends.
- Calling `createWorktree(branch, {})` (missing `enter`) is a TypeScript error.
- `postCreate` (sugar or callback) runs after creation, with `$ORIGIN`/`$TARGET` (sugar) or `{ origin, target, exec }` (callback).
- Hook failure fails the step. Successful step (incl. hook) is memoized — replay skips both creation and hook.
- Replay of the step (same `runId`) hits the cache without re-running git.
- Pre-existing branch or path produces a clear `GitCommandError`.
- All four orch testing layers covered: unit (factory + executor branch), unit (GitService methods + hook runner via FakeProcessService), integration (mocked edges), integration (real git in temp repo with a real `postCreate` like `touch` or `cp`).

## Next

Run `/workflows:plan` — it will pick this brainstorm up at `docs/sessions/orch-git-helpers/brainstorm.md` and produce `plan.md` in the same directory.
