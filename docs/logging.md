# Session logging — `.orch/state/<runId>/logs/`

This is the reference for the per-run logs directory. The audience is a
maintainer (human or AI) dropped cold into a finished run. Everything here
is append-only NDJSON or a whole JSON/markdown file — no rotation, no size
caps, no remote shipping. If you want heavy captures, pass `--debug` (or
set `ORCH_DEBUG=1`) on the run you're debugging.

## Where it lives

Every run writes to `<cwd>/.orch/state/<runId>/logs/`. The `runId` follows
the `r-YYYY-MM-DD-HHMMSS-xx` pattern from `src/state/run-id.ts` (date +
6-digit local-time clock segment + 2 base-36 chars). Each run's directory
is self-contained; deleting `.orch/state/<runId>/` removes everything orch
wrote for that run.

## Baseline files (always present)

| File | Shape | Purpose |
|---|---|---|
| `spawns.ndjson` | one line per agent launch | argv, envKeys, cwd, mode, exitCode, durationMs — "what did we run?" |
| `events.ndjson` | merged cross-step RunnerEvents | parsed agent output, cheap for `grep` across steps |
| `lifecycle.ndjson` | host + step lifecycle | `host-created`, `step:start` / `step:complete` / `step:failed`, `run-ended` |
| `timeline.ndjson` | source-tagged mirror of the three streams above | the AI reader's primary entry point |
| `run.meta.json` | reproducibility snapshot | orch version, argv, envKeys, os, runId, startedAt |
| `README.md` | run-local navigation | generated per run; has grep recipes for this specific `runId` |
| `agents/<stepName>/` | per-step folder | self-describing landing site for one step's run; see below |

Two-pane auto-attach also creates `orch-stdio.log` on the first captured
workflow-body console/stdout write. This keeps user workflow `console.log`
output out of the tmux panes while preserving it for post-run debugging.
Lines are tagged with `[stdout]` or `[stderr]`. Plain mode and `--no-attach`
keep stdout inline.

### Per-step folder (`agents/<stepName>/`)

One folder per step that produced at least one event. Always-on (no
`--debug` requirement). "Show me everything about this step" is one
folder, one `ls`.

| File | Shape | Purpose |
|---|---|---|
| `session.json` | landing page | prompt, argv, envKeys, finalEvent, exitCode, `outputs:` map listing siblings |
| `events.ndjson` | parsed `RunnerEvent[]` | one line per event (`steps/<stepName>.transcript.ndjson` in older runs) |
| `raw_output.ndjson` | subprocess stdout, line-buffered | NDJSON the runner emitted before parsing — parser-miss recovery |
| `raw_stderr.log` | subprocess stderr, line-buffered | empty file when the runner writes no stderr |
| `formatted_output.ansi` | verbatim host bytes | `cat formatted_output.ansi` replays the run on a TTY |
| `formatted_output.txt` | `formatted_output.ansi` minus ANSI | `grep`-friendly stripped form |

Mode-specific shapes:

- **Autonomous step** — produces every file above.
- **Interactive step** — only `session.json` (tmux owns the PTY; orch never
  sees the bytes).
- **Silent step** — `events.ndjson` and `raw_output.ndjson` only; the host
  renders nothing, so `formatted_output.*` are absent.

`session.json.outputs:` maps a logical name (e.g. `formattedAnsi`) to a
sibling filename (e.g. `formatted_output.ansi`). Cold readers can
inventory the folder without prior knowledge.

### Resume truncation

Resuming a crashed run re-enters the step. The append-only files inside
the per-step folder (`events.ndjson`, `raw_output.ndjson`,
`raw_stderr.log`, `formatted_output.ansi`, `formatted_output.txt`) are
truncated on the first write of the step in the resumed process so the
folder reflects only the latest attempt. The cross-step `lifecycle.ndjson`
still records every attempt's `step:start` / `step:failed` /
`step:complete` boundary.

`session.json` is written atomically (tmp + rename) so it overwrites
cleanly without truncation.

Cached resume (the step's value is already in `state.json`) does not
re-enter the step, so the folder — if it exists from a prior run — is
left untouched.

## The `stepSpanId`

Every step attempt gets a fresh UUID — the `stepSpanId` — that tags every
record that relates to the step across every file. Parallel branches each
get their own id. To follow a single step:

```bash
grep <stepSpanId> .orch/state/<runId>/logs/*.ndjson
```

`grep` returns at least one hit from each file that recorded the step —
spawns, events, lifecycle, timeline, and the step's session.json.

## `--debug` (opt-in heavy captures)

Pass `--debug` on the run you want to capture, or export `ORCH_DEBUG=1`.
The flag is all-or-nothing in v1; every heavy capture turns on together.
Users opt in knowing the cost — there are no size caps.

| File | Shape |
|---|---|
| `tmux/<paneId>.log` | `tmux pipe-pane` capture, two-pane mode only |
| `subprocesses.ndjson` | every non-agent subprocess (git, tmux, probes) that routed through `ProcessService` |
| `orch.ndjson` | orch's own internal trace — view resolution, cache hits, state writes, signal handling, host teardown |

Note: per-step raw stdout/stderr is now baseline (always-on) under
`agents/<stepName>/raw_output.ndjson` + `raw_stderr.log`. The old
`agents/<stepName>.stdout` / `.stderr` debug files no longer exist —
they're superseded by the per-step folder. Use `raw_output.ndjson` to
debug parser misses; `events.ndjson` only shows what `parseEvents`
accepted.

Notes:
- Agent subprocesses carry `tag: 'agent'` so they are intentionally skipped by
  `subprocesses.ndjson`. Only non-agent spawns (git probes, tmux commands, etc.)
  land there. See `src/observability/instrument-process-service.ts`.
- `tmux/<paneId>.log` starts AFTER the pane is created, so the first splash line
  can be lost. Accepted loss in v1 — it's baseline output, not step output.
- `orch.ndjson` is append-only NDJSON despite the name drift; v1 keeps the
  `.ndjson` suffix so `grep` and `jq` work the same way they do on the
  baseline files.

## Redaction

Values for env keys that match `^(ANTHROPIC_|CLAUDE_)|.*_TOKEN$|.*_SECRET$|.*_KEY$|.*_PASSWORD$`
are replaced with `***` wherever values are written. The default everywhere
is `envKeys` — no values at all. Export `ORCH_LOG_ENV_VALUES=1` to include
values in `run.meta.json` (secrets still redacted).

> Note (2026-04-27): under the env passthrough contract
> ([plan](plans/2026-04-27-feat-env-passthrough-plan.md)), `spawns.ndjson`
> `envKeys` records the user's full env keys — there's no allowlist filtering
> them anymore. Keys only, no values; sharing a log dump is still safe by the
> same redaction rules above. If you spot a value leaking, treat it as a
> regression.

If you find a secret leaking, flag it as a regression — redaction lives in
a single function (`redactEnv` in `src/observability/redact.ts`) and every
writer routes through it.

## Quick grep recipes

One step, every file:

```bash
grep <stepSpanId> .orch/state/<runId>/logs/*.ndjson
```

All failed steps in a run:

```bash
grep '"type":"step:failed"' .orch/state/<runId>/logs/lifecycle.ndjson
```

Every tool call the Claude runner made:

```bash
jq 'select(.event.type | test("^tool_"))' .orch/state/<runId>/logs/events.ndjson
```

Every spawn that exited non-zero:

```bash
jq 'select(.exitCode != 0)' .orch/state/<runId>/logs/spawns.ndjson
```

Per-step folder for one step (everything orch knows about that run):

```bash
ls .orch/state/<runId>/logs/agents/<stepName>/
```

Replay the run on a TTY:

```bash
cat .orch/state/<runId>/logs/agents/<stepName>/formatted_output.ansi
```

Raw agent bytes for one step (pairs with the parsed events to spot parser
misses):

```bash
diff <(jq -c '.event' .orch/state/<runId>/logs/events.ndjson | sort) \
     <(sort .orch/state/<runId>/logs/agents/<stepName>/raw_output.ndjson)
```

### `--debug`-only recipes

Every non-agent subprocess orch fired (git, tmux, probes):

```bash
jq -r '[.argv[], .exitCode] | @tsv' .orch/state/<runId>/logs/subprocesses.ndjson
```

Internal decisions the orchestrator logged:

```bash
jq -r '[.msg, .stepName // ""] | @tsv' .orch/state/<runId>/logs/orch.ndjson
```
