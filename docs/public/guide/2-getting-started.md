# Getting started

> **What you'll learn:** how to install orch, scaffold a project, write a one-step workflow, and run it.

In a hurry? This is the whole page in four commands:

```bash
brew tap futuredapp/orch && brew trust futuredapp/orch && brew install orch
orch init             # scaffolds .orch/ with a hello workflow
orch run hello        # spawns Claude Code and watches it work
orch resume --latest  # picks an interrupted run back up
```

(`brew trust` exists only on Homebrew 5.1+ - skip it if it errors.)
The rest of the page explains what each command does.

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.2.0 — orch is a Bun project and ships TypeScript directly.
- At least one agent CLI on your `PATH`:
  - `claude` (Claude Code) for the [`claude()`](/reference/runners#claude) runner.
  - `codex` (≥ 0.118.0) for the [`codex()`](/reference/runners#codex) runner.
- Optional: `tmux` ≥ 3.2 for the interactive [two-pane mode](/reference/cli#run-modes). Without it, orch falls back to plain mode.

There is no `orch login` — each runner uses its own auth (`claude` via its own login, `codex login`).

## Install

The recommended path is Homebrew, which installs a standalone binary — no Bun is required for orch itself (you still need Bun only if you run workflows that import Bun APIs):

```bash
brew tap futuredapp/orch
brew trust futuredapp/orch   # Homebrew 5.1+ only — see note below
brew install orch
orch --help
```

> **Homebrew 5.1+ requires trusting third-party taps.** Since Homebrew 5.1, formulae from taps outside the official set are not loaded until you trust the tap, so `brew install orch` fails with `Refusing to load formula … from untrusted tap futuredapp/orch`. Run `brew trust futuredapp/orch` once, then re-run the install. On older Homebrew versions the `trust` command does not exist — skip that line if `brew trust --help` errors.

Upgrade later with `brew upgrade orch`.

Alternatively, run orch through `bunx` without installing it (requires Bun from the prerequisites above):

```bash
bunx orch --help
```

## Scaffold a project

From your project root:

```bash
orch init
```

This creates a single `.orch/` directory and registers state files in `.gitignore`:

```
my-project/
├── .gitignore            # `.orch/state/` appended by orch init
└── .orch/
    ├── orch.config.ts    # workflow manifest (name → file path)
    ├── workflows/
    │   └── hello.ts      # the hello-world workflow scaffolded for you
    └── state/            # per-run state — gitignored
        └── <run-id>/
            ├── state.json
            └── logs/
```

`orch.config.ts` and everything under `workflows/` are committed to your repo. `.orch/state/` is gitignored. `orch init` is safe to re-run — it prompts before touching an existing `.orch/`.

## Your first workflow

A workflow is a TypeScript file that default-exports a `workflow(...)`. Here is a complete one-step program — read it top to bottom:

```ts
// .orch/workflows/hello.ts
import { workflow, step, claude } from 'orch'
import { fileProduced } from 'orch'

const CREATE_FILE = step.define('create-hello-file', {
  agent: claude(),
  prompt:
    'Create a file at ./hello.txt containing exactly the text "Hello World" ' +
    '(no trailing newline, no code fences, no extra explanation).',
  validate: fileProduced('hello.txt'),
})

export default workflow('hello', async (run) => {
  await run(CREATE_FILE)
})
```

Three things are happening:

- `step.define('create-hello-file', { ... })` declares a reusable step. The name is its memoization key — keep it stable and meaningful.
- `agent: claude()` says this step runs the Claude Code CLI. `prompt:` is the default instruction.
- `validate: fileProduced('hello.txt')` asserts the file exists after the step. If it does not, the step fails.

## Register and run it

Add the workflow to your config so `orch run` can find it by name:

```ts
// .orch/orch.config.ts
import { defineConfig } from 'orch'

export const config = defineConfig({
  workflows: {
    hello: './workflows/hello.ts',
  },
})
```

Then run it:

```bash
orch run hello
```

What happens:

1. orch creates `.orch/state/<run-id>/` and picks a [run mode](/reference/cli#run-modes) (two-pane if you have a TTY and tmux, otherwise plain).
2. It spawns the `claude` CLI with your prompt and streams the transcript.
3. When Claude exits, orch runs the `fileProduced` validator, persists the result to `state.json`, and reports success.

If the run is interrupted, resume it:

```bash
orch resume --latest
```

The workflow function re-executes from the top; the finished step returns its cached value, and execution picks up where it stopped.

## Where to go next

- [Core concepts](/guide/3-core-concepts) — understand steps, runs, modes, and resume.
- [Writing a workflow](/guide/4-writing-a-workflow) — chaining steps, passing data, and looping.
- [Authoring API reference](/reference/api) — every export from the `orch` package.
