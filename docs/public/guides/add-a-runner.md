# Add a runner

> **What you'll learn:** how to wrap a new coding-agent CLI (Aider, Amp, Ollama, …) as an orch runner with `defineRunner`.

A runner is an adapter around a CLI. `claude()` and `codex()` are built on the same public `defineRunner` API you'll use — wrapping a new CLI is a first-class operation, not a plugin afterthought. This repo also ships a **runner-author** skill that walks a contributor through it interactively; this page is the orientation.

## The shape of a runner

`defineRunner(config)` validates the config and returns it frozen. A runner declares its name and capabilities, then implements four methods:

```ts
import { defineRunner } from 'orch'
import { mergeEnv } from 'orch'

export function myAgent(options: { model?: string } = {}) {
  return defineRunner({
    name: 'my-agent',
    supports: { interactive: false, structuredOutput: false },

    // 1. Build the argv + env to spawn the CLI for one step.
    buildCommand(ctx) {
      const argv = ['my-agent', '--print', ctx.prompt, ...ctx.extraArgs]
      return { argv, env: mergeEnv(process.env, {}, ctx.env) }
    },

    // 2. Parse one line of the CLI's stdout into a RunnerEvent (or null to skip).
    parseEvents(line) {
      const text = line.trim()
      if (text === '') return null
      if (text === '[done]') return { kind: 'terminal', type: 'turn-complete' }
      return { kind: 'info', type: 'message', payload: { text } }
    },

    // 3. Pull structured output from the terminal event (only when supported).
    extractStructuredOutput() {
      return undefined
    },

    // 4. Format a RunnerEvent into transcript lines for the host to render.
    toTranscriptLines(event) {
      if (event.kind === 'info' && typeof event.payload?.text === 'string') {
        return [{ kind: 'line', category: 'assistant', body: event.payload.text }]
      }
      return []
    },
  })
}
```

Then use it like any built-in runner:

```ts
const WORK = step.define('work', { agent: myAgent(), prompt: 'Do the thing.' })
```

## The four required methods

| Method | Job |
| --- | --- |
| `buildCommand(ctx)` | Turn a [`RunnerContext`](/reference/runners) (cwd, env, prompt, `extraArgs`, optional `schema`/`mode`/`sessionId`) into `{ argv, env }`. May be async (e.g. to write a temp schema file). |
| `parseEvents(line)` | Parse one stdout line into a `RunnerEvent`, or `null` to ignore it. Emit a `{ kind: 'terminal' }` event when the agent's turn ends. |
| `extractStructuredOutput(finalEvent)` | Pull the typed result out of the terminal event. Return `undefined` when the runner doesn't support structured output. |
| `toTranscriptLines(event)` | Pure formatter: map a `RunnerEvent` to zero or more `TranscriptLine`s. No I/O. Return `[]` to suppress an event. |

The `supports` flags declare what the runner can do: `interactive` (can it run a TUI?) and `structuredOutput` (can it honor a `returns:` schema?). orch checks these before spawning.

## Optional capabilities

Three methods are optional — implement them only if the CLI can. orch detects each by `typeof runner.method === 'function'`; there are no extra `supports` flags:

- **`resumeCommand(ctx, sessionId)`** — build the argv to resume a captured session. Without it, resume of an interactive step is refused.
- **`captureSessionId(ctx)`** — capture the CLI's own session id post-spawn (Codex's `thread_id`). Skip it if the CLI accepts a pre-set id.
- **`prepareAutoStop(ctx)`** — register a signal-only stop hook so [`autoStop: true`](/guides/interactive-steps#keep-an-interactive-step-from-stalling-a-pipeline) works. Without it, a step setting `autoStop` fails fast with `AutoStopUnsupportedError`.

## Env policy: passthrough

Build the subprocess env with `mergeEnv(process.env, extras, ctx.env)`. No filtering, no allowlist:

- `process.env` — the base.
- `extras` — runner/mode-specific overrides (e.g. `{ FORCE_COLOR: '3' }`).
- `ctx.env` — always wins last.

The `env` you return from `buildCommand` is a *full replacement* handed to `ProcessService` — orch does not merge it again, so build the complete environment with `mergeEnv`.

## Where the code and tests live

A runner lives under `src/runners/<name>/` and is exported from `src/runners/index.ts`. Like every subprocess in orch, it spawns through `ProcessService` — never `child_process` or `Bun.spawn` directly. Each runner ships **two** integration tests: a mocked one (against the `ProcessService` port) and a real one (auto-skipped when the CLI is absent). The **runner-author** and **testing-strategy** skills in this repo walk through both.

## Where to go next

- [Runners reference](/reference/runners) — the `Runner` interface and `RunnerContext` in full.
- [Chain two agents](/guides/chain-two-agents) — use your runner alongside `claude()` and `codex()`.
- [Typed returns](/guides/typed-returns) — what `extractStructuredOutput` feeds.
