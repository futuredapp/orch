# predictable-tui (dev-only)

A development workflow that uses the **predictable fake agent** (`scriptedFake`)
as a deterministic stand-in for `claude()` / `codex()`. Use it to exercise the
two-pane TUI, build automation, or QA the orchestrator without burning a real
agent CLI.

> **Dev-only.** `scriptedFake` is deliberately absent from the public barrels and
> the package is `private`, so a published consumer cannot import it. This
> example deep-imports it from `src/runners/scripted-fake/index.ts`. Do not add
> this workflow to any shipped config.

## What it shows

Three **interactive** steps (`plan` → `execute` → `report`), each a predictable
fake rendered with the **Ink list+input TUI** (`interactiveUi: 'ink'`):

- a scrolling message list of everything sent so far, plus
- a `❯` input prompt that **echoes what you type** as you type it.

Every step takes input from TWO channels routed through ONE engine, so a human
and a script are interchangeable drivers:

1. **manual typing** into the pane (input + Enter to send; `exit`/`q` to end), and
2. an **external script / QA agent** appending NDJSON commands to the step's
   on-disk control file (see `drive.ts`).

There is no headless step, so there is **no `ORCH_LIFECYCLE_SCRIPT` to set** — the
interactive entry has exactly one behavior and reads no script file.

## Run it

```bash
bunx orch run predictable-tui --mode=two-pane
```

Then drive it one of two ways:

- **By hand** — type a line + Enter into each step's pane; `exit` or `q` ends the
  step and advances to the next.
- **By script** — in a second terminal:

  ```bash
  bun examples/predictable-tui/drive.ts            # newest run
  bun examples/predictable-tui/drive.ts <runDir>   # a specific .orch/state/<runId>
  ```

`drive.ts` is the seed for an automation skill: it discovers the run, waits for
each step's `.ready` marker, and sends `type_and_send` / `finish` commands,
gating every send on the command's `.ack` — no timers. It reuses the runner's
own `resolveControlPaths`, so the control-file path can never drift.

## The control channel

Each step owns an NDJSON control file under its run-state dir, addressed by the
step's `as:` key. The command vocabulary the driver appends:

```jsonc
{ "cmd": "type_and_send", "text": "a line to render" }
{ "cmd": "finish" }                  // clean exit (interactive ignores any code)
```

Edit the `SCRIPT` array in `drive.ts` to script a different dialogue.

## Raw vs Ink UI

`interactiveUi: 'ink'` (used here) gives the human-friendly list+input pane with
live echo. The default `'raw'` entry is a deterministic line-printer that shows
nothing until Enter — better for scripted-only tests, worse for typing by hand.
Both share one engine and the same `.ready` / `.ack` / render-log contract, so a
driver cannot tell which is mounted.
