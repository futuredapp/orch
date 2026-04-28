---
date: 2026-04-28
topic: autonomous-transcript-rendering
status: shipped
---

# Autonomous transcript rendering — runner-owned formatting

## Symptom

A 6-turn autonomous Claude run rendered as five `· <type>` lines and nothing
else. The final answer, cost, duration, token usage, and tool errors never
reached the screen, even though every byte was already on disk at
`<runId>/steps/<step>.transcript.ndjson`. Same mismatch broke the tmux right
pane.

## Root cause

`src/hosts/plain/transcript-text.ts` switched on top-level `event.type`:

```ts
switch (event.type) {
  case 'assistant':   return renderAssistant(event)
  case 'tool_use':    return renderToolUse(event)
  case 'tool_result': return renderToolResult(event)
  default:            return `· ${event.type}`
}
```

Claude Code's NDJSON puts the interesting types **nested** inside
`payload.message.content[<i>]`. Top-level `event.type` is only `system`,
`assistant`, `user`, `rate_limit_event`. So:

- `tool_use` / `tool_result` / `text` / `thinking` never match → fall through
  to `· <type>`.
- `renderAssistant` read `payload.text`, but the real path is
  `payload.message.content[<i>].text` → returned `null`.
- `terminal/turn-complete` was hard-suppressed, so the completion summary
  never printed.

A host that hardcodes one runner's shape will silently lose data the moment
the runner's NDJSON isn't flat. Codex's `turn.*` events were latently broken
for the same reason.

## What we shipped

Push formatting to the runner. Each `Runner` adapter implements a required
method:

```ts
// src/runners/types.ts
toTranscriptLines(event: RunnerEvent): readonly TranscriptLine[]
```

`TranscriptLine` is a discriminated union:

```ts
export type TranscriptLine =
  | { kind: 'line'; category: TranscriptCategory; label?: string; body: string }
  | { kind: 'block'; heading: 'done' | 'failed'; rows: readonly (readonly [string, string])[] }
```

The executor calls `runner.toTranscriptLines(evt)` for every parsed event on
autonomous steps, then passes the lines to the host alongside the raw event:

```ts
// src/core/workflow.ts
onEvent: makeAgentEventHandler(deps, key, config.agent, …)
// inside the handler:
const lines = safeToTranscriptLines(runner, evt, deps.logger, key)
deps.host.onRunnerEvent(evt, key, lines)
```

`safeToTranscriptLines` catches formatter throws, logs once via `orchLog`, and
returns `[]` so a buggy formatter cannot abort a run. The raw event still
flows to `transcript.ndjson` and to the host's `--format=json` path
unmodified.

Hosts own presentation: glyph + color per `TranscriptCategory`, the
`[<step>] ` prefix, and the `── done ──` / `── failed ──` block heading with
2-space indented rows. `src/hosts/plain/render-line.ts` is the single
renderer; both the plain host and tmux right pane call it. Tmux always passes
`color: true`; plain host gates on `process.stdout.isTTY && !NO_COLOR`.

The Claude formatter (`src/runners/claude/format-event.ts`) walks
`payload.message.content[]` and emits one line per nested block (thinking,
tool_use, text, tool_result). `terminal/turn-complete` expands into a
`kind: 'block'` with rows for `result`, `duration`, `turns`, `cost`,
`tokens` (`cache R/W`, `in`, `out`), `permissions`, and `session`.

Interactive steps skip the formatter entirely — the executor only calls
`toTranscriptLines` on the autonomous event handler path; interactive steps
go through `runInteractiveStep` and own the TTY directly.

## Why `toTranscriptLines` is required, not optional

A missing default = no fall-through to a generic formatter that lies about
shape it doesn't understand. New runners must opt into rendering or
explicitly return `[]`. Zod validation in `RunnerAdapterSchema` rejects
adapters without it at construction time.

## Contract test pattern that catches CLI shape drift

We capture a real run's `transcript.ndjson` into `tests/fixtures/claude/` and
pipe it through the production chain
(`JSON.parse → toClaudeTranscriptLines → renderTranscriptLine`). The
integration test at
`tests/integration/hosts/plain/transcript-render-claude.test.ts` asserts:

- the system init line is present at the top
- a tool call shows up with its file path
- a tool error shows up with its message
- the final assistant text reaches the screen
- the `── done ──` block lands at the bottom with all rows
- **no `· <type>` fall-through lines anywhere** (the bug we fixed)

When Claude Code's NDJSON shape drifts, this test catches it with a real
fixture, not a hand-rolled mock. Re-capture the fixture by running the
example workflow and copying the new file in.

## What this fix does NOT do

- **Does not implement Codex.** `CodexRunner.toTranscriptLines` is a
  placeholder `() => []`. Phase B will port the same pattern over once
  Codex's nested envelope shape is mapped.
- **Does not persist runner identity in the transcript sidecar.** The `logs`
  CLI command (`src/cli/commands/logs.ts`) currently hard-codes the Claude
  formatter when replaying a saved transcript. Phase E will record runner
  name in the sidecar metadata so the replay path can look up the right
  formatter dynamically.
- **Does not change the JSON envelope.** `--format=json` still emits raw
  `event` records; only the text-rendering path is affected.

## Related

- Plan: [`docs/plans/2026-04-28-feat-autonomous-transcript-rendering-plan.md`](../plans/2026-04-28-feat-autonomous-transcript-rendering-plan.md)
- Brainstorm: [`docs/brainstorms/2026-04-28-autonomous-transcript-rendering-brainstorm.md`](../brainstorms/2026-04-28-autonomous-transcript-rendering-brainstorm.md)
- Adapter pattern: `CLAUDE.md` rule 2 ("Runners are adapters")
- Skill: `.claude/skills/runner-author/SKILL.md` — covers the
  `toTranscriptLines` requirement for new runners
