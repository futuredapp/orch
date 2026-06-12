# Plan 005: Test coverage for the transcript sidecar and the workflow-loading CLI seam

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 832a56d..HEAD -- src/state/transcript-sidecar.ts src/cli/commands/load-workflow.ts src/cli/commands/dry-run.ts tests/unit/state tests/integration/cli/commands`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `832a56d`, 2026-06-11

## Why this matters

Two critical seams are under-tested:

1. `src/state/transcript-sidecar.ts` persists every runner event to per-step
   NDJSON files, with three subtle contracts — truncate-on-first-write (so a
   resumed step's folder shows only the latest attempt), a per-step serial
   append chain (so concurrent event callbacks never interleave lines), and
   reject-the-caller-but-don't-poison-the-chain error handling. Its only
   current coverage is one integration test
   (`tests/integration/observability/resume-per-step-folder.test.ts`)
   asserting the resume-truncation outcome. A regression in chain ordering or
   error handling would surface only on long real runs with recovery —
   the costliest possible place.
2. `src/cli/commands/load-workflow.ts` gates every `orch run` / `resume` /
   `dry-run` invocation (config load → workflow resolution → dynamic import →
   default-export shape check), and `dry-run.ts` is its thinnest consumer.
   Neither has a dedicated test; only indirect coverage exists via
   `tests/integration/cli/main-dispatch.test.ts` and `run-builtin.test.ts`.

## Current state

### `src/state/transcript-sidecar.ts` (130 lines, read in full before starting)

Key excerpts:

```typescript
// src/state/transcript-sidecar.ts:80-91
      const sanitized = sanitizeStepName(stepName)
      const relativePath = `logs/agents/${sanitized}/events.ndjson`
      const filePath = path(`${runDir}/${relativePath}`)
      let count = 0
      // Truncate on the first write of this process so a resumed step's
      // folder reflects only the latest attempt ...
      let truncated = false
      // Per-step serial append chain prevents two concurrent RunnerEvent
      // callbacks from interleaving lines in the sidecar file.
      let chain: Promise<void> = Promise.resolve()
```

```typescript
// src/state/transcript-sidecar.ts:94-108
        async append(event: unknown): Promise<void> {
          const line = `${JSON.stringify(event)}\n`
          const next = chain.then(async () => {
            await ensureStepDir(sanitized)
            if (!truncated) {
              truncated = true
              await deps.fs.writeFile(filePath, '')
            }
            await deps.fs.appendFile(filePath, line)
            count += 1
          })
          // Swallow on the chain so a failing write doesn't poison later
          // appends. The awaited promise still rejects for the caller.
          chain = next.catch(() => {})
          await next
        },
```

```typescript
// src/state/transcript-sidecar.ts:127-129
function sanitizeStepName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_')
}
```

Factory signature: `createTranscriptSidecar({ fs: FsService, runId: RunId, basePath: Path })`;
files land at `<basePath>/<runId>/logs/agents/<sanitized>/events.ndjson`.
`forStep` caches handles per step name. `snapshot()` returns
`{ transcriptPath: relativePath, transcriptEventCount: count }`.

Supporting types: `RunId` comes from `src/state/run-id.ts` (smart constructor
`runId(...)` — check its exported helpers; existing state tests construct one,
see `tests/unit/state/state-store.test.ts` for the pattern). `Path` comes from
`src/services/types.ts` via `path('...')`. `FakeFsService` lives at
`src/services/fs/fake-fs-service.ts` — an in-memory `FsService` whose
`writeFile`/`appendFile` throw `ENOENT` when the parent dir is missing and
which exposes `readFile`/`exists` for assertions.

### `src/cli/commands/load-workflow.ts` (110 lines, read in full)

Return type is a union: `LoadResult { executor, config }` or
`LoadError { code }`, discriminated by the exported `isLoadError`. Error
branches all return `{ code: EXIT.CONFIG_ERROR }` (= 2, from
`src/cli/main.ts` `EXIT` table) and write a message to `process.stderr`
unless `opts.quiet === true`:

- config load failure (`ConfigLoadError` from `loadConfig`)
- workflow name resolution failure (unknown name)
- dynamic import failure ("Cannot load workflow at <path>: …")
- default export not a `WorkflowExecutor`
  ("…must export a default WorkflowExecutor (use workflow())")

The executor-shape check is structural:
`'execute' in v && 'resume' in v && bodyHandle in v` (`bodyHandle` is a
symbol imported from `src/core/workflow.ts`).

### `src/cli/commands/dry-run.ts` (48 lines, read in full)

`dryRunCmd(deps, name, args, opts)`: empty `name` → usage line to stderr +
`EXIT.CONFIG_ERROR`; load error → its code; success → prints
`Dry-run: "<name>"`, `Workflow "<executor.name>" loaded successfully.`, and a
whitespace-normalized prompt preview truncated to 80 chars with a trailing
`…`.

### Existing test exemplars (match their structure)

- Unit + FakeFsService pattern: `tests/unit/state/state-store.test.ts`.
- CLI integration pattern (temp cwd, real config file on disk):
  `tests/integration/cli/commands/runs.test.ts` and
  `tests/integration/cli/commands/init.test.ts` — read one fully and copy its
  setup/teardown idioms (temp dir creation, cwd handling, stderr capture).
- Repo rules: full-sentence test names; AAA with blank lines; mock only
  `*Service` ports (`mock.module` is BANNED for `src/core`, `src/state`,
  `src/validators`, `src/runners` tests); never bare `bun test`.

**Known pitfall (from prior sessions in this repo)**: workflow-loading
integration tests are cwd-sensitive — some prompt-file machinery caches
`process.cwd()`. Pass explicit `cwd` arguments (the `loadWorkflow(cwd, …)`
parameter) rather than `process.chdir`, and keep each test's files inside its
own `fs.mkdtemp` directory.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| New sidecar tests | `bun test tests/unit/state/transcript-sidecar.test.ts` | all pass |
| New CLI tests | `bun test tests/integration/cli/commands/load-workflow.test.ts tests/integration/cli/commands/dry-run.test.ts` | all pass |
| Unit tier | `bun run test:unit` | all pass |
| Integration CLI tier | `bun test --max-concurrency=4 tests/integration/cli` | all pass |
| Lint / typecheck | `bun run lint && bun run typecheck` | exit 0 |

## Scope

**In scope** (create only — no production code changes):
- `tests/unit/state/transcript-sidecar.test.ts`
- `tests/integration/cli/commands/load-workflow.test.ts`
- `tests/integration/cli/commands/dry-run.test.ts`

**Out of scope** (do NOT touch):
- `src/state/transcript-sidecar.ts`, `src/cli/commands/load-workflow.ts`,
  `src/cli/commands/dry-run.ts` — if a test exposes a real bug, STOP and
  report; don't fix production code under a test-coverage plan.
- `tests/integration/observability/resume-per-step-folder.test.ts` — the
  existing integration test stays untouched.
- `src/services/fs/fake-fs-service.ts` — if you need failure injection,
  subclass it inside your test file (it's the sanctioned edge fake; an
  in-test subclass keeps the mock at the edge per CLAUDE.md rule 3).

## Steps

### Step 1: `tests/unit/state/transcript-sidecar.test.ts`

Use `FakeFsService` (+ `path()`, a `RunId`). Cases:

1. **Truncates on first append**: pre-seed the fake fs with stale content at
   `<basePath>/<runId>/logs/agents/<step>/events.ndjson` (mkdir the parents
   first via the fake's `mkdir`), then `append({a: 1})`; `readFile` shows ONLY
   the new line.
2. **Appends accumulate in order**: three appends → file content is the three
   JSON lines, newline-terminated, in call order; `snapshot()` count is 3.
3. **Serial chain under concurrency**: fire `Promise.all([append(e1), append(e2), append(e3)])`
   without awaiting in between; assert the file holds exactly three complete
   lines (no interleaving — with the in-memory fake this asserts ordering of
   the chain, which is the contract).
4. **A failing write rejects the caller but does not poison later appends**:
   subclass FakeFsService in-test so the FIRST `appendFile` call rejects, the
   rest delegate to `super`. Assert: first `append` rejects, count stays 0;
   second `append` resolves and the file contains only the second event;
   count is 1.
5. **`snapshot()` returns the relative path** `logs/agents/<step>/events.ndjson`
   (relative — must NOT start with the basePath) and the running count.
6. **Step-name sanitization**: `forStep('review: src/foo.ts')` writes under
   `logs/agents/review__src_foo_ts/events.ndjson` (every char outside
   `[a-zA-Z0-9_-]` becomes `_` — compute the expected name by applying the
   rule, then assert `exists()` on the full path).
7. **Handle caching**: two `forStep('x')` calls return the same handle
   (`toBe`), and counts continue across them.

**Verify**: `bun test tests/unit/state/transcript-sidecar.test.ts` → 7+ pass.

### Step 2: `tests/integration/cli/commands/load-workflow.test.ts`

Model setup on an existing test in the same folder (read
`tests/integration/cli/commands/runs.test.ts` first). Each test gets its own
temp dir with a real `.orch/orch.config.ts` (copy the shape from
`orch.config.ts` at the repo root or from what `orch init` scaffolds — see
`tests/integration/cli/commands/init.test.ts`). Cases:

1. **No config anywhere** → result satisfies `isLoadError`, `code === 2`, and
   stderr received a message (capture by temporarily swapping
   `process.stderr.write`, restoring in `finally` — or reuse the capture
   idiom from the exemplar test if one exists).
2. **`quiet: true` suppresses stderr** for the same failure.
3. **Unknown workflow name** (config exists, name not in `workflows` map) →
   load error, stderr names the problem.
4. **Default export is not an executor** (workflow file exporting
   `export default { execute() {} }` — missing `resume` and the `bodyHandle`
   symbol) → load error, stderr contains
   `must export a default WorkflowExecutor`.
5. **Happy path**: a minimal real workflow file built with the public
   `workflow()` factory (import from the repo's `src/index.ts`; follow how
   `examples/` or an existing integration test constructs a trivial workflow)
   → `isLoadError(result)` is false; `result.executor.name` matches; config
   is returned.

**Verify**: `bun test tests/integration/cli/commands/load-workflow.test.ts`
→ all pass.

### Step 3: `tests/integration/cli/commands/dry-run.test.ts`

Reuse Step 2's temp-dir + workflow fixture helpers (extract a small local
helper inside the test file or duplicate — do NOT create shared support infra
for two files). Cases:

1. Empty name → returns `EXIT.CONFIG_ERROR` (2) and stderr starts with
   `Usage: orch dry-run`.
2. Load failure propagates the loader's code (2).
3. Happy path → returns 0; stdout contains `Dry-run: "<name>"` and
   `loaded successfully`.
4. Prompt preview: pass a prompt longer than 80 chars containing newlines and
   runs of spaces → stdout's `Prompt:` line is whitespace-normalized,
   ≤ 80 chars, and ends with `…`.

**Verify**: `bun test tests/integration/cli/commands/dry-run.test.ts` → all
pass.

### Step 4: Run the tiers

**Verify**: `bun run test:unit` → pass;
`bun test --max-concurrency=4 tests/integration/cli` → pass;
`bun run lint && bun run typecheck` → exit 0.

## Test plan

This plan IS the test plan (Steps 1–3). Structural patterns:
`tests/unit/state/state-store.test.ts` (unit + FakeFsService),
`tests/integration/cli/commands/runs.test.ts` (CLI integration).

## Done criteria

- [ ] Three new test files exist at the in-scope paths; ≥16 tests total
- [ ] `bun run test:unit` exits 0
- [ ] `bun test --max-concurrency=4 tests/integration/cli` exits 0
- [ ] `bun run lint` and `bun run typecheck` exit 0
- [ ] No production source files modified (`git status` shows only the three
      new test files)
- [ ] No `mock.module` anywhere in the new files
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- A test per this case list FAILS against current production code — that is a
  real bug discovery (e.g. the serial chain interleaves, or truncation
  doesn't happen). Report the failing case + observed behavior; do not change
  production code.
- `RunId` cannot be constructed in a unit test without filesystem side
  effects (check `src/state/run-id.ts` and how `state-store.test.ts` does
  it) — if it genuinely can't, report rather than weakening the branded type
  with a cast.
- The dynamic-import happy path (Step 2 case 5) fails because Bun can't
  import a workflow that imports from the repo's `src/index.ts` inside a temp
  dir — try an absolute import path in the generated workflow file first; if
  it still fails, STOP and report the import-resolution constraint.

## Maintenance notes

- If the sidecar ever adds rotation or size caps, cases 1–3 are the
  regression net; extend rather than rewrite.
- Reviewer should scrutinize: stderr capture must always restore the original
  writer in `finally` (a leaked stub poisons unrelated tests in the same
  process).
- Deferred from the audit: scenario-level recovery tests
  (`noRetry` vs `backoffResume` policy swap through a full run) — judged
  lower-leverage than these two seams; revisit after this lands.
