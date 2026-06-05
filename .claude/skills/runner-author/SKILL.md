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

tests-new/unit/runners/<name>/
└── <name>-runner.test.ts

tests-new/integration/
├── <name>-runner-mocked-process.test.ts      # runs on every gate
└── <name>-runner-real.integration.test.ts    # auto-skipped if CLI missing

tests-new/_support/fixtures/<name>/
├── simple-success.jsonl                      # canned transcript for unit tests
└── with-structured-output.jsonl              # (if runner supports structured output)
```

> **Test home & shape.** Runner tests follow the unchanged three-layer model (`unit` / `integration` / `e2e`) — see [`docs/testing-strategy.md`](../../../docs/testing-strategy.md). Their **target** home is `tests-new/` (mirroring `src/`); during the repo-wide test migration the non-two-pane tree is still relocating, so if `tests/integration/` is where the other runner tests currently live, it is also fine to add yours there and let parent U11 relocate them as a batch. **Raw CLI parser fixtures stay at the runner layer** (the `.jsonl` transcripts above) — they are *not* replaced by two-pane `recorded-agent` cassettes, which capture orch's normalised `RunnerEvent` stream, not raw CLI stdout.

## The Runner interface

```ts
export interface Runner {
  name: string
  supports: { interactive: boolean; structuredOutput: boolean }

  buildCommand(ctx: RunnerContext): { argv: string[]; env: Record<string, string> }
  parseEvents(line: string): RunnerEvent | null
  extractStructuredOutput(finalEvent: RunnerEvent, schema: ZodSchema): unknown
  toTranscriptLines(event: RunnerEvent): readonly TranscriptLine[]
  escalationWiring?(ctx: RunnerContext): EscalationBinding   // optional
}
```

## Why `toTranscriptLines` is required

Hosts know nothing about your runner's NDJSON shape; you do. Map every
`RunnerEvent` your `parseEvents` emits into one or more `TranscriptLine`s.
Return `[]` to suppress (e.g. `rate_limit_event`). Throwing is safe — the
executor catches and falls back to `[]` per event — but a thrown formatter
means no text reaches the screen for that event.

```ts
export type TranscriptCategory =
  | 'system' | 'thinking' | 'tool-call' | 'tool-result' | 'tool-error' | 'assistant'

export type TranscriptLine =
  | { kind: 'line'; category: TranscriptCategory; label?: string; body: string }
  | { kind: 'block'; heading: 'done' | 'failed'; rows: readonly (readonly [string, string])[] }
```

Rules:

- **Truncate at the source.** Long file paths use middle-ellipsis; long
  command/JSON values get tail-ellipsis (`…`). Recommended caps: file paths
  60 chars, Bash commands 120, generic tool input JSON 80, tool-result first
  line 80, error messages 200, assistant text 4000.
- **One terminal block per terminal event.** `terminal/turn-complete` →
  `kind: 'block', heading: 'done'`; `terminal/error` → `heading: 'failed'`.
  Rows are `[label, value]` tuples — typically `result`, `duration`, `turns`,
  `cost`, `tokens`, `permissions`, `session`. Omit rows whose value is
  unavailable rather than emitting `'?'`.
- **Stay free of ANSI.** The host owns color, glyphs, the `[<step>] ` prefix,
  and the block heading. You return raw text.
- **Walk nested envelopes.** Many CLIs (Claude, Codex) put the interesting
  content blocks inside `payload.message.content[]`. The top-level
  `event.type` is just an envelope tag — don't switch on it like a leaf.

See `src/runners/claude/format-event.ts` for a worked example. The Claude
formatter walks `payload.message.content[]`, emits one line per nested
block (`thinking`, `tool_use`, `text`, `tool_result`), and turns
`turn-complete` into a `done` block with rows.

## Environment

Build the subprocess env via `mergeEnv(processEnv, extras, ctxEnv)` from `src/services/process/merge-env.ts` (re-exported via `src/services/index.ts`). Passthrough by default — the child sees the same env the orch process saw, with `undefined` values filtered. `extras` is a runner/mode-specific override slot (today the only entry is `{ FORCE_COLOR: '3' }` for Claude in interactive mode); `ctx.env` always wins last on conflict, so workflow authors can disable extras (`FORCE_COLOR=0`) per step. No allowlist, no filtering. See [2026-04-27 env passthrough plan](../../../docs/plans/2026-04-27-feat-env-passthrough-plan.md).

## Minimal example (30 lines)

```ts
// src/runners/myagent/myagent-runner.ts
import { defineRunner } from '@orch/runners/runner'
import { mergeEnv } from '@orch/services'

export const myagent = defineRunner({
  name: 'myagent',
  supports: { interactive: true, structuredOutput: false },

  buildCommand: (ctx) => ({
    argv: ['myagent', '--prompt', ctx.prompt, ...(ctx.extraArgs ?? [])],
    // Passthrough; ctx.env wins last. No extras for myagent.
    env: mergeEnv(process.env, {}, ctx.env),
  }),

  parseEvents: (line) => {
    if (line.startsWith('DONE:')) return { kind: 'terminal', type: 'turn-complete' }
    if (line.startsWith('TOOL:')) return { kind: 'info', type: 'tool-call', payload: { name: line.slice(5) } }
    if (line.startsWith('ERR:')) return { kind: 'terminal', type: 'error', message: line.slice(4) }
    return null
  },

  extractStructuredOutput: () => {
    throw new Error('myagent does not emit structured output')
  },

  toTranscriptLines: (evt) => {
    if (evt.kind === 'terminal' && evt.type === 'turn-complete') {
      return [{ kind: 'block', heading: 'done', rows: [['result', 'ok']] }]
    }
    if (evt.kind === 'terminal' && evt.type === 'error') {
      return [{ kind: 'block', heading: 'failed', rows: [['message', evt.message]] }]
    }
    if (evt.kind === 'info' && evt.type === 'tool-call') {
      const name = (evt.payload as { name?: string } | undefined)?.name ?? '?'
      return [{ kind: 'line', category: 'tool-call', label: name, body: '' }]
    }
    return []
  },
})
```

## Required tests (non-negotiable)

1. **Unit test** (`tests-new/unit/runners/myagent/myagent-runner.test.ts`):
   - Asserts `buildCommand` produces the expected argv/env for a known context.
   - Asserts `parseEvents` recognises every line shape the runner cares about.
   - Asserts `parseEvents` returns `null` for unrecognised lines.
   - Asserts `extractStructuredOutput` throws with a clear error when unsupported.

2. **Mocked integration test** (`tests-new/integration/myagent-runner-mocked-process.test.ts`):
   - Uses `FakeProcessService` scripted from `tests-new/_support/fixtures/myagent/simple-success.jsonl`.
   - Runs the full runner lifecycle and asserts the final result.
   - This is the test that catches "I parsed one line wrong" bugs — it MUST use a real fixture file, not an inline string.

3. **Real integration test** (`tests-new/integration/myagent-runner-real.integration.test.ts`):
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
