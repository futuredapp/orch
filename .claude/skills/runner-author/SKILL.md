---
name: runner-author
description: How to add a new Runner adapter (Aider, Amp, Ollama, or any new coding-agent CLI) to the orch project. Use when wrapping a new CLI agent.
---

# Runner Author Guide

A `Runner` is an adapter that lets the orchestrator drive a coding-agent CLI. All runners implement the same interface. Adding one is a single PR touching one folder.

## Folder layout

```
src/runners/<name>/
├── index.ts              # exports { <name>() factory }
├── <name>-runner.ts      # buildCommand, parseEvents, extractStructuredOutput
└── <name>-events.ts      # (optional) stream parser if needed

tests/unit/runners/<name>/
└── <name>-runner.test.ts

tests/integration/
├── <name>-runner-mocked-process.test.ts      # runs on every `bun test`
└── <name>-runner-real.integration.test.ts    # auto-skipped if CLI missing

tests/fixtures/<name>/
├── simple-success.jsonl                      # canned transcript for unit tests
└── with-structured-output.jsonl              # (if runner supports structured output)
```

## The Runner interface

```ts
export interface Runner {
  name: string
  supports: { interactive: boolean; structuredOutput: boolean }

  buildCommand(ctx: RunnerContext): { argv: string[]; env: Record<string, string> }
  parseEvents(line: string): RunnerEvent | null
  extractStructuredOutput(finalEvent: RunnerEvent, schema: ZodSchema): unknown
  escalationWiring?(ctx: RunnerContext): EscalationBinding   // optional
}
```

## Minimal example (30 lines)

```ts
// src/runners/myagent/myagent-runner.ts
import { defineRunner } from '@orch/runners/runner'

export const myagent = defineRunner({
  name: 'myagent',
  supports: { interactive: true, structuredOutput: false },

  buildCommand: (ctx) => ({
    argv: ['myagent', '--prompt', ctx.prompt, ...(ctx.extraArgs ?? [])],
    env: { ...ctx.env, MYAGENT_KEY: ctx.secrets.MYAGENT_KEY },
  }),

  parseEvents: (line) => {
    if (line.startsWith('DONE:')) return { type: 'turn-complete' }
    if (line.startsWith('TOOL:')) return { type: 'tool-call', tool: line.slice(5) }
    if (line.startsWith('ERR:')) return { type: 'error', message: line.slice(4) }
    return null
  },

  extractStructuredOutput: () => {
    throw new Error('myagent does not emit structured output')
  },
})
```

## Required tests (non-negotiable)

1. **Unit test** (`tests/unit/runners/myagent/myagent-runner.test.ts`):
   - Asserts `buildCommand` produces the expected argv/env for a known context.
   - Asserts `parseEvents` recognises every line shape the runner cares about.
   - Asserts `parseEvents` returns `null` for unrecognised lines.
   - Asserts `extractStructuredOutput` throws with a clear error when unsupported.

2. **Mocked integration test** (`tests/integration/myagent-runner-mocked-process.test.ts`):
   - Uses `FakeProcessService` scripted from `tests/fixtures/myagent/simple-success.jsonl`.
   - Runs the full runner lifecycle and asserts the final result.
   - This is the test that catches "I parsed one line wrong" bugs — it MUST use a real fixture file, not an inline string.

3. **Real integration test** (`tests/integration/myagent-runner-real.integration.test.ts`):
   - Starts with a guard:
     ```ts
     if (!Bun.which('myagent')) {
       test.skip('real myagent CLI not on $PATH — install and set RUN_REAL_MYAGENT=1 to run')
     }
     ```
   - Runs a tiny "reply with OK" prompt against the real CLI.
   - Asserts a real run completes and produces the expected final event.

## Register it

Export from `src/runners/index.ts`:

```ts
export { myagent } from './myagent/index.ts'
export type { MyAgentOptions } from './myagent/myagent-runner.ts'
```

## Done checklist

- [ ] 4-method adapter in `src/runners/<name>/`
- [ ] Unit test covering every `parseEvents` line shape
- [ ] Mocked integration test using a real fixture file
- [ ] Real integration test that auto-skips when the CLI is missing
- [ ] Exported from `src/runners/index.ts`
- [ ] `bun run check` passes
- [ ] PR description lists tests added at each layer

Follow the `testing-strategy` skill for how each of those tests should be shaped.
