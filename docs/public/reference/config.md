# Configuration

## orch.config.ts

orch is configured by a single file. Two locations are supported, discovered by walking up from the current directory to `/`:

1. `.orch/orch.config.ts` — recommended (everything orch-related stays inside `.orch/`).
2. `orch.config.ts` — root-level, also supported.

When both exist at the same level, the `.orch/` one wins. Like `vite.config.ts`, the config resolves from any subdirectory of your project.

```ts
import { defineConfig } from 'orch'

export const config = defineConfig({
  workflows: {
    hello: './workflows/hello.ts',
    feature: './workflows/feature.ts',
  },
  defaultMode: 'two-pane',
})
```

`defineConfig` is a typed identity helper. You may also `export default` the same object — `export const config` is preferred (the linter flags default exports).

### Fields

| Field | Type | Notes |
| --- | --- | --- |
| `workflows` | `Record<string, string>` | Required. Maps a workflow name to its file path. Relative paths resolve against the config's directory. Absolute paths are used as-is. Paths containing `..` are rejected. |
| `defaultMode` | `'plain' \| 'single-pane' \| 'two-pane'` | Optional fallback when mode autodetection can't pick a host. `single-pane` is resolved later and exits with the deferral message. |
| `prompts` | `{ include: string[]; exclude: string[] }` | Optional. Glob patterns the [`orch types`](/reference/cli#types) codegen scans for `.md`/`.txt` prompt files. Defaults to `.orch/workflows/**/*.{md,txt}` and `.orch/prompts/**/*.{md,txt}`. Explicit configuration replaces the defaults — it does not merge. |

The config is validated at load time; an invalid shape exits with `CONFIG_ERROR` (code 2) and a message naming the offending field.

::: warning Config files execute arbitrary code
`orch.config.ts` is imported and run, same trust model as `vite.config.ts` / `vitest.config.ts`. orch does not sandbox it.
:::

## Environment variables

| Variable | Effect |
| --- | --- |
| `ORCH_DEBUG=1` | Equivalent to `--debug`: heavy captures (raw agent stdout/stderr, tmux pipe-pane, subprocess spawns, internal trace) under `.orch/state/<runId>/logs/`. |
| `ORCH_NONINTERACTIVE=1` | Equivalent to `--noninteractive`: `ask()` steps resolve from `defaultWhenNoninteractive`. For CI and scheduled runs. |
| `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` | Passed through to the Claude CLI; makes tmux copy-mode scrollback work in two-pane mode. See [Runners](/reference/runners#scrollback-in-two-pane-mode). |

CLI flags take precedence over the corresponding environment variable.

## State directory

Each run writes to `.orch/state/<run-id>/`, which `orch init` adds to `.gitignore`:

```
.orch/state/r-2026-05-27-143052-7k/
├── state.json                # persisted step results, status, args
└── logs/
    ├── events.ndjson         # merged runner events
    ├── lifecycle.ndjson      # step + host lifecycle
    ├── timeline.ndjson       # source-tagged merged stream
    └── agents/<step>/        # per-step transcript + metadata
```

See [Debugging](/guide/6-debugging) for how to read these.

## Where to go next

- [CLI reference](/reference/cli) — the flags these settings mirror.
- [Getting started](/guide/2-getting-started) — scaffolding `.orch/` with `orch init`.
