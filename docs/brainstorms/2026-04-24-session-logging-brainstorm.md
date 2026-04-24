---
date: 2026-04-24
topic: session-logging
---

# Session Logging (Maintainer Debugging)

## What We're Building

A per-run directory of log files under `.orch/state/<runId>/logs/` that lets a
maintainer — in practice, an AI agent doing post-mortem on a finished run —
reconstruct exactly what happened. Multiple files, each a different perspective
on the same session, cross-referenced by a correlation id (`stepSpanId`) so
`grep` across files works.

Scope is the **maintainer/developer** lens (people building `orch`), not the
workflow-author lens (people *using* `orch`) — the latter is a separate concern
and gets a separate mechanism.

Baseline logs are always-on and tiny. Heavy captures (raw agent stdout/stderr,
tmux pane output, orch internal trace, non-agent subprocesses) are gated behind
a single `--debug` flag (also `ORCH_DEBUG=1`).

No size caps on debug logs — users opt into `--debug` knowing the cost.

## Why This Approach

Existing `TranscriptSidecar` (per-step NDJSON of parsed RunnerEvents) captures
only agent *output* as parsed events. It misses: the launch argv/env, raw
bytes, tmux behavior, host lifecycle, and orch's own internal decisions.

Three rejected alternatives:
- **Extend transcripts to carry everything.** Rejected: transcripts are agent
  output; mixing perspectives breaks `orch logs` semantics.
- **Single `orch.log` for everything.** Rejected: one file, many formats, hard
  to grep by category — fights the AI-reader goal.
- **Stand up a proper tracing framework (OpenTelemetry, structured logging
  library).** Rejected: YAGNI. NDJSON on disk is sufficient, zero dependencies,
  works with `cat`/`grep`/`jq`, and matches the project's existing
  append-only-NDJSON muscle memory (see `TranscriptSidecar`).

## Key Decisions

### File layout — `.orch/state/<runId>/logs/`

**Baseline (always-on):**
- `spawns.ndjson` — one line per agent launch: `ts, stepName, runnerName,
  mode, argv, envKeys, cwd, sessionId, exitCode, durationMs, reproduce`.
  Solves "can't reproduce locally".
- `events.ndjson` — merged cross-step timeline of all parsed RunnerEvents,
  each tagged `{stepName, runnerName, ts, stepSpanId}`. Cheap; complements
  per-step transcripts.
- `lifecycle.ndjson` — host + tmux + pane + workflow lifecycle:
  `host-created, tmux-session-created, pane-created(L|R), attach, detach,
  pane-died, signal-received, run-ended`. Solves "pane created/finished"
  narrative + parts of "tmux weirdness".
- `timeline.ndjson` — merged interleave of spawns + events + lifecycle +
  errors in `ts` order, each line source-tagged. Duplicates data (~1.5×
  storage) in exchange for one-file grep covering the full picture. Primary
  entry point for the AI reader.
- `run.meta.json` — frozen invocation snapshot: orch version, git SHA of
  orch, runner versions, OS, tmux version, full argv, env snapshot
  (redacted). Single source of truth for reproducibility.
- `agents/<stepName>.session.json` — per-step summary with full prompt,
  argv, envKeys, final event, exit, duration, plus file pointers to every
  other stream relevant to the step. The "landing page" for one step.
- `README.md` — generated at run start. Describes every file + field in
  that run's dir; includes grep recipes for common questions. Target
  audience: an AI agent dropped cold into the directory.

**`--debug` only:**
- `agents/<stepName>.stdout` + `.stderr` — raw unparsed bytes from each
  agent subprocess. Uncapped. Complements `events.ndjson` (parsed) and the
  existing per-step transcripts.
- `tmux/<paneId>.log` — `tmux pipe-pane` capture of full rendered output
  per pane. Requires two-pane mode. Uncapped.
- `orch.log` — orch's own internal trace: view resolution, mode
  resolution, sidecar writes, state writes, caching decisions, signal
  handling. Structured replacement for scattered `console.log`.
- `subprocesses.ndjson` — every non-agent subprocess spawn (git, tmux CLI,
  anything through `ProcessService` that isn't a runner). Closes the loop
  on "what tmux commands did orch issue?".

### Correlation id

`stepSpanId` (UUIDv4) minted per step span. Parallel branches get unique
ids per branch. Every log line that relates to a step carries it, so
`grep <stepSpanId> logs/*.ndjson` returns every trace across every file.

### Verbosity

Single `--debug` CLI flag (also `ORCH_DEBUG=1`). All-or-nothing for the
heavy captures. No per-category flags for v1 — adding them later is
additive and cheap.

### Reading UX

No CLI reader. Files are read via `cat`/`grep`/`jq` directly. Self-service
is possible because:
1. A run-local `README.md` explains that run's directory.
2. A new `docs/logging.md` documents the general format + grep recipes.
3. `CLAUDE.md` links to `docs/logging.md` so AI collaborators pick it up
   automatically.

### Secrets

`env` in logs is redacted by default: `envKeys` listed as a string array;
values omitted. `run.meta.json` may carry values only when
`ORCH_LOG_ENV_VALUES=1`, and even then the redaction policy
(`^(ANTHROPIC_|CLAUDE_).*|.*_TOKEN$|.*_SECRET$|.*_KEY$|.*_PASSWORD$` → `***`)
applies. `reproduce` commands use the same policy.

### Implementation boundaries

- One new port `SessionLogger` (in `src/observability/`). File-backed impl
  writes to `.orch/state/<runId>/logs/`. Null impl for tests.
- Baseline writers hook in at: `runAgentStep` + `runInteractiveStep`
  (spawns + events), `TmuxHost` + `PlainHost` (lifecycle), `run.ts` +
  `resume.ts` (run.meta.json + README.md at init).
- `--debug` writers hook in at: `BunProcessService` (optional wrapper for
  stdout/stderr/subprocess capture), `TmuxHost` (pipe-pane on pane
  creation), internal orch code (opt-in calls to `logger.debug(...)`).
- Resume appends to the same `logs/` directory — run continues, trace
  continues.

## Resolved Questions

1. **`events.ndjson` duplication vs linking** → **Duplicate write.**
   Write each event twice (once to the per-step transcript, once to
   `events.ndjson`). Simplest, crash-tolerant, grep-friendly. Events are
   the smallest category; the 2× cost is negligible.
2. **Step lifecycle ownership** → **Include step events in
   `lifecycle.ndjson`.** Carries host/tmux/pane + `step:start` /
   `step:complete` / `step:failed` / `step:cached` /
   `step:parallel-branch-update`. One-file narrative. The future
   workflow-narrative log (separate audience) can consume the same
   source.
3. **`ORCH_STEP_SPAN_ID` env propagation** → **No propagation in v1.**
   Orch mints and logs the id; doesn't inject it into the agent's env.
   Zero coupling. Add later if a concrete agent-side telemetry need
   appears.

## Open Questions

1. **Tmux `pipe-pane` timing.** Starting pipe-pane *after* pane creation
   may miss the first few lines. Need to verify whether tmux can attach
   a pipe at creation time via the `tmux neww ... \; pipe-pane ...`
   chained form (or similar). Plan-phase research.

## Next Steps

→ `/workflows:plan` for the full implementation breakdown (which writers
go where, test matrix, schema shapes, docs).
