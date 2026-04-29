---
title: "feat: Timestamped run ID + path-on-completion"
type: feat
date: 2026-04-29
brainstorm: docs/sessions/timestamped-session-reference/brainstorm.md
---

# feat: Timestamped run ID + path-on-completion

## Context

Two small, paired UX wins for `orch run` / `orch resume`:

1. **Run ID encodes time, not just date.** Today: `r-YYYY-MM-DD-xxxxyy`
   (4 clock-derived + 2 crypto base-36 chars). Going forward:
   `r-YYYY-MM-DD-HHMMSS-xx` — date + local-time `HHMMSS` + 2 crypto chars.
   Example: `r-2026-04-29-143052-7k`. The directory under `.orch/state/` is
   self-explanatory at a glance; collisions inside the same wall-clock second
   are still disambiguated by the 2-char suffix (~1296 slots/sec).
2. **End-of-run prints the run directory path.** Both success and failure
   summaries gain a `data: .orch/state/<runId>/` line so the user can `cd` /
   `tail` into the run without recomputing the path from the ID.

Both decisions, including the rejected alternatives (UTC vs local, soft
backwards-compat vs hard cutover, format-only vs path-only), live in the
[brainstorm](./brainstorm.md). This plan is mechanics only.

**Hard cutover.** `RUN_ID_PATTERN` only matches the new format. Existing
`.orch/state/r-YYYY-MM-DD-xxxxyy` directories become invisible to `orch logs`,
`orch resume`, and `RunRegistry`. User is expected to delete them.

## Acceptance criteria

- [x] `bun run check` is green: lint, typecheck, unit, mocked integration.
- [x] A fresh `orch run hello-file` produces a run dir of the form
  `.orch/state/r-2026-04-29-143052-7k/` (date + 6-digit local time +
  2 base-36 chars).
- [x] On success, stderr ends with:
  ```
  Workflow "hello-file" completed.
    data: .orch/state/r-2026-04-29-143052-7k/
  ```
- [x] On a failing step, stderr ends with:
  ```
  Workflow "hello-file" failed: <reason from mapError>
    data: .orch/state/r-2026-04-29-143052-7k/
  ```
- [x] The same path appendix appears for `orch resume` (success and failure).
- [x] `RUN_ID_PATTERN` rejects every old-format ID (`r-2026-04-29-tvmshp`).
- [x] Two same-second `generateRunId` calls produce distinct IDs (the 2-char
  crypto suffix still does its job).
- [x] No regression in `orch logs <runId>`, `orch resume`, `orch runs`,
  `orch status` for newly created runs.

## Out of scope

- Backwards-compat read of old ID format (hard cutover by decision).
- A `Z`/`L` marker in the ID to disambiguate local vs UTC (deferred, YAGNI).
- Rewriting old state.json files to the new ID format (user deletes
  `.orch/state/`).
- Changing the start-of-run banner — it already prints the ID; no path there.

## Files in scope

### Production

| File | Change |
|---|---|
| `src/state/run-id.ts` | New regex; `generateRunId` builds `HHMMSS` from local time + 2-char crypto suffix |
| `src/observability/null-session-logger.ts:33` | `PLACEHOLDER_RUN_ID` literal updated to new format |
| `src/cli/commands/execute-with-attach.ts` | Replace `onSuccess: () => void` with a `summary` value object (`workflowName`, `runDir`); print success and failure summaries; treat `mapError` returning a `{code, reason}` |
| `src/cli/commands/run.ts:101-175` | Pass `summary: { workflowName, runDir }`; have `mapRunError` return `{code, reason}`; drop the inlined "Workflow X completed." print |
| `src/cli/commands/resume.ts:243-251` | Same shape change as `run.ts`; the success line for resume becomes `Workflow "<name>" completed.` (was `Run <id> completed.`) for consistency |

### Tests (mechanical literal renames)

Every hard-coded `r-2026-XX-XX-{6chars}` literal becomes
`r-2026-XX-XX-{6digits}-{2chars}` (e.g., `r-2026-04-23-phased2` →
`r-2026-04-23-143052-aa`). The grep scope is the union of:

```
tests/helpers/make-step-entry.ts
tests/unit/state/run-id.test.ts
tests/unit/state/run-registry.test.ts
tests/unit/state/state-store.test.ts
tests/unit/state/state-store-v5.test.ts
tests/unit/observability/{file-session-logger,instrument-process-service,readme-template,status-pane}.test.ts
tests/unit/hosts/{plain-host,plain-host-attach-foreground,tmux-host,tmux-host-attach-foreground,failure-text}.test.ts
tests/unit/hosts/plain/per-step-tee.test.ts
tests/unit/core/{failure-summary,workflow,workflow-args,workflow-tmux-guards,workflow-validators,interactive-mode,schema-validation}.test.ts
tests/unit/cli/argv.test.ts
tests/integration/state/{state-store,run-registry}.test.ts
tests/integration/observability/{resume-per-step-folder,session-logger.e2e,session-logger-baseline.integration,session-logger-debug.integration}.test.ts
tests/integration/hosts/{plain-mode,two-pane-mocked,two-pane-interactive,two-pane-failure-and-parallel,two-pane-sequential-runs}.test.ts
tests/integration/hosts/plain/transcript-render-claude.test.ts
tests/integration/cli/{run-resume-cycle,two-pane-auto-attach,two-pane-tty-guard}.test.ts
tests/integration/cli/commands/{logs-old-and-new-runs,resume,runs,status}.test.ts
tests/integration/runners/claude/{claude-e2e-lite,claude-resume,claude-structured-mocked,claude-structured-real}.test.ts
tests/integration/core/{commit-mocked,commit-real,interactive-workflow,parallel-mocked,resume,validators-workflow,view-resolution,workflow}.test.ts
tests/e2e/resume-real-claude.test.ts
```

Total: ~70 test files. A grep-driven find/replace pass covers it. The
`tests/unit/state/run-id.test.ts` file gets bespoke updates (new format
assertions, see Phase 1).

### Tests (new behavioural assertions)

| File | Why |
|---|---|
| `tests/unit/state/run-id.test.ts` | New regex, new format, local-time mapping, two-call distinctness |
| `tests/integration/cli/run-resume-cycle.test.ts` (or new `run-end-of-run-summary.test.ts`) | Asserts the success/failure summary lines including the path appendix |

### Docs

| File | Change |
|---|---|
| `docs/getting-started.md:445,450,530,556,577,601` | Update example IDs in the prose to the new format |
| `docs/logging.md:12` | Update the format reference (`r-YYYY-MM-DD-HHMMSS-xx`) |

(README has no run-ID examples to update.)

## Phase 1 — Run ID format

**Goal:** the new ID format is generated, validated, and accepted everywhere.
No end-of-run output changes yet.

### Production changes

`src/state/run-id.ts`:

```ts
export const RUN_ID_PATTERN = /^r-\d{4}-\d{2}-\d{2}-\d{6}-[a-z0-9]{2}$/

export function generateRunId(deps: { readonly clock: Clock }): RunId {
  const now = deps.clock.now()
  const d = new Date(now)
  const yyyy = String(d.getFullYear())
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  const rand = randomBase36Pair()
  return runId(`r-${yyyy}-${mm}-${dd}-${hh}${mi}${ss}-${rand}`)
}
```

Notes:
- Local time: `getFullYear`/`getMonth`/`getDate`/`getHours`/`getMinutes`/
  `getSeconds`. Today's `getUTC*` is dropped — explicit decision in the
  brainstorm.
- The clock-derived 4-char base-36 prefix is gone. `HHMMSS` already encodes
  the second; if two same-second calls collide, the 2-char crypto suffix
  resolves them.
- Doc comment on `RunId` updated to match: `r-YYYY-MM-DD-HHMMSS-xx where
  HHMMSS is local wall-clock time and xx is 2 cryptographically random
  base-36 chars`.

`src/observability/null-session-logger.ts:33`:

```ts
const PLACEHOLDER_RUN_ID = runIdFactory('r-1970-01-01-000000-00')
```

### Test changes

`tests/unit/state/run-id.test.ts` (rewritten):

- `generateRunId produces r-YYYY-MM-DD-HHMMSS-xx format`.
- `uses clock for date and time portions in local time` — `FakeClock` set to a
  known epoch; assert `id.startsWith('r-2026-04-10-')` AND that the time
  segment matches a deterministic local-time format. To avoid timezone
  flakes, assert via the regex (`/r-\d{4}-\d{2}-\d{2}-\d{6}-[a-z0-9]{2}/`)
  rather than a fixed `HHMMSS` string.
- `derives the time slug from clock.getHours/getMinutes/getSeconds` — set
  `FakeClock` to two different timestamps **a second apart**; assert the
  6-digit time segment differs by 1.
- `two calls within the same second produce distinct IDs` — same epoch, 1000
  draws, expect ≥200 unique (same lower bound rationale as today: 2 base-36
  chars = 1296 slots, birthday paradox bounds).
- `runId() rejects the old 6-char-slug format` (e.g. `r-2026-04-10-ab3z9k`)
  and accepts the new format.

Mass-rename pass across the test files listed in **Files in scope → Tests
(mechanical literal renames)**. The grep:

```
rg -l "r-\\d{4}-\\d{2}-\\d{2}-[a-z0-9]{4,6}" tests/
```

Substitution rule: any `r-YYYY-MM-DD-XXXXXX` becomes
`r-YYYY-MM-DD-HHMMSS-aa` where `HHMMSS` is the previous slug
re-purposed as a deterministic time digit string (e.g.,
`r-2026-04-23-phased2` → `r-2026-04-23-143052-aa`). Concrete values don't
matter; only the regex shape does.

### Definition of Done — Phase 1

- [x] `bun test tests/unit/state/run-id.test.ts` passes against the new
  regex and generator.
- [x] `bun run check` is green (every test fixture parses through the new
  `RUN_ID_PATTERN`).
- [x] `orch run hello-file` creates `.orch/state/r-YYYY-MM-DD-HHMMSS-xx/`
  (smoke verified once locally).
- [x] `orch resume` and `orch logs` work against a fresh new-format run.

## Phase 2 — End-of-run path output

**Goal:** every `orch run` and `orch resume` invocation prints the run
directory path on its last line, regardless of success or failure. Single
seam: `executeWithAttach`.

### Production changes

`src/cli/commands/execute-with-attach.ts`:

Refactor `ExecuteWithAttachOpts`:

```ts
export interface RunSummaryDescriptor {
  readonly workflowName: string
  /** Already-formatted relative path, e.g., '.orch/state/r-...-7k'. */
  readonly runDir: string
}

export interface ExecuteWithAttachOpts {
  readonly host: Host
  readonly workflow: Promise<void>
  readonly runId: string
  readonly stderr: NodeJS.WritableStream
  /** Maps domain errors. Returns the exit code AND a reason string the
   *  failure summary can quote. Returning undefined means re-throw. */
  readonly mapError: (err: unknown) => { code: number; reason: string } | undefined
  readonly summary: RunSummaryDescriptor
  readonly logger?: SessionLogger
}
```

Behavioural changes:

- **Success path** — after `await opts.host.teardown()`, print:
  ```
  Workflow "<workflowName>" completed.
    data: <runDir>/
  ```
- **Mapped-failure path** — `mapError` returned `{code, reason}`. After
  `await opts.host.teardown()`, print:
  ```
  Workflow "<workflowName>" failed: <reason>
    data: <runDir>/
  ```
- **Unmapped-failure path** — `mapError` returned `undefined`. Re-throw
  unchanged (current behaviour). The existing top-level Bun handler prints
  the stack; no path appendix in this case (it would be lost in the stack
  trace anyway and is recoverable from the run-start banner that already
  printed the ID).

Note: the inline detached-attach hint from
`execute-with-attach.ts:80-86` is unaffected; it prints **before** teardown
and is not part of the end-of-run summary.

`src/cli/commands/run.ts`:

```ts
function mapRunError(err: unknown): { code: number; reason: string } | undefined {
  if (err instanceof ViewResolutionError) return { code: EXIT.CONFIG_ERROR, reason: err.message }
  if (err instanceof StepError || err instanceof SchemaValidationError || err instanceof ParallelError) {
    return { code: EXIT.STEP_FAILURE, reason: err.message }
  }
  return undefined
}

// inside runCmd, replace the executeWithAttach call:
const runDir = relativeRunDir(deps.cwd, deps.statePath, runId)
return await executeWithAttach({
  host,
  workflow: result.executor.execute(wfDeps),
  runId,
  stderr: process.stderr,
  mapError: mapRunError,
  summary: { workflowName: name, runDir },
  logger,
})
```

`relativeRunDir` is a small helper local to one of the two command files (or
shared in `cli/commands/relative-run-dir.ts`):

```ts
import { relative } from 'node:path'
export function relativeRunDir(cwd: Path, statePath: Path, runId: string): string {
  return `${relative(cwd, statePath)}/${runId}`
}
```

`src/cli/commands/resume.ts` (parallel change):

- `mapResumeError` returns `{code, reason} | undefined` for all four mapped
  branches (`RunNotFoundError`/`ResumeError`,
  `ViewResolutionError`/`StateCorruptionError`, `StepError`/
  `SchemaValidationError`/`ParallelError`).
- Pass `summary: { workflowName, runDir }`. The success message becomes
  `Workflow "<workflowName>" completed.` (was `Run <id> completed.`) — call
  out in the PR description; the workflow name is already loaded from
  state.json.

### Test changes

`tests/unit/cli/execute-with-attach.test.ts` (new) — covers:

- Calls `summary` formatter on success and writes the two-line success block.
- Calls `summary` formatter on mapped failure and writes the two-line failure
  block including the reason.
- Re-throws when `mapError` returns undefined; **does not** write a failure
  summary in that case.
- Does **not** double-write the reason (prove `mapError` no longer side-
  effects on stderr).

`tests/integration/cli/run-end-of-run-summary.test.ts` (new) — drives a
mocked-edge `runCmd`/`resumeCmd` and asserts:

- Success run produces `Workflow "..." completed.\n  data: .orch/state/r-...-...\n`.
- Failing run (script a `StepError`) produces
  `Workflow "..." failed: <reason>\n  data: .orch/state/r-...-...\n`.
- Path is relative (no leading `/`).

### Definition of Done — Phase 2

- [x] `bun run check` green.
- [x] Integration test asserts both summary lines in success and failure
  flows.
- [x] Manual: `orch run hello-file` shows the success block; intentionally
  failing a step shows the failure block.
- [x] Manual: same checks for `orch resume`.

## Risk + mitigation

| Risk | Likelihood | Mitigation |
|---|---|---|
| Mass-rename misses a literal → one test fails on `RUN_ID_PATTERN` | medium | `bun run check` is the gate; failing test names point straight at the literal |
| Local-time tests flake on CI in a different timezone | low | Assert via regex shape, not exact `HHMMSS`; the few tests that need a specific time use `FakeClock` + tolerate any timezone (regex match) |
| `mapError` refactor leaves duplicate stderr writes | low | Phase 2 unit test asserts no double-write |
| User has an old `.orch/state/` checked out → `orch resume` silently ignores it | accepted | Brainstorm decision: hard cutover. README/getting-started note (one line) added under "Migration" |
| DST fall-back collision (2 IDs at 01:30:42 in same hour) | very low | The 2-char crypto suffix disambiguates. No further action. |

## Migration note (one-liner for getting-started.md)

> **2026-04-29 — Run ID format changed.** Existing runs under
> `.orch/state/r-YYYY-MM-DD-xxxxyy/` are no longer recognised by `orch logs`/
> `orch resume`. Delete the directory if you no longer need them.

## References

- Brainstorm: [`./brainstorm.md`](./brainstorm.md)
- Existing format + generator: [`src/state/run-id.ts`](../../../src/state/run-id.ts)
- The single seam to extend: [`src/cli/commands/execute-with-attach.ts`](../../../src/cli/commands/execute-with-attach.ts)
- Run command: [`src/cli/commands/run.ts:101-175`](../../../src/cli/commands/run.ts)
- Resume command: [`src/cli/commands/resume.ts:243-251`](../../../src/cli/commands/resume.ts)
- Run-id collision history: [`todos/012-done-p2-run-id-collision.md`](../../../todos/012-done-p2-run-id-collision.md) — explains why the entropy bound is `≥200/1000`, not `≥999/1000`.
