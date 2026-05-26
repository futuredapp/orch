# codex-and-claude

The smallest workflow that uses **both** runners — one Codex step and one
Claude Code step — chained through a shared file. Both steps are
`mode: 'interactive'` with `autoStop: true`.

| Step | Runner | Does |
|---|---|---|
| `draft` | Codex | Writes a one-line topic sentence to `./note.txt`. |
| `expand` | Claude Code | Reads that line and appends a short paragraph below it. |

Each step runs the real agent TUI in a tmux pane. With `autoStop: true`, orch
injects a signal-only hook (Claude `Stop`/`StopFailure`, Codex `notify`); when
the agent finishes its turn the pane closes on its own and the pipeline
advances — no human keystroke. This is the "interactive UI, autonomous
behavior" pattern.

```bash
bunx orch run codex-and-claude                    # auto → two-pane
bunx orch run codex-and-claude "about tide pools" # → args.prompt
```

Requires `codex` (>= 0.118.0) and `claude` on PATH, plus a TTY and tmux ≥ 3.2
(auto-stop is a two-pane/tmux feature).
