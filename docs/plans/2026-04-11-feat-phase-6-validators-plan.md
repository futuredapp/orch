---
title: Phase 6 — Validators
type: feat
status: completed
date: 2026-04-11
---

# Phase 6 — Validators

## Enhancement Summary

**Deepened on:** 2026-04-11 via 10 parallel review + research agents (architecture, simplicity, pattern-recognition, performance, security, typescript, data-integrity, best-practices, Bun/Zod docs, repo research).

### Critical fixes to apply before Step 1

1. **Security — SHA injection (HIGH).** `ctx.preRunSnapshot.headSha` is persisted to `state.json` and re-read on resume, then passed to `git diff --name-only <sha>`. A poisoned state file with `sha: '--upload-pack=/tmp/evil'` is remote-code-execution via git protocol helpers (CVE-class: 2024-32002/32004). Two-line fix: (a) add `z.string().regex(/^[0-9a-f]{7,64}$/)` on `preRunSnapshot.headSha` in `StepEntrySchema`, (b) insert `--` separator in every git argv, e.g. `['git','diff','--name-only', sha, '--']`. Do both — defense in depth.
2. **Security — env allowlist (HIGH).** Plan says `BunGitService` passes `env: {}`. That strips `PATH`, `HOME`, and — critically — leaves `GIT_TERMINAL_PROMPT` unset, which means a credential failure will hang the CI forever. Use a minimal allowlist: `{ PATH, HOME, LANG, LC_ALL, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1' }`. Document in `bun-git-service.ts`.
3. **TypeScript — undefined type (BLOCKS COMPILE).** The snippet at `workflow.ts:177` references `ValidationFailureWithName` which is never declared. Either define it next to `ValidationFailure` in `validator.ts` or replace the predicate with `(o): o is Extract<typeof o, { ok: false }>`.
4. **Architecture — `normalizeValidators` location.** Plan puts it "private in workflow.ts" but Step 6 tests want to import it directly. Move to `src/validators/normalize.ts` and export from the barrel. Keeps workflow.ts ignorant of `check`'s placeholder sentinel.
5. **Performance — `safeHeadSha` fires every step.** Plan captures baseline SHA unconditionally before every runner, even on steps with no git validators. Fix: add a lightweight `needs: readonly ('headSha')[]` capability on the `Validator` interface (or scan validator names starting with `git`), and only shell out when needed. Saves ~5-15ms × N steps on workflows without git validators.
6. **Performance — `fileProduced` must short-circuit.** Plan iterates the entire glob result into `matches[]` just to check `length === 0`. Replace with a `for await` + early `return { ok: true }` on first yield. On a 5k-file monorepo `**/*.ts`, this is ~100x faster.

### Medium fixes

7. **Pattern mismatch — `FakeGitService` framing.** Plan claims the loud-on-unscripted philosophy matches `FakeProcessService`, but the imperative `setHeadSha`/`setDiff`/`setClean` API does NOT match `FakeProcessService`'s fluent `when(argv).respondWith(response)` shape. Either adopt the fluent form OR reframe the docstring as "like `FakeFsService`'s direct-state approach, with loud failure on unscripted reads." The latter is cheaper.
8. **Glob safety + defaults.** `fileProduced(glob)` should (a) reject absolute/`..`-traversal patterns at factory time, (b) pass default ignores `['**/node_modules/**', '**/.git/**']`, (c) note that `Bun.Glob` does not match dotfiles by default (`fileProduced('.env')` will silently fail unless `FsService.glob` grows a `dot: true` option).
9. **`git diff --quiet` over `--name-only`.** For `gitDiffCreated()` you only need a boolean. Shell out to `git diff --quiet <sha> --` (exit 0 = clean, 1 = dirty) — O(1) memory regardless of diff size. Add a new `GitService.hasDiffSince(cwd, sha): Promise<boolean>` method; keep `diffSinceSha` for future richer consumers.
10. **Stderr redaction.** `GitCommandError.stderr` can leak `https://user:token@github.com/...` URLs, absolute home paths, and credential-helper messages — which flow into `ValidationFailure.reason` and get persisted to `state.json`. Redact before storing: strip `https?://[^@]+@` credential prefixes, collapse `$HOME` to `~`, cap at ~500 chars. Keep `rawStderr` (un-serialized) for debugging.
11. **Actionable schema-mismatch error.** Wrap Zod's default `"schemaVersion: Invalid literal value, expected 2"` with a message that tells developers what to do: `"State file at <path> is schema v1 (Phase 5); Phase 6 bumped to v2. Pre-production — delete .orch/state/ to reset."` Prevents blind `rm -rf .orch/` reflexes.
12. **Fixture helper before fixture edits.** Land `tests/helpers/make-step-entry.ts` exporting `makeStepEntry(overrides)` and `makeRunState(overrides)` as the FIRST commit of Step 3, then mechanically convert fixtures. Actual touched files (from repo grep): 4 files, ~8 edit points — not "5-10" — because there are no JSON fixtures, only `.toBe(1)` assertions and inline `StepEntry` literals in `tests/{unit,integration}/state/state-store.test.ts` + one `z.literal(1)` reference at `tests/integration/core/workflow.test.ts:158`.
13. **Structural round-trip test.** Add one new test that uses `Object.keys(StepEntrySchema.shape)` to assert every schema key is copied by the loader's explicit-decode block. Self-policing guard against silent-drop drift in future schema bumps.

### Intentional decisions worth re-confirming (agents flagged them as YAGNI, brainstorm resolved them)

- **`hint?` on `ValidatorResult`** — simplicity reviewer said cut. Brainstorm decision 8 explicitly reserved the field for the Phase 14 Stop hook. Keep; cost is one optional key.
- **`defineValidator` + module registry + `getValidator`** — simplicity reviewer said cut (not used by Phase 6 executor). Brainstorm decisions 6 and 7 put the registry in now so Phase 14's out-of-process `orch validate <runId> <stepName>` CLI has no refactor to do. Keep, but **strengthen** per the agent recommendations: rename the test helper to `__resetValidatorRegistryForTests`, guard with `NODE_ENV === 'production'` throw, introduce a typed `DuplicateValidatorError` class, and document in JSDoc that the registry only works cross-process if the Stop hook subprocess can `import` the same files that called `defineValidator`.
- **`preRunSnapshot` persisted to disk** — simplicity reviewer said keep baseline in memory. Brainstorm decision 5 requires on-disk persistence so Phase 14 can re-run validators out-of-process. Keep — this is the load-bearing piece that lets v6 seams be v14-ready.
- **`gitCommitCreated()` alongside `gitDiffCreated()`** — simplicity reviewer said defer. They express distinct assertions ("worked on a file" vs "committed a file"). Keep both; cost is one file + one test.
- **`isClean()` on `GitService`** — simplicity reviewer said cut (unused in Phase 6). **This one has merit.** Grep confirms no Phase 6 consumer. Recommend: cut from Phase 6 port and fake. Phase 10 can add it back when the commit/branch ops land. One fewer moving piece.

### Key additional items to add to Acceptance Criteria

- [ ] `BunGitService` constructor takes a deps bag `{ readonly processService: ProcessService }` — matches `BunFsService`'s `{ readonly homedir?: () => string } = {}` idiom (`src/services/fs/bun-fs-service.ts:30`).
- [ ] Every git argv includes the `--` separator after revision args.
- [ ] `preRunSnapshot.headSha` in `StepEntrySchema` is `z.string().regex(/^[0-9a-f]{7,64}$/)`, not a bare `z.string()`.
- [ ] `safeHeadSha` is called **strictly after** the cache-hit early return (ordering assertion via `FakeGitService` invocation count = 0 on resume).
- [ ] `fileProduced` breaks out of the async iterator on first match (asserted via a spying fake that counts yielded paths).
- [ ] `check(fn)` throws (not normalizes) when `fn` returns `undefined` — programmer-error path, catches accidental missing `return` statements.
- [ ] `ValidationError` implements `Object.setPrototypeOf(this, new.target.prototype)` in constructor (matches `StepError` cross-transpile `instanceof` safety).
- [ ] Structural round-trip test uses `StepEntrySchema.shape` to assert every schema key is preserved through decode.
- [ ] Integration test: "delete `.orch/state/` mid-workflow, resume, assert fresh baseline captured and validators re-run."
- [ ] Integration test: "20+ validators round-trip through atomic write" — sanity check the larger v2 payload.

### Research sources cited below

Bun.Glob API: https://bun.com/docs/api/glob · Bun.spawn: https://bun.com/docs/api/spawn · Zod v3: https://zod.dev/v3 · Git CVEs 2024: https://github.blog/2024-05-14-securing-git-addressing-5-new-vulnerabilities/ · Git environment: https://git-scm.com/docs/git#_environment_variables · tinyglobby (modern glob defaults reference): https://github.com/SuperchupuDev/tinyglobby

---

## Overview

Land post-exit assertions for steps. After a step's runner exits successfully, the executor runs the step's configured validators against the real filesystem and git state. If any validator fails, the workflow throws an aggregated `ValidationError` listing every failure — same crash/resume semantics as `StepError` from Phase 4. A minimal `GitService` port ships with this phase to unblock git-oriented validators without a throwaway refactor.

Source brainstorm: [`docs/brainstorms/2026-04-11-phase-6-validators-brainstorm.md`](../brainstorms/2026-04-11-phase-6-validators-brainstorm.md) — all key decisions resolved, no open questions.

## Problem Statement / Motivation

Validators are the second most-called-out feature in `docs/getting-started.md` after the workflow DSL itself, and they gate the "real feedback early" value the project promises: a step isn't done until the environment says it's done. Landing them now — before Phase 7's typed `returns:` — means every subsequent phase can assert facts about the work, not just trust the runner's exit code. Phase 6 also installs the seams (persisted pre-run snapshot, named validator registry, pure `(services, ctx) → result` shape) that Phase 14's Claude Code `Stop` hook will reuse without refactor.

## Proposed Solution

1. **New module `src/validators/`** with the public surface: `Validator`, `ValidatorResult`, `ValidatorCtx`, `ValidatorServices`, `ValidationError`, `fileProduced`, `gitDiffCreated`, `gitCommitCreated`, `check`, `defineValidator`, `getValidator`.
2. **New service `src/services/git/`** mirroring the `fs/` shape: `GitService` port, `BunGitService` (real, via `ProcessService`), `FakeGitService` (scriptable), barrel.
3. **`WorkflowDeps` grows `fsService` and `gitService`.** Built-in validator factories close over these at workflow level — user code never sees the services.
4. **`StepConfig` gains `validate?: Validator | ReadonlyArray<Validator>`.** Single validators are normalized to a one-element array internally.
5. **Executor wiring in `src/core/workflow.ts`:** snapshot `gitService.headSha()` before `runRunner`, persist it to `StepEntry.preRunSnapshot`, run validators after runner success, aggregate failures into `ValidationError`, persist `validations` array to `StepEntry` only on all-pass.
6. **`StepEntry` schema bumps 1 → 2.** New optional `preRunSnapshot` + required `validations` array. Loader rejects v1 entries. Existing hand-built v1 test fixtures get updated in the same PR (no migration code — pre-production).
7. **`check(fn)` is anonymous** (`check@<stepName>#<index>` auto-name). **`defineValidator(name, fn)`** registers into a module-level registry (`Map<string, Validator>`) for later Stop-hook lookup.

## Technical Approach

### Architecture

```
src/
  validators/
    validator.ts        # types + ValidationError
    file-produced.ts    # fileProduced(glob)
    git-diff-created.ts # gitDiffCreated()
    git-commit-created.ts
    check.ts            # anonymous check(fn)
    define-validator.ts # named + registry
    index.ts            # public barrel
  services/
    git/
      git-service.ts      # port
      bun-git-service.ts  # real adapter (via ProcessService)
      fake-git-service.ts # scriptable fake
      index.ts            # barrel
  core/
    step.ts       # +validate?
    workflow.ts   # +preRunSnapshot capture, +validator loop, +ValidationError
  state/
    state-store.ts  # schemaVersion 1→2, StepEntry+preRunSnapshot,+validations
```

### Key types

```ts
// src/validators/validator.ts
export type ValidatorResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string; readonly hint?: string }

// Generic on V so Phase 7 can flow typed `returns:` through validators
// without a breaking change to every call site.
export interface ValidatorCtx<V = unknown> {
  readonly stepName: StepName
  readonly cwd: Path
  readonly value: V                                   // runner's extractStructuredOutput
  readonly preRunSnapshot?: { readonly headSha: string }  // present iff baseline captured
}

export interface ValidatorServices {
  readonly fs: FsService
  readonly git: GitService
}

export interface Validator<V = unknown> {
  readonly name: string
  readonly needs?: ReadonlyArray<'headSha'>           // capability declaration — lazy baseline
  run(services: ValidatorServices, ctx: ValidatorCtx<V>): Promise<ValidatorResult>
}

export interface ValidationFailure {
  readonly name: string
  readonly reason: string
  readonly hint?: string
}

// Persisted shape — extracted so state-store.ts and the Zod schema share one type.
export interface PersistedValidation {
  readonly name: string
  readonly ok: boolean
  readonly reason?: string
  readonly hint?: string
}

// Internal to the executor loop (answers the missing `ValidationFailureWithName` gap).
export type ValidationOutcome =
  | { readonly name: string; readonly ok: true }
  | { readonly name: string; readonly ok: false; readonly reason: string; readonly hint?: string }

export class ValidationError extends Error {
  constructor(
    readonly stepName: StepName,
    readonly failures: ReadonlyArray<ValidationFailure>,
  ) {
    super(
      `Step "${stepName}" failed validation (${failures.length}):\n` +
        failures.map((f) => `  • ${f.name}: ${f.reason}`).join('\n'),
    )
    this.name = 'ValidationError'
    // Cross-transpile instanceof safety — mirrors StepError pattern.
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

// Thin helpers exported from the validators barrel for explicit return shapes.
export const ok = (): ValidatorResult => ({ ok: true })
export const fail = (reason: string, hint?: string): ValidatorResult => ({ ok: false, reason, hint })
```

> **TypeScript review fixes applied:**
> - `Validator<V = unknown>` + `ValidatorCtx<V = unknown>` generics added *now* so Phase 7's typed `returns:` flows through without a breaking change. Deferring would break every user call site that annotated `Validator` explicitly.
> - `PersistedValidation` extracted as a named type — shared between `state-store.ts` (`StepEntry.validations: ReadonlyArray<PersistedValidation>`) and the Zod schema. Prevents drift.
> - `ValidationOutcome` discriminated union defined — fills the missing `ValidationFailureWithName` reference that would have blocked compile in the executor snippet.
> - `Object.setPrototypeOf(this, new.target.prototype)` — cross-transpile `instanceof` safety, mirrors `StepError`.
> - `ok()` / `fail(reason, hint?)` helpers exported alongside for explicit-result ergonomics in `check(fn)` bodies.
> - `preRunSnapshot` optionality reconciled end-to-end: `{ readonly headSha: string } | undefined`. Either the whole object is absent, or it's present with a valid SHA. No more `preRunSnapshot ?? {}` papering.

```ts
// src/services/git/git-service.ts
export interface GitService {
  headSha(cwd: Path): Promise<string>
  hasDiffSince(cwd: Path, sha: string): Promise<boolean>  // O(1) memory — git diff --quiet
  diffSinceSha(cwd: Path, sha: string): Promise<string>   // raw name-only output for richer consumers
  // isClean() deferred to Phase 10 — Phase 6 has no consumer.
}

export class GitCommandError extends Error {
  constructor(
    readonly exitCode: number,
    readonly stderr: string,   // redacted — see BunGitService
    message: string,
  ) {
    super(message)
    this.name = 'GitCommandError'
    Object.setPrototypeOf(this, new.target.prototype)
  }
}
```

```ts
// StepEntry v2 shape — imports PersistedValidation from src/validators/validator.ts
export interface StepEntry {
  readonly name: string
  readonly value: unknown
  readonly startedAt: number
  readonly endedAt: number
  readonly artifacts: readonly string[]
  readonly preRunSnapshot?: { readonly headSha: string }     // present iff baseline captured
  readonly validations: ReadonlyArray<PersistedValidation>   // shared type
}
```

### Executor integration (workflow.ts)

Two hook points in the existing `run` closure (`src/core/workflow.ts:99-142`):

**Before `runRunner` (current line 114–115):**
```ts
// Early-return path for cached step entries MUST come before safeHeadSha.
// Resume runs must do zero git subprocess calls.
if (state.steps[key] !== undefined) return state.steps[key].value  // existing line

const startedAt = deps.clock.now()

// NEW: lazy baseline capture — only if any configured validator needs headSha.
const normalized = normalizeValidators(s.config.validate, key)
const needsHeadSha = normalized.some(v => validatorNeedsHeadSha(v))
const headSha = needsHeadSha
  ? await safeHeadSha(deps.gitService, deps.cwd)
  : undefined
const preRunSnapshot = headSha !== undefined ? { headSha } : undefined

const result = await runRunner(...)
```

**Lazy baseline capture** (performance review fix #1). Plan's original version called `safeHeadSha` unconditionally before every runner — ~5-15ms × N steps wasted on workflows with no git validators. The lazy form checks whether any configured validator actually needs `headSha` first. Two implementations possible:

- **Name-based detection (simple):** `validatorNeedsHeadSha(v) = v.name.startsWith('git')`. Cheap, fragile (any user validator starting with `git` gets a baseline).
- **Capability declaration (cleaner):** add `readonly needs?: ReadonlyArray<'headSha'>` to the `Validator` interface. `gitDiffCreated` and `gitCommitCreated` set `needs: ['headSha']`; user `check(fn)` defaults to `[]`. Validator authors opt in explicitly.

Phase 6 picks capability declaration — same cost, clearer semantics, forward-compatible if Phase 10 adds more baseline kinds.

`safeHeadSha` is a private helper in workflow.ts that catches `GitCommandError` and returns `undefined` — a non-repo cwd must not crash the workflow just because validators *might* run. Git validators that actually need the baseline fail with a clear reason if it's missing. Other error classes (e.g., `ProcessSpawnError` — git binary missing) propagate as runtime errors; `safeHeadSha` only swallows `GitCommandError`.

> **Performance Insight.** Add to Success Metrics: *"20-step workflow configured with zero git validators makes zero git subprocess calls."* Enforced by a test that asserts `FakeProcessService.invocationCount('git', ...) === 0` after the run. This is the forcing function for the lazy-capture fix above.

**After runner success (current line 129):**
```ts
const value = s.config.agent.extractStructuredOutput(result.finalEvent)

// NEW: run validators (all of them, no fail-fast). `normalized` reused from
// the pre-run block above — don't re-normalize.
const ctx: ValidatorCtx = {
  stepName: key,
  cwd: deps.cwd,
  value,
  preRunSnapshot,   // {headSha: string} | undefined, end-to-end
}
const services: ValidatorServices = { fs: deps.fsService, git: deps.gitService }

// Serial execution by default (performance review fix #2).
// Deterministic failure ordering + no IO thrash on large globs.
// Opt-in parallelism can land in a later phase if workloads demand it.
const outcomes: ReadonlyArray<ValidationOutcome> = []
for (const v of normalized) {
  try {
    const r = await v.run(services, ctx)
    outcomes.push({ name: v.name, ...r })
  } catch (err) {
    outcomes.push({ name: v.name, ok: false, reason: redactErrorMessage(err) })
  }
}

type FailedOutcome = ValidationOutcome & { ok: false }
const failures = outcomes.filter((o): o is FailedOutcome => o.ok === false)
if (failures.length > 0) {
  throw new ValidationError(
    key,
    failures.map(({ name, reason, hint }) => ({ name, reason, hint })),
  )
}

const endedAt = deps.clock.now()
const entry: StepEntry = {
  name: key,
  value,
  startedAt,
  endedAt,
  artifacts: [],
  preRunSnapshot,
  validations: outcomes.map(({ name, ok }) => ({ name, ok })),
}
```

**Invariants preserved:**
- Cached step (`state.steps[key] !== undefined`) still returns early *without* re-running validators — matches brainstorm decision 9's "validators run once, at success time". **Explicit ordering assertion:** the cache-hit early return happens BEFORE `safeHeadSha` is called (enforced by a unit test that asserts `FakeGitService.headSha` invocation count is 0 on resume).
- `StepError` still short-circuits before validators run — if the runner itself errored, validators never execute.
- A failing validator throws `ValidationError` *before* `saveStep`, so no `StepEntry` is persisted. Next run re-executes the runner *and* validators from scratch. Same resume model as `StepError`.
- `setStatus(..., 'crashed')` swallow pattern (workflow.ts:148-155) handles `ValidationError` exactly the same as `StepError`.

> **Research Insights — aggregate error design.**
>
> Considered `AggregateError` (ES2021) vs a custom `ValidationError` with `failures[]`. Custom wins:
> - `AggregateError.errors` is typed as `unknown[]` — we'd lose the typed `{name, reason, hint}` shape without re-wrapping.
> - `AggregateError`'s default `.message` is `"All promises were rejected"` — we'd override it anyway.
> - Stack traces on `AggregateError` are famously poor in Node/Bun.
> - Zod, ajv, and Playwright all ship custom multi-issue error classes for the same reasons.
>
> `ValidationError` should also implement `Object.setPrototypeOf(this, new.target.prototype)` in the constructor — same pattern as `StepError` — for `instanceof` safety across the TS→JS transpile boundary. Optional: implement `[Symbol.iterator]` over `failures` for ergonomic destructuring in tests.
>
> **Serial vs parallel validators.** Plan's original `Promise.all(...)` was changed to sequential `for...of`. Rationale: (a) deterministic failure ordering — `ValidationError.failures` reads in declaration order, (b) no IO thrash on filesystem-heavy validators like `fileProduced('**/*.ts')` on a monorepo, (c) simpler mental model. Risk #6 in the original plan hand-waved this ("revisit if a real workload surfaces"); the agents agreed serial-by-default is the safer default.

### GitService adapters

**`BunGitService`** shells out via the existing `ProcessService` (project rule #1). Commands used:
- `headSha`: `git rev-parse HEAD --` — returns stdout trimmed; translates non-zero exit (e.g. "not a git repository") into `GitCommandError`.
- `hasDiffSince(cwd, sha)`: `git diff --quiet <sha> --` — exit 0 = clean, exit 1 = dirty. O(1) memory regardless of diff size. Preferred over `diffSinceSha` for `gitDiffCreated()`'s boolean question.
- `diffSinceSha(cwd, sha)`: `git diff --name-only <sha> --` — returns raw stdout. Kept for future richer consumers (Phase 10+); not used by Phase 6 validators.
- `isClean`: **cut from Phase 6.** Grep confirms no Phase 6 consumer; Phase 10 re-adds when commit/branch ops land (simplicity review).

All commands drain stdout+stderr concurrently via `Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])` — this is the canonical Bun pattern and the only safe way to avoid pipe deadlock on large output. Mirrors `src/runners/execute.ts:25-53`. Never use `Bun.spawnSync` for git diff — synchronous pipes deadlock on stdout > ~64KB. `cwd` is the branded `Path` passed through `SpawnOptions.cwd`.

**Env handling (security-hardened).** Instead of a bare `env: {}`, `BunGitService` passes a minimal allowlist:
```ts
const GIT_ENV: Readonly<Record<string, string>> = {
  PATH: process.env.PATH ?? '',
  HOME: process.env.HOME ?? '',
  LANG: process.env.LANG ?? 'C',
  LC_ALL: 'C',
  GIT_TERMINAL_PROMPT: '0',     // never hang on credential prompts
  GIT_OPTIONAL_LOCKS: '0',      // no lock contention with user's concurrent git
  GIT_CONFIG_NOSYSTEM: '1',     // ignore /etc/gitconfig
}
```
Rationale: empty env breaks `PATH`-based git binary lookup, kills `HOME/.gitconfig`, and — most importantly — leaves `GIT_TERMINAL_PROMPT` unset, which means a credential failure will hang CI indefinitely. Never inherit `GIT_DIR` or `GIT_WORK_TREE` — a poisoned parent env could redirect git at a different repo.

**SHA argv safety.** Every git command that takes a revision argument uses the `--` separator to disambiguate refs from paths (canonical pattern for CVE-2018-17456 class issues). `diffSinceSha(cwd, sha)` also validates `sha` against `/^[0-9a-f]{7,64}$/i` before spawning — belt-and-suspenders against a future caller passing an arbitrary string. Reject on mismatch with `GitCommandError` (or a new `InvalidGitRefError`).

**Stderr redaction.** `GitCommandError.stderr` is redacted before being stored on the instance: strip `https?://[^@]+@` credential prefixes, collapse absolute `$HOME` paths to `~`, cap at ~500 chars. Keep the raw stderr on a private `#rawStderr` field for debugging; `.stderr` exposes only the redacted form (which is what gets persisted via `ValidationFailure.reason`).

> **Research Insights — Bun API confirmation**
>
> Bun docs (2026) confirm `Bun.Glob.scan()` returns `AsyncIterable<string>` and supports `cwd`, `dot`, `followSymlinks: false` (default), `onlyFiles: true` (default). `Bun.spawn` with `stdout: "pipe"` + `stderr: "pipe"` yields `ReadableStream`s that must be drained concurrently to avoid deadlock. `proc.exited` resolves to exit code. Zod v3.23.8 is locked in `package.json`; `.readonly()` modifier is available in v3. No Zod 4 migration is in scope.
>
> **Git CVE hygiene (2024–2026).** CVE-2024-32002 and CVE-2024-32004 reinforced the rule: never pass user-controlled paths/refs without `--`. Phase 6 only exposes git to trusted SHAs that originate from `rev-parse HEAD`, but state-file poisoning (see top-level security fix #1) reopens the attack surface. SHA regex validation + `--` separator closes it.
>
> Sources: https://bun.com/docs/api/spawn · https://git-scm.com/docs/git-diff · https://github.blog/2024-05-14-securing-git-addressing-5-new-vulnerabilities/

**`FakeGitService`** holds per-cwd scriptable maps:
```ts
const git = new FakeGitService()
git.setHeadSha(cwd, 'abc123')
git.setHasDiff(cwd, 'abc123', true)          // baseline → boolean (for gitDiffCreated)
git.setDiff(cwd, 'abc123', 'src/foo.ts\n')   // baseline → diff text (for diffSinceSha consumers)
```
Unscripted calls throw `Error('FakeGitService: no HEAD SHA scripted for <cwd>')` — a loud failure beats silent defaults. **Framing clarification (from pattern review):** this setter-style scripting matches `FakeFsService`'s direct-state idiom, NOT `FakeProcessService`'s fluent `when(argv).respondWith(...)` builder. Both styles exist in the codebase; choose whichever matches the subject's semantics. Git state is per-cwd key-value, so setters read more naturally than argv pattern-matching.

### Built-in validators

**`fileProduced(glob: string)`** — returns a `Validator` with `name: 'fileProduced(<glob>)'`.
```ts
async run(services, ctx) {
  // Short-circuit: break on first match. Cheap when glob is `**/*.ts` on a monorepo.
  for await (const _ of services.fs.glob(glob, {
    cwd: ctx.cwd,
    ignore: ['**/node_modules/**', '**/.git/**'],  // sensible defaults
  })) {
    return { ok: true }
  }
  return {
    ok: false,
    reason: `No files matched glob "${glob}" under ${ctx.cwd}`,
    hint: `Make sure the step writes at least one file matching "${glob}".`,
  }
}
```

**Factory-time validation.** `fileProduced(glob)` throws synchronously when:
- The glob is empty or whitespace-only (programmer error, not runtime failure).
- The glob starts with `/` (absolute path — potential sandbox escape).
- The glob starts with `~` (home dir — same).
- The glob contains a `..` path segment (parent traversal — same).

**Dotfile gotcha.** `Bun.Glob` does NOT match dotfiles by default (`fileProduced('.env')` silently fails). Options:
- Document the limitation in JSDoc and leave it.
- Thread a `dot?: boolean` option through `FsService.glob` and through `fileProduced(glob, { dot })`.

Phase 6 picks (a) — documented limitation. Phase 7+ can add the option if users hit it.

> **Research Insights — glob validator patterns (2026)**
>
> `tinyglobby` (the 2025 replacement for `fast-glob`) is the reference for "sensible defaults" — its ignore list is exactly `['**/node_modules/**', '**/.git/**', '**/dist/**']`. Vitest, ESLint 9, and Prettier 3 all ship variants of this list. `**/dist/**` is tempting but orch workflows may legitimately write artifacts under `dist/` — leave it out of Phase 6's default, document that users can pass their own `ignore` once the option is threaded.
>
> `Bun.Glob` has no gitignore awareness (confirmed from Bun docs). If users want gitignore-respecting behavior, they must pass their own ignore list. Out of scope for Phase 6.
>
> Source: https://bun.com/docs/api/glob · https://github.com/SuperchupuDev/tinyglobby

**`gitDiffCreated()`** — name `'gitDiffCreated'`. Uses `hasDiffSince` (boolean, O(1) memory), not `diffSinceSha` (string buffer).
```ts
async run(services, ctx) {
  const baseline = ctx.preRunSnapshot?.headSha
  if (baseline === undefined) {
    return { ok: false, reason: 'No baseline HEAD SHA captured — is cwd a git repo?' }
  }
  const hasDiff = await services.git.hasDiffSince(ctx.cwd, baseline)
  if (!hasDiff) {
    return {
      ok: false,
      reason: `No file changes since baseline ${baseline.slice(0, 8)}`,
      hint: 'The step should produce or modify at least one tracked file.',
    }
  }
  return { ok: true }
}
```

**`gitCommitCreated()`** — name `'gitCommitCreated'`. Compares `headSha()` now vs. `ctx.preRunSnapshot.headSha`. Missing baseline → clear failure reason.

### User validators

**`check(fn, opts?: { name?: string })`** — anonymous one-shot.
- `fn` signature: `(ctx: ValidatorCtx) => MaybePromise<true | false | string | ValidatorResult>`.
- Return-shape normalization: `true` → `{ok:true}`; `false` → `{ok:false, reason:'check returned false'}`; `string` → `{ok:false, reason:<string>}`; full result passed through. **`undefined` return throws a programmer-error** (`Error('check(fn) returned undefined — did you forget a return?')`) — catches the `(ctx) => { ctx.value.foo }` bug. Thrown exceptions are NOT caught inside `check`; they bubble to the executor's existing try/catch at `workflow.ts:172` which normalizes them into a `ValidationFailure`. Single catch point preserves stack traces (Vitest made this same change in v1 for exactly this reason).
- **Helpers exported alongside:** `ok()` and `fail(reason, hint?)` thin constructors, so the explicit-result path is ergonomic:
  ```ts
  check((ctx) => ctx.value.count > 0 ? ok() : fail('count was zero'))
  ```
  The `true | false | string` sugar is documented as "convenience for inline one-liners only"; non-trivial validators should use `ok`/`fail` or `defineValidator`.
- Auto-name generation: `check` is a *factory*. It returns a `Validator` with a placeholder `name: 'check'`. A helper `normalizeValidators(validate, stepName)` re-names each anonymous `check` to `check@<stepName>#<index>` when the executor resolves `validate:`. **Location (per architecture review):** this helper lives in `src/validators/normalize.ts` — NOT in `workflow.ts` — so the executor never imports `check.ts`'s placeholder sentinel. It's exported from the validators barrel for direct unit-testing without reaching into workflow internals.

**`defineValidator(name, fn)`** — named + registered.
- Same `fn` shape as `check`.
- **Returns a `Validator` directly, NOT a factory function.** (TypeScript review correction.) `fileProduced('*.md')` is a factory because it parameterizes on the glob argument; `defineValidator` takes no runtime config, so returning `() => Validator` adds parentheses for no reason. Call sites are `validate: [myValidator]`, matching `check(...)` ergonomics.
- Registers the validator under `name` in a module-level `Map<string, Validator>` (`src/validators/define-validator.ts`). Duplicate name throws a typed `DuplicateValidatorError extends Error` (not plain `Error`) so tests can assert on the class, not the message.
- `getValidator(name): Validator | undefined` exported for future `orch validate` CLI (Phase 14). Not used by the executor in Phase 6.

**Module-scope registry — rule #8 mitigation (strengthened).**
The `Map` is declared empty; it only mutates when user code explicitly calls `defineValidator(...)`. No imports trigger registration. Strengthened mitigations:
1. Test isolation uses an exported `__resetValidatorRegistryForTests()` helper (renamed from `__resetValidatorRegistry()` to make intent undeniable; underscore-prefixed, not in the public barrel). Wired into the `define-validator.test.ts` `afterEach` — also the unit tests include a regression case that registers the same validator name twice across two test bodies to prove the reset works.
2. `__resetValidatorRegistryForTests()` throws if `process.env.NODE_ENV === 'production'` — same pattern `react-dom` uses for test-only exports.
3. Lazy allocation: `const getRegistry = (() => { let r: Map<string, Validator> | null = null; return () => r ??= new Map() })()` — lets a tree-shaker drop the Map entirely if `defineValidator` is never imported.
4. JSDoc on `defineValidator` explicitly documents the Phase 14 constraint: "The registry is process-local. An out-of-process consumer (`orch validate`) can only see validators whose defining file has been imported. Place `defineValidator` calls in files that the Stop hook CLI will load — typically alongside your workflow."

> **Architecture review caveat:** an even cleaner alternative is to convert the registry to a DI instance hanging off `WorkflowDeps.validatorRegistry`, with a convenience singleton for ergonomics. Costs ~15 lines and fully honors rule #8. The brainstorm locked in the module-global approach; if that's flexible, the DI version is architecturally preferred. Otherwise, the strengthened mitigation above is acceptable — Phase 14 can revisit.

### State store schema bump

`src/state/state-store.ts` changes:
- `RunState.schemaVersion: 1` → `2`.
- `StepEntry` gains `preRunSnapshot?`, `validations`.
- `StepEntrySchema` (zod) gains the new fields. `validations` is `z.array(z.object({name, ok, reason?, hint?})).readonly()` — always present, may be empty. `.readonly()` forces parse-time immutability so Zod's inferred type matches the `ReadonlyArray<...>` TS declaration.
- `preRunSnapshot` is **`{ readonly headSha: string }` with the field required when the baseline exists** — not `headSha?`. Either the whole `preRunSnapshot` is absent (non-git cwd), or it's present with a valid SHA. End-to-end: `safeHeadSha(): Promise<string | undefined>` → `preRunSnapshot: {headSha: string} | undefined`. This removes the `preRunSnapshot ?? {}` papering-over in the executor snippet.
- **`preRunSnapshot.headSha` is regex-constrained** in Zod: `z.string().regex(/^[0-9a-f]{7,64}$/i)`. This is the load-bearing security fix — a poisoned state file with `sha: '--upload-pack=/tmp/evil'` fails the schema at load time, before any git argv is constructed. See top-level critical fix #1.
- `RunStateSchema.schemaVersion` → `z.literal(2)`.
- **Actionable error wrapping.** Loader catches the `ZodError`, inspects `result.error.issues` for a `schemaVersion` path, and re-throws `StateCorruptionError` with an actionable message: `"State file at <path> is schema v1 (Phase 5); Phase 6 bumped to v2. Pre-production — delete .orch/state/ to reset."` This is a ~10-line special case in `loadRun`, not a migration system.
- `saveStep` and `initRun` write `schemaVersion: 2`.
- Loader's step reconstruction (`state-store.ts:110-119`) explicitly copies `preRunSnapshot` and `validations` — no `...step` spread, maintaining the existing explicit-decode pattern.
- **New structural round-trip test.** Asserts `Object.keys(StepEntrySchema.shape).every(key => key in decodedStep)`. Self-policing guard: future schema extensions that forget to update the decode block fail this test instead of silently dropping fields.

**Actual fixture touch points (from repo grep — simpler than "5-10 files"):**
- `src/state/state-store.ts` — interface + schema + 2 write literals + loader decode block (~5 edit points).
- `tests/unit/state/state-store.test.ts` — 2 `.toBe(1)` assertions (lines 100, 200) + `makeEntry()` helper at line 15.
- `tests/integration/state/state-store.test.ts` — 1 `.toBe(1)` assertion (line 38) + `makeEntry()` helper at line 14.
- `tests/integration/core/workflow.test.ts` — 1 `z.literal(1)` reference (line 158).

**Total: 4 files, ~8 edit points.** There are zero JSON fixtures on disk — only inline literals and `.toBe(1)` assertions. Land `tests/helpers/make-step-entry.ts` (exporting `makeStepEntry(overrides)` + `makeRunState(overrides)`) as the FIRST commit of Step 3, then mechanically convert the two existing `makeEntry()` helpers to import from it. Reviewer sees a single atomic diff per file.

### Test-fixture migration

Existing unit tests that hand-build v1 `StepEntry` or `RunState` objects must be updated in the same PR:

- `tests/unit/state/state-store.test.ts` — all hand-built states bump to v2; add `validations: []` to step fixtures where needed.
- `tests/unit/core/workflow.test.ts` — executor tests that inspect `StepEntry` gain `validations` assertions.
- `tests/integration/state/state-store.test.ts` — same.
- `tests/integration/core/workflow.test.ts` — same.

No grep-and-replace; each fixture needs human review to confirm `validations: []` (vs. populated) is correct for the scenario.

## Acceptance Criteria

### Types & public surface

- [ ] `src/validators/validator.ts` exports `Validator`, `ValidatorResult`, `ValidatorCtx`, `ValidatorServices`, `ValidationFailure`, `ValidationError`.
- [ ] `src/validators/index.ts` barrel re-exports: `fileProduced`, `gitDiffCreated`, `gitCommitCreated`, `check`, `defineValidator`, `getValidator`, `ValidationError`, plus all validator types.
- [ ] `src/index.ts` re-exports `./validators/index.ts`.
- [ ] `src/services/git/index.ts` exports `GitService`, `BunGitService`, `FakeGitService`, `GitCommandError`.
- [ ] `src/services/index.ts` re-exports the git barrel.
- [ ] `StepConfig` (`src/core/step.ts`) gains `readonly validate?: Validator | ReadonlyArray<Validator>`.
- [ ] `WorkflowDeps` (`src/core/workflow.ts`) gains `readonly fsService: FsService` and `readonly gitService: GitService`.
- [ ] No file exceeds 300 lines; no function exceeds 60 lines (rule #5). Warn-comment if any does.
- [ ] No `any`, no `!` non-null assertions (rule #6).

### GitService

- [ ] `BunGitService` routes all subprocess calls through `ProcessService` — no direct `child_process`/`Bun.spawn` imports (rule #1).
- [ ] `GitCommandError` carries `exitCode`, `stderr`, and a readable message.
- [ ] `FakeGitService.setHeadSha / setDiff / setClean` fluent scripts, throws loud on unscripted lookups.

### Executor behavior

- [ ] `preRunSnapshot.headSha` captured *before* `runRunner` invocation (assertable via invocation order on `FakeGitService`).
- [ ] `safeHeadSha` returns `undefined` in non-git cwd without crashing the workflow.
- [ ] All validators run to completion (no fail-fast) when any fails.
- [ ] A thrown exception inside a validator is normalized to `{ ok: false, reason: err.message }` and *still* collected into `ValidationError.failures`.
- [ ] `ValidationError.failures` preserves validator order, carries `{ name, reason, hint? }`.
- [ ] `StepEntry` is *not* persisted when any validator fails (symmetric with `StepError`).
- [ ] `StepEntry.validations` is persisted and round-trippable through `FileStateStore` when all validators pass.
- [ ] Cached step (`state.steps[key] !== undefined`) returns `value` without re-running validators.
- [ ] `StepError` short-circuits *before* validators run — proven by a test with a failing runner + a failing validator, where only `StepError` surfaces.
- [ ] `setStatus('crashed')` swallow pattern continues to work for `ValidationError` (same try-catch as `StepError`).

### State schema

- [ ] `schemaVersion: 2` in `RunStateSchema` and in all `saveStep`/`initRun` writes.
- [ ] Loader rejects v1 entries with a clear `StateCorruptionError`.
- [ ] Existing hand-built v1 fixtures across unit + integration tests are updated to v2.

### User-facing validators

- [ ] `fileProduced('*.md')` matches ≥1 file → ok; 0 files → failure with glob + cwd in reason.
- [ ] Empty or whitespace-only glob passed to `fileProduced` throws synchronously at factory time.
- [ ] `gitDiffCreated()` fails with a clear reason when `preRunSnapshot.headSha` is missing.
- [ ] `gitCommitCreated()` passes only when current HEAD SHA differs from baseline.
- [ ] `check(fn)` accepts `true | false | string | ValidatorResult` and a thrown exception, normalizing each.
- [ ] `check` auto-names to `check@<stepName>#<index>` on invocation (appears in `ValidationError` message and in `StepEntry.validations`).
- [ ] `defineValidator('tests-passed', fn)` registers into the module registry; duplicate registration throws.
- [ ] `getValidator('tests-passed')` retrieves the registered validator.
- [ ] `__resetValidatorRegistry()` is exported but *not* in the public barrel (`src/validators/index.ts`) — only imported directly by tests.

### Test layers (three per validator)

**Unit — validator logic against fakes:**
- [ ] `fileProduced`: matches on glob hit, empty match, missing cwd, empty-glob programmer error.
- [ ] `gitDiffCreated`: diff present → ok; empty diff → fail; missing baseline → fail with distinct reason.
- [ ] `gitCommitCreated`: HEAD changed → ok; HEAD unchanged → fail; missing baseline → fail.
- [ ] `check(fn)` return-shape normalization: all five cases (`true`, `false`, `string`, full result, thrown exception).
- [ ] `check` auto-name format asserted against a captured `StepEntry.validations[i].name`.
- [ ] `defineValidator` registers + retrieves; duplicate throws a loud error.
- [ ] `ValidationError` renders all failures in `.message` and carries the structured `.failures` array.

**Unit — executor wiring (in `tests/unit/core/workflow.test.ts`, style-matching existing file):**
- [ ] `workflow.run()` captures `preRunSnapshot.headSha` from `GitService` *before* `runRunner` (asserted via call-order on `FakeGitService` + `FakeProcessService`).
- [ ] Successful runner + passing validators → `StepEntry.validations` has one entry per validator, all `ok: true`.
- [ ] Successful runner + one failing validator → `ValidationError` with one failure, `StepEntry` not persisted.
- [ ] Successful runner + two failing validators → `ValidationError` with both failures (proves no fail-fast).
- [ ] Failing runner short-circuits: `StepError` surfaces, validators never invoked.
- [ ] Resume path: cached step entry returns `value`, `FakeGitService.headSha` is never called, validators never run.
- [ ] `validate:` as a single `Validator` and `validate:` as `Validator[]` produce identical executor behavior.

**Integration — real I/O (gated by nothing; these always run in `bun run test:int`):**
- [ ] `fileProduced` against a real temp dir (`BunFsService`): matches `**/*.md`, fails cleanly on empty dir, handles nested matches.
- [ ] `gitDiffCreated` + `gitCommitCreated` against a real temp git repo (`tests/helpers/temp-git-repo.ts` + `BunGitService`): baseline snapshot → modify file → diff appears → commit → `gitCommitCreated` passes.
- [ ] Full pipeline: `FakeRunner` that succeeds without side effects + `validate: fileProduced('out/*.txt')` against a real temp dir → `ValidationError` with the expected failure reason.
- [ ] Full pipeline: `FakeRunner` with a scripted filesystem side-effect in its response → validators pass → `StepEntry.validations` persisted to disk, readable back via `FileStateStore`.
- [ ] `tests/helpers/temp-git-repo.ts` handles init + seed commit + cleanup, and is lifecycle-safe (`afterEach` removes tmp dirs even on test failure).

### Gate

- [ ] `bun run check` green: lint + typecheck + unit + mocked-integration tests (rule #10).

## Implementation Plan

### Step 1 — Ground types (no I/O)

**Files:** `src/validators/validator.ts`, `src/validators/index.ts` (stub).
**Tests:** `tests/unit/validators/validation-error.test.ts`.

Define `Validator`, `ValidatorResult`, `ValidatorCtx`, `ValidatorServices`, `ValidationFailure`, `ValidationError`. Unit-test `ValidationError` message rendering and `.failures` array shape. Nothing else imports these yet; the rest of the phase builds on top.

### Step 2 — `GitService` port + fakes + real adapter

**Files:**
- `src/services/git/git-service.ts` — interface + `GitCommandError`.
- `src/services/git/fake-git-service.ts` — scriptable in-memory fake.
- `src/services/git/bun-git-service.ts` — shells out via `ProcessService`.
- `src/services/git/index.ts` — barrel.
- `src/services/index.ts` — add git re-exports.

**Tests:**
- `tests/unit/services/git/fake-git-service.test.ts` — scripting, loud-on-unscripted, per-cwd isolation.
- `tests/unit/services/git/bun-git-service.test.ts` — with `FakeProcessService`, assert argv + cwd + env for each method, error translation on non-zero exit.

Mirror the `src/services/fs/` layout exactly. Use `FakeProcessService.when(...).respondWith(...)` pattern to script subprocess responses for `BunGitService` unit tests.

### Step 3 — `StepEntry` schema v2 bump

**Files:** `src/state/state-store.ts`.
**Tests to update:** every hand-built v1 fixture across `tests/unit/state/`, `tests/unit/core/`, `tests/integration/state/`, `tests/integration/core/`.

Bump `schemaVersion` literal. Extend `StepEntry` with `preRunSnapshot?` + `validations`. Extend `StepEntrySchema` (zod). Extend loader's explicit-decode block to copy the new fields. Add one new unit test asserting `StateCorruptionError` on a loaded v1 JSON fixture.

Run `bun run check` — expect typecheck failures in all existing tests that build `RunState` / `StepEntry` objects. Fix each by adding `validations: []` (and `schemaVersion: 2`) until green.

### Step 4 — `WorkflowDeps` extension + executor wiring

**Files:** `src/core/workflow.ts`, `src/core/step.ts`, `src/core/index.ts`.

Extend `WorkflowDeps` with `fsService`, `gitService`. Extend `StepConfig` with `validate?`. Add `normalizeValidators(config, stepName)` private helper that (a) wraps a single validator into an array, (b) re-names anonymous `check` validators to `check@<stepName>#<index>`.

Add the two hook points in the `run` closure:
1. `safeHeadSha` before `runRunner`.
2. Validator loop after `extractStructuredOutput`, before `saveStep`.

Add unit tests for executor wiring (seven scenarios listed in acceptance criteria) to `tests/unit/core/workflow.test.ts`. Use `makeDeps()` helper, extending it to inject `FakeGitService` + `FakeFsService`.

At this point no real validators exist yet — use inline `{name, run}` literals to exercise the executor. This keeps Step 4 independent from Step 5.

### Step 5 — Built-in validators

**Files:** `src/validators/file-produced.ts`, `src/validators/git-diff-created.ts`, `src/validators/git-commit-created.ts`. Update `src/validators/index.ts` barrel.

**Tests:** one unit test file per validator under `tests/unit/validators/`, each exercising pass + fail + error paths with the relevant fake service. Names embed in failure reasons.

### Step 6 — User validators: `check` + `defineValidator`

**Files:** `src/validators/check.ts`, `src/validators/define-validator.ts`. Update barrel.

**Tests:**
- `tests/unit/validators/check.test.ts` — return-shape normalization (five cases), auto-name assertion via the executor (import `normalizeValidators` from workflow — expose a test-only entry or rely on full `workflow.run()` path).
- `tests/unit/validators/define-validator.test.ts` — registry put/get/duplicate, `__resetValidatorRegistry()` works, uses `afterEach(__resetValidatorRegistry)`.

### Step 7 — Integration tests

**Files:**
- `tests/helpers/temp-git-repo.ts` — `createTempGitRepo()` returns `{ cwd: Path, seedCommit: string, cleanup: () => Promise<void> }`. Uses `node:fs/promises.mkdtemp` + shells `git init`, `git commit --allow-empty -m seed` via `Bun.spawn` (test helper, not production — allowed in `tests/`). Respects `afterEach` cleanup.
- `tests/integration/validators/file-produced.test.ts` — real temp dir via `BunFsService`.
- `tests/integration/validators/git-validators.test.ts` — real temp git repo + `BunGitService`.
- `tests/integration/core/validators-workflow.test.ts` — full pipeline with `FakeRunner`, real temp dir, real `FileStateStore`, both the failing and passing end-to-end cases.

### Step 8 — Docs + phase doc update

**Files:**
- `docs/plans/implementation-phases.md` — mark Phase 6 ☑ after land, add "Landed: 2026-04-11" and link to this plan. (Do *not* edit during implementation; flip only after PR merges.)
- `docs/getting-started.md` — sweep for any validator TODO markers or stale API sketches; align with the shipped API.

## Success Metrics

- `bun run check` green locally before push.
- Every validator has ≥1 unit test (fake service), ≥0 executor-wiring test, and at least one integration test in the aggregate integration suite.
- `ValidationError` from a workflow with three failing validators shows all three failures in one run — measured by the multi-failure executor-wiring test.
- Cached step re-run takes zero subprocess calls to git (measured by `FakeProcessService` invocation count on the resume test).
- **Zero-baseline tax:** a 20-step workflow configured with no git validators performs zero `git rev-parse` subprocess calls (enforced by `FakeProcessService` invocation counter). Gates the lazy `safeHeadSha` fix.
- **`fileProduced` short-circuit:** a test with a scripted fake that yields 1000 paths asserts `fileProduced` consumed at most 1 yield before returning `{ok: true}` (via a counter on the fake).
- **Large-diff memory safety:** `gitDiffCreated()` against a temp repo with a 10 MB diff uses `hasDiffSince` (exit-code based), not `diffSinceSha` — verified by the BunGitService unit test asserting argv contains `--quiet`.

## Dependencies & Risks

**Dependencies:**
- Phase 4 (state store + resume) — landed. Provides `FileStateStore.saveStep`, `StepEntry`, and the crash/resume model this phase mirrors.
- Phase 5 (ClaudeRunner) — landed. Not strictly required, but the `FakeRunner` + runner-result flow used for integration tests is already exercised by Phase 5.

**Risks:**
- **Test fixture migration burn-down is tedious.** Expected ~4 files / 8 edit points (per repo grep — lower than the original "5-10 files" estimate). Mitigation: do Step 3 in isolation on a branch, land `tests/helpers/make-step-entry.ts` FIRST, then mechanically convert the two existing `makeEntry()` helpers to import from it. Get `bun run check` green, commit, then proceed to Step 4. Keep the diff small per commit so a reviewer can verify each fixture change is intentional.
- **`safeHeadSha` masking real errors.** If `BunGitService` throws for a non-`GitCommandError` reason (e.g., `ProcessSpawnError` — git binary missing), swallowing it with `undefined` hides a real misconfiguration. Mitigation: `safeHeadSha` catches only `GitCommandError`; any other error propagates as a runtime error. Add a unit test for the bubble-up case.
- **Module-level validator registry + test isolation.** If a test forgets to call `__resetValidatorRegistryForTests()`, a duplicate-name error surfaces in a later test run. Mitigation: the reset helper is wired into a shared `afterEach` in the `define-validator.test.ts` describe block, the helper throws when `NODE_ENV === 'production'`, and the Step 6 test layer includes a regression test that runs the registration case twice to prove isolation. Duplicate registration throws a typed `DuplicateValidatorError` so tests can assert on the class.
- **`check` auto-name coupling.** The rename lives in `src/validators/normalize.ts` (moved out of `workflow.ts` per architecture review). `workflow.ts` calls `normalizeValidators(validate, stepName)` as an opaque function, preserving workflow's ignorance of the placeholder sentinel. The rename is a pure function of `(validators, stepName)` — unit-testable without reaching into workflow internals.
- **Serial validator execution.** Plan changed from `Promise.all` to sequential `for...of` based on performance review: deterministic failure ordering, no IO thrash on large globs. If a real workload demands parallelism later, add an opt-in flag — do NOT flip the default.
- **Git SHA state poisoning (security).** `preRunSnapshot.headSha` is read from disk on resume and passed to git argv. Without the Zod regex constraint and the `--` separator, a poisoned state file is remote-code-execution via git protocol helpers. **Both fixes are required** (see top-level critical fix #1). Add an explicit unit test: write a state file with `headSha: '--upload-pack=/tmp/evil'`, assert the loader rejects it with `StateCorruptionError`.
- **Git env stripping breaks credential prompts.** An empty `env: {}` leaves `GIT_TERMINAL_PROMPT` unset — a credential failure will hang CI forever. Mitigation: explicit allowlist (`PATH`, `HOME`, `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`, `GIT_CONFIG_NOSYSTEM=1`). See GitService adapters section.
- **Stderr credential leakage.** Git stderr routinely contains `https://user:token@github.com/...` URLs, absolute home paths, and credential-helper strings — which flow via `GitCommandError.stderr` → `ValidationFailure.reason` → persisted `state.json`. Mitigation: `BunGitService` redacts before constructing the error (strip credential prefixes, collapse `$HOME` to `~`, cap length). Add a test that asserts a URL with an embedded token is redacted before reaching `ValidationFailure.reason`.
- **State file atomicity with larger v2 payload.** `FileStateStore.#atomicWrite` already uses tmp+rename (POSIX-atomic). No `fsync` before rename, so a power-loss window exists. Pre-production — acceptable. Add a TODO at `#atomicWrite` noting fsync is deferred to Phase 10+. Add one integration test: "20+ validators round-trips through atomic write" — sanity check the bigger shape.

> **Research Insights — risk framing**
>
> All HIGH-severity security findings stem from one decision: persisting baseline SHA to disk for Phase 14 forward-compat. The brainstorm's architecture is correct (persist the baseline), but the implementation must treat `state.json` as an untrusted input on resume — same discipline as treating user-supplied HTTP request bodies. The Zod regex constraint is the load-bearing check; everything else (the `--` separator, the env allowlist, the stderr redaction) is defense in depth.
>
> Agent verdict convergence: architecture-strategist, best-practices researcher, and security reviewer independently flagged the same two points (registry mitigation strength, git argv safety). The plan's original treatment of both was adequate but thin — the insights above are the concrete hardening steps each reviewer recommended.

## Alternative Approaches Considered

1. **Ship `GitService` as a separate phase before Phase 6.** Rejected — creates a dead-end phase with no user-visible deliverable. The brainstorm's "minimal port now, grow in Phase 10" approach is cheaper and keeps the rule #1 seam honest.
2. **Fail-fast validators.** Rejected — the brainstorm's decision 2 nails this: multi-failure DX is strictly better ("you see all missing pieces in one shot") and matches the future Stop-hook use case.
3. **Validators as part of `Runner` interface.** Rejected — violates rule #2 (runners are adapters). Validators are a workflow-layer concern; runners stay focused on subprocess protocol.
4. **Persist `preRunSnapshot` in a separate sidecar file.** Rejected — doubling state files for one field isn't worth the complexity. `StepEntry` is already the per-step record.
5. **Auto-migrate v1 state to v2.** Rejected by brainstorm decision 7 — pre-production, migration code costs more than fixing a handful of fixtures.

## Future Considerations

- **Phase 7** will add `returns: schema(…)` — the validator `ctx.value` becomes a typed Zod-parsed object instead of raw JSON. `check(fn)` receives the same typed value via TypeScript generics on `StepConfig`.
- **Phase 10** will grow `GitService` with `stageAll`, `commit`, branch management. The port stays the same; new methods get added. Existing validators don't change.
- **Phase 13 (tmux)** will surface `validations[].name` + pass/fail in the status bar — stable names matter, which is why `defineValidator` registers by name.
- **Phase 14 (Stop hook)** will re-invoke validators from a separate process: `orch validate <runId> <stepName>` loads the persisted `preRunSnapshot`, constructs a `ValidatorCtx`, looks up named validators via `getValidator()`, and runs them. That's exactly the shape Phase 6 ships — no refactor needed.

## References & Research

### Source brainstorm

- [`docs/brainstorms/2026-04-11-phase-6-validators-brainstorm.md`](../brainstorms/2026-04-11-phase-6-validators-brainstorm.md) — all eight resolved decisions, deliverables list, three-layer test plan.

### Existing code patterns (mirror exactly)

- `src/services/fs/fs-service.ts` — port shape.
- `src/services/fs/bun-fs-service.ts` — real-adapter guard pattern.
- `src/services/fs/fake-fs-service.ts` — scriptable fake template.
- `src/services/process/fake-process-service.ts:10-24` — `when(...).respondWith(...)` fluent API, reused for `BunGitService` unit tests.
- `src/services/types.ts:1-28` — `Path` branded type; all path arguments across new code use it.
- `src/core/workflow.ts:34-40` — `WorkflowDeps` extension point.
- `src/core/workflow.ts:99-142` — the `run` closure; hook points at L114 (preRunSnapshot) and L129 (validator loop).
- `src/core/workflow.ts:61-70` — `StepError` class; `ValidationError` mirrors the structured-fields-plus-readable-message shape.
- `src/core/workflow.ts:148-155` — `setStatus('crashed')` swallow pattern; `ValidationError` propagates through it unchanged.
- `src/state/state-store.ts:6-19` — `StepEntry` + `RunState` types to extend.
- `src/state/state-store.ts:42-55` — zod schemas to extend.
- `src/state/state-store.ts:110-119` — explicit decode block (no spread) to extend.
- `src/runners/execute.ts:12-66` — the stderr-drain + process-kill pattern that `BunGitService` reuses.
- `src/runners/fake/fake-runner.ts:31-58` — script-queue pattern for integration tests.
- `tests/unit/core/workflow.test.ts:13-50` — `makeDeps()` factory + AAA test style to extend.
- `tests/integration/core/workflow.test.ts:40-75` — four-step workflow integration harness template.
- `tests/integration/state/state-store.test.ts:26-54` — temp-dir lifecycle + `afterEach` cleanup pattern for `temp-git-repo.ts`.

### Project rules that constrain this phase

- [`CLAUDE.md`](../../CLAUDE.md) rules #1 (subprocess isolation), #2 (runner adapters), #3 (mock only at the edge), #5 (size limits), #6 (strict TS), #7 (single barrel), #8 (no import-time side effects), #9 (branded `Path`), #10 (`bun run check` gate). Every rule applies to this phase; #8 has a registry-module mitigation noted above.

### Roadmap

- [`docs/plans/implementation-phases.md:162-179`](implementation-phases.md) — Phase 6 charter (to be flipped ☑ after land).

### Related skills

- `phase-implementer` — load at start of implementation to enforce phased discipline.
- `testing-strategy` — three-layer testing strategy ("mock only at the edge"). Every validator needs all three layers.
