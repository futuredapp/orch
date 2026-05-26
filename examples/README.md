# Examples

| Workflow | What it shows |
|---|---|
| [`steps-tui-demo/`](./steps-tui-demo/) | Canonical walkthrough for the **two-pane Steps TUI** — exercises every per-kind Enter behavior (transcript replay, command pane log, commit details, interactive resume) in one short run. Start here. |
| [`compound/`](./compound/) | Full compound-engineering loop: brainstorm → plan → deepen-plan → phase-by-phase execution. |
| [`feature-loop/`](./feature-loop/) | The loop-with-feedback pattern that motivated `ask()`. |
| [`command-demo/`](./command-demo/) | First-class `command()` step that streams stdout/stderr live. |
| [`command-lazygit/`](./command-lazygit/) | Wraps `lazygit` as a `command:` step. |
| [`command-tick-demo/`](./command-tick-demo/) | Shows live streaming + `tail()` helper for trimming captured output. |
| [`ask-demo/`](./ask-demo/) | Interactive `ask()` form rendered via the Ink prompt service. |
| [`worktree-demo/`](./worktree-demo/) | `createWorktree()` step + `postCreate` hook. |
| [`hello-file/`](./hello-file/) | Minimal first workflow — a single autonomous Claude step. |
| [`riddle-solver*/`](./riddle-solver/) | Multi-step Claude flow that solves a riddle from the prompt. |
| [`codex-riddle-solver/`](./codex-riddle-solver/) | Same shape, but driven by Codex. |
| [`codex-and-claude/`](./codex-and-claude/) | Smallest two-runner workflow — one Codex step + one Claude Code step, chained through a shared file. |

Run any example from the project root:

```bash
bunx orch run <name>                         # plain mode
bunx orch run <name> --mode=two-pane         # tmux + Steps TUI
```
