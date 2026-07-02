# Plan 008: Make `orch status` show per-step outcome and the failure reason

> **Executor instructions**: Follow this plan step by step. Run every
> verification command. If a STOP condition occurs, stop and report — do not
> improvise. When done, update the status row for plan 008 in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 0265592..HEAD -- src/cli/commands/status.ts src/core/workflow.ts src/state/state-store.ts`
> If any changed, compare the "Current state" excerpts against the live code
> before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none (complements 007)
- **Category**: bug / debugging
- **Planned at**: commit `0265592`, 2026-07-02

## Why this matters

`orch status <failed-id>` prints `✗ failed` at the top, then lists every step with
a hardcoded green `✓` and **never names the step that failed or why**. It is the
first command a user runs to answer "why did run X fail?", and today it actively
misleads (all-green step list) and forces the user to abandon the CLI and hand-grep
log files. This plan makes `status` name the failing step and point at (or print)
the reason.

## Current state

- `src/cli/commands/status.ts` — the whole `orch status` command. The misleading
  loop is at `status.ts:75-79`:

  ```ts
  process.stdout.write(`Steps:    ${stepEntries.length}\n\n`)
  for (const s of stepEntries) {
    const dur = s.endedAt - s.startedAt
    process.stdout.write(`  ${GLYPH.completed} ${s.name.padEnd(30)} ${dur}ms\n`)
  }
  ```

  Every step gets `GLYPH.completed` unconditionally.

- **Why the reason isn't already here**: on failure, the workflow executor's catch
  only calls `setStatus(runId, 'failed'|'crashed', ...)` — it does **not** `saveStep`
  the failing step (`src/core/workflow.ts:1588-1592` comment: "executeWorkflowFn's
  catch only sets the run status, never saveStep"). `StepEntry`
  (`src/state/state-store.ts:7-57`) has **no** `status` or `error` field. So
  `state.steps` contains only the steps that *succeeded*; the failing step and its
  reason are not in `state.json` in the general case.

- **Where the failure IS recorded**: the executor emits a `step:failed` lifecycle
  event to `<runDir>/logs/lifecycle.ndjson`. Its type
  (`src/core/workflow.ts:211-217`):

  ```ts
  | {
      readonly type: 'step:failed'
      readonly stepName: StepName
      readonly error: unknown
      readonly subPath?: readonly string[]
      readonly insideParallel?: true
    }
  ```

  The existing consumer is `src/observability/status-loop.ts:174`, and
  `src/observability/readme-template.ts:59` documents
  `grep '"type":"step:failed"' logs/lifecycle.ndjson` as the manual way to find it.
  A partial `StepEntry` carrying a `recoveryLog` IS persisted for recovery
  give-ups (`persistRecoveryFailure`, gated on `recoveryLog.length > 0` at
  `workflow.ts:1592`), but not for fast-fail (that gap is plan 010).

- The run directory for a runId is available via the state store / deps. `statusCmd`
  already resolves the runId by prefix (`status.ts:32`) and loads `RunState`
  (`status.ts:48`). Look at how `src/cli/commands/logs.ts` derives the run's
  `logs/` directory from a runId (search `logs.ts` for `runDir` / `logs/`) and
  reuse the same derivation.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Typecheck | `bun run typecheck` | exit 0 |
| Targeted test | `bun test tests/integration/cli/commands/status.test.ts` | all pass |
| Full gate | `bun run check` | exit 0 |

## Scope

**In scope:**
- `src/cli/commands/status.ts`
- `tests/integration/cli/commands/status.test.ts` (add cases)
- A small read helper if needed — keep it inside `status.ts` unless an existing
  helper (in `src/cli/commands/`) already reads `lifecycle.ndjson`, in which case
  reuse it.

**Out of scope (do NOT touch):**
- `src/core/workflow.ts` failure-persistence path — that is plans 009/010.
- `StepEntry` shape in `src/state/state-store.ts` — do not add fields.
- The glyph set in `src/cli/format.ts`.

## Steps

### Step 1: Confirm the run-dir + lifecycle-read approach

Read `src/cli/commands/logs.ts` to see how it maps a runId to `<runDir>` and reads
per-run files. Confirm there is a way to read `<runDir>/logs/lifecycle.ndjson`
using `deps` (the CLI deps object — it exposes fs and state paths). If no clean
read path exists, STOP and report (do not invent a new fs seam).

### Step 2: Stop the misleading unconditional `✓`

In `status.ts:75-79`, keep listing the persisted (completed) steps, but only render
them as completed when the run itself did not fail. Concretely: the per-step glyph
should stay `GLYPH.completed` for entries in `state.steps` (they genuinely
completed), but the loop must no longer be the *only* thing printed for a failed
run — Step 3 adds the failure section. Do not fabricate a per-step failed glyph for
steps that aren't in `state.steps` (the failing step isn't there).

### Step 3: Print a Failure section for failed/crashed runs

After the step list, when `state.status === 'failed' || state.status === 'crashed'`:

1. Read `<runDir>/logs/lifecycle.ndjson` if it exists. Parse it line-by-line as
   NDJSON (one JSON object per line; ignore blank/unparseable lines). Find the
   **last** record with `type === 'step:failed'`.
2. If found, print:
   ```
   Failed step: <record.stepName>
   Reason:      <best-effort message>
   ```
   For `<best-effort message>`: the `error` field may serialize to `{}` (Error
   objects don't JSON-serialize their message). Extract a message defensively —
   if `error` is a string use it; if it's an object with a string `message` use
   that; otherwise print `(see transcript)`.
3. Always print a pointer line so the deeper trail is one copy-paste away:
   ```
   Details:     orch logs <id> --step <failed-step-name>
                <runDir>/logs/lifecycle.ndjson
   ```
   (Use the resolved full runId and runDir.)
4. If `lifecycle.ndjson` is absent or has no `step:failed` record, still print the
   `Details:` pointer with the `logs/` directory, and a line
   `Failed step: (unknown — see logs)`.

Keep the run-level `Status:  ✗ failed` line that already exists at `status.ts:64`.

### Step 4: Tests

**Verify each step**: `bun run typecheck` → exit 0 after Steps 2–3.

## Test plan

Add to `tests/integration/cli/commands/status.test.ts` (mirror its existing
arrange/act/assert and how it seeds a run via the state store + a temp run dir):

- **Failed run with a `step:failed` record**: seed a run whose `state.json` status
  is `failed` with one completed step, and write a `logs/lifecycle.ndjson`
  containing a `{"type":"step:failed","stepName":"build",...}` line. Assert the
  output contains `Failed step: build` and the `Details:` pointer.
- **Failed run with no lifecycle log**: status `failed`, no `logs/` dir. Assert the
  output contains `Failed step: (unknown — see logs)` and the `Details:` pointer,
  and does not throw.
- **Completed run (regression)**: an all-completed run prints the step list with
  `✓` and **no** Failure section.

Structural pattern to copy: the existing status tests in the same file (they
already build a `RunState` and call `statusCmd`). If they use a fake fs / temp
dir helper, reuse it to write the `lifecycle.ndjson` fixture.

Verification: `bun test tests/integration/cli/commands/status.test.ts` → all pass,
3 new/updated cases.

## Done criteria

ALL must hold:

- [ ] `bun run typecheck` exits 0.
- [ ] `orch status` on a `failed` run prints a `Failed step:` line and a `Details:`
      pointer (covered by the new tests).
- [ ] A completed run still prints its step list with `✓` and no Failure section.
- [ ] `bun test tests/integration/cli/commands/status.test.ts` passes with the new
      cases.
- [ ] `bun run check` exits 0.
- [ ] Only in-scope files modified (`git status`).
- [ ] `plans/README.md` row 008 updated.

## STOP conditions

Stop and report if:

- There is no `deps`-based way to read `<runDir>/logs/lifecycle.ndjson` without
  adding a new filesystem seam.
- The `step:failed` NDJSON record does not contain a usable `stepName` string
  (drift from the excerpt in "Current state") — that would mean the log format
  changed.
- You find that the failure reason is genuinely unavailable from both `state.json`
  and `lifecycle.ndjson` — report it; plans 009/010 (which persist the reason)
  should then land first.

## Maintenance notes

- Once plan 010 lands (fast-fail classifications persisted with an `errorClass`),
  `status` can prefer that structured field over the best-effort `error` parse —
  leave a `// TODO: prefer persisted errorClass once plan 010 lands` comment near
  the reason extraction.
- Reviewer: confirm the NDJSON parse tolerates partial/truncated final lines (a
  run killed mid-write) and never throws on a malformed line.
