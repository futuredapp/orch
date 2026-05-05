# codex-riddle-solver

Two-step demo of the orch pipeline using **CodexRunner** (the OpenAI Codex CLI). Mirrors `examples/riddle-solver-proper` but swaps Claude for Codex.

Step 1 runs interactively (foreground TTY) — user interacts directly with Codex's Ratatui TUI to write a short riddle to `./riddle.txt`. Step 2 runs autonomously, reads that file, solves the riddle, and writes the answer to `./solution.txt`. Both steps run in the same workflow `cwd`, so step 2 reads what step 1 wrote without any inter-step data passing.

Requires a TTY (`process.stdin.isTTY === true`) for step 1, and `codex` (>= 0.118.0) on `PATH`.

## Run

The example is registered as a workflow in `examples/orch.config.ts`; invoke it via `orch run` from inside `examples/`:

```sh
cd examples/codex-riddle-solver/sandbox
bunx orch run codex-riddle-solver
```

`orch` auto-detects the run mode — two-pane when TTY + tmux ≥ 3.2 are available, otherwise it surfaces a clear error (interactive steps can't render in plain mode). After the run, the workflow `cwd` should contain both `riddle.txt` and `solution.txt`, and `.orch/state/<runId>/state.json` should report `status: "completed"` for both steps.

## Flags

```sh
# Seed a theme — flows into args.prompt; the workflow body logs it for visibility.
bunx orch run codex-riddle-solver "about the ocean"

# Workflow-level interactivity = noninteractive (controls how ask() steps resolve).
# This demo has no ask() steps, so the flag is a wiring smoke test.
bunx orch run codex-riddle-solver --noninteractive

# Resume — cached steps return without spawning Codex again.
bunx orch resume <runId>
```

## The two "interactivity" axes

There are two distinct interactivity axes in orch — both supported by Codex:

| Axis | What it controls | This demo |
| --- | --- | --- |
| **Step-level `mode: 'interactive'`** | Foreground TTY spawn — user interacts directly with the agent's TUI | Step 1 uses it. Codex's interactive TUI is Ratatui (Claude's is Ink). |
| **Workflow-level `interactivity`** | How `ask()` steps resolve when no human is present (`'interactive'` prompts; `'noninteractive'` requires `defaultWhenNoninteractive`) | Toggle with `--noninteractive`. This demo has no `ask()` steps, so the flag is a wiring smoke test. |

`sandbox/` is disposable — delete at any time. State lives at `<cwd>/.orch/state/<runId>/`.
