# Running workflows

> **What you'll learn:** the day-to-day commands for running a workflow, choosing how it renders, resuming after a crash, and previewing a run before spending tokens.

This is the narrative walkthrough. For the exhaustive flag and exit-code tables, see the [CLI reference](/reference/cli).

## Run it

`orch run <name>` looks the workflow up in `orch.config.ts` and executes it:

```bash
orch run feature
```

Most workflows take a prompt. Pass it inline as a positional argument — it arrives as `args.prompt` inside the function (see [Reading the inline prompt](/guide/4-writing-a-workflow#reading-the-inline-prompt)):

```bash
orch run feature "add a CSV exporter to the report module"
```

The positional form and `--prompt "..."` are equivalent; use whichever reads better.

## Run a built-in — no file required

You don't have to author a workflow to get started. orch ships a few **built-in** workflows under an `orch::` prefix that run in place — no `.orch/workflows/` file, no `orch.config.ts` entry:

```bash
orch run orch::work-cc "add a CSV exporter to the report module"
```

`orch::work-cc` (Claude) and `orch::work-codex` (Codex) take a plan file or an inline description and build it in phases, unattended. See [Built-in workflows](/guides/built-in-workflows).

## Choosing how it renders

A [run mode](/guide/3-core-concepts#run-modes) decides *where* the views appear. You rarely set it by hand — orch picks one:

- **`two-pane`** when you have a TTY and tmux ≥ 3.2. A tmux session opens: the left pane lists every step with live status, the right pane shows the active step's transcript or interactive TUI.
- **`plain`** in CI, over a pipe, or anywhere without a TTY. Transcript lines stream to stdout.

Force a mode with `--mode`:

```bash
orch run feature --mode=two-pane
orch run feature --mode=plain
```

On a headless box where you still want the live panes, create the session without attaching and connect later:

```bash
orch run feature --mode=two-pane --no-attach
```

orch prints a one-line banner on stderr naming the mode it chose and why. The full resolution precedence is in the [CLI reference](/reference/cli#run-modes).

## Resume after a crash

A run can stop for many reasons — Ctrl-C, a CI timeout, a failed step, a closed laptop. Resume picks up where it left off:

```bash
orch resume --latest
```

`--latest` targets the most recent run; pass a run id to target a specific one. Resume **re-executes the whole workflow function**, but every `run()` that already finished returns its cached value instantly, so only the unfinished work actually runs. That is the [memoization model](/guide/3-core-concepts#memoization-and-resume) at work. You can also pass a fresh prompt to override the persisted one:

```bash
orch resume r-2026-05-27-143052-7k "focus on the edge cases this time"
```

Resuming a run that already completed is an error (exit code 3) — there is nothing left to do.

## Inspect what happened

List recent runs and their status:

```bash
orch runs
```

Show one run in detail — which steps finished, which failed, the args it ran with:

```bash
orch status r-2026-05-27-143052-7k
```

To read the transcript a step produced, use `orch logs` — covered in [Debugging](/guide/6-debugging).

## Preview before spending tokens

`orch dry-run` resolves the workflow, runs the same preflight checks as a real run (config valid, runners present, version preflight), and peeks at the first step — without spawning any agent:

```bash
orch dry-run feature "add a CSV exporter"
```

Use it after editing a workflow to catch a bad config or a missing CLI before you pay for a single agent turn.

## Where to go next

- [Debugging](/guide/6-debugging) — read a run's logs and follow a step live.
- [CLI reference](/reference/cli) — every command, flag, and exit code.
- [Configuration](/reference/config) — set a `defaultMode` so you don't pass `--mode` each time.
