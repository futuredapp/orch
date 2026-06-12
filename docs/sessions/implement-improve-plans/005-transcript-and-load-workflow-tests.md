# Plan 005 — transcript sidecar + load-workflow/dry-run test coverage

**Status: DONE.** All Done criteria met. No production code changed; no STOP
condition fired.

## What was done

Created three new test files (test-only; zero production source changes):

1. `tests/unit/state/transcript-sidecar.test.ts` — **7 tests**. Covers all 7
   plan cases: truncate-on-first-append (pre-seeded stale content via the
   fake's `mkdir`+`writeFile`), ordered accumulation + count, serial chain
   under `Promise.all`, failing-write-rejects-caller-but-chain-survives,
   relative `snapshot()` path, step-name sanitization, handle caching (`toBe`).
   Failure injection is an **in-test `FailFirstAppendFsService extends
   FakeFsService`** (first `appendFile` rejects, rest delegate to `super`) —
   keeps the mock at the fs edge per CLAUDE.md rule 3; `fake-fs-service.ts`
   untouched.
2. `tests/integration/cli/commands/load-workflow.test.ts` — **5 tests**: no
   config, `quiet` suppresses stderr, unknown name, default-export-not-an-
   executor, happy path via the public `workflow()` factory.
3. `tests/integration/cli/commands/dry-run.test.ts` — **4 tests**: empty-name
   usage error, load-failure code propagation, happy-path stdout, ≤80-char
   whitespace-normalized `…`-suffixed prompt preview.

**Total: 16 new tests** (meets the ≥16 Done criterion exactly).

## Drift check

`git diff --stat 832a56d..HEAD -- src/state/transcript-sidecar.ts
src/cli/commands/load-workflow.ts src/cli/commands/dry-run.ts tests/unit/state
tests/integration/cli/commands` → **empty (no drift)**. Read all three
production files in full; every "Current state" excerpt matches live code
(truncate-on-first-write + per-step serial append chain + reject-but-don't-
poison at `transcript-sidecar.ts:80-108`; `LoadResult`/`LoadError` union +
`isLoadError` + structural `isExecutorShape`; `dryRunCmd` output shape +
`formatPromptPreview` 80-char/`…` rule).

## Implementation notes for the next worker / critic

- **`RunId` constructs with no filesystem side effects** — `runId(s)` (`src/
  state/run-id.ts:13`) is a pure regex-validating smart constructor, same as
  `state-store.test.ts` uses. STOP condition not triggered.
- **Temp-dir workflow import resolution** — a temp-dir workflow file cannot
  `import { workflow } from 'orch'` (not resolvable from `/tmp`). Resolved per
  the plan's guidance by importing the **absolute** `src/index.ts` path
  (`nodePath.resolve(import.meta.dir, '../../../../src/index.ts')`). Works
  cleanly — Bun resolves the barrel's transitive `zod`/relative imports against
  the repo. The temp-dir `.orch/orch.config.ts` exports a **plain object**
  (`export const config = { workflows: {…} }`, no `defineConfig`/`orch` import)
  so it too imports cleanly from `/tmp`; the schema only needs
  `workflows: Record<string,string>`. STOP condition not triggered.
- **cwd handling** — honored the known pitfall: every test passes an explicit
  `cwd` (`loadWorkflow(path(dir), …)` / `makeDeps(dir).cwd`); **no
  `process.chdir`** anywhere.
- **stderr/stdout capture always restored in `finally`** — both files monkey-
  patch `process.stderr.write` / `process.stdout.write` and restore the
  original in a `finally`, so no leaked stub can poison sibling tests.
- Each test uses its own `fs.mkdtemp` dir, cleaned in `afterEach` (unique paths
  also dodge Bun's dynamic-import module cache).

## Verification commands (each run, with outcome)

| Command | Outcome |
|---|---|
| `bun test tests/unit/state/transcript-sidecar.test.ts` | **7 pass, 0 fail** |
| `bun test tests/integration/cli/commands/load-workflow.test.ts tests/integration/cli/commands/dry-run.test.ts` | **9 pass, 0 fail** |
| `bun run test:unit` | **1831 pass, 0 fail** |
| `bun test --max-concurrency=4 tests/integration/cli` | **136 pass, 0 fail** |
| `bun run lint` | **exit 0** (biome: 712 files, no fixes) |
| `bun run typecheck` | **exit 0** (tsc --noEmit clean) |
| `git status --porcelain` | only the 3 new test files `??` |
| `grep mock.module <3 files>` | none found |

(The integration-CLI run prints diagnostic stderr from pre-existing resume
tests — those are expected outputs of those tests, not failures; 0 fail.)

## Done criteria checklist

- [x] Three new test files exist at the in-scope paths; ≥16 tests total (16)
- [x] `bun run test:unit` exits 0
- [x] `bun test --max-concurrency=4 tests/integration/cli` exits 0
- [x] `bun run lint` and `bun run typecheck` exit 0
- [x] No production source files modified (`git status` shows only the three
      new test files)
- [x] No `mock.module` anywhere in the new files
- [x] `plans/README.md` status row updated (005 → DONE)

## STOP conditions

None fired. No test failed against current production code — the three subtle
sidecar contracts (truncation, serial ordering, reject-but-don't-poison) all
held, so no bug was discovered. `RunId` constructed without fs side effects;
temp-dir workflow imported successfully via the absolute `src/index.ts` path.
