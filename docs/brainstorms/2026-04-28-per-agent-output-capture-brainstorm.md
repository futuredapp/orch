---
date: 2026-04-28
status: ready-for-planning
topic: Per-agent output capture — record raw + formatted streams per step
---

# Per-agent output capture

## What's broken today

After the autonomous-transcript work landed (commit `d9dbc45`), the right pane is finally legible. But the *record* of what was on the right pane lives nowhere on disk. If you want to verify "did we render the riddle answer correctly?" or debug a parser miss, you have to re-run.

Concretely, after a run finishes, here is what `.orch/state/<runId>/` contains:

```
state.json
steps/<step>.transcript.ndjson         (parsed RunnerEvents — autonomous only)
logs/spawns.ndjson                     (cross-step argv/env/exit)
logs/events.ndjson                     (cross-step parsed events)
logs/lifecycle.ndjson                  (cross-step host + step lifecycle)
logs/timeline.ndjson                   (source-tagged mirror)
logs/run.meta.json                     (reproducibility snapshot)
logs/agents/<step>.session.json        (per-step landing page)
```

The four gaps the user hit:

1. **No per-step "what we displayed".** The bytes that flowed into `tmux send-keys` for the right pane are produced by `renderTranscriptLine()` and immediately discarded. There is no `formatted_output.*` anywhere.
2. **Raw stdout is `--debug`-only.** `agents/<step>.stdout` and `.stderr` are gated behind `ORCH_DEBUG=1` (`src/observability/file-session-logger.ts:153-177`). On the run the user inspected (`r-2026-04-28-oxo618`), they don't exist — debug was off.
3. **Per-step files are scattered.** `steps/<step>.transcript.ndjson` lives in one place, `logs/agents/<step>.session.json` in another, `logs/agents/<step>.stdout` in a third. There is no folder you can `cd` into and see *everything* about one agent's run.
4. **Parser misses are invisible.** Without raw stdout next to the parsed events, you can't tell whether an event was malformed, dropped, or never emitted.

## What we're building

A per-step folder under `logs/agents/<stepName>/` that gathers *everything* we know about that step's run — spawn metadata, raw subprocess streams, parsed events, and the verbatim bytes we sent to the host's right pane. Always-on, no flag.

### Scope

- **In scope:** autonomous (non-interactive) Claude steps. They produce stdout we can tee, and they fan their parsed events through `host.onRunnerEvent()` where we already render to the right pane. Both signals are tappable cleanly.
- **Out of scope (v1):** interactive steps stay a black box. They take over the TTY via `tmux respawn-pane`, so orch never sees their stdout, and the existing `--debug` `tmux/<paneId>.log` already covers anyone who needs the rendered TUI bytes. Decision recorded so it doesn't drift back in.
- **Also out of scope:** changes to the renderer, runner adapters' event shape, the `--debug` flag itself, or the cross-step `logs/*.ndjson` files. Those stay as they are.

## Target layout

For a single autonomous step:

```
logs/agents/solve-riddle/
  session.json           ← was logs/agents/solve-riddle.session.json
  events.ndjson          ← was steps/solve-riddle.transcript.ndjson
  raw_output.ndjson      ← NEW — subprocess stdout, line-buffered
  raw_stderr.log         ← NEW — subprocess stderr, line-buffered
  formatted_output.ansi  ← NEW — verbatim bytes sent to right pane
  formatted_output.txt   ← NEW — same lines, ANSI-stripped
  README.md              ← NEW — grep recipes scoped to this step
```

For a step with parallel branches:

```
logs/agents/code-review/
  rollup.json            ← branch outcomes summary (status, exitCode, durationMs)
  branches/
    <branchId>/
      session.json
      events.ndjson
      raw_output.ndjson
      raw_stderr.log
      formatted_output.ansi
      formatted_output.txt
```

Branch-folder naming uses the existing `stepSpanId` shape so cross-referencing back to `logs/timeline.ndjson` is trivial.

## Why this approach

1. **One folder = one step run.** The user's debugging mental model is "show me everything about *this* agent". Today's layout splits that across three directories. Consolidation reads better and matches how every other observability system in the project is shaped (`logs/<runId>/...`).
2. **Raw + parsed side-by-side catches parser misses.** A line that's in `raw_output.ndjson` but absent from `events.ndjson` is exactly the parser-miss signal `docs/logging.md` already talks about — we just stop hiding it behind `--debug`.
3. **`formatted_output.*` makes the host's behaviour testable post-hoc.** Today we test `renderTranscriptLine()` in isolation. We have *no* way to verify, after a real run, that the host did what the renderer said. Persisting both forms lets a future check be "diff what the host wrote against what the renderer would produce from `events.ndjson`".
4. **Always-on matches the user's stated intent.** They explicitly asked for "as much info as possible" so they can verify and debug without re-running. The baseline-files philosophy in `docs/logging.md` (no rotation, no caps, append-only NDJSON) already accepts this cost for the streams we keep.
5. **Interactive black-box is the honest answer.** We don't have stdout for interactive runs (tmux owns the pty). Trying to fake it via per-step pipe-pane would produce a noisy redrawn TUI capture that's worse than nothing — and we already have `--debug` `tmux/<paneId>.log` for the rare case someone needs it.

## Key decisions

- **Both raw stdout *and* parsed events.** `raw_output.ndjson` is the byte stream the subprocess wrote (line-buffered, NDJSON for Claude because that's its `--output-format=stream-json`; plain text for runners that don't emit JSON). `events.ndjson` is the parsed `RunnerEvent[]` — the relocated `transcript.ndjson`.
- **Both ANSI-verbatim *and* stripped formatted output.** `formatted_output.ansi` is what tmux actually received, `cat`-replayable. `formatted_output.txt` is `stripAnsi`-cleaned for grep/diff. Two cheap writes; no re-rendering at debug time.
- **Always-on, no `--debug` requirement.** Joins the baseline-files set. Existing `--debug` captures (`subprocesses.ndjson`, `orch.ndjson`, `tmux/<paneId>.log`) stay gated.
- **Stderr always captured as `raw_stderr.log`.** Plain `.log` (not `.ndjson`) since stderr isn't structured. Empty file on the happy path is fine — symmetry beats cleverness.
- **Existing files move into the folder.** `logs/agents/<step>.session.json` becomes `logs/agents/<step>/session.json`; `steps/<step>.transcript.ndjson` becomes `logs/agents/<step>/events.ndjson`. The `steps/` directory disappears for autonomous runs. No symlinks — one canonical location, full migration. Update `docs/logging.md`, the per-run `README.md` template, and the `logs` CLI command in lockstep.
- **Parallel branches nest under `branches/`.** One folder per branch with the same file set; parent folder gets a `rollup.json`. Keeps the step↦branches grouping that today's `step:parallel-branch-update` event already implies.
- **Interactive steps: only `session.json`.** No new files. The folder exists (so the layout is uniform), but it contains just the landing page. The folder's `README.md` says explicitly "interactive run — see `tmux/<paneId>.log` with `--debug` for the rendered pane".

## Implementation seams (for the planning step)

Concrete attachment points already mapped:

- **Raw stdout/stderr:** the `onRawLine` hook in `src/runners/execute.ts:63,70` already exists; today it's wired only when `logger.debug` is true (`src/core/workflow.ts:566-581`, `openRawCapture`). Drop the `debug` gate, change the path to the new per-step folder.
- **Formatted output:** wrap the existing `host.onRunnerEvent()` call in `src/core/workflow.ts:606`. Today it calls `renderTranscriptLine()` *inside* the host; we need the rendered strings *also* tee'd to a per-step file. Either lift the render into workflow (renderer becomes shared, hosts get pre-rendered lines) or add an `onRendered(stepName, lines)` hook the hosts call after they write to the pane. The latter is less invasive.
- **Folder creation:** trigger on `step:start` lifecycle (`src/core/workflow.ts:660` autonomous, `353` interactive). `mkdir -p logs/agents/<stepName>/` (or `…/branches/<branchId>/` for parallel branches).
- **Layout migration:** `transcript-sidecar.ts:70-105` writes the current `steps/<step>.transcript.ndjson`. Re-point its destination. `logAgentSpawn` and the interactive-session writer (`src/core/workflow.ts:551`) re-point too. Update the run-local `README.md` template under `logs/README.md`.

## Open questions

None blocking. The following can be resolved in the plan:

- **Naming for branch folders.** Use the bare `stepSpanId`, or a friendly `b-0`/`b-1`/...? `stepSpanId` correlates back to `timeline.ndjson` exactly; `b-N` reads better. Cheap to do both — branch folder named `b-N`, with `branchSpanId` as a field inside `session.json`.
- **`session.json` shape change.** Today it lists `argv`, `envKeys`, `prompt`, `finalEvent`. Should it gain pointers to its own siblings (`raw_output.ndjson`, etc.)? Probably yes — explicit inventory makes the folder self-describing for cold readers.
- **`README.md` per-step.** Worth generating, or skip? The run-level `README.md` already has grep recipes; per-step would be `grep <stepSpanId> raw_output.ndjson` style. Marginal value — defer unless cheap.

## Resolved questions

- *Q: What's in `raw_output.ndjson` — raw bytes or parsed events?* → **Both, as separate files.** `raw_output.ndjson` is bytes; `events.ndjson` is parsed.
- *Q: Should `formatted_output.txt` keep ANSI or strip it?* → **Both.** `formatted_output.ansi` verbatim, `formatted_output.txt` stripped.
- *Q: What about interactive sessions?* → **Black box for v1.** Only `session.json` gets written; rely on `--debug` `tmux/<paneId>.log` for the rare interactive-debug case.
- *Q: Always-on or `--debug`-gated?* → **Always-on**, joins the baseline files.
- *Q: Do existing scattered files move into the folder?* → **Yes, full consolidation** (no symlinks). One canonical location.
- *Q: How do parallel-branch steps appear?* → **One folder per branch under `<step>/branches/`** plus a parent `rollup.json`.
- *Q: Capture stderr too?* → **Yes, always-on `raw_stderr.log`.**
