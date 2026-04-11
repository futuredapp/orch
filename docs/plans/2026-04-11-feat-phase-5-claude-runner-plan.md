---
title: "Phase 5 — Real ClaudeRunner (prompt only, no schema, no validate)"
type: feat
status: active
date: 2026-04-11
deepened: 2026-04-11
---

# Phase 5 — Real ClaudeRunner

## Enhancement Summary

**Deepened on:** 2026-04-11 via 11 research/review agents (architecture-strategist, performance-oracle, security-sentinel, code-simplicity-reviewer, pattern-recognition-specialist, kieran-typescript-reviewer, spec-flow-analyzer, framework-docs-researcher, best-practices-researcher, repo-research-analyst, agent-native-architecture)

### Key Improvements
1. **Fixed Zod schemas** against real CLI v2.1.101 / SDK v0.2.101: `is_error` → `z.boolean()`, error subtype → `z.string()`, `.passthrough()` on all schemas
2. **Resolved `--max-turns` uncertainty** — not in `claude --help` v2.1.101; verification step added
3. **Fixed compilation blockers** — `process.env` type mismatch and `errors[0]` under `noUncheckedIndexedAccess`
4. **Security hardening** — env allowlist replaces full `process.env` passthrough
5. **Eliminated unsafe `as` cast** in `extractStructuredOutput` — replaced with Zod `safeParse`
6. **Simplified** — 5 source files → 2, dropped YAGNI version preflight, 4 test files → 2

---

## Overview

First real CLI runner adapter. Wires Claude Code CLI into the existing `Runner` interface / `runRunner` executor / `ProcessService` stack from Phases 1–4. Architecture proof + usable runner.

**Scope:** prompt-only runs with `--output-format stream-json`. No `--json-schema` (Phase 7), no `--session-id` (Phase 14), no validators (Phase 6).

## Problem Statement / Motivation

Phases 1–4 built the full pipeline but only tested with `FakeRunner`. Phase 5 is the "real feedback early" milestone: first time a real subprocess drives the orchestrator. If abstractions crack under a real NDJSON stream, we find out here.

## Proposed Solution

### Command shape

```
claude --bare -p <prompt> --output-format stream-json --verbose \
  --no-session-persistence [--model <model>] [--max-turns <n>] [...flags]
```

- `--bare` suppresses interactive UI, hooks, LSP, plugins; auth is strictly `ANTHROPIC_API_KEY`
- `--output-format stream-json` emits NDJSON to stdout
- `--verbose` includes intermediate events (system init, tool calls, assistant messages)
- `--no-session-persistence` avoids disk writes for ephemeral orchestrated runs

> **`--max-turns` verification required:** Not in `claude --help` v2.1.101 despite `error_max_turns` existing in SDK. During Phase D (fixture capture), verify at runtime. Fallback: `--max-budget-usd`.

> **`claude --version` format:** `2.1.101 (Claude Code)` — parse with `/^(\d+\.\d+\.\d+)\s/`

### Options-object factory

```ts
const agent = claude({ model: 'claude-sonnet-4-20250514', maxTurns: 5 })
```

Returns a frozen `Runner` via `defineRunner()` (not a class — stateless adapter). Factory-time Zod validation of `ClaudeOptions` dropped: TypeScript types + `defineRunner()` + CLI error messages provide sufficient validation.

### Two-tier NDJSON parser

1. **Terminal result envelope** — strict Zod validation with `.passthrough()`. Drives memoization and error handling.
2. **All other events** — generic passthrough: `{ kind: 'info', type: <raw type>, payload: <raw object> }`. No per-type mapping switch until Phase 13 (observability). YAGNI.

Use `safeParse` everywhere (codebase convention). Narrow `JSON.parse` catch to `SyntaxError` only.

## Technical Approach

### Architecture

```
claude() factory ──► defineRunner() ──► frozen Runner
                                           │
workflow.run(step) ──► runRunner(runner, ctx, deps)
                           │
                   runner.buildCommand(ctx) ──► { argv, env }
                           │
                   processService.spawn(opts) ──► SpawnHandle
                           │
                   for await (line of stdout)
                     runner.parseEvents(line) ──► RunnerEvent | null
                           │
                   isTerminalEvent(evt) ──► stop
                           │
                   runner.extractStructuredOutput(finalEvent) ──► value
```

No new seams. No changes to `runRunner`, `workflow`, `ProcessService`, or `Runner` interface. Architecture review confirmed: clean dependency graph `core → runners → services`, no boundary violations, no circular dependencies.

**Performance is not a concern.** At hundreds of events per subprocess run (seconds-to-minutes), adapter overhead is <5ms total. Bottleneck is always the Claude CLI.

### Event mapping: Claude CLI → Runner events

| Claude CLI event | → Runner event |
|---|---|
| `result` + `subtype: "success"` | `{ kind: 'terminal', type: 'turn-complete', data: <envelope> }` |
| `result` + `subtype: "error_*"` | `{ kind: 'terminal', type: 'error', message: errors[0] ?? 'unknown error', data: <envelope> }` |
| Everything else | `{ kind: 'info', type: <raw type>, payload: <raw object> }` |

**SDK event types (v0.2.101):** `result`, `system` (init/status/api_retry/...), `assistant`, `tool_progress`, `tool_use_summary`, `rate_limit_event`, `stream_event`, `user`, `prompt_suggestion`, `auth_status`. All carry `uuid` and `session_id`.

**Error subtypes (complete, 4 values):** `error_during_execution`, `error_max_turns`, `error_max_budget_usd`, `error_max_structured_output_retries`

### Environment variable handling (UPDATED — allowlist)

```ts
const CLAUDE_ENV_ALLOWLIST = [
  'HOME', 'PATH', 'SHELL', 'USER', 'TMPDIR', 'LANG', 'LC_ALL',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS',
] as const

function buildClaudeEnv(ctxEnv: Readonly<Record<string, string>>): Record<string, string> {
  const base: Record<string, string> = {}
  for (const key of CLAUDE_ENV_ALLOWLIST) {
    const val = process.env[key]
    if (val !== undefined) base[key] = val
  }
  for (const [key, val] of Object.entries(process.env)) {
    if ((key.startsWith('ANTHROPIC_') || key.startsWith('CLAUDE_')) && val !== undefined) {
      base[key] = val
    }
  }
  return { ...base, ...ctxEnv }
}
```

**Why allowlist (not `{ ...process.env }`):** (1) **Security** — Claude CLI is an AI agent that can run `printenv`; forwarding `DATABASE_URL`, `STRIPE_SECRET_KEY` etc. is a secret leak. (2) **Compilation** — `process.env` values are `string | undefined`, violating `Record<string, string>`. Allowlist solves both.

### `extractStructuredOutput` — via Zod safeParse (UPDATED)

```ts
extractStructuredOutput(finalEvent: TerminalEvent): unknown {
  if (finalEvent.type === 'error') return undefined
  const parsed = ClaudeResultSuccess.safeParse(finalEvent.data)
  return parsed.success ? parsed.data.result : undefined
}
```

**Why (replaces `as` cast):** The Zod schema already exists. Reusing `safeParse` maintains end-to-end type safety at negligible cost. Flagged by 4 reviewers.

## Implementation Phases

### Phase A: Zod schemas + event parser + env builder + runner (all in `claude-runner.ts`)

**Zod schemas (corrected against real CLI output):**

```ts
const ClaudeResultSuccess = z.object({
  type: z.literal('result'),
  subtype: z.literal('success'),
  result: z.string(),
  session_id: z.string(),
  duration_ms: z.number(),
  duration_api_ms: z.number(),
  is_error: z.boolean(),              // NOT z.literal(false) — real CLI has true on auth failure
  num_turns: z.number(),
  total_cost_usd: z.number(),
  usage: z.object({
    input_tokens: z.number(),
    output_tokens: z.number(),
    cache_creation_input_tokens: z.number(),
    cache_read_input_tokens: z.number(),
  }).passthrough(),                    // real usage has many more fields
  structured_output: z.unknown().optional(),
}).passthrough()                       // preserves uuid, modelUsage, terminal_reason, etc.

const ClaudeResultError = z.object({
  type: z.literal('result'),
  subtype: z.string(),                 // NOT z.enum — forwards-compatible with new error types
  session_id: z.string(),
  duration_ms: z.number(),
  is_error: z.literal(true),
  errors: z.array(z.string()),
}).passthrough()

export type ClaudeResultSuccessT = z.infer<typeof ClaudeResultSuccess>
export type ClaudeResultErrorT = z.infer<typeof ClaudeResultError>
```

**Parser (manual discrimination since error subtype is `z.string()`):**

```ts
function parseResultEnvelope(raw: unknown): TerminalEvent {
  const successResult = ClaudeResultSuccess.safeParse(raw)
  if (successResult.success) {
    return { kind: 'terminal', type: 'turn-complete', data: successResult.data }
  }
  const errorResult = ClaudeResultError.safeParse(raw)
  if (errorResult.success) {
    const msg = errorResult.data.errors[0] ?? 'unknown error'
    return { kind: 'terminal', type: 'error', message: msg, data: errorResult.data }
  }
  return {
    kind: 'terminal', type: 'error',
    message: `Malformed result envelope: ${successResult.error.issues.map(i => i.message).join('; ')}`,
  }
}
```

**Full runner in one file (~200 lines, declarative argv construction):**

```ts
export function claude(opts: ClaudeOptions = {}): Readonly<Runner> {
  const { model, maxTurns, bare = true, flags } = opts
  return defineRunner({
    name: 'claude',
    supports: { interactive: false, structuredOutput: false },
    buildCommand(ctx: RunnerContext): RunnerCommand {
      const argv = [
        'claude',
        ...(bare ? ['--bare'] : []),
        '-p', ctx.prompt,
        '--output-format', 'stream-json',
        '--verbose',
        '--no-session-persistence',
        ...(model ? ['--model', model] : []),
        ...(maxTurns !== undefined ? ['--max-turns', String(maxTurns)] : []),
        ...(flags ?? []),
        ...ctx.extraArgs,
      ]
      return { argv, env: buildClaudeEnv(ctx.env) }
    },
    parseEvents: parseClaudeLine,
    extractStructuredOutput(finalEvent: TerminalEvent): unknown {
      if (finalEvent.type === 'error') return undefined
      const parsed = ClaudeResultSuccess.safeParse(finalEvent.data)
      return parsed.success ? parsed.data.result : undefined
    },
  })
}
```

### Phase B: Barrel + re-export

- `src/runners/claude/index.ts` — export `claude` factory and types
- Update `src/runners/index.ts` — re-export `claude` factory

### Phase C: Test fixtures

- `tests/fixtures/claude/simple-success.jsonl` — captured + sanitized (replace `session_id`, `uuid` with placeholders, zero `total_cost_usd`)
- `tests/fixtures/claude/error-max-turns.jsonl` — hand-crafted from SDK schema

Real CLI emits ~3 lines for simple prompt: system init → assistant → result.

### Phase D: Tests (all layers)

Use `describe.skipIf()` for real CLI gating. Use `import type {}` per `verbatimModuleSyntax`. Relative imports (not aliases). Inline `ctxFor()` helper per test file.

## Files

### New files

| File | Purpose | Est. lines |
|---|---|---|
| `src/runners/claude/claude-runner.ts` | Schemas, parser, env builder, factory — all via `defineRunner()` | ~200 |
| `src/runners/claude/index.ts` | Module barrel | ~10 |
| `tests/fixtures/claude/simple-success.jsonl` | Sanitized captured NDJSON | ~10 |
| `tests/fixtures/claude/error-max-turns.jsonl` | Hand-crafted error NDJSON | ~10 |
| `tests/unit/runners/claude/build-command.test.ts` | Unit: buildCommand, factory, env builder | ~120 |
| `tests/unit/runners/claude/parse-events.test.ts` | Unit: parser, extractStructuredOutput | ~160 |
| `tests/integration/runners/claude/claude-mocked.test.ts` | Mocked integration via FakeProcessService | ~80 |
| `tests/integration/runners/claude/claude-real.test.ts` | Real CLI, gated `RUN_REAL_CLAUDE=1` | ~40 |
| `tests/integration/runners/claude/claude-e2e-lite.test.ts` | Workflow DSL + real CLI, gated | ~60 |

### Modified files

| File | Change |
|---|---|
| `src/runners/index.ts` | Re-export `claude` factory |
| `src/runners/types.ts` | JSDoc on `RunnerCommand.env` (full-replacement semantics) |
| `.gitignore` | Add `.env`, `.env.*` |
| `docs/plans/implementation-phases.md` | Fix Phase 5 (remove `--session-id`, add `--no-session-persistence`), mark ◐ |

## Acceptance Criteria

### Unit tests

- [x] `buildCommand` produces correct argv with defaults (bare, stream-json, verbose, no-session-persistence)
- [x] `buildCommand` includes `--model` / `--max-turns` when provided
- [x] `buildCommand` omits `--bare` when `bare: false`
- [x] `buildCommand` appends `flags` before `extraArgs`, `extraArgs` last
- [x] `buildCommand` env uses allowlist (includes HOME, PATH, ANTHROPIC_API_KEY; excludes DATABASE_URL etc.)
- [x] `buildCommand` env merges `ctx.env` with higher precedence; no `undefined` values
- [x] `parseEvents` success result → `TerminalEvent` `turn-complete` with envelope in `data`
- [x] `parseEvents` error result → `TerminalEvent` `error` with `message` from `errors[0]`
- [x] `parseEvents` error result with empty `errors[]` → `message: 'unknown error'`
- [x] `parseEvents` success with `is_error: true` → still parses as `turn-complete` (not rejected)
- [x] `parseEvents` unknown error `subtype` → parsed successfully (not rejected by enum)
- [x] `parseEvents` unknown event type → `InfoEvent` with raw type and payload
- [x] `parseEvents` malformed JSON → `null`; JSON without `type` → `null`
- [x] `parseEvents` result with invalid Zod schema → `TerminalEvent` error with Zod issues
- [x] `extractStructuredOutput` success → `result` text; error → `undefined`
- [x] `claude()` factory defaults → valid runner `name: 'claude'`, `structuredOutput: false`
- [x] `claude()` factory with all options → correct config

### Integration tests (mocked)

- [x] Full round-trip `ClaudeRunner → runRunner → FakeProcessService` from `simple-success.jsonl`: correct argv, events in order, terminal `turn-complete`, `durationMs` via `FakeClock`, `extractStructuredOutput` returns text
- [x] Error round-trip from `error-max-turns.jsonl`: terminal `error`, message present, `data.subtype` is error string

### Integration tests (real, gated)

- [x] `RUN_REAL_CLAUDE=1` + `Bun.which('claude')`: "Reply with exactly: OK" prompt, `subtype: 'success'`, at least one intermediate event

### E2E-lite (real, gated)

- [x] Workflow DSL + real ClaudeRunner: `state.json` has completed step, status `'completed'`

### Quality gates

- [x] `bun run check` green
- [x] Files ≤ 300 lines, functions ≤ 60 lines
- [x] No `any`, `!`, or unsafe `as` casts on `unknown`
- [x] No `child_process`/`Bun.spawn` outside `src/services/process/`

## Decisions Log

| ID | Decision | Rationale |
|---|---|---|
| D1 | TerminalEvent subtypes in `data` field, union not extended | Avoids changing all runners; `data` exists for this purpose |
| D2 | Env allowlist (not `...process.env`) | Security (agent can `printenv`) + compilation (`string \| undefined`) |
| D3 | Version preflight deferred to Phase 12 | YAGNI — nothing calls it; `Bun.which` gates tests |
| D4 | `extractStructuredOutput` via Zod `safeParse` | Eliminates `as` cast; schema already exists |
| D5 | `supports.structuredOutput: false` | Honest — schema validation requires Phase 7 |
| D6 | No `--session-id` | Deferred to Phase 14 |
| D7 | `--verbose` without `--include-partial-messages` | Phase 5 needs complete messages, not token-level streaming |
| D8 | No stderr in error events | Requires changing `runRunner`; Phase 13 |
| D9 | `null` for JSON without `type` | Noise filtering, matches established pattern |
| D10 | `-p` for prompts (no stdin) | `execvp` is safe; OS limits sufficient; `--stdin` doesn't exist |
| D11 | Generic intermediate events | No consumer until Phase 13; raw type preserved |
| D12 | `--no-session-persistence` default | Ephemeral runs don't need disk writes |
| D13 | Error subtype `z.string()` not `z.enum` | Forwards-compatible with new CLI error types |
| D14 | `is_error: z.boolean()` | Real CLI has `true` on success (auth failures) |
| D15 | No timeout mechanism | Known gap; Phase 12 adds `AbortSignal` support |
| D16 | No `extraArgs` validation | Workflow author's responsibility; future deny-list |

## References

### Internal
- Brainstorm: [`docs/brainstorms/2026-04-10-phase-5-claude-runner-brainstorm.md`](../brainstorms/2026-04-10-phase-5-claude-runner-brainstorm.md)
- Runner interface: `src/runners/types.ts` | Executor: `src/runners/execute.ts`
- FakeRunner: `src/runners/fake/fake-runner.ts` | Workflow: `src/core/workflow.ts`
- ProcessService: `src/services/process/process-service.ts`

### External
- CLI reference: https://code.claude.com/docs/en/cli-reference
- Headless mode: https://code.claude.com/docs/en/headless
- SDK streaming: https://code.claude.com/docs/en/agent-sdk/streaming-output
- SDK TypeScript types: https://github.com/anthropics/claude-agent-sdk-typescript (v0.2.101)
- Community parser: https://github.com/Khan/format-claude-stream

### Result subtypes & terminal reasons

**Subtypes:** `success`, `error_during_execution`, `error_max_turns`, `error_max_budget_usd`, `error_max_structured_output_retries`

**Terminal reasons (12):** `completed`, `max_turns`, `blocking_limit`, `rapid_refill_breaker`, `prompt_too_long`, `image_error`, `model_error`, `aborted_streaming`, `aborted_tools`, `stop_hook_prevented`, `hook_stopped`, `tool_deferred`
