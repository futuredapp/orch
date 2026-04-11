---
date: 2026-04-09
status: brainstorm-deepened
topic: Phase 1 — ProcessService port, Bun adapter, Fake adapter, and fs/clock service stubs
relates-to: docs/plans/implementation-phases.md (Phase 1)
deepened: 2026-04-10
---

# Phase 1 Brainstorm — `ProcessService` port + Bun adapter + Fake adapter

## Enhancement Summary

**Deepened on:** 2026-04-10
**Sections enhanced:** 8
**Research agents used:** architecture-strategist, kieran-typescript-reviewer, performance-oracle, code-simplicity-reviewer, pattern-recognition-specialist, security-sentinel, agent-native-reviewer, repo-research-analyst, best-practices-researcher, framework-docs-researcher

### Key Improvements

1. **Ship the `Bun.spawn` grep enforcement in Phase 1, not reactively** — 3 independent reviewers (architecture, security, patterns) all flagged this. A 5-line script in `bun run check` closes the single biggest enforcement gap at near-zero cost.
2. **Use `unique symbol` for the `Path` brand** — prevents accidental structural unification across modules. Confine the `as Path` cast to a single `toPath()` factory function.
3. **Place `Path` in `src/types.ts`** (top-level, outside any module) instead of `src/services/types.ts` — avoids guaranteed import churn in Phase 3. Both `src/services/` and the future `src/core/` import from the same canonical location.
4. **Extract named types**: `ExitResult` for `wait()` return, `FileStat` for `stat()` return — prevents anonymous inline types from proliferating.
5. **Define structured error types early**: At minimum `ProcessSpawnError` with a `code` discriminant field — enables programmatic error handling by agents and runners without message parsing.
6. **Add `assertAllConsumed()` to `FakeProcessService`** — standard test-double hygiene that catches over-scripted tests.
7. **Use 128+signal for kill exit codes** (not -1) — matches real Unix semantics and prevents fake/real behavior divergence.
8. **`frameLines()` must have `try/finally`** for ReadableStream reader cleanup on early termination — prevents file descriptor leaks under spawn/kill cycles.

### New Considerations Discovered

- **Security**: argv validation gap (no allowlist for permitted executables), path traversal risk in FsService (no workspace containment), fake services should not be importable from production barrels
- **Agent-native**: `SpawnHandle` lacks observable state (`status` property), `wait()` should return `signal` metadata for agent error diagnosis
- **Performance**: AsyncIterable is confirmed as the correct primitive (not ReadableStream/TransformStream); back-pressure is naturally handled by async generator suspension
- **Simplicity tension**: FsService 10-method surface is debated — simplicity reviewers recommend 5 methods (`readFile`, `writeFile`, `mkdir`, `rename`, `tempDir`), architecture reviewers accept the YAGNI exception
- **Pattern gap**: Consider `Symbol.asyncDispose` on SpawnHandle for leak prevention in tests
- **Naming**: Document the `Clock` vs `*Service` naming exception as intentional
- **Bun-specific**: stderr defaults to `"inherit"` (must set `"pipe"` explicitly), `TextDecoder` needs `{ stream: true }`, `Subprocess` implements `AsyncDisposable` natively, `Bun.write` auto-creates parent dirs

### Consensus Matrix

| Topic | Architecture | TypeScript | Performance | Simplicity | Patterns | Security | Agent-Native |
|---|---|---|---|---|---|---|---|
| Ship grep check now | **Must-fix** | — | — | — | **Must-fix** | **Must-fix** | — |
| unique symbol for Path | — | **Must-fix** | — | — | OK as-is | — | — |
| Path in src/types.ts | **Must-fix** | — | — | — | Flagged | — | — |
| Extract named types | — | **Must-fix** | — | — | — | — | — |
| Structured error types | Should-fix | **Must-fix** | — | Defer | Should-fix | **Must-fix** | **Must-fix** |
| assertAllConsumed() | — | — | — | — | **Must-fix** | — | Should-fix |
| 128+signal kill codes | — | — | — | — | **Must-fix** | — | — |
| frameLines try/finally | — | — | **Must-fix** | — | — | — | — |
| FsService 5 vs 10 methods | Accept 10 | — | — | Reduce to 5 | Accept 10 | — | Accept 10 |
| env optional vs required | Required OK | Make optional | — | — | Helper fn | — | — |
| Clock.set(ms) | — | — | — | Remove | — | — | — |
| SpawnHandle.status | — | — | — | — | — | — | **Must-fix** |

---

## What we're building

Phase 1 installs the **single seam** between the codebase and every subprocess it will ever spawn. Every future runner (Claude, Codex, Aider, anything a user wraps) reaches the real world through one port: `ProcessService.spawn(opts)`. Phase 2's `runRunner` glue imports this port; Phase 5's `ClaudeRunner` is tested against a scripted fake built on top of it; and an enforcement rule makes sure no other code path to a subprocess can ever be opened.

The phase also lands **full service parity** for `fs/` and `clock/` — not just stubs. Both folders ship interface + real adapter + fake with the same layout as `process/`, so later phases (state store, validators, duration measurement) drop in without touching the service layer.

### Deliverables

```
src/services/
├── process/
│   ├── process-service.ts        # interface + SpawnOptions + SpawnHandle types
│   ├── bun-process-service.ts    # real adapter, wraps Bun.spawn, line-framed stdout/stderr
│   ├── fake-process-service.ts   # keyed-by-argv FIFO scripting
│   ├── line-framer.ts            # pure async iterator helper (split \n, strip \r, yield trailing partial)
│   └── index.ts                  # barrel
├── fs/
│   ├── fs-service.ts             # interface
│   ├── bun-fs-service.ts         # real adapter (Bun.file + node:fs/promises)
│   ├── fake-fs-service.ts        # in-memory map
│   └── index.ts
├── clock/
│   ├── clock.ts                  # interface
│   ├── system-clock.ts           # () => Date.now()
│   ├── fake-clock.ts             # advance(ms)
│   └── index.ts
└── index.ts                      # top-level barrel (exports all three)

tests/unit/services/
├── process/
│   ├── fake-process-service.test.ts
│   └── line-framer.test.ts
├── fs/fake-fs-service.test.ts
└── clock/fake-clock.test.ts

tests/integration/services/
├── process/bun-process-service.test.ts   # real `echo hello` round-trip
└── fs/bun-fs-service.test.ts              # real temp dir round-trip

biome.json                        # noRestrictedImports rule + overrides for src/services/process/
```

Nothing outside `src/services/process/` may import `child_process`/`node-pty` or reference the `Bun.spawn` global. The only cross-module entry points are the three `index.ts` barrels.

## Why this approach

The core design tension in Phase 1 is between **"minimal surface, YAGNI"** (the implementation plan's mantra) and **"consistent service-folder parity"** (which makes later phases cheaper and more readable). We resolved it by keeping the `ProcessService` surface strictly minimal while landing all three services with the same structure. The result satisfies the three design drivers from the implementation plan:

- **Testability** — the one port every subprocess crosses is also the one port every test fakes. Phase 2's `runRunner` tests, Phase 3's state-store tests, and every runner test from Phase 5 onward all reach for `FakeProcessService` by name. No `mock.module` anywhere.
- **Readability** — `spawn()` takes three fields and returns four methods; a runner author can memorise the contract in thirty seconds. Line framing is a single ≤ 40-line pure function with its own unit test.
- **Maintainability** — a Biome `noRestrictedImports` rule (with an override for `src/services/process/`) enforces the boundary at lint time, so future contributors cannot quietly add a second subprocess path. The `fs` and `clock` folders mirror `process` exactly, so adding a new service later is a copy-paste exercise.

## Key decisions (locked from the Q&A)

### 1. `SpawnHandle` exposes line-framed stdout/stderr only

```ts
// src/services/process/process-service.ts
export interface SpawnOptions {
  readonly argv: readonly string[]
  readonly cwd: Path
  readonly env: Readonly<Record<string, string>>
}

export interface SpawnHandle {
  readonly stdout: AsyncIterable<string>   // one line per iteration
  readonly stderr: AsyncIterable<string>   // one line per iteration
  wait(): Promise<{ readonly exitCode: number }>
  kill(signal?: NodeJS.Signals): void      // default 'SIGTERM'
}

export interface ProcessService {
  spawn(opts: SpawnOptions): SpawnHandle
}
```

No bytes-level surface, no pre-collected transcript on `wait()`. Runners parse NDJSON line-by-line via `parseEvents(line)` (Phase 2), which is the only consumer pattern we care about through Phase 5. Adding a bytes surface later is a purely additive change.

**Why:** every runner planned through Phase 16 consumes newline-delimited JSON. Shipping a bytes surface now would be dead weight, and pre-collecting the transcript on `wait()` would preclude the streaming observability tmux phase (Phase 13) depends on.

#### Research Insights — SpawnHandle Design

**AsyncIterable confirmed as the right primitive (Performance):**
- Bun's `Subprocess.stdout` is a `ReadableStream<Uint8Array>` that also implements `Symbol.asyncIterator` natively, so `for await...of` works directly.
- `TransformStream` would add overhead (WritableStream/ReadableStream pair with internal queue) for a single-producer single-consumer pipe. The async generator already provides natural backpressure: the producer suspends when the consumer hasn't called `.next()`.
- At the expected throughput (hundreds of NDJSON events per run), the per-yield overhead of an async generator (one microtask per `.next()`) is irrelevant.

**Extract a named return type for wait() (TypeScript, Agent-Native):**
```ts
export interface ExitResult {
  readonly exitCode: number
  readonly signal?: NodeJS.Signals   // if killed by signal (agent-native)
  readonly killedByUs: boolean       // true if our kill() was called (agent-native)
}
```
The anonymous `{ readonly exitCode: number }` inline type will be used everywhere. A named type gives a clean extension point for Phase 11 (resume) without hunting down every inline usage. The `signal` and `killedByUs` fields are zero-cost metadata that let agents distinguish intentional kills from external ones.

**Consider `Symbol.asyncDispose` on SpawnHandle (Patterns):**
When using `using` syntax (TypeScript 5.2+, supported by Bun), a disposable handle guarantees cleanup even if the consumer throws mid-iteration. Particularly relevant for integration tests spawning real processes — a test that throws before calling `kill()` can leak a child process.

**Add `status` property for agent observability (Agent-Native):**
```ts
readonly status: 'running' | 'exited' | 'killed'
```
Without this, an orchestrating agent managing concurrent subprocesses (Phase 8) has no non-blocking way to check liveness. `wait()` blocks until termination; `kill()` is destructive. A readonly `status` property is zero-cost to implement.

**Document the concurrent stdout/stderr iteration contract (Architecture, Performance):**
Consumers that want both `stdout` and `stderr` must merge or race the two iterables — otherwise one blocks the other. Phase 2's `runRunner` will own this merging logic. The performance reviewer confirms that stderr must be pumped eagerly to prevent deadlock (OS pipe buffer fills at ~64 KiB on macOS/Linux). A bounded tail buffer (200 lines) for stderr is the right approach.

**`frameLines()` must have try/finally for cleanup (Performance):**
If the consumer of `SpawnHandle.stdout` stops iterating early (on `kill()`), the underlying ReadableStream must be cancelled. Without `try/finally` in the async generator releasing the reader, Bun may keep the file descriptor open and the subprocess may not receive SIGPIPE, leading to zombie processes.

### 2. `spawn(opts)` is YAGNI-minimal — no stdin, no signal, no stdio redirection

`SpawnOptions` has exactly three fields: `argv`, `cwd`, `env`. `env` is a **full replacement** (no automatic merge with `process.env`) — callers that want inheritance can spread explicitly. No `stdin`, because Claude and Codex take prompts via argv in every phase up to 16. No `AbortSignal` yet — Phase 11 (resume) will add one and eat the call-site churn when cancellation has a real test.

**Why:** adding an optional field you never populate is dead weight that misleads future runner authors about what's available. The rule from Phase 2's brainstorm — "each addition touches one type, the glue, and a single test" — applies here too.

#### Research Insights — SpawnOptions Design

**env: required vs optional (TypeScript vs Architecture tension):**
The TypeScript reviewer recommends making `env` optional or adding an `extendEnv` field, since most spawns want to inherit the parent environment with a few overrides. The architecture reviewer defends the full-replacement approach for testability and determinism. **Resolution**: Keep `env` as required full replacement (the architecture argument is stronger for an orchestrator), but add a `buildEnv(overrides)` utility in Phase 2 that runner authors use instead of manual spreading. Document clearly that `env` is a full replacement.

**`Record<string, string>` under noUncheckedIndexedAccess (TypeScript):**
Every lookup on the env record returns `string | undefined`. This is correct behavior for env vars. Consider `Record<string, string | undefined>` to match `process.env`'s actual type in Node/Bun and make the `| undefined` explicit to consumers.

**Security concern — no argv validation (Security):**
The `spawn()` interface accepts any `argv` with no validation on what executables can be spawned. While this is fine for Phase 1 (no runner calls spawn directly), Phase 2's `runRunner` or Phase 5's `ClaudeRunner.buildCommand` should validate that `argv[0]` resolves to an expected binary. Consider adding this validation in Phase 2, not Phase 1. Document `extraArgs` must never be used as `argv[0]`.

### 3. `FakeProcessService` matches by argv equality with a per-key FIFO queue

```ts
// src/services/process/fake-process-service.ts
export class FakeProcessService implements ProcessService {
  when(argv: readonly string[]): { respondWith(r: FakeResponse): void }
  spawn(opts: SpawnOptions): SpawnHandle   // pops the next response for opts.argv
}

export interface FakeResponse {
  readonly stdout?: readonly string[]   // one entry per yielded line
  readonly stderr?: readonly string[]
  readonly exit: number
}
```

Semantics:
- `.when(argv).respondWith(r)` enqueues `r` under a key derived from `JSON.stringify(argv)`.
- `spawn({ argv, ... })` pops the next response from `argv`'s queue. Running out throws `FakeProcessService: no scripted response for argv <...>` — silent under-scripting becomes a loud test failure.
- Matching is **exact array equality**. No wildcards, no predicates. Phase 2's `FakeRunner` already plans to use a per-instance nonce argv (`[':fake:', '<nonce>']`), so two independent FakeRunners in the same test never collide.
- The returned `SpawnHandle.wait()` resolves with the scripted `exit`. `stdout`/`stderr` async-iterables yield the scripted lines and then complete.
- `kill()` marks the handle as killed; if iteration hasn't drained yet, it throws `AbortError` on the next iteration and `wait()` resolves with `{ exitCode: -1 }`.

**Why:** keyed-by-argv + FIFO is the sweet spot — expressive enough for any realistic multi-runner test, strict enough that ambiguous scripts fail loudly instead of matching the wrong call. Predicate-based matching was rejected for being too easy to get wrong; global FIFO was rejected for being order-sensitive under concurrency.

#### Research Insights — FakeProcessService Design

**Add `assertAllConsumed()` (Patterns, Agent-Native):**
The fake throws when an unscripted argv is spawned (good), but does NOT fail if scripted responses go unconsumed. A test can over-script (enqueue three responses, consume two) and pass silently. Add:
```ts
assertAllConsumed(): void   // throws if any queued response was never used
get pendingCount(): number  // how many responses remain unmatched
```
Call `assertAllConsumed()` in test `afterEach` blocks. This is standard practice in test doubles (nock, msw, etc.) and catches over-scripting — often a sign of a test that doesn't understand the code path it exercises.

**JSON.stringify key is correct but document the assumption (Patterns):**
`JSON.stringify` produces deterministic output for `readonly string[]`. Add a comment noting the key derivation is intentionally argv-only — if it's ever extended to include `env` or `cwd`, `JSON.stringify` on objects with inconsistent key ordering would silently break matching.

**Array.shift() for FIFO is O(n) — use index pointer (Performance):**
The expected usage is 1-5 responses per argv (negligible), but consider:
```ts
{ responses: FakeResponse[], nextIndex: number }
```
instead of `queue.shift()` which re-indexes every remaining element. Micro-optimization, but trivial to implement.

**Exact matching limits automated test generation (Agent-Native):**
Keep exact matching as the default (correct call), but note that Phase 5+ will need `whenMatching(predicate)` for cases where `ClaudeRunner.buildCommand` produces argv with dynamic session IDs that a test cannot predict. Flag as a known future need, not a Phase 1 requirement.

### 4. `BunProcessService` throws synchronously on spawn failure; line framing is forgiving

```ts
// src/services/process/bun-process-service.ts
export class BunProcessService implements ProcessService {
  spawn(opts: SpawnOptions): SpawnHandle {
    // Bun.spawn is referenced ONLY here. Throws a ProcessSpawnError
    // synchronously if the binary is missing or the cwd doesn't exist.
    // stdout/stderr are streamed through the line-framer below.
  }
}
```

Line framer rules (tested in isolation as a pure async generator):
- Split on `\n`.
- Strip a single trailing `\r` from each line (CRLF tolerance).
- On EOF, if the buffer has a non-empty residual line, yield it.
- On EOF with an empty residual buffer, complete silently.
- UTF-8 only; non-UTF8 bytes surface as replacement characters (Bun's default behaviour — we do not introduce a separate decoder).

`kill(signal)` defaults to `'SIGTERM'`; `'SIGKILL'` is the escalation. Any signal other than those two is accepted and forwarded verbatim.

**Why:** synchronous `spawn()` failures are caller-caused (bad argv, missing binary) and surfacing them at the call site gives a much clearer stack trace than a deferred non-zero exit code. Forgiving framing tolerates real-world CLIs that sometimes omit the final newline without crashing the runner.

#### Research Insights — Error Types and Line Framing

**Define structured error types (TypeScript, Security, Agent-Native — all agree):**
Use a `code` discriminant field instead of `instanceof` for exhaustive `switch` checking across module boundaries:
```ts
export class ProcessSpawnError extends Error {
  readonly code: 'BINARY_NOT_FOUND' | 'CWD_NOT_FOUND' | 'PERMISSION_DENIED' | 'UNKNOWN'
  readonly argv: readonly string[]
  readonly cwd: Path
}
```
This lets Phase 2's `runRunner` distinguish "binary not found" from other failures without parsing error messages. Every runner author benefits. **Counter-argument (Simplicity):** defer until a caller needs `instanceof`. **Resolution:** define at least a minimal `ProcessSpawnError` with `code` — the cost is 10 lines, the value compounds across every phase.

**kill() should use 128+signal exit codes, not -1 (Patterns):**
The `exitCode: -1` convention is non-standard. Real Unix signals produce exit codes like 128+15 (SIGTERM → 143). Using -1 as a sentinel causes divergence between fake and real behavior, which undermines the "fakes behave like the real thing" principle. Make the fake configurable: `kill(signal)` → `128 + signalNumber(signal)`.

**Line framer memory profile (Performance):**
At steady state, buffer holds at most one partial line (~200-2000 bytes for NDJSON). **Pathological case:** a subprocess emitting megabytes without a newline (malformed binary dump) causes unbounded buffer growth. Add a `MAX_LINE_BYTES` guard (e.g., 10 MB) before Phase 5 when real CLIs connect. Acceptable to defer from Phase 1.

**Prefer `Symbol.asyncIterator` detection over `getReader()` (Performance):**
In Bun, `ReadableStream` supports both. Using async iteration is simpler and avoids reader-locking semantics. Consider accepting only `AsyncIterable<Uint8Array>` in `frameLines()` — Bun streams are already async iterable.

### 5. Boundary enforcement is a Biome `noRestrictedImports` rule with an override

```jsonc
// biome.json
{
  "linter": {
    "rules": {
      "style": {
        "noRestrictedImports": {
          "level": "error",
          "options": {
            "paths": {
              "child_process": "Use ProcessService from src/services/process",
              "node:child_process": "Use ProcessService from src/services/process",
              "node-pty": "Use ProcessService from src/services/process"
            }
          }
        }
      }
    }
  },
  "overrides": [
    {
      "include": ["src/services/process/**"],
      "linter": { "rules": { "style": { "noRestrictedImports": "off" } } }
    }
  ]
}
```

**Known gap:** Biome cannot flag references to the `Bun.spawn` **global** (it's not an import). This is documented as a CLAUDE.md rule only — trust the author + code review. If a violation ever slips through, Phase 1 will retroactively add a ten-line grep script under `scripts/` and wire it into `bun run check`. We are explicitly choosing not to pre-build the grep to avoid duplicating the rule in two places.

**Why:** lint-time editor feedback is much better DX than a pre-lint shell script; the `Bun.spawn` global gap is small enough that a code-review norm covers it until we have evidence otherwise.

#### Research Insights — Boundary Enforcement ⚠️ STRONG CONSENSUS

**Ship the grep check NOW, not reactively (Architecture, Security, Patterns — all agree):**
This is the single most strongly recommended change across all reviewers. The subprocess isolation rule is the most important architectural invariant in this project. Partial enforcement of a non-negotiable rule is a contradiction. The cost is 5 lines:
```bash
#!/bin/bash
if grep -r 'Bun\.spawn' src/ --include='*.ts' | grep -v 'src/services/process/'; then
  echo "ERROR: Bun.spawn used outside src/services/process/"
  exit 1
fi
```
Wire into `bun run check` via `package.json`. The argument "duplicating the rule in two places" doesn't hold — the Biome rule and the grep script check different things (imports vs global references).

**Security perspective:** The entire security model rests on `ProcessService` being the sole subprocess path. A single `Bun.spawn` call outside `src/services/process/` completely bypasses all intended controls. Code review norms fail under pressure (deadline rushes, new contributors, large diffs).

### 6. `fs/` and `clock/` ship full interface + real + fake parity with `process/`

`ClockService`:

```ts
export interface Clock {
  now(): number   // epoch milliseconds
}
export class SystemClock implements Clock { now() { return Date.now() } }
export class FakeClock implements Clock {
  constructor(initial: number = 0)
  now(): number
  advance(ms: number): void
  set(ms: number): void
}
```

`FsService` (near-complete surface, chosen over minimal for consistency):

```ts
export interface FsService {
  readFile(path: Path): Promise<string>
  writeFile(path: Path, data: string): Promise<void>
  rename(from: Path, to: Path): Promise<void>                  // atomic swap for state store
  mkdir(path: Path, opts?: { recursive?: boolean }): Promise<void>
  exists(path: Path): Promise<boolean>
  glob(pattern: string, opts?: { cwd?: Path }): AsyncIterable<Path>
  readDir(path: Path): Promise<readonly Path[]>
  stat(path: Path): Promise<{ size: number; mtimeMs: number }>
  remove(path: Path): Promise<void>
  tempDir(prefix: string): Promise<Path>
}
```

`FakeFsService` is a map-backed implementation that supports the full surface. `BunFsService` wraps `Bun.file`, `Bun.write`, and `node:fs/promises` where Bun doesn't have a direct equivalent (`rename`, `stat`, `readdir`).

**Why:** the `FsService` surface is a deliberate YAGNI exception. Phases 3, 6, 10, and 13 all need different subsets; designing the full surface once (with the test matrix already in place) is cheaper than touching the file four separate times. Clock stays small because `now()` is the only thing any future phase needs.

#### Research Insights — FsService, Clock, and Path

**FsService scope — DEBATED:**
- **Simplicity reviewers** recommend 5 methods: `readFile`, `writeFile`, `mkdir`, `rename`, `tempDir`. The argument: adding a method later is a 3-line change per adapter, which is cheaper than writing, testing, and reviewing 5 unused methods now. `FakeFsService` at ~180 lines would be the largest file in Phase 1.
- **Architecture and Pattern reviewers** accept the YAGNI exception. The structural consistency is worth the upfront cost; testing the full surface catches fake implementation bugs before they block future phases.
- **Compromise:** If shipping 10 methods, mark unconsumed methods in the fake with `// Not yet exercised by production code` comments. This flags them for future review and catches staleness.

**FsService security — path traversal risk (Security):**
The `Path` brand is compile-time only — no runtime protection against path traversal. Consider adding a `rootDir` parameter to `BunFsService` constructor; all operations resolve paths relative to this root and reject any path that escapes it (after symlink resolution). The `glob` method with a user-controlled pattern is especially dangerous (`glob('../../**/*')` enumerates the filesystem). **Recommendation:** defer workspace containment to Phase 2 or 3 when runners actually call FsService, but document the risk.

**Extract named type for stat() return (TypeScript):**
```ts
export interface FileStat {
  readonly size: number
  readonly mtimeMs: number
}
```
Note the original is missing `readonly` markers — inconsistent with every other interface.

**Clock.set(ms) — consider removing (Simplicity):**
No phase in the roadmap replays time backward. `advance(ms)` is sufficient. If a test needs a specific start time, pass it to the constructor. **Counter-argument:** `set()` is 2 lines and costs nothing. **Resolution:** keep or drop — either is defensible. If kept, add a comment explaining the use case.

**FakeClock default value — use non-zero epoch (Architecture):**
An initial value of 0 can mask bugs where code checks `if (timestamp)` and treats 0 as falsy. Consider defaulting to a realistic-looking timestamp (e.g., `1_704_067_200_000` — 2024-01-01).

**Clock.delay() — consider for testable timeouts (TypeScript):**
```ts
export interface Clock {
  now(): number
  delay(ms: number, signal?: AbortSignal): Promise<void>
}
```
Without this, `setTimeout` calls scattered through the codebase can't be controlled by `FakeClock`, defeating the abstraction's purpose. **Counter-argument (YAGNI):** no phase before Phase 11 needs delays. **Resolution:** defer, but note as a known future addition.

**Clock vs *Service naming (Patterns):**
`Clock` breaks the `*Service` suffix pattern used by `ProcessService` and `FsService`. This is a defensible exception (simpler, more idiomatic), but document it as intentional so future contributors don't "fix" it into `ClockService`.

**Merge clock files (Simplicity):**
`clock.ts` + `system-clock.ts` + `fake-clock.ts` = ~55 lines total. Consider combining into a single `clock.ts` with the interface, `SystemClock`, and `FakeClock`. Three files for 55 lines is over-modularization. **Counter-argument:** structural consistency with `process/` and `fs/` has value for learnability.

**Path brand — use `unique symbol` (TypeScript):**
```ts
declare const PathBrand: unique symbol
type Path = string & { readonly [PathBrand]: true }
```
This guarantees no accidental structural match across modules. The current `'Path'` string literal can unify silently with any other branded type using the same literal.

**Path location — place in `src/types.ts` (Architecture):**
Instead of `src/services/types.ts` (Phase 1) → `src/core/types.ts` (Phase 3 migration), place `Path` in `src/types.ts` from day one. Both `src/services/` and the future `src/core/` import from the same canonical location. No migration churn.

**Confine `as Path` to a single factory function (TypeScript):**
```ts
function toPath(raw: string): Path {
  return raw as Path
}
```
If you see `as Path` anywhere else in the codebase, that's a code smell.

**Don't export fakes from production barrels (TypeScript, Security):**
`FakeProcessService`, `FakeClock`, `FakeFsService` should NOT be exported from `src/services/index.ts`. Export them from a separate entry point (e.g., `src/services/process/testing.ts`) or keep them in the `tests/` tree. Leaking test doubles into the production module graph is a common mistake. Consider adding a runtime guard: `FakeProcessService` constructor throws if `process.env.NODE_ENV === 'production'`.

## Tests this phase must ship

Following the testing-strategy skill layer convention:

### Unit

- `process/line-framer.test.ts`
  - Splits on `\n` into one yield per line.
  - Strips a single trailing `\r` from each line.
  - Yields the trailing residual on EOF when non-empty.
  - Completes silently on EOF when the residual is empty.
  - Handles an empty input stream without yielding anything.
- `process/fake-process-service.test.ts`
  - A scripted argv produces the configured stdout lines and exit code.
  - Multiple `.when(argv).respondWith()` calls for the same argv form a FIFO queue.
  - An unscripted argv throws `FakeProcessService: no scripted response for argv <...>`.
  - Two distinct argvs are served independently (no cross-talk).
  - `kill()` interrupts iteration with an `AbortError` and `wait()` resolves with `exitCode: -1`.
  - stderr scripting works symmetrically with stdout.
- `fs/fake-fs-service.test.ts`
  - Round-trips `writeFile` → `readFile`.
  - `exists` flips from false to true after `writeFile`, and back to false after `remove`.
  - `rename` is atomic: after `rename(tmp, dst)`, `tmp` does not exist and `dst` does.
  - `mkdir({ recursive: true })` creates nested paths; non-recursive fails on missing parents.
  - `glob` matches simple patterns (`**/*.json`, `foo/*.md`) over the fake tree.
  - `readDir`, `stat`, `tempDir` all exercised.
- `clock/fake-clock.test.ts`
  - `now()` reflects the initial value.
  - `advance(ms)` moves the clock forward monotonically.
  - `set(ms)` can move backward (needed for tests that replay state).

### Integration (mocked edges)

- **None in Phase 1 for `process/`** — the only "edge" is the real OS, which is the Integration (real CLI) layer below.
- The fake service tests above already exercise the `ProcessService` interface via its implementations, which satisfies the integration layer's "wire the real type together" goal.

### Integration (real OS)

- `process/bun-process-service.test.ts`
  - `echo hello` on `/bin/sh -c` yields exactly one line `"hello"` and exits with code 0.
  - `sh -c 'printf "a\nb\nc"'` (no trailing newline) yields three lines.
  - `sh -c 'exit 7'` yields no stdout lines and `wait()` resolves with `exitCode: 7`.
  - A missing binary (`spawn({ argv: ['__orch_nonexistent_binary__'], ... })`) throws synchronously.
  - `kill()` on a long-running `sh -c 'sleep 30'` causes `wait()` to resolve quickly with a non-zero exit code.
- `fs/bun-fs-service.test.ts` — round-trip against a real temp dir (created via `BunFsService.tempDir('orch-phase1-')`). Covers `writeFile`, `readFile`, `rename` atomicity, `glob`, `remove`, `stat`.

### E2E

- **None in Phase 1.** No runner exists yet.

## Bun-Specific Implementation Notes (from research)

These findings from the Bun API documentation and best practices research should guide implementation. They are not design changes — they are implementation details that the Phase 1 plan should account for.

### Bun.spawn API surface

- **`Subprocess` implements `AsyncDisposable`** — can use `await using proc = Bun.spawn(...)` for automatic cleanup. Consider making `SpawnHandle` also implement `AsyncDisposable` for consistency.
- **stderr defaults to `"inherit"` in Bun, not `"pipe"`.** Must explicitly set `stderr: "pipe"` in the spawn config to capture it as a stream. This is a silent gotcha — omitting it makes stderr invisible to the line framer.
- **`proc.exited` is a `Promise<number>`** — the canonical way to await process completion. The exit code is the resolved value. No `'exit'` event like Node.js.
- **`proc.signalCode: NodeJS.Signals | null`** and **`proc.killed: boolean`** — available natively on the `Subprocess` object. These can populate the proposed `ExitResult.signal` and `ExitResult.killedByUs` fields without manual tracking.
- **`kill()` accepts signal name (`'SIGTERM'`) or number (`15`).** Matches the proposed `kill(signal?: NodeJS.Signals)` signature.

### Line framer implementation

```ts
async function* frameLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })  // ← { stream: true } is critical

      let idx: number
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).replace(/\r$/, '')
        buffer = buffer.slice(idx + 1)
        yield line
      }
    }

    // Trailing residual
    if (buffer.length > 0) {
      yield buffer.replace(/\r$/, '')
    }
  } finally {
    reader.releaseLock()  // ← prevents file descriptor leaks
  }
}
```

Key details:
- **`TextDecoder` with `{ stream: true }`** — without this flag, multi-byte UTF-8 characters split across chunks produce replacement characters.
- **`reader.releaseLock()` in `finally`** — runs on consumer `break`, `.return()`, or error. Prevents ReadableStream resource leaks.
- **One `TextDecoder` per `frameLines()` call** (i.e., per subprocess stream). Two per spawned process (stdout + stderr). Correct and efficient.

### BunFsService adapter notes

- **`Bun.write(path, data)` auto-creates parent directories** by default (`createPath: true`). This means `writeFile` doesn't need a separate `mkdir -p` step.
- **No built-in `Bun.mkdir` or `Bun.readdir`** — use `import { mkdir, readdir } from 'node:fs/promises'`. These are fully compatible in Bun.
- **`Bun.file(path).exists()`** does a syscall — documented as slower than try/catch. For `FsService.exists()`, this is fine (correctness > speed).
- **`Bun.file(path).stat()`** returns standard `node:fs.Stats` — compatible with Node.js patterns.
- **`Bun.file(path).size`** is unreliable until the file has been read. Use `.stat()` for reliable size.

### Test runner patterns

- **`test.skipIf(condition)` and `describe.skipIf(condition)`** — native Bun test API for conditional skipping:
  ```ts
  const hasClaudeCli = Bun.spawnSync(['which', 'claude']).success
  describe.skipIf(!hasClaudeCli)('ClaudeRunner real integration', () => { ... })
  ```
- **`import.meta.dir`** instead of `__dirname` for ESM modules.
- **All imports from `'bun:test'`** — `describe`, `it`/`test`, `expect`, `beforeAll`, `afterAll`, `beforeEach`, `afterEach`, `mock`, `spyOn`.

### Biome considerations

- **Consider enabling `noFloatingPromises`** (nursery rule) — catches unhandled promises. Subprocess `wait()` calls are easy to forget.
- **`noRestrictedImports` nesting:** `"noRestrictedImports": { "level": "error", "options": { "paths": { ... } } }` — the `options` wrapper is required.
- **Override `includes` uses glob syntax** — `src/services/process/**` recursively matches.

## File/function budget check

- `process-service.ts` — ~40 lines (interface + types only).
- `bun-process-service.ts` — ~90 lines; `spawn()` body ≤ 60 lines.
- `fake-process-service.ts` — ~100 lines.
- `line-framer.ts` — ~40 lines, one exported async generator.
- `fs-service.ts` — ~30 lines (interface only).
- `bun-fs-service.ts` — ~140 lines (ten methods, each ≤ 15 lines).
- `fake-fs-service.ts` — ~180 lines (ten methods against an in-memory tree — glob is the largest at ~30 lines).
- `clock.ts` — ~15 lines.
- `system-clock.ts`, `fake-clock.ts` — ~20 lines each.
- Every test file ≤ 200 lines.

All comfortably under the 300-line per-file / 60-line per-function warnings. `fake-fs-service.ts` is the closest to the ceiling; if glob gets hairier it moves into its own `fake-fs-glob.ts` helper.

## CLAUDE.md rules check

- **Rule 1 (subprocess isolation).** ✅ `Bun.spawn` is referenced once, in `bun-process-service.ts`. Biome `noRestrictedImports` blocks `child_process` and `node-pty` everywhere else. Documented caveat for the `Bun.spawn` global.
- **Rule 2 (runners are adapters).** N/A — no runners in this phase.
- **Rule 3 (mock only at the edge).** ✅ All fakes ARE the edge. No `mock.module` anywhere.
- **Rule 4 (tests read like sentences).** ✅ See the unit test list above.
- **Rule 5 (file/function size).** ✅ See budget.
- **Rule 6 (TypeScript strict).** ✅ No `any`, no `!`. `exitCode` is `number`, `data` uses `unknown` where needed.
- **Rule 7 (single public barrel).** ✅ Every service folder has an `index.ts`; cross-module imports go through it.
- **Rule 8 (no side effects at import).** ✅ All classes are exported; nothing constructs at module load.
- **Rule 9 (branded `Path`).** ✅ `FsService` and `SpawnOptions` both take `Path`. Phase 1 forward-declares the brand locally in a new `src/services/types.ts` (`type Path = string & { readonly __brand: 'Path' }`) with a TODO — Phase 3 relocates it to `src/core/types.ts`, and Phase 1's import in the services barrel switches to the core import with one line changed. This is the same cross-phase pattern Phase 2's brainstorm uses for `Path`.
- **Rule 10 (`bun run check` is the gate).** ✅ Everything in this phase must be green before Phase 2 starts.

#### Research Insights — Testing Strategy

**Testing-strategy skill alignment (Project Skills):**
The brainstorm's test plan aligns well with the three-layer strategy. Key points from the skill:
- `buildTestRun()` helper doesn't exist yet — Phase 1 should start building test helper infrastructure in `tests/helpers/`.
- The `@orch/test/*` path alias is configured in `tsconfig.json` but `tests/helpers/` doesn't exist yet. Create it.
- No `mock.module` anywhere (confirmed compliant).
- No shared `beforeEach` mutating module-level state (confirmed compliant).

**Repo conventions to follow (Repo Analysis):**
- `verbatimModuleSyntax: true` means every type import must use `import type { ... }` syntax.
- `noDefaultExport: "error"` in Biome — all exports must be named.
- `allowImportingTsExtensions: true` — imports should use `.ts` extension.
- `noConsole: "warn"` with exceptions for `console.error` and `console.warn`.
- Auto-formatting hook runs `biome format --write` on every Edit/Write.
- Big-file hook warns at 300 lines, blocks at 600.

**Phase-implementer skill enforcement (Project Skills):**
Commit ordering prescribed: scaffold first (interfaces only, `throw new Error('not implemented')` bodies), then tests (red), then implementations (green). The brainstorm's handoff section mentions this but the plan should expand each deliverable into this ordering.

## Things deliberately NOT in this phase

- `stdin` on `SpawnOptions` (no phase needs it before Phase 16).
- `AbortSignal` on `SpawnOptions` (Phase 11 resume will add it).
- Bytes-level stdout/stderr (no runner emits binary).
- A pre-collected transcript surface on `wait()` (would preclude streaming).
- Any concrete runner.
- ~~The grep-based enforcement script (the Biome rule covers 95%; we'll add grep only if a `Bun.spawn` global leaks through review).~~ **REVERSED by research: ship the grep check in Phase 1.** See Enhancement Summary.
- A runner registry, plugin mechanism, or per-invocation factory shape.
- Phase 3's `StateStore`, run IDs, or anything that consumes `FsService` — those land in Phase 3.

#### Research Insights — Cross-Phase Risks and Future Considerations

**Items to track for later phases (discovered by research):**

| Item | Target Phase | Source |
|---|---|---|
| `MAX_LINE_BYTES` guard on frameLines (10 MB) | Phase 5 | Performance |
| argv validation / executable allowlist | Phase 2 | Security |
| `buildEnv(overrides)` helper for runner authors | Phase 2 | Architecture, Patterns |
| Workspace containment for BunFsService | Phase 2-3 | Security |
| `whenMatching(predicate)` on FakeProcessService | Phase 5 | Agent-Native |
| `ServiceContainer` / `Deps` record type | Phase 4 | Patterns |
| `Clock.delay()` for testable timeouts | Phase 11 | TypeScript |
| Push-based lifecycle events (onExit callback) | Phase 8/13 | Agent-Native |
| stdout timestamp metadata `{ line, timestamp }` | Phase 13 | Patterns |
| Default `wait()` timeout to prevent hung tests | Phase 5 | Patterns |

## Resolved questions

1. **stdout shape?** → `AsyncIterable<string>`, line-framed, single surface only. No bytes, no collected transcript. (See decision 1.)
2. **`spawn(opts)` shape?** → `argv` + `cwd` + `env`; no stdin, no signal. `env` is a full replacement. (See decision 2.)
3. **FakeProcessService matching?** → Keyed by exact-argv equality, FIFO per key. Unscripted argv throws loudly. (See decision 3.)
4. **Spawn failure and line framing edges?** → Throw synchronously on binary-not-found; forgiving framer (strip `\r`, yield trailing partial). (See decision 4.)
5. **How is the boundary enforced?** → Biome `noRestrictedImports` with a `src/services/process/**` override. The `Bun.spawn` global gap is documented and accepted; a grep script lands reactively if needed. (See decision 5.)
6. **How much do `fs/` and `clock/` ship in Phase 1?** → Full interface + real + fake parity with `process/`. `FsService` takes a deliberate YAGNI exception to avoid four future touches. (See decision 6.)
7. **Where does `Path` live in Phase 1?** → Forward-declared in `src/services/types.ts`; Phase 3 relocates it to `src/core/types.ts` and the barrel re-exports it. Same pattern as Phase 2's brainstorm.

## Open questions

_None remaining for Phase 1 — every design decision is locked. New questions discovered during planning land in the plan document, not here._

## Research-Driven Action Items

Prioritized list of changes to incorporate before or during Phase 1 implementation, based on multi-agent research review.

### Must-fix (before implementation starts)

1. **Ship `Bun.spawn` grep enforcement in Phase 1.** Add `scripts/check-spawn-boundary.sh` and wire into `bun run check`. 5 lines, closes the single biggest enforcement gap. _(Architecture, Security, Patterns — unanimous)_

2. **Use `unique symbol` for Path brand.** Replace `string & { readonly __brand: 'Path' }` with `string & { readonly [PathBrand]: true }` using `declare const PathBrand: unique symbol`. Confine `as Path` to a single `toPath()` factory. _(TypeScript)_

3. **Place Path in `src/types.ts`** instead of `src/services/types.ts`. Eliminates Phase 3 migration churn. _(Architecture)_

4. **`frameLines()` must have `try/finally`** that releases the ReadableStream reader on early termination. Prevents file descriptor leaks. _(Performance)_

5. **Add `assertAllConsumed()` to FakeProcessService.** Standard test-double hygiene. _(Patterns, Agent-Native)_

6. **Use 128+signal for kill exit codes** instead of -1. Match real Unix semantics. _(Patterns)_

### Should-fix (during implementation)

7. **Extract `ExitResult` and `FileStat` named types.** Prevent anonymous inline types from proliferating. _(TypeScript)_

8. **Define minimal `ProcessSpawnError`** with `code` discriminant (`'BINARY_NOT_FOUND' | 'CWD_NOT_FOUND' | 'PERMISSION_DENIED' | 'UNKNOWN'`). _(TypeScript, Security, Agent-Native)_

9. **Add `readonly status: 'running' | 'exited' | 'killed'`** to SpawnHandle for agent-native observability. _(Agent-Native)_

10. **Document concurrent stdout/stderr iteration contract** on SpawnHandle interface — consumers must merge or race. _(Architecture, Performance)_

11. **Don't export fakes from production barrels.** Use separate `testing.ts` entry points or keep fakes in `tests/`. _(TypeScript, Security)_

12. **Document `Clock` vs `*Service` naming exception** as intentional. _(Patterns)_

### Nice-to-have (consider during implementation)

13. **FakeClock default to non-zero epoch** (e.g., `1_704_067_200_000`). _(Architecture)_

14. **Add `pendingCount` getter to FakeProcessService.** _(Agent-Native)_

15. **Add `signal` and `killedByUs` to ExitResult.** _(Agent-Native)_

16. **Consider `Symbol.asyncDispose` on SpawnHandle.** _(Patterns)_

### Explicitly deferred (not Phase 1)

- `MAX_LINE_BYTES` guard → Phase 5
- argv validation / executable allowlist → Phase 2
- `buildEnv(overrides)` helper → Phase 2
- Workspace containment for BunFsService → Phase 2-3
- `whenMatching(predicate)` on FakeProcessService → Phase 5
- `ServiceContainer` / `Deps` record → Phase 4
- `Clock.delay()` → Phase 11

## Handoff

- Next step: `/workflows:plan` with this document as input. The plan should expand each deliverable into ordered sub-tasks with tests-first commits (scaffold → tests → implementation → green gate), starting with the `line-framer` (smallest, purest) and ending with the `BunProcessService` integration tests (longest feedback loop).
- Load the `phase-implementer` skill when implementation begins.
- Load the `testing-strategy` skill before writing any of the listed tests.
- Phase 1 unblocks Phase 2, which is already brainstormed at `docs/brainstorms/2026-04-09-phase-2-runner-port-brainstorm.md`.
