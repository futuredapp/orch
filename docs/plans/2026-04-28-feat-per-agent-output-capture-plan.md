---
title: Per-agent output capture — record raw + formatted streams per step
type: feat
status: completed
date: 2026-04-28
---

# Per-agent output capture

## Overview

Consolidate everything we know about one autonomous step's run into a
single self-describing folder under `.orch/state/<runId>/logs/agents/<stepName>/`.
Persist four signals side-by-side, always-on (no `--debug` flag):

- `session.json` — landing page (relocated from `logs/agents/<step>.session.json`).
- `events.ndjson` — parsed `RunnerEvent[]` (relocated from `steps/<step>.transcript.ndjson`).
- `raw_output.ndjson` — subprocess stdout, line-buffered (was `--debug`-only).
- `raw_stderr.log` — subprocess stderr (was `--debug`-only).
- `formatted_output.ansi` — verbatim bytes the host wrote to its sink (NEW).
- `formatted_output.txt` — same lines, ANSI-stripped (NEW).

After this lands, "show me everything about this step" is one folder, one
`ls`. Parser misses (lines that exist in `raw_output.ndjson` but not in
`events.ndjson`) become trivially diff-able. The host's behaviour becomes
post-hoc testable against the renderer.

In scope: autonomous Claude/Codex/Fake steps. Out of scope: interactive
steps (the folder exists but contains only `session.json` — tmux owns the
PTY, orch never sees the bytes), per-step `README.md` (deferred), the
brainstorm's `branches/<branchId>/` nesting (deferred — see
[Resolved questions § 1](#resolved-questions)).

Reference: brainstorm at
[`docs/brainstorms/2026-04-28-per-agent-output-capture-brainstorm.md`](../brainstorms/2026-04-28-per-agent-output-capture-brainstorm.md)
(approved, ready-for-planning).

## Problem statement

After a run finishes, the user has no canonical place to inspect what an
agent did. Today's layout fragments the per-step record across three
directories and gates the most useful signal (raw subprocess bytes) behind
a `--debug` flag the user is unlikely to remember to set:

```
.orch/state/r-2026-04-28-oxo618/
  state.json
  steps/solve-riddle.transcript.ndjson           ← parsed events live here
  logs/
    spawns.ndjson, events.ndjson, ...            ← cross-step streams
    agents/solve-riddle.session.json             ← landing page lives here
    (debug only) agents/solve-riddle.stdout      ← raw bytes live here, sometimes
```

Four concrete pain points:

1. **No persisted "what we displayed".** The bytes that flow into
   `tmux send-keys` for the right pane are produced by `renderTranscriptLine()`
   inside the host and immediately discarded. There is nothing on disk to
   verify "did we render the riddle answer correctly?" without re-running.

2. **Raw stdout/stderr is `--debug`-only.** `agents/<step>.stdout`/`.stderr`
   exist only when `ORCH_DEBUG=1` was set on the run
   ([`src/observability/file-session-logger.ts:153-177`](../../src/observability/file-session-logger.ts)).
   Most runs don't set it; users who hit a parser miss have nothing to grep.

3. **Per-step files are scattered across three directories.** No single
   folder you can `cd` into to see *this agent's* run.

4. **Parser misses are invisible.** `events.ndjson` only shows what
   `parseEvents` accepted; without raw stdout side-by-side, you can't tell
   whether an event was malformed, dropped, or never emitted by the runner.

## Proposed solution

Introduce a per-step folder under `logs/agents/<stepName>/` and relocate
existing per-step files into it. Always-on. No `--debug` requirement.

### Target layout (after this change)

For an autonomous step:

```
logs/agents/solve-riddle/
  session.json            ← was logs/agents/solve-riddle.session.json
  events.ndjson           ← was steps/solve-riddle.transcript.ndjson
  raw_output.ndjson       ← NEW (was --debug `agents/solve-riddle.stdout`)
  raw_stderr.log          ← NEW (was --debug `agents/solve-riddle.stderr`)
  formatted_output.ansi   ← NEW
  formatted_output.txt    ← NEW
```

For an interactive step:

```
logs/agents/install-deps/
  session.json            ← landing page only; tmux owns the PTY
```

For a parallel-fan-out step (today's behaviour — flat, since `parallel()`
does not introduce a parent step name; see
[Resolved questions § 1](#resolved-questions) for the deferral):

```
logs/agents/review-security/         ← branch's own top-level step
logs/agents/review-performance/      ← branch's own top-level step
logs/agents/review-design/           ← branch's own top-level step
```

### Cross-step files unchanged

The cross-run NDJSON streams (`spawns.ndjson`, `events.ndjson`,
`lifecycle.ndjson`, `timeline.ndjson`, `subprocesses.ndjson`, `orch.ndjson`,
`run.meta.json`, run-level `README.md`) keep their current shape and
location. Only the per-step files move.

### `--debug` policy unchanged for everything else

The new files are always-on. The existing `--debug` captures
(`tmux/<paneId>.log`, `subprocesses.ndjson`, `orch.ndjson`) stay gated. The
old per-step `agents/<step>.stdout`/`.stderr` debug files are **removed** —
the new always-on `raw_output.ndjson` + `raw_stderr.log` supersede them
inside the per-step folder.

## Why this approach

1. **One folder = one step run.** Matches the user's debugging mental
   model. Today three directories; after this, one. Same shape every
   observability primitive in this project converges on (`logs/<runId>/...`).

2. **Raw + parsed side-by-side surfaces parser misses.** A line in
   `raw_output.ndjson` with no counterpart in `events.ndjson` is exactly
   the parser-miss signal `docs/logging.md` calls out — we just stop hiding
   it behind `--debug`. This is the lesson from the autonomous-transcript
   bug ([`docs/solutions/autonomous-transcript-rendering.md`](../solutions/autonomous-transcript-rendering.md)):
   hosts that hardcoded one runner's NDJSON shape silently lost data, and
   we only noticed by re-running with `--debug` on.

3. **`formatted_output.*` makes host behaviour testable post-hoc.** Today
   we test `renderTranscriptLine()` in isolation. We have no way to verify,
   after a real run, that the host did what the renderer said. Persisting
   the verbatim bytes the host emitted lets a future check be:
   "diff what the host wrote against what the renderer would produce from
   `events.ndjson`".

4. **Always-on matches the user's stated intent.** They asked for "as much
   info as possible to verify and debug without re-running". The
   baseline-files philosophy in `docs/logging.md` (no rotation, no caps,
   append-only NDJSON) already accepts this cost for the streams we keep.

5. **Interactive black-box is honest.** We don't have stdout for
   interactive runs (tmux owns the pty). Faking it via per-step pipe-pane
   would produce a noisy redrawn TUI capture worse than nothing — and we
   already have `--debug` `tmux/<paneId>.log` for the rare case anyone
   needs that.

## Technical approach

### Architecture

**Three writers feed one folder.** Each on its own serial chain — no
inter-writer ordering needed:

| Writer | Source file | Sink |
|---|---|---|
| `transcriptSidecar` (relocated) | `src/state/transcript-sidecar.ts` | `events.ndjson` |
| `openRawCapture` (gate dropped) | `src/core/workflow.ts:566` | `raw_output.ndjson`, `raw_stderr.log` |
| host-side render tee (NEW) | `src/hosts/plain/plain-host.ts:74`, `src/hosts/two-pane/tmux-host.ts:321` | `formatted_output.ansi`, `formatted_output.txt` |
| `writeAgentSession` (relocated) | `src/core/workflow.ts:790` | `session.json` |

**`SessionLogger` port grows one method.** Today `rawSink(rel)` is
documented as `--debug` only and returns `null` when `!debug`. We add a
new always-on sibling — call it `streamSink(rel)` — that returns a
`RawSink` regardless of `debug`. The existing `rawSink` keeps its
`--debug` semantics for `tmux/<paneId>.log`. This preserves the existing
contract instead of relaxing it.

```ts
// src/observability/session-logger.ts
export interface SessionLogger {
  // ... existing methods ...
  /** Always-on byte sink. Used for the per-step folder's raw_output.ndjson,
   *  raw_stderr.log, formatted_output.ansi, formatted_output.txt.
   *  Returns a RawSink even when `!debug`. */
  streamSink(relPath: string): RawSink
}
```

The null adapter returns a no-op `RawSink` whose `write` resolves and
`close` resolves. The file adapter reuses `enqueue` + `ensureSubDir`
exactly as `rawSink` does today, minus the `if (!deps.debug) return null`
gate.

**Folder creation is lazy on first write.** No eager mkdir at `step:start`.
The existing `ensureSubDir` cache in
[`file-session-logger.ts:84-95`](../../src/observability/file-session-logger.ts)
already handles "two writers race on first touch" via a shared
`Promise<void>`. Steps with zero events / no rendered lines (silent steps,
crash-before-spawn) leave no folder behind. This matches today's behaviour
and avoids the empty-folder window the analyzer flagged.

**Host-side render tee.** Each host calls a new
`SessionLogger.streamSink(...)` once per step, holding the `RawSink` for
the step's lifetime. Inside `onRunnerEvent`, after writing to its primary
sink (stdout for plain, `tmux send-keys` for two-pane), the host fires
`void sink.write(text)` for the ANSI form, and `void textSink.write(stripAnsi(text))`
for the stripped form. On `step:complete` / `step:failed` the host
`close()`s the sinks.

The host owns the tee — not the workflow — because the bytes the host
actually emits depend on the host's policy (plain uses `\n`, tmux uses
`\r\n`; plain gates color on `isTTY`, tmux always renders color). Lifting
render into the workflow would defeat the brainstorm's point #3 — the
file would no longer be "what the host actually sent".

**`step:start` lifecycle is the discovery hook.** Hosts open per-step
sinks on `step:start` (not on first event) so the sinks exist before the
first `onRunnerEvent` fires. Closing happens on `step:complete` /
`step:failed` (both arrive through `onLifecycleEvent`). This lives inside
each host implementation; the workflow stays unchanged.

### Concrete code changes

#### A. `SessionLogger` port

- `src/observability/session-logger.ts` — add `streamSink(rel: string): RawSink`.
- `src/observability/file-session-logger.ts` — implement; copy of the
  existing `rawSink` body with the `if (!deps.debug)` short-circuit
  removed. Tests mirror the rawSink suite.
- `src/observability/null-session-logger.ts` — return a no-op
  `{ write: async () => {}, close: async () => {} }`.

#### B. Workflow executor

- `src/core/workflow.ts:566-581` — `openRawCapture` drops the
  `!logger.debug` gate. New rel paths:
  - stdout → `agents/${key}/raw_output.ndjson`
  - stderr → `agents/${key}/raw_stderr.log`
  Switch from `logger.rawSink(...)` to `logger.streamSink(...)`. Returns
  always (never `undefined`); the spread at line 691 always attaches
  `onRawLine`.
- `src/core/workflow.ts:790-828` — `writeAgentSession` rel path becomes
  `agents/${stepName}/session.json` (was `agents/${stepName}.session.json`).
- `src/core/workflow.ts:529-552` — `writeInteractiveSession` likewise.
- Add an `outputs:` field to the `session.json` body so a cold reader can
  inventory siblings without prior knowledge:
  ```jsonc
  {
    "stepName": "...",
    "outputs": {
      "events": "events.ndjson",
      "rawStdout": "raw_output.ndjson",
      "rawStderr": "raw_stderr.log",
      "formattedAnsi": "formatted_output.ansi",
      "formattedText": "formatted_output.txt"
    },
    // ... existing fields
  }
  ```

#### C. Transcript sidecar

- `src/state/transcript-sidecar.ts:54-104` — change `relativePath` from
  `steps/${sanitized}.transcript.ndjson` to
  `logs/agents/${sanitized}/events.ndjson`. The `transcriptPath` field
  written into `state.json` follows automatically (no schema bump
  required — `state-store.ts:121` is `z.string().optional()`). Lazy
  mkdir of `logs/agents/<step>/` instead of `steps/`. Function
  `sanitizeStepName` unchanged.
- The `steps/` directory disappears for new runs. Do not delete it for
  old runs (backwards-compat read path — see § Migration).

#### D. Hosts — render tee

- `src/hosts/plain/plain-host.ts` — accept a `SessionLogger` (already
  optional in `PlainHostOptions`, line 52). On `step:start` lifecycle,
  open `streamSink('agents/${step}/formatted_output.ansi')` and
  `streamSink('agents/${step}/formatted_output.txt')`. In `onRunnerEvent`
  text path (lines 74-92), after the stdout `write`, also write to both
  sinks. On `step:complete`/`step:failed`, close the sinks.
- `src/hosts/two-pane/tmux-host.ts` — same pattern. Tee fires
  *before* `pane-queue.enqueue` so the file reflects per-step ordering
  even when two parallel branches interleave on the right pane.
- Both hosts already have a `logger?` field — wiring the tee is additive
  inside each host. Extract a small helper `createPerStepRenderTee(logger)`
  in `src/hosts/plain/per-step-tee.ts` (shared by both hosts; lives under
  `plain/` because that's where `renderTranscriptLine` lives) so the tee
  state machine isn't duplicated. Function under 60 lines.

#### E. CLI / docs / template

- `src/cli/commands/logs.ts:5-6` — update the header comment ("`steps/<name>
  .transcript.ndjson`" → "`logs/agents/<name>/events.ndjson`").
  No code change — the command reads `step.transcriptPath` literal from
  `state.json` and that already follows the new path on new runs and the
  old path on old runs.
- `docs/logging.md` — rewrite the per-step section. Update the table at
  lines 18-26 (the per-step row); add a new subsection "per-step folder"
  with the new layout. Update the `--debug` row at line 49 to remove
  `agents/<step>.stdout`/`.stderr` (they're now baseline). Update the
  grep recipes at lines 86-129.
- `src/observability/readme-template.ts:38-46` and `:67-70` — update the
  rendered run-level `README.md`. Replace the `agents/<step>.session.json`
  bullet with `agents/<step>/` block. Remove the debug-only stdout/stderr
  bullet; leave `tmux/`, `subprocesses.ndjson`, `orch.log`. Stay under
  60 lines (CLAUDE.md rule 5).

### File and function size budget

- `src/core/workflow.ts` is already 1039 lines. This change *removes* the
  `!logger.debug` gate (saves ~3 lines) and adds an `outputs:` field
  (~6 lines). Net neutral. No function grows past 60 lines.
- `src/hosts/plain/plain-host.ts` is 217 lines; the tee adds ~15 lines
  via the helper. Stays under 300.
- `src/hosts/two-pane/tmux-host.ts` is 479 lines. Adds ~15 lines via the
  same helper. Already over 300 — the per-step tee helper extraction is
  the right move and aligns with CLAUDE.md rule 5 (warning, not an error,
  and the existing comment at the top of the file already accepts this
  in this case).
- `src/hosts/plain/per-step-tee.ts` (NEW, ~50 lines).
- `src/observability/file-session-logger.ts:67-204` is 137 lines; adding
  `streamSink` adds ~15. Stays under 300.

### Lifecycle edges (from the SpecFlow analysis)

- **Crash mid-write.** Each writer has its own serial chain. A crash
  between the first stdout byte and `step:complete` leaves the folder
  with a populated `raw_output.ndjson` and possibly an empty
  `events.ndjson`. NDJSON readers tolerate trailing partial lines (same
  guarantee `docs/logging.md` makes for every other file). No `partial: true`
  marker — the existing `state.json` `status: 'crashed'` is the canonical
  signal and the lifecycle.ndjson `step:failed` line is the per-step
  signal.

- **Resume of a partially-completed step.** Resume re-enters
  `runAgentStep` for any non-cached step. The existing
  `transcript-sidecar.ts:75-94` already appends without truncation — and
  the same happens for `raw_output.ndjson`. **Decision:** truncate the
  per-step folder's append-only files on `step:start` so each folder
  reflects the *last* attempt. Implement via a one-shot `truncate(0)`
  against the four append-only files (`events.ndjson`, `raw_output.ndjson`,
  `raw_stderr.log`, `formatted_output.ansi`, `formatted_output.txt`)
  inside the writers, gated by "first write of this step in this process".
  `session.json` is already atomic (tmp + rename via `writeFile` at
  `file-session-logger.ts:142-149`) so it overwrites cleanly. Document
  this in `docs/logging.md`.

- **Cached-resume.** Folder writes never fire (executor short-circuits
  before `step:start`; see `workflow.ts:937-948`). The folder, if it
  exists from a prior run, is left untouched. Document in the run-level
  README that `session.json` may reference an earlier `stepSpanId` for
  cached steps; the `lifecycle.ndjson` `step:cached` line is the
  authoritative signal.

- **SIGINT before the first event.** Folder may not exist (lazy mkdir).
  No `formatted_output.*` files. This is fine — the absence is a signal
  ("the step never produced output"), and `step:start`/`step:failed` in
  `lifecycle.ndjson` document why.

- **Silent steps.** `workflow.ts:604` short-circuits `host.onRunnerEvent`
  when `isSilent`. The host therefore never opens
  `formatted_output.*` sinks. `events.ndjson` and `raw_output.ndjson` are
  written as usual (silent only suppresses host rendering, not data
  capture). Document this asymmetry once in the README template.

- **Non-silent events with `lines: []`.** Many event kinds (system_init,
  some thinking) render zero lines today. The host only writes to the
  formatted sinks when `lines.length > 0` — so empty events produce no
  bytes in `formatted_output.*`. If every event is empty, the file ends
  up zero-byte. That's acceptable (and matches stderr's empty-on-happy-path
  pattern).

### Migration / backwards compatibility

**Read path: backwards-compatible by construction.** `state.json`
`StepEntry.transcriptPath` is a literal string. Old runs persisted
`steps/<step>.transcript.ndjson`; new runs persist
`logs/agents/<step>/events.ndjson`. `src/cli/commands/logs.ts:84-85`
joins `runDir + step.transcriptPath` blindly, so both layouts work. Schema
v5 is unchanged.

**Write path: forward-only.** No on-disk migration script. New writers
emit new paths going forward. Old run directories under `.orch/state/`
are not modified, which means:

- `orch logs r-2026-04-01-abc` (an old run) → reads `state.json`,
  follows `steps/<step>.transcript.ndjson`, file exists, prints. Works.
- `orch logs r-2026-04-29-xyz` (a new run) → reads `state.json`, follows
  `logs/agents/<step>/events.ndjson`, file exists, prints. Works.

**No symlinks, no dual-write, no schema bump.** Aligns with the brainstorm
("full migration, no symlinks") and with the
[`docs/solutions/autonomous-transcript-rendering.md`](../solutions/autonomous-transcript-rendering.md)
lesson that one canonical location beats fallback chains.

**Add a fixture** at
`tests/integration/cli/logs-old-and-new-runs.test.ts` that loads two
fixture state files (one with `transcriptPath: steps/...`, one with
`transcriptPath: logs/agents/.../events.ndjson`) and asserts the `logs`
command prints both. Locks the backwards-compat contract.

## Acceptance criteria

### Functional requirements

- [x] After an autonomous run, `logs/agents/<stepName>/` exists for every
      autonomous step that produced at least one event, containing
      `session.json`, `events.ndjson`, `raw_output.ndjson`,
      `raw_stderr.log`, `formatted_output.ansi`, `formatted_output.txt`.
- [x] `session.json` includes an `outputs:` map listing its sibling files.
- [x] Files are written **without** `ORCH_DEBUG=1`.
- [x] `formatted_output.ansi` is byte-identical to the bytes the host
      emitted (`\n`-delimited under plain, `\r\n`-delimited under
      two-pane); `cat formatted_output.ansi` replays the run on a TTY.
- [x] `formatted_output.txt` is `formatted_output.ansi` passed through
      `stripAnsi` — usable as a `grep` target.
- [x] `raw_output.ndjson` contains the verbatim bytes drained from the
      subprocess stdout, line-buffered.
- [x] Interactive steps produce only `session.json` inside their folder.
- [x] Silent steps produce `events.ndjson` and `raw_output.ndjson` but no
      `formatted_output.*` files.
- [x] Resuming a crashed step truncates its per-step folder so the folder
      reflects only the latest attempt.
- [x] The `--debug` flag still gates `tmux/<paneId>.log`,
      `subprocesses.ndjson`, `orch.ndjson`. Old `agents/<step>.stdout` and
      `agents/<step>.stderr` no longer exist (superseded).

### Non-functional requirements

- [x] No new dependencies.
- [x] `bun run check` passes (lint + typecheck + unit + mocked integration).
- [x] No file grows past 300 lines; no function past 60 lines.
- [x] No new `mock.module` / `vi.mock` of internal modules in tests.
- [x] `transcriptPath` schema unchanged (state v5 still accepts the new
      literal).

### Quality gates

- [x] Cross-test for parser misses: integration test asserts that for the
      Claude fixture in `tests/fixtures/claude/r-2026-04-28-oiyrjv.transcript.ndjson`,
      `wc -l raw_output.ndjson` ≥ `wc -l events.ndjson`. (Strictly: every
      event came from a raw line, so the raw stream has at least as many
      lines as parsed events.)
- [x] Round-trip test: pipe `formatted_output.txt` through diff against
      `events.ndjson | toClaudeTranscriptLines | stripAnsi`. Asserts the
      host wrote what the renderer said.
- [x] Backwards-compat test: `orch logs <old-run-id>` continues to work
      against a fixture with `transcriptPath: steps/...`.

## Implementation phases

Each phase is independently mergeable and `bun run check`-green. Phases
are sequenced so old behaviour keeps working at every step.

### Phase 1 — `streamSink` port + null adapter

**Files:**
- `src/observability/session-logger.ts` (port + JSDoc)
- `src/observability/file-session-logger.ts` (impl)
- `src/observability/null-session-logger.ts` (no-op impl)
- `tests/unit/observability/file-session-logger.test.ts` (new tests for
  always-on `streamSink`; copy the rawSink contract tests but assert the
  sink is non-null even when `debug: false`)
- `tests/unit/observability/null-session-logger.test.ts`

**Done:** `streamSink` exists, has parity with `rawSink` minus the gate,
existing tests pass, new tests pass.

### Phase 2 — Relocate per-step files (writers only)

**Files:**
- `src/state/transcript-sidecar.ts` (new path)
- `src/core/workflow.ts:566-581` (drop `!logger.debug` gate, switch to
  `streamSink`, new paths under `agents/${key}/...`)
- `src/core/workflow.ts:790-828` and `:529-552` (`session.json` rel path
  and `outputs:` field)

**Test churn (path-string substitution, no API change):**
- `tests/unit/observability/file-session-logger.test.ts:116-118, 140, 145, 152, 158`
- `tests/integration/observability/session-logger-baseline.integration.test.ts:250-260`
- `tests/integration/observability/session-logger.e2e.test.ts:114, 127, 151, 234-246, 264`
- `tests/integration/observability/session-logger-debug.integration.test.ts:132, 146, 155, 169, 255-256`
- Anything `grep -rn "steps/" tests/ | grep transcript` surfaces.

**Done:** A FakeRunner workflow produces a `logs/agents/<step>/` folder
with `session.json`, `events.ndjson`, `raw_output.ndjson`, `raw_stderr.log`.
No `formatted_output.*` yet. `--debug` no longer creates per-step
stdout/stderr files outside the folder. Old `orch logs <runId>` fixtures
still work.

### Phase 3 — Host-side render tee

**Files:**
- `src/hosts/plain/per-step-tee.ts` (NEW — shared helper)
- `src/hosts/plain/plain-host.ts` (open/close on lifecycle, write on
  runner event)
- `src/hosts/two-pane/tmux-host.ts` (same)
- `tests/unit/hosts/plain/per-step-tee.test.ts` (NEW)
- `tests/integration/hosts/plain-mode.test.ts` (assert
  `formatted_output.ansi` matches stdout bytes for a fixture)
- `tests/integration/hosts/two-pane-mocked.test.ts` (assert
  `formatted_output.ansi` matches `tmux send-keys` payloads)

**Done:** A FakeRunner workflow under both modes produces matching
`formatted_output.ansi` and `formatted_output.txt` files. `cat formatted_output.ansi`
on a TTY replays the run.

### Phase 4 — Resume truncation + docs

**Files:**
- `src/state/transcript-sidecar.ts` (truncate on first write per
  process), `src/core/workflow.ts` raw capture (same), per-step tee
  (same).
- `docs/logging.md` (rewrite per-step section, update tables, update
  grep recipes, add resume-truncation note).
- `src/observability/readme-template.ts` (update generated README).
- `tests/integration/cli/logs-old-and-new-runs.test.ts` (NEW — fixtures
  for both layouts).
- `tests/integration/observability/resume-per-step-folder.test.ts` (NEW —
  asserts a resumed step's folder reflects only the latest attempt).

**Done:** `bun run check` green, `docs/logging.md` matches the on-disk
layout, generated `README.md` matches the on-disk layout, both old and
new `transcriptPath` literals work in `orch logs`.

## Alternative approaches considered

1. **Lift `renderTranscriptLine` into the workflow executor and tee in
   one place.** Rejected: defeats the brainstorm's point #3 — the tee
   would re-render rather than capture what the host actually emitted.
   Plain vs tmux line endings, plain's TTY-conditional color, and tmux's
   pane-queue ordering would all be invisible. Worse, it would couple
   the workflow to a host-specific renderer.

2. **Always-on tmux pipe-pane for interactive steps.** Rejected: the
   captured TUI bytes are noisy redrawn frames worse than nothing. The
   existing `--debug` `tmux/<paneId>.log` covers the rare case anyone
   needs them.

3. **Symlink `steps/<step>.transcript.ndjson` → `logs/agents/<step>/events.ndjson`
   for backwards compat.** Rejected: dual-truth. The brainstorm explicitly
   chose full migration; the lesson from `two-pane-auto-attach.md`
   (one name, one meaning) applies. `state.json`'s `transcriptPath`
   literal already gives us per-run backwards compat for free.

4. **Bump state schema to v6 and constrain `transcriptPath` to the new
   shape.** Rejected: gratuitous breakage; the existing `z.string()`
   absorbs both literals.

5. **Add `branches/<id>/` folder hierarchy now.** Deferred — see
   [Resolved questions § 1](#resolved-questions). The brainstorm assumes
   a parent step that does not exist in `parallel()`'s API today, and
   today's flat layout (one folder per `as:`-named branch) already
   satisfies "one folder = one step".

## Resolved questions

### 1. Parallel-branch folder layout — `branches/<id>/` deferred

The brainstorm proposes
`logs/agents/<parent>/branches/<branchId>/<file-set>/`. But
`src/core/parallel.ts` does **not** introduce a parent step name —
`parallel(items, fn)` runs each branch as a top-level
`run(STEP, { as: \`prefix-${i}\` })`, and each branch is its own
top-level step. There is no `code-review` parent step in the brainstorm's
example unless the user wrote one explicitly.

**Resolution:** ship flat for v1. Each branch step gets its own
`logs/agents/<branch-step-name>/` folder, exactly as a non-parallel step
would. Defer the `branches/<branchId>/` shape until `parallel()` grows a
parent-name concept (a separate plan, with new API surface). This honours
"one folder = one step" for the layout we actually have today.

### 2. Branch folder naming — N/A under the v1 deferral

Falls out of resolution § 1. There is no nested branch folder in v1.

### 3. `session.json` self-pointer — yes

Add `outputs:` map listing the sibling file names. Cold readers can
inventory the folder without prior knowledge. Cheap (one constant
object). Confirms the brainstorm's leaning ("Probably yes — explicit
inventory makes the folder self-describing").

### 4. Per-step `README.md` — deferred

Brainstorm marks it deferred; no concrete value. The run-level
`README.md` already has grep recipes that work for any step
(`grep <stepSpanId> logs/*.ndjson`). Revisit if a user actually asks.

### 5. Resume behaviour — truncate per-step append-only files on first
write of the step in the process. The folder reflects the latest attempt;
the `lifecycle.ndjson` cross-step stream still records every attempt's
boundaries.

### 6. Old `--debug` `agents/<step>.stdout`/`.stderr` files — removed.
The new always-on `raw_output.ndjson` + `raw_stderr.log` supersede them.
`docs/logging.md` updated to reflect this.

## Dependencies & risks

**Dependencies:** none new. The change is internal-only — no new packages,
no new CLI surface.

**Risks:**

- **Rendered-byte ordering under tmux concurrency.** Two parallel branches
  can interleave on the right pane. The tee captures per-step lines
  *before* they enter the pane queue, so the per-step file reflects the
  step's own order rather than the (possibly racier) on-pane order. This
  matches what `events.ndjson` already does and is the better artifact
  for debugging. Mitigation: comment in `per-step-tee.ts` explaining the
  policy.
- **Disk pressure.** Always-on raw + formatted captures are heavier than
  today's baseline. Same posture as `events.ndjson` (always-on, append,
  no caps). Acceptable per the baseline-files philosophy in
  `docs/logging.md`. Document the cost.
- **`logs/agents/<step>/` collision with old debug `agents/<step>.stdout`.**
  No collision — old debug files were `<step>.stdout` (file), new layout
  is `<step>/raw_output.ndjson` (file inside dir). `mkdir` of a directory
  named after an existing file would fail; this only happens if the same
  user runs with `--debug` and without on the same `runId`, which is
  prevented by `runId` being a one-time identifier.

## References

### Internal references

- Brainstorm: [`docs/brainstorms/2026-04-28-per-agent-output-capture-brainstorm.md`](../brainstorms/2026-04-28-per-agent-output-capture-brainstorm.md)
- Logging reference: [`docs/logging.md`](../logging.md)
- Solutions: [`docs/solutions/autonomous-transcript-rendering.md`](../solutions/autonomous-transcript-rendering.md)
- Phased roadmap: [`docs/plans/implementation-phases.md`](implementation-phases.md)
- Project rules: [`/CLAUDE.md`](../../CLAUDE.md) (rules 3, 5, 6, 7, 9, 10 apply)

### Code seams

- Workflow executor: `src/core/workflow.ts:318` (interactive step), `:566` (`openRawCapture`), `:606` (host event handler), `:633` (autonomous step), `:790-828` (session.json writer)
- Transcript sidecar: `src/state/transcript-sidecar.ts:54-104` (path)
- Session logger: `src/observability/session-logger.ts` (port), `src/observability/file-session-logger.ts:67-204` (impl), `src/observability/null-session-logger.ts` (no-op)
- Hosts: `src/hosts/plain/plain-host.ts:74-92`, `src/hosts/two-pane/tmux-host.ts:321-348`
- CLI: `src/cli/commands/logs.ts:84-85`
- Run README: `src/observability/readme-template.ts`

### Tests requiring updates

- Unit:
  - `tests/unit/observability/file-session-logger.test.ts:116, 140, 145, 152, 158`
  - `tests/unit/observability/null-session-logger.test.ts:13`
- Integration:
  - `tests/integration/observability/session-logger-baseline.integration.test.ts:250`
  - `tests/integration/observability/session-logger.e2e.test.ts:114, 127, 151, 234, 264`
  - `tests/integration/observability/session-logger-debug.integration.test.ts:132, 146, 155, 169, 255`

### Tests to add

- `tests/unit/hosts/plain/per-step-tee.test.ts` — per-step tee state machine.
- `tests/integration/hosts/plain-mode.test.ts` — `formatted_output.ansi` matches stdout bytes.
- `tests/integration/hosts/two-pane-mocked.test.ts` — `formatted_output.ansi` matches `tmux send-keys` payloads.
- `tests/integration/observability/resume-per-step-folder.test.ts` — truncation on resume.
- `tests/integration/cli/logs-old-and-new-runs.test.ts` — backwards-compat read path.
