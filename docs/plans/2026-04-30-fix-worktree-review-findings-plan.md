---
title: "fix: address worktree review findings 021–026 + 027"
type: fix
date: 2026-04-30
related:
  - docs/sessions/orch-git-helpers/plan.md
  - todos/021-pending-p1-worktree-demo-broken-bunGitService-args.md
  - todos/022-pending-p1-core-imports-runners-shared-merge-env.md
  - todos/023-pending-p1-worktree-leading-dash-not-rejected.md
  - todos/024-pending-p2-fake-git-service-nul-byte-source.md
  - todos/025-pending-p2-worktree-slug-collision-silent-cache-hit.md
  - todos/026-pending-p2-onCacheHit-unsafe-cast-to-path.md
---

# fix: address worktree review findings 021–026 + 027

> **Orchestrator agent**: this document is a managed plan for a coordinator agent. Read end-to-end, then dispatch each labelled slice (Agent A–E) as an independent implementation agent. The five slices touch disjoint files and are designed to run in parallel; each is responsible for landing its own green `bun run check`. After all five slices ship, mark the related todos `done` and update this plan's status footer.

## Context

A code review of the in-flight `createWorktree()` work-in-progress (across `src/core/`, `src/services/git/`, tests, and `examples/worktree-demo/`) surfaced six issues; an independent second-opinion AI review confirmed all six and added a seventh related to the same family of input-validation gaps. Findings are persisted as `todos/021-pending-*.md` through `todos/026-pending-*.md`.

This plan converts those findings into five parallelisable implementation slices, each scoped tightly enough for a standalone agent to execute without coordinating with the others. The intended outcome: the worktree feature lands without

- (a) a broken example file that crashes at runtime,
- (b) a cross-module barrel violation (`src/core/` reaching into `src/runners/_shared/`),
- (c) git option-injection surface from leading-`-` argv,
- (d) a NUL-byte source that diffs as binary,
- (e) silent slug-collision cache hits returning the wrong branch,
- (f) unsafe casts on cached `state.json` values.

All five slices touch disjoint file sets. Each owns its own unit/integration test pass and `bun run check` gate. Behaviour-changing slices (C, E) ship with new tests; mechanical slices (A, B, D) rely on the existing test suite.

## Pre-flight checks (orchestrator)

Before dispatching any slice, the orchestrator agent should:

1. Confirm the working tree matches the state described here. The review was performed against uncommitted changes; if those changes have been committed or modified, re-confirm the line numbers cited below before dispatching.
2. Read the six existing pending todos under `todos/021-pending-*.md` … `todos/026-pending-*.md`. They contain the original problem statements and option analyses each slice is implementing.
3. Read this section's "Existing functions and utilities to reuse" so you can pass concrete references in each agent prompt.
4. Decide on isolation strategy. Recommended: each slice runs in its own git worktree to avoid interleaving test output and lockfile churn.

## Existing functions and utilities to reuse

Pass these to every dispatched agent in their prompt — they are the seams the project already uses:

- `src/services/types.ts:15` — `path()` smart constructor; agents must not bypass.
- `src/core/commit.ts:39-54` — precedent for branch/message validators (reject empty/whitespace/NUL/newline). Mirror its shape in any new validator extensions; the cross-reference comment in `src/core/worktree.ts:38` already tracks slug-rule parity.
- `src/core/schema.ts` and the existing Zod usage in `onCacheHit`'s agent branch (`src/core/step.ts:197-200`) — Zod is already a `step.ts` dependency; no new package import needed for Agent E.
- `src/services/git/bun-git-service.ts:#runGit` — every git spawn already routes through `ProcessService`. Agents must not introduce new spawn paths.
- `tests/helpers/fake-host.ts` and `tests/unit/core/_worktree-test-helpers.ts` — reuse for any new test fixtures.

## Agent assignments

### Agent A — Fix broken `worktree-demo` example, add `examples/` to typecheck (todo 021)

**Files**
- `examples/worktree-demo/index.ts:47`
- `tsconfig.json`

**Changes**
- Replace `new BunGitService(processService)` with `new BunGitService({ processService })` to match the constructor signature at `src/services/git/bun-git-service.ts:60`.
- Extend `tsconfig.json:include` from `["src", "tests"]` to `["src", "tests", "examples"]` so the next broken example is caught by `bun run typecheck`.
- If extending `include` breaks the typecheck for any other reason (top-level await, `import.meta.dir`), prefer extending the existing tsconfig over a new `tsconfig.examples.json` — current `module: "ESNext"` and `target: "ESNext"` already permit those features.

**Verify**
- `bun run typecheck` exits 0
- `bun run examples/worktree-demo/index.ts` runs end-to-end without throwing (creates a real sibling worktree against the current repo). Tear-down between attempts: `git worktree remove --force <path>` and `git branch -D demo/worktree-example`.

**Then mark `todos/021-pending-p1-worktree-demo-broken-bunGitService-args.md` as done.**

---

### Agent B — Move `mergeEnv` out of `src/runners/_shared/` (todo 022)

**Files**
- `src/runners/_shared/merge-env.ts` (delete after move)
- `src/services/process/merge-env.ts` (new home)
- `src/services/process/index.ts` (add export)
- `src/services/index.ts` (add export at outer barrel)
- `src/core/worktree-post-create.ts:9` (update import)
- `src/runners/claude/claude-runner.ts:2` (update import)
- `src/runners/codex/codex-runner.ts:5` (update import)

**Changes**
- Move `merge-env.ts` verbatim to `src/services/process/`. Function body and signature unchanged.
- Re-export `mergeEnv` from `src/services/process/index.ts` and `src/services/index.ts`.
- Update all three importers to use the barrel. The two runner files import from `../_shared/merge-env.ts` today; switch them to `../../services/index.ts`. The core file imports from `../runners/_shared/merge-env.ts` today; switch it to `../services/index.ts`.
- Delete the empty `src/runners/_shared/` directory if no other files remain there; otherwise leave intact.

**Why services/process and not the runners barrel**: `mergeEnv` is process-spawn plumbing — it composes `process.env` with overrides into the shape `ProcessService.spawn` accepts. It is not a runner concept. Re-exporting it from the runners barrel just to satisfy rule #7 would conceptually misplace it; moving it to its actual home (the process service module) fixes the rule cleanly.

**Verify**
- `bun run check` green (lint + typecheck + tests)
- `grep -RE "runners/_shared/merge-env" src/ tests/` returns nothing
- The 3 importer call sites still call the same `mergeEnv` (signature unchanged)

**Then mark `todos/022-pending-p1-core-imports-runners-shared-merge-env.md` as done.**

---

### Agent C — Harden worktree argv validation (todos 023 + 027)

**Files**
- `src/core/worktree.ts:111-145` (`validateBranch`, `validateFrom`, `validateTarget`)
- `src/services/git/bun-git-service.ts:204-221` (`addWorktree` argv)
- `tests/unit/core/worktree.test.ts` (add factory rejection cases)
- `tests/unit/services/git/bun-git-service.test.ts` (add `--` argv assertion)

**Changes**
- `validateBranch`: also reject `branch.startsWith('-')`.
- `validateFrom`: also reject NUL bytes, newlines/CR, and leading `-`. Today it only rejects empty and whitespace.
- `validateTarget`: also reject `target.startsWith('-')`.
- `BunGitService.addWorktree`: insert `--` between the option-bearing flags and the positional args. Result: `['git', 'worktree', 'add', '-b', branch, '--', path, fromRef]`. The `--` is the standard end-of-options separator and works across modern git.

**Tests to add** (named as full sentences per CLAUDE.md):
- `throws when branch begins with a dash`
- `throws when from begins with a dash`
- `throws when from contains a null byte`
- `throws when from contains a newline character`
- `throws when target begins with a dash`
- (BunGitService) `addWorktree includes "--" separator before path and fromRef`

**Why both layers**: factory validation gives a clean error at the workflow author's surface; the `--` separator in the adapter is defense-in-depth that survives any future caller that bypasses or extends the factory.

**Out of scope (separate follow-up)**: `src/core/commit.ts` has the same leading-`-` gap on commit messages, but commit messages don't flow into argv after a flag-bearing subcommand the same way (`git commit -m "<msg>"` consumes the next arg by definition). Note this in the PR description for visibility but do not change `commit.ts` in this slice.

**Verify**
- All new factory tests fail without the validation change (sanity check before applying the validation)
- `bun run check` green
- The real-git integration tests in `tests/integration/core/worktree-real.test.ts` still pass — the `--` insertion does not break the happy path

**Then mark `todos/023-pending-p1-worktree-leading-dash-not-rejected.md` as done.**

---

### Agent D — Replace NUL-byte map separator in `FakeGitService` (todo 024)

**Files**
- `src/services/git/fake-git-service.ts` — the `#pairKey` method (line 167) and 8 callsites at lines 41, 45, 57, 68, 118, 122, 132, 136

**Changes**
- Remove the `#pairKey(cwd, value)` helper entirely. Replace each `Map<string, T>` keyed by the concatenated string with a `Map<Path, Map<string, T>>` (cwd → inner map keyed by branch / path / baseline).
- Update the four affected pairs of methods: `setHasDiff`/`hasDiffSince`, `setDiff`/`diffSinceSha`, `setBranchExists`/`branchExists`, `setWorktreePathExists`/`worktreePathExists`.
- Setters lazily create the inner map. Getters read through both layers; missing inner-map or missing inner-key still throws the same loud "no scripted X" error so test mistakes remain obvious.

**Verify**
- `git diff src/services/git/fake-git-service.ts | head -3` produces text (`diff --git a/... b/...`), not "Binary files differ"
- `grep -lP '\x00' src/ tests/` returns nothing
- `tests/unit/services/git/fake-git-service.test.ts` and all worktree integration tests pass unchanged
- `bun run check` green

**Then mark `todos/024-pending-p2-fake-git-service-nul-byte-source.md` as done.**

---

### Agent E — Cache-hit hardening: collision detection + schema validation (todos 025 + 026)

**Files**
- `src/core/step.ts:194-215` (`onCacheHit`)
- `src/core/worktree.ts` — export a `WorktreeResultSchema` (Zod) next to the existing `WorktreeResult` interface
- `tests/unit/core/step.test.ts` (extend `onCacheHit` tests)
- `tests/unit/core/worktree-executor-cache.test.ts` (collision case)

**Changes**
- Define `WorktreeResultSchema = z.object({ path: z.string().min(1), branch: z.string().min(1), fromRef: z.string().min(1) })` in `src/core/worktree.ts` and export. Branded `Path` is fine — Zod accepts it as a string.
- In `onCacheHit`'s `'worktree'` case, before any `setWorkflowCwd`:
  1. `safeParse(cachedValue)`. On failure, throw `Error('worktree cache entry "<key>" is malformed: <issue>')`.
  2. Compare `parsed.branch === config.branch` and `parsed.fromRef === (config.fromRef ?? 'HEAD')`. If either differs, throw a clear collision error: `'createWorktree: step "<key>" is cached with branch "<cached.branch>" / from "<cached.fromRef>"; current call requested branch "<config.branch>" / from "<requested>". Two different branches sanitized to the same step name. Use distinct names.'`.
  3. Only then call `setWorkflowCwd(parsed.path as Path)` if `config.enter`.
- Drop the unsafe `as { readonly path: Path }` cast at `src/core/step.ts:206`.

**Tests to add** (full sentences):
- `onCacheHit throws when cached worktree value is missing path`
- `onCacheHit throws when cached worktree value has a non-string branch`
- `onCacheHit throws when cached branch differs from the current config (slug collision)`
- `onCacheHit throws when cached fromRef differs from the current config`
- `onCacheHit accepts an exact-match cache hit (resume case)`
- (executor-cache) `createWorktree throws when two different branches slug to the same step name within one workflow`

**Why both fixes here**: both edits land at the same site (`onCacheHit`'s worktree branch). Splitting them across two agents would force one to rebase on the other for a 5-line diff. The two findings (025 + 026) share the same code path and the same test file, and both turn silent failures into explicit errors.

**Verify**
- All existing `onCacheHit` and `worktree-executor-cache` tests still green
- New tests cover the malformed-cache and collision cases
- `bun run check` green

**Then mark both `todos/025-pending-p2-worktree-slug-collision-silent-cache-hit.md` and `todos/026-pending-p2-onCacheHit-unsafe-cast-to-path.md` as done.**

---

## Critical files map (for human review)

| File | Agent | Why |
|---|---|---|
| `examples/worktree-demo/index.ts` | A | Constructor call fix |
| `tsconfig.json` | A | Add `examples/` to include |
| `src/runners/_shared/merge-env.ts` → `src/services/process/merge-env.ts` | B | Module-boundary fix (move) |
| `src/services/process/index.ts`, `src/services/index.ts` | B | Re-export |
| `src/core/worktree-post-create.ts`, `src/runners/{claude,codex}/*-runner.ts` | B | Update import paths |
| `src/core/worktree.ts` | C | Tighten validators (branch, from, target) |
| `src/services/git/bun-git-service.ts` | C | Add `--` separator in `addWorktree` argv |
| `src/services/git/fake-git-service.ts` | D | Replace NUL-byte separator with nested Maps |
| `src/core/step.ts` | E | `onCacheHit` schema + collision check |
| `src/core/worktree.ts` | E | Export `WorktreeResultSchema` |

**File overlap between slices C and E**: both touch `src/core/worktree.ts`, but in disjoint sections — C edits the validator helpers (lines ~111-145), E adds a schema export near the `WorktreeResult` interface (lines ~16-22). Even running concurrently, the merge is mechanical. Run them in separate worktrees to keep this trivial.

## Sequencing for the orchestrator

The five agents touch disjoint files in distinct concerns. Recommended dispatch order:

1. **Wave 1 (parallel)**: Agents A, B, D — mechanical / low review burden.
2. **Wave 2 (parallel)**: Agents C, E — behavioural changes with new tests; deserve focused review.

Each agent must end on a green `bun run check` in its worktree. The orchestrator should:

- Spawn each slice in its own worktree (e.g., via `EnterWorktree` or a manual `git worktree add`).
- Pass each agent the relevant section of this plan plus the corresponding `todos/0XX-pending-*.md` for full context.
- Require the agent to confirm `bun run check` green before reporting done.
- After all five slices land, run a final integration check against the merged tree (see verification block below).

## End-to-end verification (after all five slices land)

```bash
bun run check                                # lint + typecheck + tests, must be green

# Confirm the example runs:
bun run examples/worktree-demo/index.ts
git worktree list --porcelain                # confirms the new worktree is registered
git worktree remove --force <demo-path>      # tear-down
git branch -D demo/worktree-example

# Confirm fake-git-service.ts diffs as text now:
git diff src/services/git/fake-git-service.ts | head -3   # not "Binary files differ"

# Confirm no module-boundary regression:
grep -RE "from ['\"][^'\"]*runners/_shared" src/  # only runners' own internal imports allowed

# Manual collision check — author a workflow with `createWorktree('feat/Foo', ...)` followed by
# `createWorktree('feat/foo', ...)`. `bun run` it. Expected: throws collision error from
# onCacheHit on the second call with branch and from in the message.

# Manual argv-injection check:
# `createWorktree('-d', { enter: true })` — must throw at construction time.
# `createWorktree('feat/foo', { enter: true, from: '--upload-pack=evil' })` — must throw.
# `createWorktree('feat/foo', { enter: true, target: '-rf' })` — must throw.
```

## Non-goals / explicit out-of-scope

- Splitting `src/core/workflow.ts` (currently 1074 lines, well over the 300-line guideline). Pre-existing; warrants a separate plan.
- Cosmetic P3 cleanups noted in the original review:
  - stray `void (null as unknown as TestDeps)` cast at `tests/unit/core/worktree-executor-postcreate.test.ts:189-190`,
  - mismatched test description at `tests/unit/core/worktree.test.ts:109` ("with leading non-alpha chars" — actual input has none),
  - `onCacheHit` being exported from `src/core/index.ts` (probably internal dispatcher).
  These are a separate sweep.
- Hardening `src/core/commit.ts` against leading-`-` messages. Different attack surface (commit messages do not flow into positional argv after a flag-bearing subcommand). Open as a separate todo if it ever bites.
- Rotating the existing 6 todo files from `pending` to `done` is each slice's responsibility — see "Then mark X as done" line at the end of each agent's section.

## Status footer (orchestrator updates as slices land)

- [x] Agent A — `examples/worktree-demo` + tsconfig (todo 021). Scope expanded inline to fix three pre-existing example bugs (`compound`/`hello-file`/`riddle-solver`) that the new `examples/` typecheck path surfaced; the plan didn't anticipate them. The CI gate is now real: any broken example will fail typecheck.
- [x] Agent B — `mergeEnv` move (todo 022). `mergeEnv` lives at `src/services/process/merge-env.ts`; importers go through the services barrel; the unit test moved to `tests/unit/services/process/merge-env.test.ts`. Empty `src/runners/_shared/` directory removed.
- [x] Agent C — argv hardening (todos 023 + 027). `validateBranch`/`validateFrom`/`validateTarget` reject leading `-`; `validateFrom` also rejects NUL/newline (with most-specific checks first so error messages name the actual problem); `BunGitService.addWorktree` argv now includes `--` separator. Six new factory tests + a new BunGitService argv-shape test (with adversarial counter-fake to detect regression) cover the new behaviour. The pre-existing slug-strip test was updated to use non-dash punctuation since leading-`-` branches are now rejected. `worktree-real.test.ts` confirms real git accepts `--`.
- [x] Agent D — `FakeGitService` NUL-byte separator (todo 024). Replaced with nested `Map<Path, Map<string, T>>`; loud-error messages preserved verbatim so substring-match tests stay green; `git diff` now renders the file as text.
- [x] Agent E — `onCacheHit` schema + collision (todos 025 + 026). Added `WorktreeResultSchema` (Zod) beside the `WorktreeResult` interface; `onCacheHit` now `safeParse`s and throws a clear malformed-cache error; branch/fromRef collisions throw a clear collision error naming all four fields. Six new tests in step.test.ts and worktree-executor-cache.test.ts cover both paths.
- [x] End-to-end verification block run on merged tree. `bun run check` exits 0 (1030 pass, 0 fail; 1 pre-existing complexity warning unrelated to these slices). NUL-byte grep returns nothing. `git diff src/services/git/fake-git-service.ts` is text. No `runners/_shared` imports anywhere. The single skipped on-disk run of `examples/worktree-demo/index.ts` is left for the user (creates a real demo branch in the working tree).
- [x] All 6 todos rotated to `done`.
