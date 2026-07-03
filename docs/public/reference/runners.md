# Runners

A **runner** is an adapter around a coding-agent CLI. You pass a runner instance to a step's `agent:` field. orch ships two: [`claude()`](#claude) and [`codex()`](#codex). You can [write your own](#custom-runners).

```ts
import { claude, codex } from 'orch'
```

Each runner spawns the real CLI, so the corresponding binary must be on your `PATH`.

## claude

```ts
function claude(options?: ClaudeOptions): Runner

interface ClaudeOptions {
  readonly model?: string          // e.g. 'claude-opus-4-7'
  readonly maxTurns?: number       // cap agent turns
  readonly bare?: boolean          // pass --bare (API-key-only auth); default false
  readonly permissions?: 'bypass'  // 'bypass' => --permission-mode bypassPermissions
  readonly flags?: readonly string[]  // extra CLI flags, passed through
}
```

Spawns the `claude` CLI. Supports structured output (`--json-schema`), interactive mode, and auto-stop.

```ts
const PLAN = step.define('plan', {
  agent: claude({ model: 'claude-opus-4-7' }),
  prompt: 'Draft a plan.',
})
```

::: tip `bare` and authentication
`--bare` tells the Claude CLI to read auth strictly from `ANTHROPIC_API_KEY` (or `apiKeyHelper`) and never from the keychain. It is off by default, so subscription / OAuth users (Claude Pro) work out of the box. Pass `bare: true` to opt in for API-key-only environments (e.g. CI with `ANTHROPIC_API_KEY` set). For autonomous steps that need to skip permission prompts, pass `permissions: 'bypass'` (it expands to `--permission-mode bypassPermissions`).
:::

### Scrollback in two-pane mode

Claude Code uses its own alternate screen by default. To make tmux copy-mode scrollback work, export this in your shell before launching orch:

```sh
export CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1
```

orch does not set it for you — Claude has its own in-app scrollback (`Ctrl+O`) that many users prefer.

## codex

```ts
function codex(options?: CodexOptions): Runner

interface CodexOptions {
  readonly model?: string
  readonly sandbox?: 'full-auto' | 'read-only' | 'workspace-write' | 'danger-full-access'
  readonly flags?: readonly string[]
}
```

Spawns the `codex` CLI (≥ 0.118.0). Supports structured output (`--output-schema`), interactive mode, and auto-stop. orch performs a version preflight and throws `CodexVersionError` if the installed CLI is too old.

```ts
const DRAFT = step.define('draft', {
  agent: codex({ sandbox: 'workspace-write' }),
  prompt: 'Write a one-line topic sentence to ./note.txt',
})
```

- `sandbox: 'workspace-write'` lets Codex write into the workflow cwd without prompting.
- Codex's interactive default includes `--no-alt-screen`, so the right pane keeps a flat buffer that composes with copy-mode scrollback. Opt back in with `flags: ['--alt-screen']`.

## Choosing structured output vs interactive

Structured output (`returns:` on a step) requires the agent to run autonomously — Codex's `--output-schema` is only available in `codex exec` (autonomous) mode. A step that combines `mode: 'interactive'` with `returns:` is rejected at definition time. Use autonomous steps when you need typed data back; use interactive steps (optionally with `autoStop`) when you want to watch or drive the agent.

## Custom runners

Both `claude()` and `codex()` are built on the public `defineRunner` API — wrapping a new CLI (Aider, Amp, Ollama, …) is a first-class operation, not a plugin afterthought.

```ts
import { defineRunner } from 'orch'
```

A runner implements four methods (build the command, parse events, detect the terminal event, extract structured output) and declares its capabilities. The full walkthrough lives in the **runner-author** skill in this repo and in [Add a runner](/guides/add-a-runner).

## Where to go next

- [Authoring API reference](/reference/api) — how runners plug into `step.define`.
- [Add a runner](/guides/add-a-runner) — wrap a new CLI.
