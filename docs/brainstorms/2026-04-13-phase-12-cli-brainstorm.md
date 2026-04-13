---
date: 2026-04-13
status: active
topic: Phase 12 — CLI
---

# Phase 12 — CLI Brainstorm

## What We're Building

A terminal interface for the orch orchestrator. Five commands:

| Command | Purpose |
|---|---|
| `orch run <name>` | Execute a named workflow from `orch.config.ts` |
| `orch resume [id]` | Resume a crashed run (latest crashed if no ID given) |
| `orch runs` | List all runs with status glyphs |
| `orch status <id>` | Compact table of steps, durations, and outcomes |
| `orch dry-run <name>` | Preflight validation + first-step peek |

## Why This Approach

### Explicit registry over file paths

Users define workflows in `orch.config.ts` at the project root and reference them by name (`orch run deploy`), not by file path. This gives:

- Clean, memorable names in `orch runs` output.
- A single manifest that documents what workflows exist.
- A natural place to add per-workflow config later (if ever needed).

Config lookup is **cwd-only** — no directory walking. Users run `orch` from the project root, like they do with `bun`, `biome`, etc.

```typescript
// orch.config.ts
export default {
  workflows: {
    deploy: './workflows/deploy.ts',
    review: './workflows/review.ts',
  }
}
```

### Dry-run: preflight + first-step peek

Full step-graph listing is **not feasible** because workflows are imperative functions with conditionals and loops driven by step output. You can't know what steps will run without running them.

Instead, `dry-run` does:

1. **Preflight** — load config, resolve workflow file, verify runner CLIs exist on PATH.
2. **First-step peek** — execute the workflow with a special `run()` that captures the first step definition and aborts. Shows the entry point without committing to a full run.

```
$ orch dry-run deploy

 orch.config.ts loaded
 Workflow 'deploy' resolved
 claude found at /usr/local/bin/claude

First step: brainstorm (claude)
  prompt: "Analyze the codebase..."

(Cannot show further steps — control flow depends on results)
```

### Resume defaults to latest crashed

`orch resume` with no argument finds the most recent crashed run and resumes it. Covers the 90% use case. Explicit `orch resume <id>` for targeting a specific run.

### Compact table for status

One line per step with status glyph, name, duration, and exit info. Human-scannable. No `--json` flag for now (YAGNI — users can `cat .orch/<id>/state.json | jq` if they need machine output).

```
$ orch status r-2026-04-13-a1b2

Workflow: deploy  Status: crashed
Run ID:   r-2026-04-13-a1b2

   brainstorm     12.3s
   plan            8.1s
   implement      45.2s  EXIT 1
   review         —

Crashed at step: implement
```

### Hardcoded composition root

A single `createDeps(cwd)` function in `src/cli/` instantiates all real services. No DI container, no config-driven overrides. Tests bypass the CLI entry point and inject fakes directly.

### Argv parsing: `util.parseArgs`

Zero dependencies. Uses Node's built-in `util.parseArgs` (available in Bun) for flag handling, with positional args for commands and names. Stays under ~50 lines.

```typescript
import { parseArgs } from 'node:util'

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    verbose: { type: 'boolean', short: 'v' },
    help: { type: 'boolean', short: 'h' },
  },
  allowPositionals: true,
})

const [cmd, ...rest] = positionals
```

## Key Decisions

1. **Registry, not file paths** — `orch.config.ts` maps names to workflow files. cwd-only lookup.
2. **`defineConfig()` helper** — Vite-style typed helper for autocomplete. `import { defineConfig } from 'orch'`.
3. **Dry-run = preflight + first-step peek** — static step graph is impossible with imperative DSL.
4. **Resume defaults to latest crashed** — explicit ID optional.
5. **Compact human table for status** — no `--json` flag yet.
6. **Hardcoded composition root** — `createDeps(cwd)` wires real services. No DI framework.
7. **`util.parseArgs` for argv** — zero deps, structured flag parsing.
8. **No framework** — no commander, yargs, or clipanion. Hand-rolled dispatch.
9. **Specific exit codes** — 0 success, 1 workflow/step failure, 2 config/usage error, 3 run not found.
10. **No `--status` filter on `orch runs`** — YAGNI. Plain list for now.
11. **`workflowName` in RunState (schema v3)** — add the field so `orch runs` and `orch status` can display it.

## Resolved Questions

1. **Config type shape** — `defineConfig()` helper (Vite pattern). Gives autocomplete for free.
2. **Exit codes** — Specific: 0 success, 1 step failure, 2 config/usage error, 3 run not found.
3. **`orch runs` filtering** — Deferred. No `--status` flag for now.
4. **Workflow name in state** — Add `workflowName` to RunState, bump to schema v3.
