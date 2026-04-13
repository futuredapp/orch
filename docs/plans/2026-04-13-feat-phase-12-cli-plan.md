---
title: "feat: Phase 12 — CLI"
type: feat
status: completed
date: 2026-04-13
deepened: 2026-04-13
---

# Phase 12 — CLI

## Enhancement Summary

**Deepened on:** 2026-04-13 | **Agents used:** 14 (architecture, typescript, patterns, security, migration, simplicity, performance, agent-native, spec-flow, repo-research, best-practices x2, bun-cli, zod-migration)

### Critical Bugs Found
1. **Duplicate `BunProcessService`** in `createDeps` — must share one instance
2. **`resolveWorkflow` returns `string`, not `Path`** — bypasses `path()` traversal guard (security gap)
3. **Workflow relative paths not resolved to absolute** before `import()`

### Key Improvements
1. `z.discriminatedUnion` instead of `z.union` — O(1) dispatch, clear errors
2. `CliDeps` typed against abstract interfaces, not concrete `Bun*` classes
3. `resolveWorkflow` returns branded `Path`, resolves relative to `cwd`
4. Command handler tests moved to integration layer (they compose multiple modules)
5. `orch runs`/`status` do NOT call `loadConfig` — they only read state files
6. `DryRunAbort` uses symbol tag, does NOT extend `Error`
7. Shebang `#!/usr/bin/env bun` required on `main.ts`
8. TTY detection for glyph fallback; `--verbose` NOT parsed until it has behavior

---

## Overview

Terminal interface for the orch orchestrator. Five commands (`run`, `resume`, `runs`, `status`, `dry-run`) backed by `orch.config.ts` workflow registry, a hardcoded composition root, and zero-dependency argv parsing via `util.parseArgs`.

This phase also bumps `RunState` to schema v3 (adds `workflowName`, run-level timestamps) and wires the package entry point so users can `import { defineConfig } from 'orch'`.

## Problem Statement

The orchestrator has a complete core (phases 0-11) but no user-facing entry point. Users cannot execute, resume, list, or inspect workflows without writing their own script. Phase 12 bridges the library to the terminal.

## Technical Approach

### Architecture

```
src/cli/
  main.ts           <- entry point (shebang + argv parsing + command dispatch)
  deps.ts           <- createDeps(cwd) composition root
  commands/
    run.ts, resume.ts, runs.ts, status.ts, dry-run.ts

src/config/
  index.ts           <- defineConfig(), loadConfig(), ConfigSchema
```

**Module boundary rule:** `src/cli/` imports from `src/core/`, `src/state/`, `src/services/`, `src/config/`, and `src/runners/` via barrel exports only.

**Architecture insights:**
- `createDeps` should also be library-accessible for agent-native parity — export from `src/cli/index.ts` barrel and re-export from `src/index.ts`
- `CliDeps` MUST use abstract interfaces (`ProcessService`, `FsService`, etc.), not concrete `Bun*` classes — required for testability per "mock only at the edge" rule
- Import `path` from `src/services/index.ts` (canonical source), not `src/core/index.ts`
- `src/cli/index.ts` should export `CliDeps` type (not "nothing public") so integration tests can import it

### Key Design Decisions

| # | Decision | Rationale | Deepening notes |
|---|---|---|---|
| 1 | **Registry, not file paths** | `orch.config.ts` maps names -> workflow files | |
| 2 | **`defineConfig()` helper** | Vite-style typed identity fn for autocomplete | |
| 3 | **`util.parseArgs` for argv** | Zero deps. Available in Bun | Verified: fully supported in Bun 1.3.8. Use `Bun.argv.slice(2)` |
| 4 | **Hardcoded composition root** | `createDeps(cwd)` wires real services | Single shared `BunProcessService` instance. Export for library use |
| 5 | **Dry-run = preflight + first-step peek** | Imperative DSL prevents static step graph | Extract `dryRun()` as library fn for agent-native parity |
| 6 | **Resume defaults to latest resumable** | Searches `crashed` AND `running` | Cap scan at 50. Print selected run ID before resuming |
| 7 | **Schema v3** | Adds `workflowName`, `startedAt`, `endedAt` | Use `z.discriminatedUnion` + `.transform()` on v2 |
| 8 | **Workflow files export default** | Runtime-validated | Use type narrowing, not `as` cast. Validate export shape |
| 9 | **Partial run IDs via `findByPrefix`** | Ambiguous match -> exit 2 | |
| 10 | **`orch status` shows completed steps only** | Crashed step is not persisted | |

### Exit Code Matrix

| Code | Meaning | Triggered by |
|---|---|---|
| 0 | Success | Workflow completed, list/status rendered |
| 1 | Step failure | `StepError`, `ValidationError`, `SchemaValidationError`, `ParallelError` |
| 2 | Config / usage error | Missing config, bad argv, unknown command, ambiguous ID, `StateCorruptionError` |
| 3 | Cannot resume | `RunNotFoundError`, `ResumeError` (completed run), no resumable run found |

Export as `const EXIT = { OK: 0, STEP_FAILURE: 1, CONFIG_ERROR: 2, CANNOT_RESUME: 3 } as const` so tests and docs stay in sync. Exit 3 is a valid application-specific code (POSIX 3-125 range). `StateCorruptionError` was missing from the original matrix — mapped to exit 2.

### Implementation Phases

#### Step 1: Schema v3 — extend RunState

**Files:** `src/state/state-store.ts`, `src/core/workflow.ts`

```typescript
export interface RunState {
  readonly schemaVersion: 3
  readonly id: RunId
  readonly status: 'running' | 'completed' | 'crashed'
  readonly workflowName?: string          // NEW
  readonly startedAt: number              // NEW — epoch ms
  readonly endedAt?: number               // NEW — set on completed/crashed
  readonly steps: Readonly<Record<string, StepEntry>>
}
```

**Schema migration — use `z.discriminatedUnion` + `.transform()`:**
```typescript
const RunStateV2Migrated = RunStateV2Schema.transform((v2) => ({
  ...v2,
  schemaVersion: 3 as const,
  workflowName: undefined,
  startedAt: Object.keys(v2.steps).length > 0
    ? Math.min(...Object.values(v2.steps).map(s => s.startedAt))
    : 0,  // zero-step crashed run sentinel
  endedAt: undefined,
}))

const RunStateAnyVersion = z.discriminatedUnion('schemaVersion', [
  RunStateV2Migrated,   // parses v2 on disk, transforms to v3 shape in memory
  RunStateV3Schema,
])
```

**Why `discriminatedUnion`:** `z.union` tries each branch sequentially — for v3 files (common case), it fails v2 first, doubling validation cost. `discriminatedUnion` checks `schemaVersion` in O(1). Error messages are focused ("Invalid discriminator value. Expected 2 | 3") instead of a confusing wall from both schemas.

**`endedAt` atomicity:** `setStatus()` already does read-modify-write via `#atomicWrite`. Add `endedAt` to the same spread. Change signature to `setStatus(rid, status, endedAt?)`.

**`wrapSchemaError`:** Update from "Phase 6 bumped to v2" to generic: `"unsupported schema version; current is v3. Delete .orch/state/ to reset."`

**Tasks:**
- [x] `RunStateV3Schema` + `RunStateV2Migrated` with `.transform()` + `z.discriminatedUnion`
- [x] `RunState` interface = v3-only (callers never see v2)
- [x] `WorkflowDeps` gains `workflowName` (`src/core/workflow.ts`)
- [x] `initRun()` writes `workflowName`, `startedAt`
- [x] `setStatus()` accepts optional `endedAt`, writes on terminal states
- [x] Generic `wrapSchemaError` message
- [x] Update `makeRunState`/`makeStepEntry` test helpers for v3

**Tests:** `tests/unit/state/state-store-v3.test.ts` — v3 round-trip, v2 read + transform, v2 not rewritten on disk, zero-step v2 produces `startedAt=0`, discriminator rejects unknown versions

#### Step 2: Config module

**Files:** `src/config/index.ts`

Key changes from original plan based on research:

- **`ConfigLoadError` carries `readonly configPath: Path`** — matches existing pattern where errors carry domain metadata
- **`resolveWorkflow` returns `Path`, not `string`** — resolves relative to `cwd`, validates via `path()` constructor. This closes the security gap where `path()` traversal guard was bypassed before `import()`
- **Safe type narrowing for default export** — `typeof mod === 'object' && mod !== null && 'default' in mod` instead of `(mod as { default?: unknown })?.default`
- **Config/workflow files execute arbitrary code at import** — document this trust boundary (same model as Vite/Vitest/Tailwind)

**Tasks:**
- [x] `src/config/index.ts`: `defineConfig`, `loadConfig`, `resolveWorkflow` (returns `Path`), `ConfigLoadError` (with `configPath`)
- [x] `export * from './config/index.ts'` in `src/index.ts`
- [x] `export * from './core/index.ts'` in `src/index.ts` (currently missing)
- [x] `"exports": { ".": "./src/index.ts" }` in `package.json`

**Tests:** `tests/unit/config/load-config.test.ts` — valid config, missing file, no default export, invalid shape, missing workflow name, empty map, `..` traversal rejected

#### Step 3: CLI entry point + composition root

**Files:** `src/cli/main.ts`, `src/cli/deps.ts`, `src/cli/index.ts`

**`main.ts`** must have `#!/usr/bin/env bun` as line 1. Without it, `npx orch` fails. Verified on Bun 1.3.8.

**`deps.ts` — critical fixes from research:**
```typescript
export interface CliDeps {
  readonly processService: ProcessService   // abstract interface
  readonly fsService: FsService             // abstract interface
  readonly gitService: GitService           // abstract interface
  readonly clock: Clock                     // abstract interface
  readonly stateStore: StateStore           // abstract interface
  readonly registry: RunRegistry            // abstract interface
  readonly cwd: Path
}

export function createDeps(cwd: string): CliDeps {
  const cwdPath = path(cwd)
  const basePath = path(`${cwdPath}/.orch/state`)
  const fs = new BunFsService()
  const processService = new BunProcessService()  // SINGLE instance
  return {
    processService,
    fsService: fs,
    gitService: new BunGitService({ processService }),  // reuses same instance
    clock: new BunClock(),
    stateStore: new FileStateStore({ fs, basePath }),
    registry: new FileRunRegistry({ fs, basePath }),
    cwd: cwdPath,
  }
}
```

**Do NOT parse `--verbose`** — add it in the PR that implements verbose output.

**Help text:** stdout for `--help` (exit 0), stderr for unknown commands (exit 2). GNU/POSIX format.

**Tasks:**
- [x] `src/cli/main.ts` — shebang + argv (no `--verbose`) + dispatch
- [x] `src/cli/deps.ts` — abstract interfaces, single `ProcessService`
- [x] `src/cli/index.ts` — exports `CliDeps` type
- [x] `bin` + `exports` in `package.json`

**Tests:** `tests/unit/cli/argv.test.ts` — command + flags, unknown flags, missing positionals, `--help`/`-h`

#### Step 4: Command handlers

**Files:** `src/cli/commands/run.ts`, `resume.ts`, `runs.ts`, `status.ts`, `dry-run.ts`

##### `orch run <name>`
`loadConfig` -> `resolveWorkflow(config, name, cwd)` (returns `Path`) -> dynamic import (validate export shape) -> `createDeps` -> `execute`. Errors: `ConfigLoadError` -> exit 2, step errors -> exit 1.

##### `orch resume [id]`
`createDeps` (NO `loadConfig` yet) -> find run (cap scan at 50) -> print "Resuming run <id>..." -> load state -> `loadConfig` -> `resolveWorkflow` -> resume. `loadConfig` deferred until after finding the run so a broken config doesn't block explicit-ID resume.

##### `orch runs`
`createDeps` only (NO `loadConfig`) -> `listRuns()` -> load last 20 -> render table with TTY-aware glyphs. Duration: v3 uses `endedAt - startedAt`; v2 fallback: step min/max; zero steps: `—`.

##### `orch status <id>`
`createDeps` only (NO `loadConfig`) -> `findByPrefix` -> `loadRun` -> render. `StateCorruptionError` -> exit 2.

##### `orch dry-run <name>`
`loadConfig` -> `resolveWorkflow` -> import -> preflight (runner CLIs on PATH) -> first-step peek via `DryRunAbort` sentinel.

**DryRunAbort safety (from security + pattern reviews):**
- Does NOT extend `Error` — plain class with `readonly _sentinel: unique symbol`
- Lives in `src/cli/commands/dry-run.ts` (CLI concern, not core)
- Zero-step fallback: if `execute()` completes without throwing, display "workflow has no steps"
- `parallel()` interaction: fake `run()` collects step info without throwing, throws only after `parallel()` completes
- Exit 1 for preflight failure (runner missing), exit 0 otherwise

**TTY-aware output:**
- `process.stdout.isTTY`: true -> Unicode glyphs (`✓`, `✗`, `●`), false -> ASCII (`+`, `x`, `*`)
- Column alignment via `String.padEnd`. No table library, no colors (YAGNI; respect `NO_COLOR` if added later)
- Inline formatting helpers in commands; extract shared module only when 3+ call sites exist

**Tasks:**
- [x] Five command handler files
- [x] Resume: cap scan at 50, print selected ID, lazy `loadConfig`
- [x] Runs/status: no `loadConfig`, default limit 20, TTY glyph detection
- [x] Dry-run: symbol-tagged `DryRunAbort`, zero-step fallback, parallel capture
- [x] Wire dispatch table in `main.ts`

**Tests (integration layer, NOT unit):**
- `tests/integration/cli/commands/run.test.ts` — happy, missing name/config/workflow, bad export shape
- `tests/integration/cli/commands/resume.test.ts` — latest crashed, latest running (SIGKILL), explicit/partial/ambiguous ID, no crashed runs, completed, v2 state, scan cap
- `tests/integration/cli/commands/runs.test.ts` — empty, multiple, v2 compat, default limit
- `tests/integration/cli/commands/status.test.ts` — completed, crashed, not found, partial ID, corrupted state
- `tests/integration/cli/commands/dry-run.test.ts` — preflight pass, missing runner (exit 1), first-step capture, zero-step workflow, parallel first operation

**Pure unit tests (isolated logic only):**
- `tests/unit/cli/format.test.ts` — duration formatting, glyph mapping, TTY fallback

#### Step 5: Integration + E2E tests

- `tests/integration/cli/run-resume-cycle.test.ts` — v3 state verified, crash->resume->complete, `runs`/`status` display
- `tests/integration/cli/dry-run.test.ts` — capture, no state files, preflight failure
- `tests/e2e/cli/orch-run.test.ts` (gated `RUN_REAL_E2E=1`) — actual binary invocation

## Acceptance Criteria

- [x] Five CLI commands with correct exit codes
- [x] `defineConfig()` importable from `'orch'`; core modules re-exported
- [x] Schema v3 with `discriminatedUnion` + `transform` migration from v2
- [x] `CliDeps` uses abstract interfaces; single `ProcessService` instance
- [x] `resolveWorkflow` returns branded `Path`; shebang on `main.ts`
- [x] `runs`/`status` work without `orch.config.ts`
- [x] TTY glyph fallback; no `--verbose` until it has behavior
- [x] Unit + integration + e2e tests at correct layers; `bun run check` green

## Security Considerations

| # | Finding | Severity | Mitigation |
|---|---------|----------|------------|
| 1 | `resolveWorkflow` path traversal | **Medium** | Returns `Path`; `path()` rejects `..` |
| 2 | `DryRunAbort` suppression by workflow code | **Medium** | Symbol-tagged, not extending `Error` |
| 3 | Config/workflow arbitrary code execution | Low | Document trust boundary |
| 4 | TOCTOU config->workflow import | Low | Single-user CLI; document |
| 5 | State directory symlink following | Low | Defer `O_NOFOLLOW` to hardening |

## File Checklist

**New:** `src/config/index.ts`, `src/cli/{main,deps,index}.ts`, `src/cli/commands/{run,resume,runs,status,dry-run}.ts`, `tests/unit/{config/load-config,cli/argv,cli/format,state/state-store-v3}.test.ts`, `tests/integration/cli/commands/{run,resume,runs,status,dry-run}.test.ts`, `tests/integration/cli/{run-resume-cycle,dry-run}.test.ts`, `tests/e2e/cli/orch-run.test.ts`

**Modified:** `src/state/state-store.ts` (v3 schema), `src/core/workflow.ts` (workflowName in deps), `src/index.ts` (re-export config+core), `package.json` (bin+exports), `tests/helpers/make-step-entry.ts` (v3)

## References

- Brainstorm: `docs/brainstorms/2026-04-13-phase-12-cli-brainstorm.md`
- Phase 11: `docs/plans/2026-04-13-feat-phase-11-resume-end-to-end-plan.md`
- Roadmap: `docs/plans/implementation-phases.md:307`
- Current RunState: `src/state/state-store.ts:86` | Path guard: `src/services/types.ts:15`
- Test helpers: `tests/helpers/make-step-entry.ts:28`
- Zod discriminatedUnion: https://zod.dev/?id=discriminated-unions
