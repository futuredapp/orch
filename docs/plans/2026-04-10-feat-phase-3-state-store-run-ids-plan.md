---
title: Phase 3 — State store, run IDs, run registry
type: feat
status: draft
date: 2026-04-10
phase: 3
relates-to:
  - docs/plans/implementation-phases.md
---

# Phase 3 — State store + run IDs

## Enhancement Summary

**Deepened on:** 2026-04-10
**Agents used:** architecture-strategist, performance-oracle, security-sentinel, code-simplicity-reviewer, data-integrity-guardian, kieran-typescript-reviewer, pattern-recognition-specialist, best-practices-researcher, framework-docs-researcher, repo-research-analyst, spec-flow-analyzer, agent-native-reviewer

### Key Improvements
1. Add `schemaVersion: 1` to `RunState` — prevents painful schema migration later
2. Add `status` field to `RunState` — Phase 11 needs `'running' | 'completed' | 'crashed'`; adding now avoids breaking change
3. Drop `durationMs` from `StepEntry` — redundant with `endedAt - startedAt`, consistency bug vector
4. Guard `JSON.stringify` in `saveStep` — catch and throw on non-serializable values
5. Replace `exists()` + `readFile()` with try-catch — eliminates TOCTOU race, simpler
6. Add `StateCorruptionError` class — lets Phase 12 CLI catch by type

### New Considerations Discovered
- `readDir` returns basenames (verified in `FakeFsService`) — `RUN_ID_PATTERN` filter is safe
- Concurrent `saveStep` calls on same run can race (Phase 8's `parallel()`) — add per-runId serialization or TODO
- State files may contain secrets from LLM output — consider restrictive file permissions
- `value: unknown` silently loses data through `JSON.stringify` — needs runtime guard

---

## Overview

Land deterministic, inspectable persistence for workflow runs. Three modules: a run ID generator, a state store with atomic writes, and a run registry for listing/querying past runs. No workflow DSL yet — Phase 4 consumes these as the memoization backend.

## Problem statement / motivation

Phase 4's `run(STEP)` needs name-keyed memoization so that resumed workflows skip completed steps. Phase 11's `workflow.resume(runId)` reloads a crashed run from disk. Phase 12's CLI needs `orch runs` and `orch status <id>`. All three depend on a persistence layer that:

1. Generates deterministic, human-readable run identifiers
2. Loads and saves per-step state atomically (no half-written files on crash)
3. Lists and queries runs by ID or prefix

Phase 1 shipped the I/O seams this phase plugs into: `FsService` (with `rename` for atomic swap), `Clock` (for deterministic timestamps), `FakeFsService` and `FakeClock` for tests.

## Prerequisites (from Phase 1 + 2)

| Artifact | Location | Status |
|---|---|---|
| `FsService` interface | `src/services/fs/fs-service.ts` | shipped |
| `FsService.rename()` atomic swap | `src/services/fs/fs-service.ts:6` | shipped |
| `BunFsService` real adapter | `src/services/fs/bun-fs-service.ts` | shipped |
| `FakeFsService` in-memory fake | `src/services/fs/fake-fs-service.ts` | shipped |
| `Clock` interface | `src/services/clock/clock.ts` | shipped |
| `FakeClock` with `advance()` + `set()` | `src/services/clock/fake-clock.ts` | shipped |
| `Path` branded type + `path()` cast | `src/services/types.ts` | shipped |

## Proposed solution

### File tree

```
src/state/
  run-id.ts           # RunId branded type + generateRunId()
  state-store.ts      # StateStore interface + FileStateStore + types + Zod schemas
  run-registry.ts     # RunRegistry interface + FileRunRegistry
  index.ts            # public barrel

tests/unit/state/
  run-id.test.ts
  state-store.test.ts
  run-registry.test.ts

tests/integration/state/
  state-store.test.ts
  run-registry.test.ts
```

### Public type signatures

#### `src/state/run-id.ts`

```ts
import type { Clock } from '../services/index.ts'

/** Branded run identifier: r-YYYY-MM-DD-xxxx where xxxx is 4 base-36 chars. */
export type RunId = string & { readonly __brand: 'RunId' }

/** Pattern all RunIds must match. Exported for RunRegistry's directory filter. */
export const RUN_ID_PATTERN = /^r-\d{4}-\d{2}-\d{2}-[a-z0-9]{4}$/

/** Validates a string as a RunId. Throws on invalid format. */
export function runId(s: string): RunId

/** Generates a new RunId from the current clock time.
 *  Format: r-YYYY-MM-DD-<slug> where slug = clock.now() in base-36, last 4 chars, zero-padded. */
export function generateRunId(deps: { readonly clock: Clock }): RunId
```

Slug derivation: `deps.clock.now().toString(36).slice(-4).padStart(4, '0')`. Deterministic given a fixed clock. The date portion uses `new Date(deps.clock.now())` formatted as `YYYY-MM-DD`. Two IDs at the same millisecond collide — acceptable for a single-process orchestrator.

> **Research:** The `r-YYYY-MM-DD-xxxx` format is a good choice vs ULID/nanoid/KSUID. Date prefix enables `ls` sorting and `findByPrefix("r-2026-04-10")`. 4 base-36 chars give 1.6M slugs/day — plenty for single-process. The regex is anchored and excludes all path-traversal characters — no security concern.

#### `src/state/state-store.ts`

```ts
import type { FsService, Path } from '../services/index.ts'
import type { RunId } from './run-id.ts'

export interface StepEntry {
  readonly name: string
  readonly value: unknown
  readonly startedAt: number
  readonly endedAt: number
  readonly artifacts: readonly string[]
  readonly durationMs: number
}

export interface RunState {
  readonly id: RunId
  readonly steps: Readonly<Record<string, StepEntry>>
}

export interface StateStore {
  loadRun(runId: RunId): Promise<RunState | undefined>
  saveStep(runId: RunId, entry: StepEntry): Promise<void>
}

export class FileStateStore implements StateStore {
  constructor(deps: { readonly fs: FsService; readonly basePath: Path })
  loadRun(runId: RunId): Promise<RunState | undefined>
  saveStep(runId: RunId, entry: StepEntry): Promise<void>
}
```

> **Research — StepEntry changes to consider:**
> - **Drop `durationMs`**: Redundant with `endedAt - startedAt`. No Zod constraint enforces consistency, so `{startedAt:100, endedAt:200, durationMs:999}` passes. Compute at call site instead.
> - **`artifacts`**: Premature (no consumer). If kept, use `readonly Path[]` per Rule 9.
> - **`value: unknown`**: Correct over `any` or generics, but `JSON.stringify` silently drops `undefined`/functions and throws on `BigInt`/circular refs. Add a try-catch around stringify in `saveStep` with a descriptive error.

> **Research — RunState changes to consider:**
> ```ts
> export interface RunState {
>   readonly schemaVersion: 1
>   readonly id: RunId
>   readonly status: 'running' | 'completed' | 'crashed'
>   readonly steps: Readonly<Record<string, StepEntry>>
> }
> ```
> - **`schemaVersion: 1`**: Trivial now; enables `if (v === 1) migrate()` later.
> - **`status`**: Phase 11 needs to distinguish completed vs crashed runs. Adding now avoids schema migration.
> - **`noUncheckedIndexedAccess`**: `state.steps[name]` returns `StepEntry | undefined`. Phase 4 callers must handle this.

> **Research — Error handling:**
> Add `StateCorruptionError extends Error` with `path: Path` and `zodIssues: z.ZodIssue[]` fields. Follows the existing `ProcessSpawnError` pattern. Export from barrel.

**Zod schemas (internal):**

```ts
const StepEntrySchema = z.object({
  name: z.string().min(1),
  value: z.unknown(),
  startedAt: z.number(),
  endedAt: z.number(),
  artifacts: z.array(z.string()),
  durationMs: z.number(),
})

const RunStateSchema = z.object({
  id: z.string().regex(RUN_ID_PATTERN),
  steps: z.record(z.string(), StepEntrySchema),
})
```

> **Research:** Use `safeParse` (already planned). Format errors as: `issues.map(i => i.path.join('.') + ': ' + i.message).join('; ')`. Zod does not sanitize `__proto__` keys in records, but `JSON.parse` in V8/JSC doesn't pollute prototypes — safe at the store layer. Consider validate-on-save to catch `NaN`/`Infinity` that pass TypeScript's `number` but serialize as `null`.

**Atomic write protocol:**

1. `fs.mkdir(basePath/<runId>/, { recursive: true })`
2. Load existing state via `loadRun` (or create `{ id, steps: {} }`)
3. Spread existing steps, add/overwrite `steps[entry.name] = entry`
4. `fs.writeFile(<runDir>/state.json.tmp, JSON.stringify(state, null, 2))`
5. `fs.rename(<runDir>/state.json.tmp, <runDir>/state.json)`

On crash between step 4 and 5: original `state.json` is untouched; orphaned `.tmp` is overwritten by the next save.

> **Research — Atomic write is sound.** `rename()` is atomic on POSIX same-filesystem. No `fsync` needed at this scale. No library needed — `FsService` provides both primitives. Use `Bun.write()` for the tmp file (faster than `node:fs writeFile`).
>
> **Async interleaving risk:** Two concurrent `saveStep` calls (Phase 8's `parallel()`) can race: second load reads stale state, first step's data lost on second rename. Mitigation: per-runId promise chain (`#writeQueue = new Map<string, Promise<void>>()`). Defer to Phase 8 with a TODO if not implementing now.
>
> **Symlink note (medium severity, low exploitability):** Symlink at `.tmp` path could redirect writes. Requires local code execution. Document local-filesystem assumption.

**`loadRun` algorithm:**

1. Build path: `basePath/<runId>/state.json`
2. `fs.exists(path)` — if false, return `undefined`
3. `fs.readFile(path)` → `JSON.parse` → `RunStateSchema.safeParse`
4. If parse fails, throw with file path + Zod issue summary
5. Return typed `RunState`

> **Research — Simplify with try-catch:** Replace steps 2-3 with try-catch on `readFile` (catch → return `undefined`). Eliminates TOCTOU race and is simpler code. Consider `stat.size` guard before read (reject >10MB) to prevent OOM from bloated/crafted files.
>
> **Corrupted state in `saveStep`:** `saveStep` calls `loadRun` internally — if state is corrupted, save also throws, making the run permanently unrecoverable. Acceptable for Phase 3; document for Phase 11.

#### `src/state/run-registry.ts`

```ts
import type { FsService, Path } from '../services/index.ts'
import type { RunId } from './run-id.ts'

export interface RunRegistry {
  listRuns(): Promise<readonly RunId[]>
  findLatest(): Promise<RunId | undefined>
  findByPrefix(prefix: string): Promise<readonly RunId[]>
}

export class FileRunRegistry implements RunRegistry {
  constructor(deps: { readonly fs: FsService; readonly basePath: Path })
  listRuns(): Promise<readonly RunId[]>
  findLatest(): Promise<RunId | undefined>
  findByPrefix(prefix: string): Promise<readonly RunId[]>
}
```

**`listRuns` algorithm:**

1. `fs.exists(basePath)` — if false, return `[]`
2. `fs.readDir(basePath)` → get child names
3. Filter entries matching `RUN_ID_PATTERN` (ignores `.DS_Store`, etc.)
4. Sort lexicographically (chronological due to date prefix)
5. Map to `RunId` via `runId()` validating cast

`findLatest`: `listRuns()` → return last element via `.at(-1)` or `undefined`.

`findByPrefix`: `listRuns()` → `.filter(id => id.startsWith(prefix))`.

> **Research:** `readDir` returns basenames (verified in `FakeFsService:79-98`). Regex filter works correctly. Scale is fine (<1ms for 100 entries). Keep StateStore and RunRegistry separate per ISP — matches project's per-concern interface pattern. Extract shared `resolveRunDir(basePath, runId): Path` helper if path logic duplicates. `findByPrefix` returning multiple matches is fine — Phase 12 caller decides behavior. No `deleteRun` needed yet (YAGNI) but trivial to add later. Document that `basePath` default is resolved by Phase 4/12, not this module.

#### `src/state/index.ts` (public barrel)

```ts
export type { RunId } from './run-id.ts'
export { runId, generateRunId, RUN_ID_PATTERN } from './run-id.ts'
export type { StepEntry, RunState, StateStore } from './state-store.ts'
export { FileStateStore, StateCorruptionError } from './state-store.ts'
export type { RunRegistry } from './run-registry.ts'
export { FileRunRegistry } from './run-registry.ts'
```

> **Research:** Barrel pattern matches `src/services/index.ts` exactly: types via `export type`, values via `export`. Also export `StateCorruptionError` for Phase 12 CLI.

### Things deliberately NOT in this phase

- **Path relocation to `src/core/types.ts`** — deferred to Phase 4 which creates `src/core/`. The TODO in `src/services/types.ts` stays.
- **`FakeStateStore` / `FakeRunRegistry`** — Phase 4 can add if workflow tests need them. Phase 3 tests `FileStateStore` directly with `FakeFsService`.
- **Concurrency control / file locking** — single-process orchestrator; not needed.
- **Garbage collection for `.tmp` files** — orphaned tmps are harmless and overwritten by next save.
- **Step ordering** — steps are keyed by name in a Record, not ordered. Phase 4 re-executes top-to-bottom regardless.
- **JSON-serializability validation on `value`** — Phase 4 passes Zod-validated results which are always serializable. `JSON.stringify` silently drops non-serializable values; acceptable.
- **Run cleanup / TTL** — runs accumulate. TODO(phase-12) for `orch gc` or `orch prune`.
- **File permissions hardening** — `0o700` dirs / `0o600` files deferred to Phase 12 process entry point.
- **Append-only step log** — alternative to read-modify-write; simpler single-file approach is sufficient for <20 steps.

### Edge cases

| Case | Behavior |
|---|---|
| Missing `.orchestrator/runs/` dir | `loadRun` → `undefined`; `listRuns` → `[]`; `saveStep` → creates via `mkdir({ recursive: true })` |
| Corrupted `state.json` | Zod `safeParse` fails → throw `StateCorruptionError` with file path + Zod issues |
| Orphaned `.tmp` from prior crash | Next `saveStep` overwrites via `writeFile` |
| Empty runs directory | `listRuns` → `[]`; `findLatest` → `undefined` |
| Non-matching dir entries (`.DS_Store`) | `listRuns` filters by `RUN_ID_PATTERN`, ignores them |
| `runId()` with invalid format | Throws descriptive error with the invalid string |
| Two concurrent `saveStep` on same run | Read-modify-write race → first step lost (add serialization or TODO) |
| `JSON.stringify` on `BigInt`/circular ref in `value` | Throws — `saveStep` should catch and wrap with step name |
| `NaN`/`Infinity` in numeric fields | Serializes as `null`; Zod fails on reload — validate-on-save prevents |
| Run dir exists but `state.json` doesn't | `loadRun` → `undefined` |
| `.tmp` exists but `state.json` doesn't | `loadRun` → `undefined`; next `saveStep` creates fresh state |
| Disk full during `writeFile` | `.tmp` partially written; original untouched; raw FS error propagates |

## Implementation plan (ordered commits)

### Commit 1 — red tests for run-id, state-store, run-registry

**Goal:** complete test suite, all failing.

**Commit message:** `phase 3: red tests for run-id, state-store, run-registry`

#### `tests/unit/state/run-id.test.ts`

- [x] `generateRunId produces r-YYYY-MM-DD-xxxx format` — FakeClock at a known epoch, assert regex match
- [x] `generateRunId is stable given a fixed clock` — same `clock.now()` twice → identical IDs
- [x] `generateRunId uses clock for date portion` — FakeClock at `2026-04-10T00:00:00Z` epoch → verify `r-2026-04-10-` prefix
- [x] `generateRunId pads short slugs to 4 chars` — FakeClock at 0 → slug is `0000`
- [x] `runId validates correct format` — valid string passes
- [x] `runId throws on invalid format` — `"bad"`, `"r-2026-04-10"` (no slug), `"r-2026-04-10-ABCD"` (uppercase)

#### `tests/unit/state/state-store.test.ts`

- [x] `loadRun returns undefined for a non-existent run`
- [x] `saveStep then loadRun round-trips a single step entry`
- [x] `saveStep then loadRun round-trips multiple step entries`
- [x] `saveStep overwrites an existing step with the same name`
- [x] `saveStep creates the run directory if it does not exist`
- [x] `loadRun throws on corrupted JSON with a readable error`
- [x] `atomic write leaves original state untouched when rename fails` — inject a FakeFsService subclass where `rename` throws; assert original `state.json` is unchanged
- [x] `saveStep wraps JSON.stringify errors with step name and cause` *(research)*

#### `tests/unit/state/run-registry.test.ts`

- [x] `listRuns returns empty array when base directory does not exist`
- [x] `listRuns returns empty array when base directory is empty`
- [x] `listRuns returns sorted run IDs` — seed 3 run dirs out of order, assert sorted
- [x] `listRuns ignores non-matching directory entries` — seed `.DS_Store` and `notes.txt` alongside valid runs
- [x] `findLatest returns undefined when no runs exist`
- [x] `findLatest returns the most recent run`
- [x] `findByPrefix returns matching runs`
- [x] `findByPrefix returns empty array when nothing matches`

#### `tests/integration/state/state-store.test.ts`

- [x] `FileStateStore round-trips against a real temp directory` — BunFsService + OS temp dir
- [x] `FileStateStore atomic write produces valid JSON on disk` — write, read back with `fs.readFileSync`, JSON.parse

#### `tests/integration/state/run-registry.test.ts`

- [x] `FileRunRegistry lists runs from a real temp directory` — BunFsService, pre-create run dirs, assert sorted list

**Guardrails:**
- [x] All test names are full sentences
- [x] Arrange-Act-Assert with blank-line separators
- [x] No shared mutable state across tests
- [x] Unit tests use `FakeFsService` + `FakeClock` from `src/services/index.ts`
- [x] Import from barrel `src/state/index.ts`, not internal files

---

### Commit 2 — implement generateRunId

**Goal:** `tests/unit/state/run-id.test.ts` goes green.

**Commit message:** `phase 3: implement generateRunId with clock-derived slug`

- [x] Create `src/state/run-id.ts`:
  - `RunId` branded type
  - `RUN_ID_PATTERN` regex
  - `runId(s)`: validate against regex, throw `"Invalid RunId: <s>"` on failure, return cast
  - `generateRunId(deps)`: `new Date(deps.clock.now())` → extract `yyyy`, `mm`, `dd` (zero-padded); slug = `deps.clock.now().toString(36).slice(-4).padStart(4, '0')`; return `runId('r-${yyyy}-${mm}-${dd}-${slug}')`

**Guardrails:**
- [x] File under 50 lines
- [x] No `any`, no `!`
- [x] `Clock` imported from `src/services/index.ts`

---

### Commit 3 — implement FileStateStore with atomic writes

**Goal:** `tests/unit/state/state-store.test.ts` + `tests/integration/state/state-store.test.ts` go green.

**Commit message:** `phase 3: implement FileStateStore with atomic writes`

- [x] Create `src/state/state-store.ts`:
  - `StepEntry` interface
  - `RunState` interface (with `schemaVersion` and `status` per decision log)
  - `StepEntrySchema` + `RunStateSchema` (Zod, internal — not exported)
  - `StateCorruptionError` class (exported)
  - `StateStore` interface
  - `FileStateStore` class:
    - Private `#fs: FsService`, `#basePath: Path`
    - Private helper `runDir(runId: RunId): Path` → `path(\`${this.#basePath}/${runId}\`)`
    - Private helper `statePath(runId: RunId): Path` → `path(\`${runDir}/ state.json\`)`
    - Private helper `tmpPath(runId: RunId): Path` → `path(\`${statePath}.tmp\`)`
    - `loadRun`: try readFile → catch return undefined → JSON.parse → safeParse → return or throw `StateCorruptionError`
    - `saveStep`: load existing or `{ id: runId, steps: {} }` → merge → try JSON.stringify (catch + wrap) → mkdir(recursive) → writeFile(tmp) → rename(tmp, final)

**Guardrails:**
- [x] Zod validation on load only (trust internal callers on save)
- [x] Atomic write: always write to `.tmp` then rename — never write directly to `state.json`
- [x] `mkdir({ recursive: true })` before every write
- [x] `z.unknown()` for `value` field — no `any`
- [x] File under 120 lines
- [x] Wrap `JSON.stringify` in try-catch *(research)*

---

### Commit 4 — implement FileRunRegistry

**Goal:** `tests/unit/state/run-registry.test.ts` + `tests/integration/state/run-registry.test.ts` go green. Full test suite green.

**Commit message:** `phase 3: implement FileRunRegistry with prefix search`

- [x] Create `src/state/run-registry.ts`:
  - `RunRegistry` interface
  - `FileRunRegistry` class:
    - Private `#fs: FsService`, `#basePath: Path`
    - `listRuns`: exists → readDir → filter by `RUN_ID_PATTERN.test()` → sort → map to `RunId` via `runId()`
    - `findLatest`: `listRuns()` → `.at(-1)` → `?? undefined` (for `noUncheckedIndexedAccess`)
    - `findByPrefix`: `listRuns()` → `.filter(id => id.startsWith(prefix))`

**Guardrails:**
- [x] Reuse `RUN_ID_PATTERN` and `runId()` from `./run-id.ts`
- [x] `readDir` returns `Path[]` — cast each to `string` for regex test
- [x] File under 60 lines
- [x] `bun run check` should be fully green after this commit

---

### Commit 5 — land: public barrel + roadmap update

**Goal:** cross-module callers see exactly the public surface. Phase doc updated.

**Commit message:** `phase 3: land — public barrel + roadmap update`

- [x] Create `src/state/index.ts` with exports matching the "Public barrel" section above
- [x] Update `docs/plans/implementation-phases.md`: flip Phase 3 from `☐` to `✓`, add `**Landed:** 2026-04-10`
- [x] Run `bun run check` — fully green
- [x] Verify no imports of `src/state/` internal files from outside `src/state/`

**Guardrails:**
- [x] Barrel exports match spec exactly — no more, no less
- [x] No `src/core/` created (Phase 4)
- [x] `Path` stays in `src/services/types.ts` (relocation deferred to Phase 4)

## Acceptance criteria

- [x] `bun run check` passes (lint + typecheck + unit + integration)
- [x] `generateRunId` with `FakeClock` produces deterministic, stable IDs
- [x] `FileStateStore` round-trips step entries through `FakeFsService`
- [x] `FileStateStore` atomic write: original state survives if rename never happens
- [x] `FileStateStore` handles missing files, corrupted JSON, missing directories
- [x] `FileRunRegistry` lists, sorts, and filters runs correctly
- [x] All new files import `FsService` / `Clock` from service barrels, never raw `bun:fs` or `node:fs`
- [x] No file exceeds 300 lines; no function exceeds 60 lines
- [x] `saveStep` throws descriptive error on `JSON.stringify` failure *(research)*
- [x] `StateCorruptionError` includes file path and Zod issues *(research)*

## Decision log (from research)

Decisions the implementer should make before writing code:

| # | Decision | Options | Rec. | Impact |
|---|---|---|---|---|
| 1 | Drop `durationMs`? | (A) Drop, compute at call site (B) Keep | A | Eliminates consistency bug |
| 2 | Drop `artifacts`? | (A) Drop (B) Keep as `readonly Path[]` | Either | ~8 LOC if dropped |
| 3 | Add `schemaVersion: 1`? | (A) Add now (B) Defer | A | 1 line now vs migration pain |
| 4 | Add `status` to `RunState`? | (A) Add now (B) Defer to Phase 11 | A | Avoids schema migration |
| 5 | Validate on save too? | (A) Load only + stringify guard (B) Full safeParse on save | A | Stringify guard is minimal |
| 6 | Serialize concurrent `saveStep`? | (A) Promise chain now (B) Defer to Phase 8 | B+TODO | Phase 8 is first real consumer |
| 7 | `value: unknown` or `JsonValue`? | (A) `unknown` + stringify guard (B) `JsonValue` type | A | Simpler, runtime guard sufficient |
| 8 | Constructor: `deps` object or positional? | (A) `deps` object (B) Positional | A | Consistent with `runRunner` |
| 9 | Drop `findByPrefix`? | (A) Drop (B) Keep | Either | 3 lines + 1 test |

## References

- Phase spec: `docs/plans/implementation-phases.md` lines 96-110
- FsService interface: `src/services/fs/fs-service.ts`
- FakeFsService: `src/services/fs/fake-fs-service.ts`
- Clock / FakeClock: `src/services/clock/clock.ts`, `src/services/clock/fake-clock.ts`
- Path type + TODOs: `src/services/types.ts`
- RunnerResult pattern reference: `src/runners/execute.ts:6-12`
- Phase 2 plan (format reference): `docs/plans/2026-04-09-feat-phase-2-runner-port-plan.md`
- Atomic write pattern: POSIX `rename()` guarantees, git ref update pattern
- Bun file I/O: `Bun.write()` / `Bun.file().json()` for optimized read/write
- Directory-per-record pattern: matches git `.git/objects/`, Turborepo `.turbo/runs/`
