---
date: 2026-04-12
status: decided
topic: Phase 10 — GitService expansion + commit() primitive
---

# Phase 10 — `GitService` + `commit()` primitive

## What We're Building

A `commit()` DSL primitive that makes git commits first-class workflow steps. Workflow authors write `await run(commit('after research'))` and the orchestrator handles staging, committing, memoization, and resume.

This requires expanding the existing `GitService` port (shipped in Phase 6 with read-only methods) with write operations: `isClean`, `stageAll`, `commit`.

### User-facing API

```ts
const RESEARCH = step.define('research', { agent: claude(), prompt: '...' })

await run(RESEARCH)
await run(commit('checkpoint after research'))   // ← new
await run(IMPLEMENT)
```

## Why This Approach

### Key Decisions

1. **Stage-all only.** `commit()` always stages everything (`git add .`). No selective staging — YAGNI. Agent workflows produce changes and the orchestrator commits them wholesale.

2. **Extensible return object.** `commit()` returns `CommitResult | null` where `CommitResult = { sha: string }`. The object shape is extensible — later phases can add `changedFiles: string[]` or similar without breaking callers. Returns `null` when the working tree is clean (nothing to commit).

3. **Skip silently on clean tree.** If `isClean()` returns true, `commit()` resolves with `null` and logs a warning. No error. This is the natural behavior on resume (commit already landed) and for defensive "commit if anything changed" patterns.

4. **Standalone step factory.** `commit(message)` returns a `Step<CommitResult | null>` that gets passed to `run()`. Consistent with `step.define()`, composes with `parallel()`, and memoization comes free from existing `run()` machinery.

5. **Internal step type (discriminated union).** `StepConfig` becomes a union: agent steps have `agent: Runner`, commit steps have `kind: 'commit'`. The executor branches on the kind. This keeps the `Runner` abstraction honest — runners are for CLI agents, not for internal git operations.

6. **Check `isClean()` before staging.** Call `isClean()` first. If clean, return `null` immediately. Clearer intent than try-and-catch on `git commit` exit code, and `isClean()` is useful for other consumers (Phase 11 resume, custom validators).

### Execution flow inside the executor

```
commit step enters executor
  → cache hit? return cached value
  → isClean(cwd)?
    → yes: persist null, return null
    → no: stageAll(cwd) → commit(cwd, message) → headSha(cwd)
           persist { sha }, return { sha }
```

## GitService Expansion

### New methods (added to existing port)

| Method | Signature | Git command | Notes |
|--------|-----------|-------------|-------|
| `isClean` | `(cwd: Path) => Promise<boolean>` | `git status --porcelain` | Empty output = clean. Detects modified, staged, AND untracked files. |
| `stageAll` | `(cwd: Path) => Promise<void>` | `git add .` | Stages everything including untracked. |
| `commit` | `(cwd: Path, message: string) => Promise<string>` | `git commit -m <message>` | Returns new HEAD SHA. Message passed as argument (not stdin). |

### Security considerations (follow Phase 6 patterns)

- All git argv include `--` separator where applicable
- Minimal environment via `buildGitEnv` (already exists)
- Stderr redaction in errors (already exists)
- Commit message: no shell interpolation risk since it goes through `ProcessService.spawn` as an argv array element, not through a shell

## Type Changes

### StepConfig union

```ts
// Before (Phase 7):
interface StepConfig<T> {
  readonly agent: Runner
  readonly prompt?: string
  readonly validate?: Validator | ReadonlyArray<Validator>
  readonly returns?: SchemaWrapper<T>
}

// After (Phase 10):
type StepConfig<T> =
  | AgentStepConfig<T>   // existing shape with agent + prompt + validate + returns
  | CommitStepConfig      // new: kind: 'commit', message: string
```

### CommitResult

```ts
interface CommitResult {
  readonly sha: string
  // extensible: changedFiles, stats, etc. in future phases
}
```

### Step name convention

`commit()` generates step names with the prefix `commit:` — e.g., `commit:checkpoint after research`. This is a reserved prefix; `step.define()` should reject names starting with `commit:` to prevent collisions.

## Open Questions

1. **Should validators be supported on commit steps?** Probably not in Phase 10 (what would you validate?), but the union type shouldn't prevent adding them later.

2. **Should commit steps support `returns` / `SchemaWrapper`?** No — the return type is always `CommitResult | null`, hardcoded by the factory.

3. **`stageAll` and `.gitignore` interaction** — `git add .` respects `.gitignore` by default, which is the right behavior. No special handling needed.

4. **Empty commit message** — Should `commit('')` throw at construction time or at execution time? Likely a validation in the factory (throw immediately).

## Testing Shape

- **Unit — GitService methods:** `isClean` returns true/false correctly, `stageAll` calls correct git command, `commit` calls correct git command and returns SHA. All via `FakeProcessService`.
- **Unit — `commit()` factory:** produces correct step name, rejects empty message, returns correct Step type.
- **Unit — executor branch:** commit step calls isClean → stageAll → commit → headSha in order; skips when clean; memoizes by step name.
- **Integration (mocked):** full round-trip commit step through workflow executor with `FakeGitService`.
- **Integration (real):** real git in a temp repo — create file, run commit step, verify HEAD moved and file is committed.
