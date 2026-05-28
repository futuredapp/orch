# CLI reference

Run orch with `bunx orch <command> [options]` (or `orch ...` when installed).

## Commands

| Command | Description |
| --- | --- |
| `orch init` | Scaffold a fresh `.orch/` in this project. |
| `orch new <name>` | Create a new workflow file under `.orch/workflows/`. |
| `orch run <name> [prompt]` | Run a workflow, with an optional inline prompt. |
| `orch resume [id] [prompt]` | Resume a run; an optional prompt overrides the persisted args. |
| `orch runs` | List recent runs. |
| `orch status <id>` | Show the status of a run. |
| `orch logs <runId>` | Stream the per-step transcript for a run. |
| `orch dry-run <name> [prompt]` | Preflight check + first-step peek (no execution). |

### run

```bash
orch run hello
orch run hello "refactor the auth module"
orch run hello --prompt "refactor the auth module"
orch run hello --mode=two-pane
```

Looks up `hello` in `orch.config.ts`, resolves a [run mode](#run-modes), and executes the workflow. An inline prompt (positional or `--prompt`) is passed to the workflow as `args.prompt`.

### resume

```bash
orch resume r-2026-05-27-143052-7k
orch resume --latest
orch resume r-2026-05-27-143052-7k "new instructions"
```

Re-executes the workflow function. Steps that already finished return their cached value; the first unfinished step runs. A resume on an already-completed run errors (exit code 3).

### logs

```bash
orch logs r-2026-05-27-143052-7k
orch logs --latest
orch logs --latest --follow --step work-auth
```

Streams a run's transcript. `--latest` resolves to the most recent run. `--step <name>` prints only that step; `--follow` (`-f`) tails it until the run reaches a terminal status or you Ctrl-C (requires `--step`).

## Options

| Flag | Applies to | Description |
| --- | --- | --- |
| `-h, --help` | all | Show help. |
| `--prompt <text>` | run, resume, dry-run | Alias for the inline prompt positional. |
| `--mode <m>` | run, resume | `plain` \| `single-pane` \| `two-pane` (`single-pane` deferred). |
| `--format <f>` | run (plain mode) | `text` \| `json`. `json` emits one NDJSON envelope per event and suppresses the banner. Only valid with `--mode=plain`. |
| `--no-attach` | two-pane | Skip auto-attach; print the attach hint and keep running. Use for CI and headless boxes. |
| `--debug` | run, resume | Turn on heavy session logs (agent stdout/stderr, tmux pipe-pane, subprocess spawns). Defaults on with `ORCH_DEBUG=1`. |
| `--interactive` | run, resume | `ask()` prompts render normally (default). |
| `--noninteractive` | run, resume | `ask()` resolves declared defaults (CI, scheduled). Errors if a prompt has no default. Defaults on with `ORCH_NONINTERACTIVE=1`. |
| `--latest` | logs | Resolve `<runId>` to the most recent run. |
| `--step <name>` | logs | Print only the named step's transcript (exact match). |
| `-f, --follow` | logs | Tail the named step until terminal status or SIGINT (requires `--step`). |

## Run modes

A run mode decides where views render. orch wires `plain` and `two-pane`; `single-pane` is reserved for a future version and exits with an error if requested explicitly.

| Mode | When chosen | What you see |
| --- | --- | --- |
| `plain` | CI, no TTY, or `--mode=plain` | Transcript lines on stdout. `--format=json` for structured envelopes. |
| `two-pane` | TTY + tmux ≥ 3.2, or `--mode=two-pane` | tmux session: left = live status of all steps, right = active step's transcript or interactive TUI. orch auto-attaches your terminal. |

**Resolution precedence:** `--mode` flag > `defaultMode` in `orch.config.ts` > CI → `plain` > TTY + tmux → `two-pane` > fallback `plain`. The chosen mode and the reason print as a banner on stderr (suppressed by `--format=json`).

::: tip Running two-pane on a headless box
Pair `--mode=two-pane --no-attach`: orch creates the tmux session and prints an attach hint without taking the TTY. Running orch from *inside* an existing tmux session fails fast — start it from a plain terminal or use `--mode=plain`.
:::

## Exit codes

| Code | Name | Meaning |
| --- | --- | --- |
| `0` | OK | Workflow completed. |
| `1` | STEP_FAILURE | A step failed (runner error, validator failure, schema mismatch). |
| `2` | CONFIG_ERROR | Invalid config, unknown command, or bad flag. |
| `3` | CANNOT_RESUME | Run not found, or not resumable (e.g. already completed). |
| `130` | SIGINT | Interrupted with Ctrl-C. |
| `143` | SIGTERM | Process terminated. |

## Where to go next

- [Configuration](/reference/config) — `orch.config.ts` and environment variables.
- [Authoring API reference](/reference/api) — the workflow you're running.
