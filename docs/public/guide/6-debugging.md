# Debugging

> **What you'll learn:** how to read a run's logs, follow a step live, turn on heavy captures, and reason about surprises that only appear on resume.

Every run writes a self-contained log directory. When something goes wrong, the answer is almost always already on disk — you rarely need to re-run with a debugger attached.

## Read the transcript

The quickest view is `orch logs`. It replays the transcript a run produced:

```bash
orch logs --latest
```

Narrow to one step, and tail it while the run is still going:

```bash
orch logs --latest --step execute-phase --follow
```

`--follow` (`-f`) requires `--step` and streams until the step reaches a terminal status or you Ctrl-C. This is how you watch a single autonomous step work without the two-pane host.

## What's on disk

Each run owns `.orch/state/<run-id>/`. Two things live there: the persisted results and the logs.

```
.orch/state/r-2026-05-27-143052-7k/
├── state.json            # persisted step results, status, and the run's args
└── logs/
    ├── events.ndjson     # parsed agent events, merged across all steps
    ├── lifecycle.ndjson  # step + host lifecycle (start/complete/failed, pane events)
    ├── timeline.ndjson   # everything above, source-tagged — the best entry point
    ├── spawns.ndjson     # one line per agent launch (argv, cwd, exit code, duration)
    ├── run.meta.json     # reproducibility snapshot (orch version, argv, os)
    └── agents/<step>/     # one folder per step that emitted events
```

`state.json` answers *"what finished and what did it return?"* — it is the same file resume reads. The `logs/` tree answers *"what actually happened?"* Start with `timeline.ndjson`; it interleaves runner events, lifecycle, and spawns in one ordered stream.

### Per-step folder

`agents/<step>/` is a landing site for a single step. `session.json` is its index — prompt, argv, exit code, final event, and an `outputs:` map naming the sibling files. The transcript sits in `events.ndjson`, and for autonomous steps the rendered output is in `formatted_output.txt` (ANSI-stripped, grep-friendly) and `formatted_output.ansi` (replay with `cat` on a TTY).

Interactive steps only get `session.json` — tmux owns the PTY, so orch never sees the bytes.

## Turn on heavy captures

By default orch keeps the logs lean. When you need the raw firehose — subprocess stdout/stderr before parsing, tmux pipe-pane output, every spawn — add `--debug`:

```bash
orch run feature --debug
orch resume --latest --debug
```

`ORCH_DEBUG=1` in the environment does the same thing for every run, which is handy in a misbehaving CI job. See [Configuration → Environment variables](/reference/config#environment-variables).

## The resume lens

Most "this ran twice" or "this didn't run at all" surprises trace back to one rule: **code between `run()` calls executes every time the function runs, including on every resume.** Only the work *inside* a `run()` call is cached by name.

So if a side effect appears twice after a resume, it's almost certainly a bare statement between steps:

```ts
await run(PLAN)
await fs.appendFile('log.txt', 'planned\n') // runs again on every resume
await run(WORK)
```

The fix is to make the side effect idempotent or move it inside a step. This is the single most common debugging realization — keep [Memoization and resume](/guide/3-core-concepts#memoization-and-resume) in mind whenever resume does something you didn't expect.

A step that *failed* (runner error, validator failure, schema mismatch) is not cached, so the next resume re-runs it. Read its `agents/<step>/session.json` for the exit code and final event, then fix the prompt, the validator, or the environment and resume again.

## Where to go next

- [Running workflows](/guide/5-running-workflows) — the run and resume commands these logs come from.
- [CLI reference](/reference/cli#logs) — every `orch logs` flag.
- [Validators](/guides/validators) — make a step fail loudly instead of silently producing the wrong thing.
