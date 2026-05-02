# codex-riddle-solver

Two-step demo of the orch pipeline using **CodexRunner** (the OpenAI Codex CLI). Mirrors `examples/riddle-solver` but swaps Claude for Codex.

Step 1 invents a short riddle and writes it to `riddle_<suffix>.txt`. Step 2 reads that file, solves the riddle, and writes the answer to `solution_<suffix>.txt`. Both steps run in the same sandbox `cwd`, so step 2 reads what step 1 wrote without any inter-step data passing.

## Run

```sh
bun run examples/codex-riddle-solver/index.ts
```

Requires `codex` (>= 0.118.0) on `PATH`. After the run, `sandbox/` should contain both `riddle_<suffix>.txt` and `solution_<suffix>.txt`, and `state/<runId>/state.json` should report `status: "completed"` for both steps.

## Flags

```sh
# Resume — both steps return cached results without spawning Codex again.
bun run examples/codex-riddle-solver/index.ts --run-id=<id-from-previous-run>

# Seed a theme for the riddle.
bun run examples/codex-riddle-solver/index.ts --prompt="about the ocean"

# Run with workflow-level interactivity = noninteractive.
bun run examples/codex-riddle-solver/index.ts --noninteractive
```

## Interactive vs non-interactive — what works with Codex

There are two distinct "interactivity" axes in orch. Codex behaves differently on each:

| Axis | What it controls | Codex support |
| --- | --- | --- |
| **Step-level `mode: 'interactive'`** | Foreground TTY spawn — user interacts directly with the agent's REPL | **Not supported.** `codex()` declares `supports.interactive = false`. A step with `mode: 'interactive'` throws `RunnerCapabilityError`. |
| **Workflow-level `interactivity`** | How `ask()` steps resolve when no human is present (`'interactive'` prompts; `'noninteractive'` requires `defaultWhenNoninteractive`) | Supported. Toggle with `--noninteractive` above. This demo has no `ask()` steps, so the flag is a wiring smoke test. |

If you want to see a mixed interactive + autonomous workflow, look at `examples/riddle-solver` — the `write-riddle` step there uses `mode: 'interactive'`, which only works because `claude()` declares `supports.interactive = true`.

`sandbox/` and `state/` are disposable — delete either at any time.
