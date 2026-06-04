# examples/qa — predictable-fake QA driver

DEV-ONLY external driver for orch's two-pane TUI. It launches a real `orch run`
(with the predictable fake agent), screenshots the panes, advances steps
deterministically, simulates a human typing/clicking, and tears down — all as
stateless, turn-by-turn shell commands. It powers the `orch-qa-engineer` skill,
but you can use it by hand too.

Everything goes through the sanctioned `RealTmuxService` / `BunProcessService`
and the runner's own `resolveControlPaths` (CLAUDE.md rule #1 — no raw tmux/
`Bun.spawn`). It deep-imports `scriptedFake`-adjacent addressing on purpose:
this is a dev/test affordance, never shipped.

## Files

| File | Role |
| --- | --- |
| `qa.ts` | the CLI dispatcher (entry point) |
| `session.ts` | tmux channel: resolve the run, capture panes, send keys, focus, kill the server |
| `drive.ts` | control channel: ack-gated `type_and_send` / `finish`, `wait-ready`, `awaiting` |
| `steps.ts` | parse a left-pane capture into structured steps (name/status/depth/active) |
| `render.ts` | render an ANSI capture to a PNG via `freeze` (color-accurate vision input) |

## Usage

The run is launched by you (or the QA agent), in the background, from `examples/`
so it uses `examples/orch.config.ts` + `examples/.orch/state`:

```sh
cd examples && bun ../src/cli/main.ts run predictable-sub --mode=two-pane --no-attach
```

Then drive it from the repo root (`--cwd examples` points at the state dir):

```sh
bun examples/qa/qa.ts info --wait --cwd examples         # resolve run, wait until ready
bun examples/qa/qa.ts shot both --cwd examples           # both panes → .txt + .png (+ stacked both.png)
bun examples/qa/qa.ts steps --json --cwd examples        # structured steps read
bun examples/qa/qa.ts awaiting --cwd examples            # discover drivable step keys
bun examples/qa/qa.ts send triage finish --cwd examples  # advance a step (ack-gated)
bun examples/qa/qa.ts keys right "hi" Enter --cwd examples  # simulate typing
bun examples/qa/qa.ts focus left --cwd examples          # simulate clicking a pane
bun examples/qa/qa.ts down --cwd examples                # kill the tmux server (always)
```

Run `bun examples/qa/qa.ts` with no args for the full command list.

## Screenshots & PNGs

`shot` always writes `<NNN>-<pane>.txt` (ANSI-stripped, trailing blank rows
trimmed). When [`freeze`](https://github.com/charmbracelet/freeze) is on PATH it
also writes `<NNN>-<pane>.ansi` (the colored source) and `<NNN>-<pane>.png` (a
color-accurate render for vision/color analysis); `shot both` adds a stacked
`<NNN>-both.png`. `--no-png` skips rendering; `--raw` keeps the `.ansi` even
without PNGs. Install freeze: `brew install charmbracelet/tap/freeze`.

## Two channels

- **Control** (`send` / `wait-ready` / `awaiting`) — deterministic, ack-gated.
  Advance the run with this.
- **Raw tmux** (`keys` / `focus`) — simulate a human. Exercise input/TUI with
  this; screenshot to confirm (not ack-gated).

## Always tear down

Leaked `scripted-fake` daemons slow the suite ~8×. End every session with
`qa down`, then `pgrep -fl 'scripted-fake/'` to confirm none leaked.

## Bundled QA targets

- `predictable-tui` — three interactive steps (linear smoke test).
- `predictable-sub` — parent + `deep-dive` subworkflow (subworkflow-launch test).

See the `orch-qa-engineer` skill's `references/cookbook.md` for worked scenarios.
