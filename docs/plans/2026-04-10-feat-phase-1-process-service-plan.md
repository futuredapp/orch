---
title: Phase 1 — ProcessService port, Bun adapter, Fake adapter, and fs/clock service parity
type: feat
status: completed
date: 2026-04-10
phase: 1
relates-to:
  - docs/brainstorms/2026-04-09-phase-1-process-service-brainstorm.md
  - docs/plans/implementation-phases.md
---

# Phase 1 — `ProcessService` port + Bun adapter + Fake adapter + `fs/clock` parity

## Overview

Phase 1 installs the **single seam** between the codebase and every subprocess it will ever spawn. Every runner (Claude, Codex, Aider, anything a user wraps) reaches the real world through one port: `ProcessService.spawn(opts)`. Phase 2's `runRunner` imports this port; Phase 5's `ClaudeRunner` is tested against a scripted fake built on top of it; and a Biome lint rule enforces that no other path to a subprocess can quietly open.

The phase also lands **full service parity** for `fs/` and `clock/` — not just stubs. All three services ship with the same layout (`interface + real adapter + fake + barrel`) so later phases (state store, validators, tmux observability) drop in without touching the service layer.

**Nothing outside `src/services/process/` may reference `child_process`, `node-pty`, or `Bun.spawn`.** Cross-module entry points are the three module barrels plus the top-level `src/services/index.ts`.

## Problem statement

The brainstorm in [`docs/brainstorms/2026-04-09-phase-1-process-service-brainstorm.md`](../brainstorms/2026-04-09-phase-1-process-service-brainstorm.md) resolved the central design tension — "minimal surface, YAGNI" vs "consistent service-folder parity" — by keeping the `ProcessService` surface strictly minimal while landing all three services with the same shape. This satisfies the three implementation-plan design drivers in priority order:

1. **Testability** — the one port every subprocess crosses is the one port every test fakes. No `mock.module` anywhere from Phase 2 onward.
2. **Readability** — `spawn()` takes three fields and returns four methods; a runner author can memorise the contract in thirty seconds. Line framing is a single pure async generator with its own isolated test.
3. **Maintainability** — a Biome `noRestrictedImports` rule enforces the boundary at lint time; `fs/` and `clock/` mirror `process/` exactly, so adding a new service later is copy-paste.

## Prerequisites (blockers)

**Phase 1 cannot start until Phase 0 has landed.** Expected state:

| Artifact | Status |
|---|---|
| `package.json` (Bun ≥ 1.2, Biome ≥ 2.4.10, TS ≥ 5.6, Zod ≥ 3.23) | ✓ Phase 0 |
| `tsconfig.json` strict + `noUncheckedIndexedAccess` + `noImplicitOverride` | ✓ |
| `biome.json` with `noExplicitAny`, `noNonNullAssertion`, `noDefaultExport`, `useImportType` | ✓ |
| `src/index.ts` empty barrel + `tests/unit/placeholder.test.ts` | ✓ |
| `bun run check` green on `main` | ✓ |

```bash
bun run check   # must be green on main before Phase 1 starts
```

## Proposed solution

### File tree

```
src/services/
├── types.ts                      # `Path` brand (forward-declared; Phase 3 relocates to src/core/types.ts)
├── process/
│   ├── process-service.ts        # interface + SpawnOptions + SpawnHandle + ProcessSpawnError
│   ├── line-framer.ts            # pure async generator: split \n, strip \r, yield trailing partial
│   ├── bun-process-service.ts    # real adapter wrapping Bun.spawn (only file allowed to reference it)
│   ├── fake-process-service.ts   # keyed-by-argv FIFO scripting
│   └── index.ts
├── fs/
│   ├── fs-service.ts
│   ├── bun-fs-service.ts         # Bun.file/Bun.write + node:fs/promises
│   ├── fake-fs-service.ts        # map-backed
│   └── index.ts
├── clock/
│   ├── clock.ts
│   ├── system-clock.ts
│   ├── fake-clock.ts             # advance(ms), set(ms)
│   └── index.ts
└── index.ts                      # top-level barrel

tests/unit/services/
├── process/line-framer.test.ts
├── process/fake-process-service.test.ts
├── fs/fake-fs-service.test.ts
└── clock/fake-clock.test.ts

tests/integration/services/
├── process/bun-process-service.test.ts   # real `sh -c` round-trips
└── fs/bun-fs-service.test.ts              # real temp dir round-trip
```

Cross-module callers import **only** from `src/services/index.ts` (or directly from one of the three module barrels).

### Public types — `process/`

Locked by the brainstorm; reproduced as the source of truth:

```ts
// src/services/process/process-service.ts
import type { Path } from '../types.ts'

export interface SpawnOptions {
  readonly argv: readonly string[]
  readonly cwd: Path
  /** Full replacement. No automatic merge with process.env. */
  readonly env: Readonly<Record<string, string>>
}

export interface SpawnHandle {
  /** Line-framed stdout. One yield per logical line. */
  readonly stdout: AsyncIterable<string>
  /** Line-framed stderr. Drained concurrently from spawn time (see Watch-outs §1). */
  readonly stderr: AsyncIterable<string>
  wait(): Promise<{ readonly exitCode: number }>
  /** Defaults to 'SIGTERM'. */
  kill(signal?: NodeJS.Signals): void
}

export interface ProcessService {
  spawn(opts: SpawnOptions): SpawnHandle
}

/** Thrown synchronously when the binary is missing or cwd does not exist. */
export class ProcessSpawnError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message)
    this.name = 'ProcessSpawnError'
  }
}
```

Exactly three fields on `SpawnOptions`. No `stdin` (every runner through Phase 16 passes prompts via argv), no `AbortSignal` (Phase 11 adds it with a real test), no `stdio` redirection. Each optional field we never populate is dead weight that misleads future runner authors.

### Public types — `fs/` and `clock/`

```ts
// src/services/fs/fs-service.ts
import type { Path } from '../types.ts'

export interface FsService {
  readFile(path: Path): Promise<string>
  writeFile(path: Path, data: string): Promise<void>
  /** Atomic swap — used by Phase 3's state store write-tmp-then-rename pattern. */
  rename(from: Path, to: Path): Promise<void>
  mkdir(path: Path, opts?: { readonly recursive?: boolean }): Promise<void>
  exists(path: Path): Promise<boolean>
  glob(pattern: string, opts?: { readonly cwd?: Path }): AsyncIterable<Path>
  readDir(path: Path): Promise<readonly Path[]>
  stat(path: Path): Promise<{ readonly size: number; readonly mtimeMs: number }>
  remove(path: Path): Promise<void>
  tempDir(prefix: string): Promise<Path>
}
```

**Why the full surface?** Deliberate YAGNI exception. Phases 3, 6, 10, 13 each need different subsets; designing the full surface once is cheaper than four separate touches.

```ts
// src/services/clock/clock.ts
export interface Clock { now(): number /* epoch ms */ }

// src/services/clock/system-clock.ts
export class SystemClock implements Clock { now(): number { return Date.now() } }

// src/services/clock/fake-clock.ts
export class FakeClock implements Clock {
  constructor(initial?: number)
  now(): number
  advance(ms: number): void
  /** Can move backward; needed for state-replay tests. */
  set(ms: number): void
}
```

### Branded `Path`

```ts
// src/services/types.ts
// TODO(phase-3): relocate to src/core/types.ts. The brand shape is structurally
// identical, so every callsite keeps compiling after the move.
export type Path = string & { readonly __brand: 'Path' }

/** Unsafe cast. Phase 3 introduces validating smart constructors (path, pathAbs). */
export const path = (s: string): Path => s as Path
```

### Top-level barrel

```ts
// src/services/index.ts — the ONLY cross-module entry point for all of src/services/
export type { Path } from './types.ts'
export { path } from './types.ts'

export type { ProcessService, SpawnOptions, SpawnHandle } from './process/index.ts'
export { BunProcessService, FakeProcessService, ProcessSpawnError } from './process/index.ts'

export type { FsService } from './fs/index.ts'
export { BunFsService, FakeFsService } from './fs/index.ts'

export type { Clock } from './clock/index.ts'
export { SystemClock, FakeClock } from './clock/index.ts'
```

### Key mechanics (locked from brainstorm)

1. **`line-framer.ts` is a pure async generator.** Split on `\n`, strip a single trailing `\r`, yield non-empty residual on EOF, complete silently on empty EOF. Use `TextDecoder('utf-8', { fatal: false })` with `{ stream: true }` — critical for multi-byte UTF-8 characters that cross chunk boundaries. Accepts either `AsyncIterable<Uint8Array>` or `ReadableStream<Uint8Array>` (detect via `Symbol.asyncIterator` vs `getReader()`).

2. **`BunProcessService` throws synchronously on spawn failure.** Binary-not-found or cwd-missing are caller-caused; surfacing them at the call site gives a clearer stack trace than a deferred non-zero exit. `kill(signal = 'SIGTERM')` — `'SIGKILL'` is the escalation; any signal is forwarded verbatim. `stdin: 'ignore'` on the underlying `Bun.spawn`. **Stderr must be pumped concurrently** (Watch-outs §1).

3. **`FakeProcessService` matches by exact argv equality with a per-key FIFO queue.**
   - `.when(argv).respondWith(r)` enqueues `r` under `JSON.stringify(argv)`.
   - `spawn({ argv, ... })` pops the next response; an empty queue throws `FakeProcessService: no scripted response for argv <JSON>` — silent under-scripting becomes a loud failure.
   - No wildcards, no predicates. Phase 2's `FakeRunner` uses per-instance nonce argv `[':fake:', '<nonce>']` so two fakes never collide.
   - `wait()` resolves with `{ exitCode: scripted.exit }` **only after** the stdout/stderr iterators have completed or been killed. `kill()` sets a flag; in-flight iteration throws `AbortError` on the next step; `wait()` then resolves with `{ exitCode: -1 }`.

4. **Boundary enforcement via Biome `noRestrictedImports` with a file-scoped override.** Added to `biome.json` in Commit 1:

   ```jsonc
   {
     "linter": { "rules": { "style": { "noRestrictedImports": {
       "level": "error",
       "options": { "paths": {
         "child_process":      "Use ProcessService from src/services/process",
         "node:child_process": "Use ProcessService from src/services/process",
         "node-pty":           "Use ProcessService from src/services/process"
       }}
     }}}},
     "overrides": [{
       "includes": ["src/services/process/**"],
       "linter": { "rules": { "style": { "noRestrictedImports": "off" } } }
     }]
   }
   ```

   **Known gap:** Biome cannot flag references to the `Bun.spawn` **global** (not an import). Documented as a CLAUDE.md Rule 1 ("never reference `Bun.spawn` outside `src/services/process/`") and covered by code review. If a violation ever slips through, add a ten-line grep script reactively.

## Implementation plan (PR-sized, ordered sub-commits)

Every sub-commit leaves the tree passing `bun run check`, **except Commit 2** (red tests), which is allowed to fail `bun test` only.

Ordering follows the brainstorm handoff: **start with `line-framer` (smallest, purest) and end with `BunProcessService` integration tests (longest feedback loop).**

### Commit 1 — Scaffold + Biome boundary rule

**Goal:** every interface compiles under `tsc --noEmit`; the subprocess boundary rule is in place before any real implementation.

- [x] Create `src/services/types.ts` with `Path` brand and `path()` cast (with `TODO(phase-3)`).
- [x] Create `src/services/process/process-service.ts` — `SpawnOptions`, `SpawnHandle`, `ProcessService`, `ProcessSpawnError`.
- [x] Create `src/services/process/line-framer.ts` — signature only; body throws `Error('not implemented')`.
- [x] Create `src/services/process/bun-process-service.ts` — class skeleton; `spawn()` throws. **Do not** reference `Bun.spawn` yet (lands in Commit 7).
- [x] Create `src/services/process/fake-process-service.ts` — `FakeResponse`, `FakeProcessService` class skeleton (`when`, `spawn` throw).
- [x] Create `src/services/process/index.ts` re-exporting the full process surface.
- [x] Create `src/services/fs/fs-service.ts`, `bun-fs-service.ts` skeleton, `fake-fs-service.ts` skeleton, `index.ts`.
- [x] Create `src/services/clock/clock.ts`, `system-clock.ts` skeleton, `fake-clock.ts` skeleton, `index.ts`.
- [x] Create `src/services/index.ts` top-level barrel matching the surface above.
- [x] Update `biome.json` with `noRestrictedImports` and the `src/services/process/**` override. **Double-check the override key is `includes` (plural)** against the Biome 2.4.10 schema; typing `include` silently disables the override.
- [x] `bun run lint` → green. `bun run typecheck` → green. `bun test` still passes (only the placeholder test exists).
- [x] Commit: `phase 1: scaffold ProcessService, FsService, Clock interfaces + Biome boundary rule`.

**Guardrails verified before committing:** no `any`, no `!`, no `export default`, all type-only imports use `import type`, no runtime side effects at module load, no file references `child_process` / `Bun.spawn` (rule verified by a temporary red-experiment import in `src/index.ts`, confirmed and reverted).

### Commit 2 — Red tests (tests-first gate)

**Goal:** every test file lands, failing. Lint + typecheck still green; `bun test` allowed red. Each test name is a full sentence (CLAUDE.md Rule 4).

#### `tests/unit/services/process/line-framer.test.ts`

```ts
describe('frameLines', () => {
  it('splits a single chunk into one yield per newline-delimited line', async () => { /* ... */ })
  it('strips a single trailing carriage return from each line for CRLF tolerance', async () => { /* ... */ })
  it('yields the trailing residual when EOF arrives with a non-empty buffer', async () => { /* ... */ })
  it('completes silently when EOF arrives with an empty buffer', async () => { /* ... */ })
  it('yields nothing for an empty input stream', async () => { /* ... */ })
  it('reassembles lines that are split across chunk boundaries', async () => { /* ... */ })
  it('decodes multi-byte UTF-8 characters that span chunk boundaries', async () => { /* ... */ })
})
```

Build inputs with an inline async generator helper (`async function* bytes(...chunks: string[])`). No `tests/helpers/` yet.

#### `tests/unit/services/process/fake-process-service.test.ts`

```ts
describe('FakeProcessService', () => {
  it('emits the scripted stdout lines and exit code for a matching argv', async () => { /* ... */ })
  it('emits the scripted stderr lines symmetrically with stdout', async () => { /* ... */ })
  it('serves two distinct argvs independently with no cross-talk', async () => { /* ... */ })
  it('consumes scripts for the same argv in FIFO order', async () => { /* ... */ })
  it('throws FakeProcessService: no scripted response for argv ... when the queue is empty', async () => { /* ... */ })
  it('reports exitCode -1 via wait() when kill() interrupts the iteration with an AbortError', async () => { /* ... */ })
  it('does not resolve wait() before the stdout iterator has emitted all scripted lines', async () => { /* ... */ })
})
```

The last test is the "iteration drains before wait" invariant from Watch-outs §3.

#### `tests/unit/services/fs/fake-fs-service.test.ts`

```ts
describe('FakeFsService', () => {
  it('round-trips writeFile and readFile for a single path', async () => { /* ... */ })
  it('flips exists from false to true after writeFile and back to false after remove', async () => { /* ... */ })
  it('performs an atomic rename that removes the source and creates the destination', async () => { /* ... */ })
  it('creates nested paths when mkdir is called with recursive true', async () => { /* ... */ })
  it('throws when mkdir is called non-recursively on a missing parent', async () => { /* ... */ })
  it('matches glob patterns **/*.json and foo/*.md over the in-memory tree', async () => { /* ... */ })
  it('lists direct children via readDir', async () => { /* ... */ })
  it('reports size and mtimeMs via stat on a file', async () => { /* ... */ })
  it('returns a unique temp directory path per tempDir invocation', async () => { /* ... */ })
  it('overwrites existing files on writeFile without requiring an explicit remove', async () => { /* ... */ })
})
```

#### `tests/unit/services/clock/fake-clock.test.ts`

```ts
describe('FakeClock', () => {
  it('reports the initial value from now() when constructed with an explicit seed', () => { /* ... */ })
  it('defaults the initial value to zero when constructed with no argument', () => { /* ... */ })
  it('moves forward monotonically after advance(ms)', () => { /* ... */ })
  it('allows set(ms) to move the clock backward for state replay tests', () => { /* ... */ })
})
```

#### `tests/integration/services/process/bun-process-service.test.ts`

```ts
describe('BunProcessService', () => {
  it('yields a single line "hello" and exits with code 0 when running sh -c "echo hello"', async () => { /* ... */ })
  it('yields three lines from sh -c "printf a\\nb\\nc" even without a trailing newline', async () => { /* ... */ })
  it('yields no stdout and resolves wait() with exitCode 7 when running sh -c "exit 7"', async () => { /* ... */ })
  it('throws ProcessSpawnError synchronously when the binary does not exist', () => { /* ... */ })
  it('throws ProcessSpawnError synchronously when cwd does not exist', () => { /* ... */ })
  it('causes wait() to resolve with a non-zero exitCode after kill() on a long-running sh -c "sleep 30"', async () => { /* ... */ })
  it('drains stderr concurrently so wait() does not deadlock when the child writes > 64 KiB to stderr', async () => { /* ... */ })
})
```

The last test is **critical** and not in the brainstorm's original list — see Watch-outs §1.

#### `tests/integration/services/fs/bun-fs-service.test.ts`

```ts
describe('BunFsService', () => {
  it('round-trips writeFile and readFile against a real temp directory', async () => { /* ... */ })
  it('creates a real temp directory with the requested prefix', async () => { /* ... */ })
  it('performs an atomic rename on the real filesystem', async () => { /* ... */ })
  it('matches glob patterns over a real directory tree', async () => { /* ... */ })
  it('removes files and reports exists false afterward', async () => { /* ... */ })
  it('reports size and mtimeMs via stat on a real file', async () => { /* ... */ })
  it('creates nested directories with mkdir recursive on the real filesystem', async () => { /* ... */ })
})
```

Each integration test creates and tears down its own temp dir via `BunFsService.tempDir('orch-phase1-')`.

- [x] `bun run lint` green. `bun run typecheck` green. `bun test` red (every test throws `Error: not implemented`).
- [x] Commit: `phase 1: red tests for line-framer, FakeProcessService, FakeClock, FakeFsService, BunProcessService, BunFsService`. Commit body states explicitly that `bun test` is expected red and the next six commits green them in order.

### Commit 3 — Implement `line-framer`

**Goal:** `tests/unit/services/process/line-framer.test.ts` goes green.

- [x] Implement `frameLines()` as a pure async generator:
  1. Instantiate `new TextDecoder('utf-8', { fatal: false })` once.
  2. Buffer `= ''`. For each chunk: `buffer += decoder.decode(chunk, { stream: true })`.
  3. Split buffer on `'\n'`; keep last element as new buffer; for every other element, strip a single trailing `'\r'` and yield.
  4. On source completion: `buffer += decoder.decode()` (flush trailing state); if non-empty, yield with the same `\r` strip.
- [x] Accept both `AsyncIterable<Uint8Array>` and `ReadableStream<Uint8Array>` (detect via `Symbol.asyncIterator` vs `getReader()`).
- [x] Body ≤ 40 lines (brainstorm budget).
- [x] `bun test tests/unit/services/process/line-framer.test.ts` → green. `bun run check` lint+typecheck green; other tests still red.
- [x] Commit: `phase 1: implement line-framer (pure async generator)`.

### Commit 4 — Implement `SystemClock` + `FakeClock`

**Goal:** `tests/unit/services/clock/fake-clock.test.ts` green.

- [x] `SystemClock.now()` returns `Date.now()`.
- [x] `FakeClock`: constructor stores optional `initial` (default 0) in `#time`. `now()` returns `#time`. `advance(ms)` does `#time += ms` and throws if `ms < 0` (`FakeClock.advance: ms must be >= 0; use set() to move backward`). `set(ms)` replaces `#time` unconditionally.
- [x] `bun test tests/unit/services/clock/fake-clock.test.ts` → green.
- [x] Commit: `phase 1: implement SystemClock and FakeClock`.

### Commit 5 — Implement `FakeProcessService`

**Goal:** `tests/unit/services/process/fake-process-service.test.ts` green.

- [x] Internal state: `#queues: Map<string, FakeResponse[]>` keyed by `JSON.stringify(argv)`.
- [x] `when(argv)` returns `{ respondWith(r) { /* push into queue */ } }`. Create the queue lazily.
- [x] `spawn(opts)`:
  - Key = `JSON.stringify(opts.argv)`. Pop the front; throw with the exact message on empty.
  - Build the returned `SpawnHandle` inline:
    - `stdout`: async generator yielding each scripted line. Between yields, check a `killed` flag; if set, throw an `AbortError`.
    - `stderr`: symmetric.
    - `wait()`: await an internal "iterator finished or killed" promise, then resolve with `{ exitCode: killed ? -1 : scripted.exit }`.
    - `kill()`: sets `killed`, idempotent.
- [x] File ≤ 100 lines (brainstorm budget).
- [x] `bun test tests/unit/services/process/fake-process-service.test.ts` → green.
- [x] Commit: `phase 1: implement FakeProcessService with per-argv FIFO queue`.

### Commit 6 — Implement `FakeFsService`

**Goal:** `tests/unit/services/fs/fake-fs-service.test.ts` green.

- [x] Internal state: `#files: Map<Path, { data: string; mtimeMs: number }>`, `#dirs: Set<Path>`.
- [x] `writeFile(path, data)`: require parent to exist (parent = `path.slice(0, path.lastIndexOf('/'))`) unless empty; record `{ data, mtimeMs: Date.now() }`. Phase 3 will add a Clock dep when deterministic mtimes matter.
- [x] `readFile(path)`: throw on missing; else return `data`.
- [x] `rename(from, to)`: copy entry, delete `from`; throw if `from` missing.
- [x] `mkdir(path, { recursive })`: non-recursive throws on missing parent; recursive splits on `/` and adds every prefix to `#dirs`.
- [x] `exists(path)`: `#files.has(path) || #dirs.has(path)`.
- [x] `glob(pattern, { cwd })`: minimal pattern-to-regex (`**` → `.*`, `*` → `[^/]*`, `?` → `[^/]`, escape the rest); match over `#files`. If the matcher exceeds 30 lines, extract to `src/services/fs/fake-fs-glob.ts`.
- [x] `readDir`, `stat`, `remove`, `tempDir` per the brainstorm surface.
- [x] File ≤ 180 lines (brainstorm budget).
- [x] `bun test tests/unit/services/fs/fake-fs-service.test.ts` → green.
- [x] Commit: `phase 1: implement FakeFsService (map-backed)`.

### Commit 7 — Implement `BunProcessService` (integration-green)

**Goal:** `tests/integration/services/process/bun-process-service.test.ts` green. This is the first file in the phase allowed to reference `Bun.spawn` (the Biome override makes it legal).

- [x] `spawn(opts)`:
  1. Validate `cwd` exists (via `node:fs/promises.stat`); on failure, throw `ProcessSpawnError('cwd does not exist: ' + opts.cwd)`.
  2. `const proc = Bun.spawn({ cmd: [...opts.argv], cwd: opts.cwd, env: opts.env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })`. Wrap in try/catch; rewrap synchronous throws as `ProcessSpawnError`.
  3. **Pump stderr immediately** via an async IIFE that drains `frameLines(proc.stderr)` into a bounded tail buffer (size 200). Prevents the pipe-backpressure deadlock (Watch-outs §1).
  4. Build `SpawnHandle`:
     - `stdout: frameLines(proc.stdout)` — lazy.
     - `stderr`: expose a generator that replays the tail buffer. Document: "stderr is pumped eagerly to prevent pipe backpressure; `SpawnHandle.stderr` iterates the tail buffer, not the live stream."
     - `wait()`: `await proc.exited; return { exitCode: proc.exitCode ?? -1 }`.
     - `kill(signal = 'SIGTERM')`: `proc.kill(signal)`.
- [x] File ≤ 140 lines; `spawn()` body ≤ 60 lines (CLAUDE.md Rule 5).
- [x] `bun test tests/integration/services/process/bun-process-service.test.ts` → all seven integration tests green, including the stderr backpressure case.
- [x] Commit: `phase 1: implement BunProcessService wrapping Bun.spawn`.

### Commit 8 — Implement `BunFsService` (integration-green)

**Goal:** `tests/integration/services/fs/bun-fs-service.test.ts` green.

- [x] `readFile` → `Bun.file(path).text()`. `writeFile` → `Bun.write(path, data)`.
- [x] `rename` → `node:fs/promises.rename`. `mkdir` → `fs.mkdir(path, { recursive })`. `exists` → `fs.stat(path).then(() => true, () => false)`.
- [x] `glob` → `new Bun.Glob(pattern).scan({ cwd })` wrapped to yield `Path`.
- [x] `readDir` → `fs.readdir`. `stat` → `fs.stat`, projected to `{ size, mtimeMs }`. `remove` → `fs.rm(path, { recursive: true, force: true })`.
- [x] `tempDir` → `fs.mkdtemp(path.join(os.tmpdir(), prefix))` returned as `Path`.
- [x] Each method ≤ 15 lines; file ≤ 140 lines.
- [x] `bun test tests/integration/services/fs/bun-fs-service.test.ts` → green. `bun run check` → **full green**.
- [x] Commit: `phase 1: implement BunFsService wrapping Bun.file + node:fs/promises`.

### Commit 9 — Barrel audit + phase landing note

**Goal:** cross-module callers see exactly the surface the brainstorm promises; the roadmap is updated.

- [x] Verify `src/services/index.ts` matches the "Top-level barrel" section exactly. Quick check:
  ```bash
  bun -e "import('./src/services/index.ts').then(m => console.log(Object.keys(m).sort()))"
  ```
- [x] Verify each sub-barrel is consistent with the top-level barrel.
- [x] Sanity grep for the `Bun.spawn` global gap (not CI-wired):
  ```bash
  grep -rn 'Bun\.spawn' src/ tests/ | grep -v 'src/services/process/'
  # expected: no matches
  ```
- [x] `bun run check` → full green.
- [x] Update `docs/plans/implementation-phases.md`: flip Phase 1's glyph from `☐` to `✓` and append `**Landed:** YYYY-MM-DD`. Do not touch any other phase.
- [x] Commit: `phase 1: land — services barrel + roadmap update`.

## Tests this phase ships

### Unit (`tests/unit/services/`)
- `process/line-framer.test.ts` — 7 tests
- `process/fake-process-service.test.ts` — 7 tests
- `fs/fake-fs-service.test.ts` — 10 tests
- `clock/fake-clock.test.ts` — 4 tests

### Integration (mocked edges)
**None.** The only "edge" for `process/` is the real OS, covered below. The fake tests already exercise the interface through its fake implementation. Phase 2 is where `FakeRunner + runRunner + FakeProcessService` composition becomes meaningful.

### Integration (real OS, `tests/integration/services/`)
- `process/bun-process-service.test.ts` — 7 tests (including the stderr backpressure case)
- `fs/bun-fs-service.test.ts` — 7 tests

### E2E
**None.** Phase 5 is the first phase where E2E appears.

## Definition of Done

- [x] `bun run check` green on the phase branch.
- [x] Every unit + integration test above present and passing.
- [x] **A stray `import 'child_process'` in `src/index.ts` fails `bun run lint`** — verified via temporary red experiment, confirmed, reverted.
- [x] No file references `Bun.spawn` outside `src/services/process/bun-process-service.ts` — verified via manual grep.
- [x] Every new file under 300 lines. Every new function under 60 lines. Any exception has an inline comment.
- [x] Zero `any`, zero `!` non-null assertions.
- [x] No `mock.module()` / `jest.mock()` / `vi.mock()` anywhere in Phase 1 tests.
- [x] No runtime side effects at module import time (reviewed file-by-file).
- [x] `docs/plans/implementation-phases.md` updated: Phase 1 glyph `✓`, landed date recorded.
- [ ] PR description lists tests per layer:
  ```
  ## Phase 1 — ProcessService port + Bun adapter + Fake adapter + fs/clock parity
  - Unit: line-framer (7), fake-process-service (7), fake-fs-service (10), fake-clock (4)
  - Integration (mocked): none (see plan § Tests this phase ships)
  - Integration (real): bun-process-service (7), bun-fs-service (7)
  - E2E: none
  ```

## File / function budget

Carried from brainstorm; Commit 9 checks against it.

| File | Target LOC | Ceiling | Function ceiling |
|---|---|---|---|
| `services/types.ts` | ~10 | 30 | — |
| `services/process/process-service.ts` | ~40 | 80 | — (types only) |
| `services/process/line-framer.ts` | ~40 | 80 | 40 |
| `services/process/bun-process-service.ts` | ~90 | 140 | 60 (`spawn`) |
| `services/process/fake-process-service.ts` | ~100 | 140 | 40 |
| `services/fs/fs-service.ts` | ~30 | 60 | — |
| `services/fs/bun-fs-service.ts` | ~140 | 220 | 15 / method |
| `services/fs/fake-fs-service.ts` | ~180 | 260 | 30 (`glob`), 20 others |
| `services/clock/clock.ts` | ~15 | 30 | — |
| `services/clock/{system,fake}-clock.ts` | ~20 each | 40 | 5 |
| every test file | ≤ 200 | 300 | — |

## Watch-outs & known pitfalls

### 1. Stderr pipe backpressure can deadlock `wait()`

Bun's `Subprocess.stderr` is backed by an OS pipe with a ~64 KiB buffer. If the caller never reads stderr and the child writes more than that, the child blocks on `write()`, never exits, and `await proc.exited` deadlocks. Universal Unix pipe gotcha.

**Fix:** Commit 7 step 3 — pump stderr concurrently from spawn time via an async IIFE that drains into a bounded tail buffer.

**Test:** Commit 2 lands `it('drains stderr concurrently so wait() does not deadlock when the child writes > 64 KiB to stderr')`. Produce the pressure with `sh -c 'yes ERROR 1>&2 | head -c 100000 1>&2; exit 0'` or equivalent. Without the concurrent drain, this test hangs the suite — add a per-test timeout guard.

### 2. `TextDecoder` streaming mode is mandatory

Multi-byte UTF-8 characters that cross chunk boundaries corrupt if `TextDecoder.decode(chunk)` is called without `{ stream: true }`. `frameLines()` must instantiate the decoder once and use streaming mode, with a final no-arg `decode()` at EOF to flush trailing state.

**Test:** Commit 2's `it('decodes multi-byte UTF-8 characters that span chunk boundaries')`. Use a known 4-byte sequence (e.g., `'👋'`) split across two chunks.

### 3. `FakeProcessService.wait()` must not resolve before iteration drains

Phase 2's `runRunner` iterates stdout and then calls `wait()`. If the fake's `wait()` resolves immediately, the caller races against the iterator and tests become flaky.

**Fix:** Commit 5 — make `wait()` await an internal "iterator finished or killed" promise.

**Test:** Commit 2's `it('does not resolve wait() before the stdout iterator has emitted all scripted lines')`.

### 4. Biome override key is `includes`, not `include`

Biome 2.4.10 uses `includes` (plural). Typing `include` silently disables the `src/services/process/**` override, which then makes `bun-process-service.ts` fail lint under `noRestrictedImports` once Commit 7 lands.

**Fix:** Commit 1 double-checks the key by running a deliberate positive test (stray `import 'child_process'` in `src/index.ts` fails) and a negative test (the legitimate override location is permitted once Commit 7 lands).

### 5. `Path` brand is structural — cross-file moves are free

The forward-declared `Path` brand in `src/services/types.ts` is structurally identical to the Phase 3 `src/core/types.ts` version. When Phase 3 moves it, every existing `Path` value stays assignable. Do not add private symbols to the brand that would break this structural equivalence.

## Out of scope for Phase 1

Explicitly deferred so reviewers can reject scope-creep PRs:

- `stdin` on `SpawnOptions` (no phase through 16 needs it).
- `AbortSignal` on `SpawnOptions` (Phase 11 resume adds it with a real test).
- Bytes-level stdout/stderr (every runner consumes NDJSON lines).
- Pre-collected transcript surface on `wait()` (would preclude Phase 13 streaming observability).
- A grep-based enforcement script (add reactively if a `Bun.spawn` global ever slips through review).
- Any concrete runner (Phase 2: `Runner` port; Phase 5: `ClaudeRunner`).
- `StateStore`, run IDs, or anything that consumes `FsService` (Phase 3).
- `GitService` or `tempGitRepo` helper (Phase 10).
- Validating `Path` constructor with NUL-byte / absolute checks (Phase 3 `pathAbs`).
- Hardcoded resource backstops (max line bytes, wall-clock timeout, max events) — Phase 2 or later concern; Phase 1's `ProcessService` is a pure byte/line pipe.

## Handoff to Phase 2

Phase 1 unblocks Phase 2 (`Runner` port + `FakeRunner` + `runRunner` glue). The Phase 2 plan at [`docs/plans/2026-04-09-feat-phase-2-runner-port-plan.md`](./2026-04-09-feat-phase-2-runner-port-plan.md) lists this phase as a prerequisite and enumerates the exact symbols it needs:

- `ProcessService` + `SpawnOptions` + `SpawnHandle` (with `stdout: AsyncIterable<string>`).
- `FakeProcessService` with per-argv FIFO scripting (Phase 2's `FakeRunner.script()` FIFO depends on it).
- `Clock` + `FakeClock` (`runRunner` uses it for `durationMs`).

**Verification before Phase 2 starts:**
```bash
bun run check                                         # must be green on main
ls src/services/process/ src/services/clock/          # both must exist
grep -rn 'FakeProcessService' src/services/process/   # must find the class
grep -rn 'class FakeClock' src/services/clock/        # must find the class
```

Load the `phase-implementer` skill when starting Phase 1 implementation. Load the `testing-strategy` skill before writing any of the Commit 2 tests.

## References

### Internal
- [`docs/brainstorms/2026-04-09-phase-1-process-service-brainstorm.md`](../brainstorms/2026-04-09-phase-1-process-service-brainstorm.md) — all locked design decisions.
- [`docs/brainstorms/2026-04-09-phase-2-runner-port-brainstorm.md`](../brainstorms/2026-04-09-phase-2-runner-port-brainstorm.md) — consumer of Phase 1's `ProcessService`.
- [`docs/plans/2026-04-09-feat-phase-2-runner-port-plan.md`](./2026-04-09-feat-phase-2-runner-port-plan.md) — Phase 2 prerequisites table is the authoritative spec for Phase 1's exported surface.
- [`docs/plans/implementation-phases.md`](./implementation-phases.md) — roadmap; Phase 1 block updated in Commit 9.
- [`/CLAUDE.md`](../../CLAUDE.md) — non-negotiable rules (Rules 1, 5, 6, 7, 8, 9, 10 directly relevant).
- [`.claude/skills/phase-implementer/SKILL.md`](../../.claude/skills/phase-implementer/SKILL.md) — operational discipline.
- [`.claude/skills/testing-strategy/SKILL.md`](../../.claude/skills/testing-strategy/SKILL.md) — three-layer testing doctrine.

### External
- Biome `noRestrictedImports` rule reference (confirms path-based form and override syntax).
- Bun docs: `Bun.spawn`, `Bun.file`, `Bun.write`, `Bun.Glob`.
- `pipe(7)` manual — motivates Watch-out §1 (stderr backpressure).
- WHATWG `TextDecoder` streaming mode — motivates Watch-out §2.
