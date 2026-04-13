---
title: "feat: GitService expansion + commit() primitive"
type: feat
status: completed
date: 2026-04-13
deepened: 2026-04-13
---

# Phase 10 — `GitService` expansion + `commit()` primitive

## Enhancement Summary

**Deepened on:** 2026-04-13
**Research agents used:** architecture-strategist, pattern-recognition-specialist, performance-oracle, security-sentinel, code-simplicity-reviewer, kieran-typescript-reviewer, best-practices-researcher, repo-research-analyst, codebase-explorer, workflow-engine-researcher, testing-analyst

### Key Improvements
1. **Type safety:** Exhaustive `switch`/`assertNever` for step-kind dispatch — compile error when future kinds are added without a handler
2. **Performance:** `BunGitService.commit()` internally runs both `git commit` and `git rev-parse HEAD`, reducing executor calls from 4 to 3
3. **Slugification safety:** Validate the *slugified* name (not just raw message) to catch all-punctuation inputs like `commit('!!!')`
4. **Strict overrides:** Throw (not silently ignore) when `prompt`/`extraContext`/`extraPrompt` passed to commit steps
5. **Executor refactor:** Extract BOTH `runAgentStep` AND `runCommitStep` — `runStepOnce` is already 74 lines (over 60-line limit)
6. **Testing gaps filled:** 5 missing test scenarios added to implementation steps

### New Considerations Discovered
- Newlines in commit messages split `git commit -m` into paragraphs — validate in factory
- On crash between `git commit` and `saveStep`, resume sees clean tree → returns `null` (acceptable: commit landed, SHA not captured)
- `git add .` stages everything including secrets agents may create — document limitation, future phase adds denylist scan
- Pattern validated by Temporal Activities, Inngest `step.run()`, and AWS Step Functions state types

---

## Overview

Add a `commit()` DSL primitive that makes git commits first-class workflow steps. Workflow authors write `await run(commit('after research'))` and the orchestrator handles staging, committing, memoization, and resume. This requires expanding the existing `GitService` port (shipped in Phase 6 with read-only methods) with write operations: `isClean`, `stageAll`, `commit`.

## Problem Statement / Motivation

Currently, orchestrated workflows can run agent steps and capture their output, but there is no way to checkpoint progress via git commits between steps. If a workflow crashes mid-run, all uncommitted agent output is at risk. A `commit()` primitive solves this by:

1. **Enabling checkpoints.** Commit after each agent step to create restore points.
2. **Composing with existing DSL.** `commit()` returns a `Step<CommitResult | null>` — it works with `run()`, memoization, and resume for free.
3. **Keeping runners honest.** Git operations are not agent CLI calls — they should not flow through `Runner` adapters. A discriminated union on `StepConfig` makes this separation explicit.

## Proposed Solution

### User-facing API

```ts
const RESEARCH = step.define('research', { agent: claude(), prompt: '...' })

await run(RESEARCH)
await run(commit('checkpoint after research'))   // ← new
await run(IMPLEMENT)
await run(commit('checkpoint after implementation'))
```

### Design decisions (from brainstorm)

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Stage-all only (`git add .`) | YAGNI — agents produce changes, orchestrator commits wholesale |
| 2 | Return `CommitResult \| null` | Extensible object shape; `null` = clean tree |
| 3 | Skip silently on clean tree | Natural on resume (commit already landed); defensive pattern |
| 4 | Standalone step factory | `commit(msg)` → `Step<CommitResult \| null>`, composes with `run()` |
| 5 | Discriminated union on `StepConfig` | `kind: 'commit'` vs `kind: 'agent'` — executor branches cleanly |
| 6 | Check `isClean()` before staging | Clearer intent than catching exit codes |

## Technical Approach

### Architecture

#### GitService expansion (`src/services/git/git-service.ts`)

Three new methods added to the existing port:

| Method | Signature | Git command | Notes |
|--------|-----------|-------------|-------|
| `isClean` | `(cwd: Path) => Promise<boolean>` | `git status --porcelain` | Empty stdout = clean. Detects modified, staged, AND untracked. `--porcelain` v1 is sufficient. |
| `stageAll` | `(cwd: Path) => Promise<void>` | `git add .` | Stages everything; respects `.gitignore`. Equivalent to `git add -A` from repo root since Git 2.x. |
| `commit` | `(cwd: Path, message: string) => Promise<string>` | `git commit -m <msg>` then `git rev-parse HEAD` | Returns new HEAD SHA. Both commands inside one method — executor makes one call. |

All methods follow existing `BunGitService` patterns: DI via `ProcessService`, `buildGitEnv()`, `redactStderr()`, throw `GitCommandError`.

**Git command notes (from research):**
- `git diff --quiet HEAD` would miss untracked files — `--porcelain` is correct for `isClean()`
- No `--` separator needed for `git commit -m` or `git status --porcelain`
- Commit message via argv array (not shell) — no injection risk
- `git add .` and `git add -A` are equivalent from repo root since Git 2.x

**Security note:** `git add .` stages everything agents produce, including potential secrets (`.env`, `*.pem`). Document this limitation in `commit()` JSDoc. Future phase adds denylist scan before staging.

#### StepConfig discriminated union (`src/core/step.ts`)

```ts
interface AgentStepConfig<T = unknown> {
  readonly kind: 'agent'
  readonly agent: Runner
  readonly prompt?: string
  readonly validate?: Validator | ReadonlyArray<Validator>
  readonly returns?: SchemaWrapper<T>
}

interface CommitStepConfig {
  readonly kind: 'commit'
  readonly message: string
}

type StepConfig<T = unknown> = AgentStepConfig<T> | CommitStepConfig
```

**Type note:** `CommitStepConfig` carries a phantom `T` from the union. This is acceptable — `T` only matters when narrowing to `AgentStepConfig<T>`, and `Step<T>` binds it concretely (`commit()` returns `Step<CommitResult | null>`).

**Exhaustive dispatch pattern:**

```ts
function assertNever(x: never): never {
  throw new Error(`Unexpected step kind: ${JSON.stringify(x)}`)
}
// In runStepOnce:
switch (s.config.kind) {
  case 'agent': return runAgentStep(deps, s, key, overrides)
  case 'commit': return runCommitStep(deps, s, key)
  default: assertNever(s.config.kind)
}
```

#### CommitResult type + `commit()` factory (`src/core/commit.ts` — new file)

```ts
interface CommitResult { readonly sha: string }
function commit(message: string): Step<CommitResult | null>
```

Factory validations (all at construction time):
- Non-empty, non-whitespace-only message
- No null bytes (`\0` — git rejects these)
- No newlines (`\n` — `git commit -m` treats as paragraph separators)
- Slugified name is non-empty (catches `commit('!!!')` → empty slug)
- Total step name ≤ 128 chars (including `commit:` prefix)
- Returns **frozen** `Step` object (matching `step.define()` behavior)

**Slugification (inline, not a separate module):**
```ts
const slug = message.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
```
Truncate after slugification, re-trim trailing `-`.

#### Step name derivation

`commit('Checkpoint after research!')` → step name `commit:checkpoint-after-research`

`STEP_NAME_PATTERN` updated to `/^[a-z0-9][a-z0-9:-]*$/` (allow colons).
`step.define()` rejects names starting with `commit:` (reserved prefix).

#### Executor branching (`src/core/workflow.ts`)

`runStepOnce` is already 74 lines. Extract BOTH helpers:

**`runStepOnce` (thin dispatcher, ~25 lines):**
1. Compute step key (`overrides?.as ?? s.name`)
2. Cache-hit check (kind-agnostic). For agent steps with `returns`, call `revalidateCachedValue`; for commit steps, skip.
3. Exhaustive switch → `runAgentStep` or `runCommitStep`

**`runCommitStep` helper:**
1. Throw if `prompt`/`extraContext`/`extraPrompt` overrides provided
2. `gitService.isClean(cwd)` → clean: persist `null`, return `null`, log warning
3. `gitService.stageAll(cwd)`
4. `sha = gitService.commit(cwd, message)` (internally runs commit + rev-parse)
5. Persist `StepEntry` with `value: { sha }`, `validations: []`, no `preRunSnapshot`
6. Return `{ sha }`

**Blast radius (all 12 `.config.agent`/`.returns`/`.prompt`/`.validate` accesses in workflow.ts are encapsulated by `runAgentStep` extraction — no individual guards needed).**

#### FakeGitService expansion (`src/services/git/fake-git-service.ts`)

```ts
setIsClean(cwd: Path, isClean: boolean): void
setCommitSha(cwd: Path, sha: string): void
// stageAll() is a no-op — void return, nothing to script
```

Follows existing per-cwd `Map` + setter pattern. Unscripted lookups throw loud errors.

#### Barrel exports

- `src/services/git/index.ts` — no change (interface methods are structural)
- `src/core/index.ts` — add `commit`, `CommitResult`, `AgentStepConfig`, `CommitStepConfig`

### Implementation Phases

#### Step 1: Expand `GitService` port + `BunGitService` + `FakeGitService`

**Files:** `src/services/git/git-service.ts`, `bun-git-service.ts`, `fake-git-service.ts`

**Tests (write first):** `tests/unit/services/git/bun-git-service.test.ts`:
- `isClean` returns true when stdout is empty (clean tree)
- `isClean` returns false for modified file (`M src/foo.ts`)
- `isClean` returns false for untracked file (`?? new-file.ts`)
- `stageAll` spawns `git add .` with correct argv and cwd
- `commit` spawns `git commit -m` then `git rev-parse HEAD`, returns SHA
- `commit` throws `GitCommandError` when `git commit` fails
- `commit` propagates `GitCommandError` when `rev-parse HEAD` fails after successful commit

**Definition of Done:** `bun run check` passes.

#### Step 2: Update `StepName` regex + reserved prefix guard

**Files:** `src/core/types.ts`, `src/core/step.ts`

**Tests:** `tests/unit/core/types.test.ts` + `tests/unit/core/step.test.ts`:
- `stepName accepts a colon-separated name like commit:foo`
- `stepName accepts a name with multiple segments like a:b`
- `step.define rejects names starting with the reserved commit: prefix`

**Definition of Done:** `bun run check` passes. Existing tests green.

#### Step 3: `StepConfig` discriminated union + `kind: 'agent'` migration

**Files:** `src/core/step.ts`, `src/core/workflow.ts`, `src/core/index.ts`

Extract `runAgentStep` AND `runCommitStep`. Refactor `runStepOnce` into thin dispatcher with exhaustive switch. `step.define()` injects `kind: 'agent'` automatically.

**Tests:** `tests/unit/core/step.test.ts`:
- `step.define() produces config with kind: 'agent'`
- Existing workflow tests still pass

**Definition of Done:** `bun run check` passes. No `any`. `runStepOnce` under 30 lines.

#### Step 4: `CommitResult` type + `commit()` factory

**Files:** `src/core/commit.ts` (new), `src/core/index.ts`

**Tests:** `tests/unit/core/commit.test.ts` (new):
- Name derivation: `'after research'` → `commit:after-research`
- Empty message throws
- Whitespace-only throws
- Exceeding max length throws
- All-punctuation (`'!!!'`) throws (empty slug)
- Null byte in message throws
- Newline in message throws
- Config has `kind: 'commit'`
- Message preserved in config
- Returns frozen Step object
- Boundary: message slugifying to exactly 121 chars succeeds (128 - `commit:` = 121)
- Boundary: message slugifying to 122 chars throws

**Definition of Done:** `bun run check` passes.

#### Step 5: Executor commit-step branch

**Files:** `src/core/workflow.ts`

**Tests:** `tests/unit/core/workflow.test.ts`:
- `commit step stages and commits when tree is dirty`
- `commit step returns null when tree is clean`
- `commit step is memoized on resume`
- `commit step uses overrides.as for memoization key`
- `commit step does not invoke any Runner` (negative boundary)
- `commit step throws when prompt override is provided`
- `commit step propagates GitCommandError from stageAll`
- `commit step propagates GitCommandError from commit`

All via `FakeGitService`.

**Definition of Done:** `bun run check` passes.

#### Step 6: Integration test — mocked round-trip

**Files:** `tests/integration/core/commit-mocked.test.ts` (new)

Full workflow: agent step + commit step via `FakeGitService` + `FakeProcessService`. Verify dirty/clean/resume scenarios. **Verify state.json shape** — `StepEntry.value` is `{ sha } | null`, `validations` is `[]`.

**Definition of Done:** `bun run check` passes.

#### Step 7: Integration test — real git (env-gated)

**Files:** `tests/integration/core/commit-real.test.ts` (new), `tests/helpers/temp-git-repo.ts` (new if needed)

`tempGitRepo()` helper: creates temp dir, `git init`, configures `user.name`/`user.email`, cleanup in `afterEach`.

Scenario: create file → commit step → verify HEAD moved → re-run (cached) → clean tree (null).

**Definition of Done:** `bun run check` passes. Auto-skips without git.

#### Step 8: Update roadmap + docs

**Files:** `docs/plans/implementation-phases.md`

**Definition of Done:** Roadmap reflects reality.

## Acceptance Criteria

### Functional Requirements

- [x] `GitService.isClean(cwd)` detects modified, staged, and untracked files
- [x] `GitService.stageAll(cwd)` stages all changes including untracked
- [x] `GitService.commit(cwd, message)` creates commit and returns HEAD SHA
- [x] `commit('message')` returns `Step<CommitResult | null>` with correct step name
- [x] `commit('')`, `commit('   ')`, `commit('!!!')` throw at construction time
- [x] `commit` rejects null bytes and newlines in messages
- [x] `commit()` returns frozen Step object
- [x] Executor dispatches commit steps to git (not runner)
- [x] Commit step returns `{ sha }` (dirty) or `null` (clean, with warning)
- [x] Commit step is memoized on resume
- [x] Commit step throws on prompt/extraContext/extraPrompt overrides
- [x] `step.define('commit:foo', ...)` throws (reserved prefix)
- [x] `StepConfig` is discriminated union with exhaustive switch dispatch
- [x] Existing agent step tests remain green

### Non-Functional Requirements

- [x] All files ≤ 300 lines, all functions ≤ 60 lines
- [x] `runStepOnce` is thin dispatcher (under 30 lines)
- [x] TypeScript strict — no `any`, no `!`
- [x] All subprocess calls through `ProcessService`
- [x] `buildGitEnv()` + `redactStderr()` on all git operations
- [x] `commit()` JSDoc documents secret staging limitation

### Quality Gates

- [x] `bun run check` green
- [x] Unit: GitService methods (clean/dirty/untracked, error propagation)
- [x] Unit: `commit()` factory (slugification, validation, freezing, boundaries)
- [x] Unit: executor branch (dirty, clean, memoized, no-runner, override-rejection, errors)
- [x] Integration (mocked): full round-trip + state shape verification
- [x] Integration (real): env-gated, real git via `tempGitRepo()`

## Resolved Design Decisions

| # | Question | Resolution |
|---|----------|------------|
| 1 | Step name derivation | Slugify + prepend `commit:`. **Validate slug is non-empty.** |
| 2 | Duplicate commit messages | Same memoization as any step. Use unique messages or `as` override. |
| 3 | `commit()` return vs `headSha()` | `BunGitService.commit()` runs both commands internally. Executor makes one call. |
| 4 | `commit()` factory vs `step.define()` | Direct construction via `stepName()`. **Returns frozen object.** |
| 5 | Non-git-repo error | `GitCommandError` propagates naturally. |
| 6 | Parallel commit steps | Git lock contention → `GitCommandError`. Documented limitation. |
| 7 | Max step name length | 128 chars total. Throw at construction. |
| 8 | Whitespace-only messages | Reject at factory time. |
| 9 | Git commit failure | `GitCommandError` propagates. Workflow crashes, resume retries. |
| 10 | `preRunSnapshot` / `validations` | `validations: []`, omit `preRunSnapshot`. |
| 11 | `RunOverrides` on commit steps | **Throw** if prompt/extraContext/extraPrompt provided. Only `as` valid. |
| 12 | Schema version bump | No — `z.unknown()` handles `CommitResult \| null`. |
| 13 | `--` separator / `--no-verify` | No `--` needed. No `--no-verify` — respect hooks. |
| 14 | `isClean()` public | Yes — reusable for validators and future phases. |
| 15 | Discriminant strategy | Tagged union with `kind`. **Exhaustive switch + `assertNever`.** |
| 16 | Null bytes in messages | Reject at factory time. |
| 17 | Newlines in messages | Reject at factory time. |
| 18 | Crash between commit and saveStep | Resume sees clean tree → `null`. Acceptable. |
| 19 | `runStepOnce` refactoring | Extract BOTH `runAgentStep` and `runCommitStep`. |
| 20 | Secret staging | Document limitation. Future phase adds denylist scan. |

## Dependencies & Risks

**Dependencies:**
- Phase 6 `GitService` port (landed)
- Phase 7 `StepConfig` with `returns` field (landed)
- Phase 8 `parallel()` (landed — commit steps compose but git-lock limitation documented)

**Risks:**
- **`StepConfig` union migration** — 12 `.config.agent`/`.returns`/`.prompt`/`.validate` accesses in workflow.ts. Mitigated by `runAgentStep` extraction encapsulating all of them.
- **Step name regex** — colons could create confusing names. Mitigated by `commit:` reserved prefix.
- **`runStepOnce` complexity** — already 74 lines. Mitigated by extracting both helpers.
- **Secret staging** — `git add .` stages everything. Mitigated by documentation; future denylist.

## References

### Internal
- Brainstorm: `docs/brainstorms/2026-04-12-phase-10-git-commit-brainstorm.md`
- GitService port: `src/services/git/git-service.ts:9-19`
- BunGitService: `src/services/git/bun-git-service.ts:57-138`
- FakeGitService: `src/services/git/fake-git-service.ts:17-67`
- StepConfig: `src/core/step.ts:6-18`
- StepName regex: `src/core/types.ts:8`
- Executor (74 lines): `src/core/workflow.ts:154-228`
- WorkflowDeps: `src/core/workflow.ts:44-52`
- RunnerEvent `kind` pattern: `src/runners/types.ts:24-39`
- validation-runner: `src/core/validation-runner.ts:22-75`

### External
- [Temporal Activity Replay](https://docs.temporal.io/workflow-execution/event)
- [Inngest step.run()](https://www.inngest.com/docs/reference/typescript/v3/functions/step-run)
- [AWS Step Functions Best Practices](https://docs.aws.amazon.com/step-functions/latest/dg/sfn-best-practices.html)
