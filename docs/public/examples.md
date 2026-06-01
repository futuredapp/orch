# Examples overview

The repo ships runnable example workflows under `examples/`. Most can be run with `bunx orch run <name>` once registered, or directly with `bun run examples/<name>/index.ts`. Start with **steps-tui-demo** for the full two-pane experience.

## Start here

| Example | Demonstrates |
| --- | --- |
| `steps-tui-demo/` | The canonical two-pane walkthrough — every per-step Enter behavior (replay, logs, interactive resume) in one short workflow. |
| `hello-file/` | The minimal end-to-end run: one autonomous Claude step writing a file. |

## Authoring patterns

| Example | Demonstrates |
| --- | --- |
| `codex-and-claude/` | The smallest two-runner workflow — a Codex step and a Claude step chained through a shared file, both interactive with `autoStop`. |
| `compound/` | A full compound-engineering cycle: brainstorm → plan → deepen → phase-by-phase execution. |
| `feature-loop/` | A loop-with-feedback pattern driven by an `ask()` step (continue / retry / abort). |
| `file-prompts-demo/` | The full file-based prompts surface — `promptFile:` with run-time `vars:`, the `@/.orch/prompts/` shared-fragment pattern, and `loadPrompt()` composition. Pair with [Typed prompt vars](/guides/typed-prompt-vars) for the compile-time contract. |
| `worktree-demo/` | `createWorktree()` with a `postCreate` hook. |

## Step kinds

| Example | Demonstrates |
| --- | --- |
| `ask-demo/` | An `ask()` form — fields, buttons, and the typed result. |
| `command-demo/` | The first-class `command()` step with live stdout/stderr streaming. |
| `command-lazygit/` | Wrapping an interactive shell tool (`lazygit`) as a command step. |
| `command-tick-demo/` | Proof of live streaming — a shell loop printing one line per second. |

## Single-runner flows

| Example | Demonstrates |
| --- | --- |
| `riddle-solver/` | A multi-step Claude flow solving a riddle. |
| `riddle-solver-proper/` | The CLI-loadable variant (exports a default workflow). |
| `codex-riddle-solver/` | The same shape driven by the Codex runner. |

## Where to go next

- [Getting started](/guide/2-getting-started) — run your own first workflow.
- [Authoring API reference](/reference/api) — the primitives these examples use.
