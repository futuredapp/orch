# steps-tui-demo

Canonical walkthrough for the two-pane Steps TUI. Demonstrates every per-kind
Enter behavior the steps navigator surfaces.

## Run it

```bash
bunx orch run steps-tui-demo --mode=two-pane "anything"
```

The workflow runs five steps in sequence:

| # | Step                | Kind         | What Enter does                                    |
|---|---------------------|--------------|----------------------------------------------------|
| 1 | `command:plan-files` | command      | Replay the captured pane log (output of `ls *.md`) |
| 2 | `review-security`   | agent (auto) | Replay the rendered transcript                     |
| 2 | `review-design`     | agent (auto) | Replay the rendered transcript (parallel branch)   |
| 3 | `brainstorm`        | agent (interactive) | Resume the Claude session in window 1       |
| 4 | `commit:demo-...`   | commit       | Show the commit details panel (sha + diff stat)    |
| 5 | `command:summary`   | command      | Replay the captured pane log                       |

## TUI keymap

| Key  | Action                                |
|------|---------------------------------------|
| `↑/↓`| Move selection through past steps     |
| `⏎`  | Inspect the selected step             |
| `f`  | Follow the live step (close inspect)  |
| `?`  | Toggle keymap overlay                 |
| `q`  | Quit the TUI; the run continues       |

## After the run completes

The TUI stays mounted with an end-of-run summary header. Selection still
works — Enter on the interactive `brainstorm` step opens a fresh
`claude --resume <sessionId>` in window 1. Press `q` (or `Ctrl-b d` to detach)
to dismiss.

## Requirements

- `claude` on `$PATH` for the parallel review steps and the interactive
  brainstorm. The two `command:` steps work without it.
- `tmux >= 3.0` so two-pane mode resolves.
