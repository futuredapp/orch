---
title: Autonomous-step transcript rendering — make non-interactive runs legible
type: feat
status: active
date: 2026-04-28
brainstorm: docs/brainstorms/2026-04-28-autonomous-transcript-rendering-brainstorm.md
---

# Autonomous-step transcript rendering

## Overview

Today, `--mode=plain --format=text` and the right pane in `--mode=two-pane` render an autonomous Claude run as a column of useless type names (`· system`, `· user`, `· user`, …). This plan replaces that generic best-effort with **runner-owned formatting**: each runner adapter knows its own event shape and emits structured `TranscriptLine`s; hosts handle ANSI, prefixes, and block framing. Same renderer feeds plain text and the tmux right pane. A multi-line completion summary block prints on `terminal/turn-complete` (or `terminal/error`).

The data is already on disk at `examples/.orch/state/<runId>/steps/<step>.transcript.ndjson` — we just stop dropping it on the way to the screen.

## Problem Statement / Motivation

`src/hosts/plain/transcript-text.ts:35-48` switches on top-level `event.type`:

```ts
switch (event.type) {
  case 'assistant':    return renderAssistant(event)
  case 'tool_use':     return renderToolUse(event)
  case 'tool_result':  return renderToolResult(event)
  default:             return `· ${event.type}`
}
```

Claude Code's NDJSON has those interesting types **nested** inside `payload.message.content[<i>]`. The top-level types it actually emits are `system`, `assistant`, `user`, `rate_limit_event`. So:

- `tool_use` / `tool_result` / `text` / `thinking` never match → fall through to `· <type>`.
- `renderAssistant` reads `payload.text`, but the real path is `payload.message.content[<i>].text` → returns `null`.
- `terminal/turn-complete` is suppressed (`return null`), so the final answer + cost + duration + token usage **never reaches the screen**, even though it's all in the data.

The result: a 6-turn riddle solve renders as five `· <type>` lines and nothing else. Useless for sanity-checking a long run, useless in a CI tail, useless to anyone reading the right pane in two-pane mode.

The same shape mismatch is latent for any runner whose payload isn't flat — Codex's `turn.*` events, future runners, etc. The host doesn't know runner shapes; the runner does. The fix is to push formatting to the runner and make it a first-class part of the `Runner` interface.

## Proposed Solution

The runner becomes the source of truth for how its events render. Per CLAUDE.md rule 2 ("Runners are adapters"), each `Runner` gains a **required** `toTranscriptLines` method. The executor pre-formats every event and passes the resulting lines to the host alongside the raw event:

```ts
// src/runners/types.ts (additions)

/**
 * Semantic categorization of a transcript line. Hosts map category to visual
 * treatment (glyph, color). Runners stay free of presentation policy.
 */
export type TranscriptCategory =
  | 'system'        // host renders as `·` dim grey
  | 'thinking'      // host renders as `○` dim grey
  | 'tool-call'     // host renders as `▸` cyan
  | 'tool-result'   // host renders as `◂` dim
  | 'tool-error'    // host renders as `✗` bright red
  | 'assistant'     // host renders as `assistant>` bright white

export type TranscriptLine =
  | { readonly kind: 'line'; readonly category: TranscriptCategory; readonly label?: string; readonly body: string }
  | { readonly kind: 'block'; readonly heading: 'done' | 'failed'; readonly rows: ReadonlyArray<readonly [label: string, value: string]> }

export interface Runner {
  // …existing fields…
  /** Pre-format a runner event into transcript lines. Return `[]` to suppress. */
  toTranscriptLines(event: RunnerEvent): readonly TranscriptLine[]
}
```

```ts
// src/hosts/host.ts (signature change)
onRunnerEvent(event: RunnerEvent, step: StepName, lines: readonly TranscriptLine[]): void
```

The executor at `src/core/workflow.ts:603` calls `runner.toTranscriptLines(evt)` and passes the result through. Hosts render `lines` for `--format=text` (plain or tmux right pane); `--format=json` keeps using the raw `event` for NDJSON output.

`terminal/turn-complete` for autonomous steps expands into a `kind: 'block'` with `heading: 'done'` (rows: `result`, `duration`, `turns`, `cost`, `tokens`, `permissions`, `session`). For interactive steps the executor doesn't dispatch the event in the first place — the tmux pane already shows the agent's TUI.

`thinking` renders as `○ thinking` (a presence marker), not as content. Real Claude payloads have `thinking: ""` with only an encrypted `signature`; rendering the empty string would be misleading.

System init renders as a one-line summary: `· system: model=claude-opus-4-7[1m], 47 tools, 6 mcp servers`. The full payload is on disk in `transcript.ndjson` for debugging.

### Why required, not optional

The original design made `toTranscriptLines` optional with a fallback renderer in `transcript-text.ts`. Reviews flagged this as "two permanent code paths" — the bug being fixed *is* the fallback. Required forces every runner (Claude, Codex, Fake) to ship a formatter; the unknown-runner fallback disappears. FakeRunner gets a trivial 5-line implementation that returns `[]` for everything except `terminal/error`.

### Why pre-format in the executor, not pass `runner` to the host

The original design threaded `runner?: Runner` as a third arg through `onRunnerEvent`. That spreads the optional-vs-required ambiguity across three files. Pre-formatting in the executor:

- Centralizes the call to `toTranscriptLines` at one site (`workflow.ts:603`).
- Hosts receive ready-to-render data; they no longer reach back into runner internals.
- The `runner?` optional disappears from the host port.
- Host tests stop needing a fake runner just to exercise text rendering.

## Technical Approach

### Architecture

```
RunnerEvent ──┐
              ▼
       runner.toTranscriptLines(evt)  ── (executor, src/core/workflow.ts:603)
              │
              ▼  TranscriptLine[]
       host.onRunnerEvent(evt, step, lines)
              │
              ├── format=text → renderTranscriptLine(line) per element
              │                  - prefix `[<stepName>] ` (line) or none (block)
              │                  - category → glyph + color (host policy)
              │                  - block heading + indented rows
              │                  - stripAnsi on body before write
              │
              └── format=json → write raw `event` as NDJSON (lines ignored)

Same renderer feeds PlainHost (stdout) and TmuxHost (right pane).
```

Module boundaries (per CLAUDE.md rule 2):

- **Runners** own `toTranscriptLines` — they know their own NDJSON shape.
- **Hosts** own presentation — line prefix, category-to-glyph mapping, ANSI when stdout is a TTY, block heading + indentation.
- **Core (`src/core/`)** does one new thing: call `runner.toTranscriptLines(evt)` at the existing `onRunnerEvent` callsite. No knowledge of runner shapes leaks in.

### File Layout

```
src/
├── runners/
│   ├── types.ts                            # +TranscriptLine, +TranscriptCategory, +Runner.toTranscriptLines
│   ├── claude/
│   │   ├── claude-runner.ts                # wires toTranscriptLines: toClaudeTranscriptLines
│   │   ├── format-event.ts                 # NEW — Claude formatter (~250 lines, helpers inlined)
│   │   └── index.ts                        # barrel
│   ├── codex/
│   │   ├── codex-runner.ts                 # wires toTranscriptLines: toCodexTranscriptLines
│   │   ├── format-event.ts                 # NEW — Codex formatter (~120 lines)
│   │   └── index.ts                        # barrel
│   └── fake/
│       └── fake-runner.ts                  # 5-line trivial toTranscriptLines impl
├── hosts/
│   ├── host.ts                             # onRunnerEvent gains `lines` param (required)
│   ├── plain/
│   │   ├── plain-host.ts                   # passes lines to render-line; format=text path
│   │   ├── render-line.ts                  # NEW — TranscriptLine → string(s); category→ANSI; block framing
│   │   ├── strip-ansi.ts                   # unchanged
│   │   └── transcript-text.ts              # DELETED (replaced by render-line.ts)
│   └── two-pane/
│       └── tmux-host.ts                    # uses render-line; color: true (tmux owns the pane)
└── core/
    └── workflow.ts                         # calls runner.toTranscriptLines(evt) at line 603

tests/
├── unit/runners/claude/format-event.test.ts        # NEW
├── unit/runners/codex/format-event.test.ts         # NEW
└── integration/hosts/plain/
    └── transcript-render-claude.test.ts            # NEW — captured NDJSON snapshot
```

No `src/runners/_shared/format-helpers.ts`. Truncation/middle-ellipsis helpers stay inlined in `claude/format-event.ts` until a second consumer needs them (YAGNI per CLAUDE.md size-limit rule; promote to shared the day Codex's formatter actually imports one).

### Key Types

```ts
// src/runners/types.ts (additions only)

export type TranscriptCategory =
  | 'system'
  | 'thinking'
  | 'tool-call'
  | 'tool-result'
  | 'tool-error'
  | 'assistant'

export type TranscriptLine =
  | {
      readonly kind: 'line'
      readonly category: TranscriptCategory
      readonly label?: string
      readonly body: string
    }
  | {
      readonly kind: 'block'
      readonly heading: 'done' | 'failed'
      readonly rows: ReadonlyArray<readonly [label: string, value: string]>
    }

export interface Runner {
  // …existing fields stay unchanged…
  /**
   * Format a `RunnerEvent` for the human-readable transcript stream.
   * Return `[]` to suppress this event from the transcript (e.g. low-signal
   * `rate_limit_event` for Claude).
   *
   * Pure: no I/O, no external state. Called synchronously by the executor
   * before it reaches the host.
   */
  toTranscriptLines(event: RunnerEvent): readonly TranscriptLine[]
}
```

```ts
// src/hosts/host.ts (signature change)
onRunnerEvent(event: RunnerEvent, step: StepName, lines: readonly TranscriptLine[]): void
```

`lines` is required — the executor always pre-formats. `event` stays in the signature so the JSON format path keeps working without re-serializing.

### Category → Visual Mapping (host-owned)

Host implements `renderTranscriptLine(line, opts: { color: boolean; prefix: string })`. The category-to-glyph table:

| Category       | Glyph (TTY + color)                    | Plain (pipe / NO_COLOR)         |
|----------------|----------------------------------------|---------------------------------|
| `system`       | `·` dim grey                           | `· `                            |
| `thinking`     | `○` dim grey                           | `○ `                            |
| `tool-call`    | `▸` cyan                               | `▸ `                            |
| `tool-result`  | `◂` dim                                | `◂ `                            |
| `tool-error`   | `✗` bright red                         | `✗ `                            |
| `assistant`    | label `assistant>` bright white        | label `assistant>` plain        |

Block (`kind: 'block'`):

```
── done ──            (or "── failed ──")
  result        Successfully solved the riddle
  duration      22.2s
  turns         6
  cost          $0.0142
  tokens        cache R/W: 143k / 29k · in: 4.1k · out: 612
  permissions   0 denials
  session       sess-...
```

Heading is bold + dim rule chars when `color: true`; rows are indented 2 spaces. Block lines don't get the `[<stepName>] ` prefix — the heading is the step's own context.

Color helpers: reuse the existing `stripAnsi`/color machinery from `src/observability/status-pane.ts:50` rather than parallel-implementing. Auto-detect: `color = process.stdout.isTTY === true && process.env.NO_COLOR === undefined`. The tmux right pane is always a TTY (tmux owns it), so two-pane always passes `color: true`.

### Truncation (runner-owned, with explicit limits)

Per the brainstorm, runners produce already-truncated strings. The truncation table:

| Source                           | Rule                                                     |
|----------------------------------|----------------------------------------------------------|
| `Bash` command                   | up to 120 chars, single-line                             |
| `Read`/`Write`/`Edit`/`Glob` `file_path` | middle-ellipsis at 60 chars: `/…/solution.txt`           |
| Generic / unknown tool input     | `JSON.stringify(input)` truncated at 80 chars            |
| `tool_result` body               | first non-empty line up to 80 chars                      |
| Assistant `text` block           | up to **4000 chars** (single text block can be huge)     |
| `tool_result` with `is_error`    | full error text up to 200 chars; `category: 'tool-error'`|

**Known limitation:** runner-side truncation can't account for actual pane width (tmux right pane may be <80 cols; plain stdout might be 200). The tradeoff is simplicity vs. width-aware rendering. Width-aware truncation moves to the host as a follow-up (see Future Considerations); for v1 the runner picks pragmatic defaults that read well in both 80-col tmux and 120-col plain.

`middleEllipsis`, `truncate`, `firstLine` live as private functions inside `claude/format-event.ts`. They are not exported.

### Implementation Phases

Two PRs, not four. Phase A is the bulk of the work; Phase B is the Codex follow-up.

#### Phase A — Claude formatter end-to-end

**Goal:** the captured `r-2026-04-28-oiyrjv` riddle-solve transcript renders as the brainstorm's "Live stream" output in both `--mode=plain --format=text` and the `--mode=two-pane` right pane. Each PR boundary lands behind `bun run check`.

**Deliverables:**

1. **Types and interface change** (`src/runners/types.ts`):
   - Add `TranscriptCategory`, `TranscriptLine` (discriminated union).
   - Add `Runner.toTranscriptLines(event): readonly TranscriptLine[]` — **required**.
   - Update `RunnerAdapterSchema` to validate `toTranscriptLines` as a function.

2. **Host port** (`src/hosts/host.ts`):
   - Change `onRunnerEvent(event, step)` → `onRunnerEvent(event, step, lines)`.

3. **Executor wiring** (`src/core/workflow.ts:603`):
   - Replace `deps.host.onRunnerEvent(evt, key)` with:
     ```ts
     const lines = safeToTranscriptLines(runner, evt)
     deps.host.onRunnerEvent(evt, key, lines)
     ```
   - `safeToTranscriptLines` wraps the call in try/catch: on throw, log once via `SessionLogger` and return `[]` (the event is still emitted as JSON; only the human-readable line is dropped). Prevents a buggy formatter from aborting a run.
   - **Interactive steps:** the executor already filters `onRunnerEvent` for autonomous mode only — verify in code; if not, add a guard at this site so `toTranscriptLines` is never called for interactive steps.

4. **Claude formatter** (`src/runners/claude/format-event.ts`, ~250 lines):
   - `toClaudeTranscriptLines(event): readonly TranscriptLine[]` — pure switch on `event.kind` + `event.type`.
   - Inline helpers (private to this file): `middleEllipsis(path, max)`, `truncate(s, max)`, `firstLine(s)`, `formatTokens(usage) → string`.
   - Per-content-block walker for `assistant` messages (`payload.message.content[]`):
     - `thinking` → one line, `category: 'thinking'`, `label: 'thinking'`, `body: ''` (presence marker; body is empty).
     - `tool_use` → one line, `category: 'tool-call'`, `label: <tool name>`, `body: <args preview>` (per the tool-arg table below).
     - `text` → one line, `category: 'assistant'`, `label: 'assistant>'`, `body: <text truncated to 4000 chars>`.
     - Multiple content blocks in a single `assistant` message produce multiple lines, in order.
   - Per-content-block walker for `user` messages (`payload.message.content[]`):
     - `tool_result` with `is_error: true` → `category: 'tool-error'`, body = first 200 chars of content.
     - `tool_result` otherwise → `category: 'tool-result'`, body = first non-empty line of content, max 80 chars.
   - `system` init → one line, `category: 'system'`, body = `model=…, N tools, M mcp servers` (unrecognized init shapes still emit a one-line summary; missing fields render as `model=?` / `0 tools`).
   - `terminal/turn-complete` → one block, `heading: 'done'`, rows below; rows render only when present (partial `usage` is graceful).
   - `terminal/error` → one block, `heading: 'failed'`, row 1 = `message` (mapped from `event.message`).
   - `rate_limit_event`, empty `payload.message.content[]`, `null`/missing `content` → return `[]` (suppressed).
   - Unknown content-block type → `category: 'system'`, body = `· <type>` (visible but normalized; never a crash).

   Tool-arg formatting (lives inside `formatToolUse`, not a separate module):

   | Tool         | label    | body                                                |
   |--------------|----------|-----------------------------------------------------|
   | `Read`       | `Read`   | `(/…/<filename>)` — middle-ellipsis at 60 chars     |
   | `Write`      | `Write`  | `(/…/<filename>)`                                   |
   | `Edit`       | `Edit`   | `(/…/<filename>)`                                   |
   | `Glob`       | `Glob`   | `pattern: <truncate 80>`                            |
   | `Bash`       | `Bash`   | `<command truncated to 120>`                        |
   | `TodoWrite`  | `TodoWrite` | `<N todos>` (count from `input.todos.length`)    |
   | Other        | `<name>` | `<JSON.stringify(input) truncated to 80>`           |

5. **Codex placeholder** (`src/runners/codex/codex-runner.ts`):
   - Add a 1-line `toTranscriptLines: () => []` so the type checker is satisfied. Real Codex formatter lands in Phase B.

6. **FakeRunner** (`src/runners/fake/fake-runner.ts` and any test fakes):
   - Add `toTranscriptLines(evt) => evt.kind === 'terminal' && evt.type === 'error' ? [{ kind: 'block', heading: 'failed', rows: [['error', evt.message]] }] : []`.

7. **Plain host** (`src/hosts/plain/`):
   - **Delete** `transcript-text.ts` (the buggy fallback).
   - **Add** `render-line.ts`: `renderTranscriptLine(line: TranscriptLine, opts: { color: boolean; prefix: string }): string[]`.
     - `kind: 'line'` → returns one string: `${prefix}${glyph} ${label ? label + ' ' : ''}${stripAnsi(body)}`.
     - `kind: 'block'` → returns N+1 strings: heading rule + indented rows (no `prefix`).
     - Color application uses `chalk` or whatever the existing color helper is (mirror `status-pane.ts:50`).
   - **Update** `plain-host.ts:69`: `format='text'` path renders `lines` via `renderTranscriptLine`. `color = process.stdout.isTTY === true && !process.env.NO_COLOR`. JSON format path is unchanged.

8. **Tmux host** (`src/hosts/two-pane/tmux-host.ts:321-337`):
   - Same `renderTranscriptLine` import; pass `color: true` (tmux owns the pane). Indentation must match plain so two-pane and tail-of-CI-log are visually identical.

**Test fixtures:**
- Copy `examples/.orch/state/r-2026-04-28-oiyrjv/steps/solve-riddle.transcript.ndjson` → `tests/fixtures/claude/r-2026-04-28-oiyrjv.transcript.ndjson` and commit (the `examples/.orch/state` path is gitignored). This is the only fixture file added.

**Tests (lean, behavior-focused):**

- **Unit — `tests/unit/runners/claude/format-event.test.ts`** (~12 tests, full-sentence names):
  - `'renders system init as one line with model, tool count, and mcp server count'`
  - `'expands an assistant message into ordered lines per content block (thinking, tool_use, text)'`
  - `'renders multiple text blocks in a single assistant message as separate lines'`
  - `'renders Read tool_use with middle-ellipsis on a long file path'`
  - `'renders Bash tool_use with command truncated at 120 chars'`
  - `'renders TodoWrite tool_use with todo count'`
  - `'renders unknown tool_use as JSON-stringified input truncated at 80'`
  - `'renders tool_result with is_error=true as tool-error category'`
  - `'renders tool_result with multi-line content as first non-empty line'`
  - `'renders turn-complete as a done block with rows present in usage'`
  - `'renders turn-complete with partial usage by emitting only present rows'`
  - `'renders terminal/error as a failed block with the message row'`
  - `'returns [] for rate_limit_event, missing content, and empty content'`
  - `'truncates a 50KB assistant text block to 4000 chars'`

  Suppression of low-signal events is asserted by literal inspection of the returned array. Each test exercises one branch.

- **Integration — `tests/integration/hosts/plain/transcript-render-claude.test.ts`** (the load-bearing test):
  - Pipe captured `r-2026-04-28-oiyrjv` NDJSON through `parseClaudeLine → toClaudeTranscriptLines → renderTranscriptLine` against an in-memory stdout sink with `color: false`.
  - **Snapshot the plain output** — full lines including `[step] ` prefix and the multi-line summary block. Asserts content correctness without coupling to ANSI escape sequences (which churn across libraries).
  - One additional assertion in the same test: re-run with `color: true` and assert the output contains `\x1b[` escape codes (presence check, not specific sequences).

- **Executor unit — `tests/unit/core/workflow.test.ts`** (extension):
  - `'calls runner.toTranscriptLines for autonomous events and forwards lines to host.onRunnerEvent'`
  - `'catches and logs a thrown formatter; passes [] to host so the run continues'`
  - `'does not call toTranscriptLines for interactive steps'` (asserts the executor never reaches the formatter on `mode: 'interactive'`).

- **Real CLI — `tests/integration/runners/claude/claude-real.integration.test.ts`** (existing, gated `RUN_REAL_CLAUDE=1`):
  - Add one assertion: a small real run produces at least one `kind: 'block'` summary line. No new gated test file; piggyback on the existing real runner test.

**Things explicitly NOT in the test plan** (cut from the original):
- No per-glyph ANSI unit tests — the integration `color: true` presence check covers it.
- No `<50ms for 1k events` perf benchmark — premature.
- No standalone `format-helpers.test.ts` — helpers are private to `format-event.ts`, exercised through it.
- No synthetic `turn-failed.transcript.ndjson` fixture — the `terminal/error` test uses an inline literal envelope.

**Definition of Done for Phase A:** running the captured NDJSON through the chain produces the brainstorm's target output exactly (modulo trailing newlines and ANSI on/off). `bun run check` green. Manual smoke: `orch run examples/riddle.workflow.ts --mode=plain --format=text` and the same in `--mode=two-pane` show identical content.

#### Phase B — Codex formatter

**Goal:** Codex autonomous runs no longer fall through to `· <type>`; live stream and summary block work the same way as Claude.

Codex emits a thinner stream than Claude (no nested message content), but `turn.*` events produce a summary block, and `info` events get presence markers.

**Deliverables:**
- `src/runners/codex/format-event.ts` (~120 lines):
  - `turn.completed` → `kind: 'block'`, `heading: 'done'`, rows from `usage` (only present rows).
  - `turn.failed` → `kind: 'block'`, `heading: 'failed'`, row 1 = `message` from `error.message`.
  - `task_started` / `task_complete` / `task_progress` → `kind: 'line'`, `category: 'system'`, label = event type, body = one-line summary.
  - Anything not recognized → `[]`.
- Wire `toTranscriptLines: toCodexTranscriptLines` in `codex-runner.ts`.

**Tests:**
- **Unit** — `tests/unit/runners/codex/format-event.test.ts` (4-5 tests, same style):
  - `'renders turn.completed as a done block with usage rows'`
  - `'renders turn.failed as a failed block with the inner error message'`
  - `'renders an error envelope without turn.failed shape using the top-level message'`
  - `'returns [] for unknown info event types'`
- **Integration (mocked)** — extend `tests/integration/runners/codex/codex-mocked.test.ts`: feed `simple-success.jsonl` through the chain; snapshot output ends with a `── done ──` block and contains zero `· <unknown-type>` lines.

**Definition of Done for Phase B:** snapshot for any existing Codex fixture has no `· <unknown-type>` line and ends with a `── done ──` or `── failed ──` block. `bun run check` green.

## Acceptance Criteria

### Functional Requirements

- [ ] Live stream: piping a real or captured Claude run through `--mode=plain --format=text` produces the brainstorm's "Live stream" block. Specifically:
  - One `[step] · system: model=…, N tools, M mcp servers` line on init.
  - One `[step] ○ thinking` line per `thinking` content block.
  - One `[step] ▸ <Tool> <args>` line per `tool_use` content block.
  - One `[step] ◂ <result>` (or `[step] ✗ <error>`) line per `tool_result`.
  - One `[step] assistant> <text>` line per non-empty `text` content block.
- [ ] Completion summary: on `terminal/turn-complete`, prints the multi-line `── done ──` block with rows for present `usage` fields. Cache numbers humanized as `143k`/`29k`. Partial `usage` renders only present rows; never crashes.
- [ ] Failure summary: on `terminal/error`, prints the `── failed ──` block with a `message` row.
- [ ] Same renderer feeds two-pane right pane and `--mode=plain --format=text`. Output is byte-equal modulo ANSI on/off (and the `[step]` prefix on `kind: 'line'` items).
- [ ] `--format=json` is unchanged: NDJSON envelopes still flow as before.
- [ ] `events.ndjson` and `<step>.transcript.ndjson` files on disk are unchanged.
- [ ] Interactive steps: `toTranscriptLines` is never called; the tmux pane attached to the agent already shows what happened.
- [ ] Codex autonomous runs print a meaningful summary block on `turn.completed` and a `── failed ──` block on `turn.failed`. No `· <unknown-type>` lines for events the formatter recognizes.
- [ ] A buggy `toTranscriptLines` (throws) does not abort a run: the executor catches, logs once, and the host receives `[]` for that event.

### Non-Functional Requirements

- [ ] **Color:** auto on `process.stdout.isTTY === true && NO_COLOR === undefined`. Tmux right pane is always colorized. Pipes are never colorized.
- [ ] **Truncation:** Bash to 120 chars, file paths via middle-ellipsis at 60 chars, generic JSON to 80 chars, assistant text to 4000 chars, error text to 200 chars. All operate on the JS string after `JSON.stringify`; no malformed UTF-8.
- [ ] **stripAnsi** applied to every `body` before write — runner-built strings can't poison the terminal.
- [ ] **File sizes:** all new files ≤ 300 lines per CLAUDE.md rule 5; functions ≤ 60 lines.
- [ ] **No `any`, no `!`** — payloads typed as `Readonly<Record<string, unknown>>`; safe field readers (mirror the existing `readStringField` pattern in `transcript-text.ts:86`).
- [ ] **No new module-import side effects** — formatters export functions only; no logging or fs at import time.

### Quality Gates

- [ ] Unit tests cover every branch in `toClaudeTranscriptLines` and `toCodexTranscriptLines` reachable from the captured fixture.
- [ ] Integration test consumes the real captured NDJSON (`r-2026-04-28-oiyrjv`) and snapshots the rendered plain text.
- [ ] `bun run check` green at every PR boundary.
- [ ] `RUN_REAL_CLAUDE=1 bun run test:int` passes — existing real runner test now also asserts at least one `── done ──` block reaches stdout.
- [ ] No regressions in existing `--format=json` paths (existing JSON snapshot tests still pass without edits).

## Success Metrics

- **Readability:** a developer tailing a CI log of `orch run` can describe what the agent did without opening the on-disk transcript.
- **Diagnostic value:** the summary block contains every number the brainstorm calls out (cost, duration, turns, cache R/W, denials, session id) when the underlying `usage` payload contains it.
- **No drift between modes:** content piped to a file equals `tmux capture-pane -p` modulo ANSI. Verified by snapshot symmetry in the integration test (same renderer, two `color` settings).

## Dependencies & Risks

### Dependencies

- The existing `Runner` interface and `defineRunner` factory (`src/runners/types.ts:118`) — extending the interface and schema, not replacing.
- The existing `Host.onRunnerEvent` wiring (`src/core/workflow.ts:603`, `src/hosts/plain/plain-host.ts:69`, `src/hosts/two-pane/tmux-host.ts:321`) — one signature change touches all three.
- The captured NDJSON at `examples/.orch/state/r-2026-04-28-oiyrjv/steps/solve-riddle.transcript.ndjson`. **Action item in Phase A:** copy this file into `tests/fixtures/claude/` and commit it; the `examples/.orch/state/` path is gitignored.
- Existing color/strip helpers in `src/observability/status-pane.ts:50` — reuse, don't re-implement.

### Risks

- **Claude CLI shape drift.** If the Claude CLI changes the `payload.message.content[]` shape, our formatter silently degrades to the generic `· <type>` branch. Mitigation: the integration snapshot is the canonical contract; re-capture the fixture on every Claude CLI bump (existing pattern from `docs/plans/2026-04-11-feat-phase-5-claude-runner-plan.md`).
- **Buggy formatter aborts a run.** A throw inside `toTranscriptLines` would propagate up the executor. Mitigation: `safeToTranscriptLines` wrapper at the call site catches and logs; passes `[]` to the host. Covered by an executor unit test.
- **Width-aware rendering deferred.** Runner-side truncation can't know pane width. The summary block looks best at ≥ 100 cols; in narrow tmux right panes it wraps awkwardly. Documented limitation; revisit when the tmux-host width-aware rendering enhancement lands.
- **Two code paths during Phase A.** Once Claude wires `toTranscriptLines`, every other runner must too. The interface change forces all four runners (Claude, Codex placeholder, Fake, any test fakes) to update in the same PR. Mitigation: the trivial `() => []` default for Codex/Fake keeps PR size manageable.

## Resource Requirements

- Phase A: 3-4 days (most of the work — types, formatter, host, fixtures, tests).
- Phase B: half a day to one day.
- No new dependencies. Color helpers reuse `src/observability/status-pane.ts:50`.
- Test fixtures: ~4KB of NDJSON copied into `tests/fixtures/claude/`.

## Future Considerations

- **Width-aware truncation in the host.** The runner produces a `body` that may be longer than the host's pane width. A follow-up moves truncation to the host: runners emit full bodies plus a hint (`truncate: 'path' | 'oneline' | 'json'`); host clamps to its actual width. Out of scope here because v1 widths are pragmatic and the tmux pane width API isn't wired up yet.
- **Normalize at parse time.** The brainstorm's rejected alternative ("emit pre-cooked `tool-call` / `tool-result` info events with a shared schema") is the cleanest end state. We don't ship it now because no consumer exists, but a third runner (Aider, Amp) might force the issue. The `toTranscriptLines` adapter is the cheap intermediate step that defers that surgery without painting us into a corner.
- **Two-pane wrap policy.** A future tmux-host enhancement should wrap the summary block at pane width.
- **`orch logs` view.** The reframe's Phase E `orch logs <runId>` command will replay the same `toTranscriptLines` chain over the persisted `transcript.ndjson` — same renderer, different source.
- **Per-turn cost callouts.** A future enhancement could emit a tiny inline cost line on each assistant message for very long runs. Data is in `usage.input_tokens` / `output_tokens` per assistant message.

## Documentation Plan

- Update `.claude/skills/runner-author/SKILL.md`: add a section "Implement `toTranscriptLines`" with a 30-line example that mirrors `src/runners/claude/format-event.ts`. Note that the method is required and that returning `[]` is the way to suppress an event.
- Add `docs/solutions/autonomous-transcript-rendering.md` **as part of Phase A** (not after — solutions docs that lag implementation rot fast). Cover: the bug shape (`switch` mismatch), the fix shape (runner-owned formatter), the decision to make `toTranscriptLines` required, and the contract-test pattern that catches future CLI shape drift. Models after `docs/solutions/interactive-mode-colors.md`.
- Update `docs/plans/implementation-phases.md`: this work threads through Phase A (plain host) and Phase D (two-pane host). Record the two-phase landing under a new "Transcript rendering" subhead.
- No CLAUDE.md change — runner-aware rendering strengthens rule 2 ("Runners are adapters") rather than deviating from it.

## References & Research

### Internal References

- Brainstorm: [`docs/brainstorms/2026-04-28-autonomous-transcript-rendering-brainstorm.md`](../brainstorms/2026-04-28-autonomous-transcript-rendering-brainstorm.md) — settled most decisions; this plan slices them into PRs.
- The bug, line by line: `src/hosts/plain/transcript-text.ts:35-48` (switch arms), `src/hosts/plain/transcript-text.ts:50-56` (`renderAssistant` reading wrong field), `src/hosts/plain/transcript-text.ts:28-30` (`turn-complete` suppression).
- Runner interface: `src/runners/types.ts:63-81` (the spot to extend).
- Host wiring: `src/core/workflow.ts:603` (`deps.host.onRunnerEvent(evt, key)`); `src/hosts/plain/plain-host.ts:69`; `src/hosts/two-pane/tmux-host.ts:321`.
- Claude payload shape (canonical sample): `examples/.orch/state/r-2026-04-28-oiyrjv/steps/solve-riddle.transcript.ndjson`.
- Existing color helper to mirror: `src/observability/status-pane.ts:50` (`stripAnsi`).
- Project conventions: `CLAUDE.md` rules 2 (Runners are adapters), 5 (file-size limits), 7 (single barrel), 8 (no import side effects).
- Phase plan precedent for runner-side parsers: `docs/plans/2026-04-11-feat-phase-5-claude-runner-plan.md`.

### External References

- NO_COLOR convention: https://no-color.org/ (the team already follows this).
- Claude Code stream-json schema: see SDK v0.2.101 (`payload.message.content[]` shape; verified empirically against the captured NDJSON above).

### Related Work

- The reframe plan ([`2026-04-18-feat-orch-reframe-step-views-run-modes-plan.md`](2026-04-18-feat-orch-reframe-step-views-run-modes-plan.md)) defines the host/run-mode split this work plugs into. No conflicts; this is a `TranscriptView` quality improvement.
- The session-logging plan ([`2026-04-24-feat-session-logging-plan.md`](2026-04-24-feat-session-logging-plan.md)) is orthogonal — `events.ndjson` and `transcript.ndjson` are the persistence layer; this plan is the rendering layer.

## Revision Notes (2026-04-28)

This plan was revised after a multi-agent review (DHH/Kieran/code-simplicity) flagged several issues with the original four-phase design. Substantive changes:

- **Discriminated union for `TranscriptLine`** — split into `kind: 'line' | 'block'`. Original mixed visual glyphs with type tags (`'text'`, `'block'`) in a single union. Categories are now semantic (`'system'`, `'assistant'`, …); host owns the category-to-glyph mapping.
- **`toTranscriptLines` is required** — original made it optional with a fallback renderer. Two permanent code paths is exactly the bug being fixed.
- **Pre-format in the executor** — original threaded `runner?: Runner` through `Host.onRunnerEvent` per call. Now the executor calls `runner.toTranscriptLines(evt)` once and passes `lines` to the host. No host-side runner state, no optional param.
- **No `_shared/format-helpers.ts`** — original extracted helpers for "future runners." Helpers stay private to `claude/format-event.ts` until a second consumer exists.
- **Two phases, not four** — Phase A (Claude end-to-end) + Phase B (Codex). The original Phase A (no-op type plumbing) was ceremony; folded into Phase A. Phase D (color wiring) was inseparable from Phase B; folded too.
- **`safeToTranscriptLines` wrapper** — formatter throws don't abort the run.
- **Test plan trimmed** — dropped per-glyph ANSI unit tests, the `<50ms` perf benchmark, the synthetic `turn-failed.transcript.ndjson` fixture, and `format-helpers.test.ts`. Lean on the integration snapshot.
- **Edge cases added** — partial `usage` rows, `null`/missing `content`, multiple text blocks per assistant message, 50KB single text body, formatter throws.
- **`stripAnsi` consistency** — host always strips ANSI from `body` before writing.
