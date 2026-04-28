# Session logging — `.orch/state/<runId>/logs/`

This is the reference for the per-run logs directory. The audience is a
maintainer (human or AI) dropped cold into a finished run. Everything here
is append-only NDJSON or a whole JSON/markdown file — no rotation, no size
caps, no remote shipping. If you want heavy captures, pass `--debug` (or
set `ORCH_DEBUG=1`) on the run you're debugging.

## Where it lives

Every run writes to `<cwd>/.orch/state/<runId>/logs/`. The `runId` follows
the `r-YYYY-MM-DD-xxxxyy` pattern from `src/state/run-id.ts`. Each run's
directory is self-contained; deleting `.orch/state/<runId>/` removes
everything orch wrote for that run.

## Baseline files (always present)

| File | Shape | Purpose |
|---|---|---|
| `spawns.ndjson` | one line per agent launch | argv, envKeys, cwd, mode, exitCode, durationMs — "what did we run?" |
| `events.ndjson` | merged cross-step RunnerEvents | parsed agent output, cheap for `grep` across steps |
| `lifecycle.ndjson` | host + step lifecycle | `host-created`, `step:start` / `step:complete` / `step:failed`, `run-ended` |
| `timeline.ndjson` | source-tagged mirror of the three streams above | the AI reader's primary entry point |
| `run.meta.json` | reproducibility snapshot | orch version, argv, envKeys, os, runId, startedAt |
| `README.md` | run-local navigation | generated per run; has grep recipes for this specific `runId` |
| `agents/<stepName>.session.json` | per-step landing page | prompt, argv, envKeys, finalEvent, exitCode, transcript path |

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
| `agents/<stepName>.stdout` + `.stderr` | raw bytes per agent subprocess — parser miss recovery, NDJSON decode failures |
| `tmux/<paneId>.log` | `tmux pipe-pane` capture, two-pane mode only |
| `subprocesses.ndjson` | every non-agent subprocess (git, tmux, probes) that routed through `ProcessService` |
| `orch.ndjson` | orch's own internal trace — view resolution, cache hits, state writes, signal handling, host teardown |

Notes:
- `agents/<stepName>.stdout` is the raw byte stream BEFORE any NDJSON parsing.
  Use it to debug parser misses; `events.ndjson` only shows what `parseEvents`
  accepted.
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

### `--debug`-only recipes

Every non-agent subprocess orch fired (git, tmux, probes):

```bash
jq -r '[.argv[], .exitCode] | @tsv' .orch/state/<runId>/logs/subprocesses.ndjson
```

Internal decisions the orchestrator logged:

```bash
jq -r '[.msg, .stepName // ""] | @tsv' .orch/state/<runId>/logs/orch.ndjson
```

Raw agent bytes for one step (pairs with `events.ndjson` to spot parser misses):

```bash
diff <(jq -c '.event' .orch/state/<runId>/logs/events.ndjson | sort) \
     <(sort .orch/state/<runId>/logs/agents/<stepName>.stdout)
```
