---
date: 2026-04-10
status: active
topic: Phase 5 — Real ClaudeRunner deep-dive
---

# Phase 5 — Real ClaudeRunner brainstorm

## What We're Building

The first real CLI runner adapter: `ClaudeRunner`. It wires Claude Code CLI into the existing `Runner` interface / `runRunner` executor / `ProcessService` stack from Phases 1–4. This is both an architecture proof (does the abstraction hold up with a real subprocess?) and a usable runner (good enough for real workflow authoring).

**Scope:** prompt-only runs with `--output-format stream-json`. No `--json-schema` (Phase 7), no `--session-id` (Phase 14), no validators (Phase 6).

## Why This Approach

### Key Decisions

1. **No `--session-id`:** The workflow DSL's name-keyed memoization already handles resume. Session tracking comes with escalation in Phase 14. YAGNI.

2. **Preserve error subtypes:** The final result envelope's `subtype` field (e.g., `error_max_turns`, `error_tool_use`, `success`) is mapped into `TerminalEvent` so workflows can distinguish failure modes. We don't collapse everything into a binary success/error.

3. **Two-tier NDJSON parser:**
   - **Terminal result envelope** — strict Zod validation. This drives memoization, error handling, and structured output extraction. Must be correct.
   - **Intermediate events** — loose typed parsing with a `type` discriminator. Recognized types (tool use, file edits, assistant messages) become typed `InfoEvent` variants. Unknown types pass through as generic `InfoEvent` with raw payload. Forwards-compatible.

4. **Parse intermediate events into InfoEvents:** `--verbose` output is parsed, not ignored. This makes the runner immediately useful for observability (Phase 13 tmux pane) without a second pass later.

5. **Options-object factory:** `claude({ model?, maxTurns?, bare?, flags? })` returns a `Runner`. Runner-specific config baked into the factory; step-level overrides via `extraArgs` in `RunnerContext`.

6. **`--bare` configurable, default true:** `bare?: boolean` in options. Orchestrated runs suppress interactive prompts by default; workflow authors can opt out.

7. **E2E gating:** `RUN_REAL_CLAUDE=1` env var only. No auto-detect. Explicit opt-in prevents accidental API credit burn.

8. **Research docs first, then capture:** Check Claude CLI docs/source for the stream-json event format spec, then capture real output to validate. Ground the parser in documented reality.

9. **Full version preflight:** Parse `claude --version`, enforce minimum version supporting `stream-json` + `--verbose`. Fail fast with clear error. Mirrors Phase 9 CodexRunner pattern.

## Deliverables

### Files

- `src/runners/claude/claude-runner.ts` — `Runner` implementation via `defineRunner()`.
- `src/runners/claude/claude-events.ts` — NDJSON parser: two-tier (strict terminal Zod + loose intermediate).
- `src/runners/claude/claude-options.ts` — `ClaudeOptions` type + `claude()` factory.
- `src/runners/claude/index.ts` — barrel for the module.
- `src/runners/index.ts` — re-export `claude()` factory from public barrel.
- `tests/fixtures/claude/simple-success.jsonl` — captured from a real `claude` run.
- `tests/fixtures/claude/error-max-turns.jsonl` — captured from a failing run (if feasible).

### Command Shape

```
claude --bare -p <prompt> --output-format stream-json --verbose [--model <model>] [--max-turns <n>] [...flags]
```

- `--bare` suppresses interactive UI
- `-p` passes the prompt as a string argument
- `--output-format stream-json` emits NDJSON to stdout
- `--verbose` includes intermediate events (tool calls, file edits)
- `--model`, `--max-turns`, extra flags come from `ClaudeOptions`

### Runner Methods

- **`buildCommand(ctx)`** — assembles argv from `ClaudeOptions` + `RunnerContext.prompt` + `RunnerContext.extraArgs`. Sets `cwd` from `ctx.cwd`.
- **`parseEvents(line)`** — JSON.parse, dispatch on `type` field. Terminal result → strict Zod. Intermediate → loose typed. Unknown → generic info. Parse failure → null (logged, not thrown).
- **`extractStructuredOutput(finalEvent)`** — from the terminal result envelope's `result` field. Phase 5 returns it raw; Phase 7 adds schema validation.

### Tests

- **Unit** — `ClaudeRunner.buildCommand()` produces correct argv for various option combos.
- **Unit** — `parseEvents` on fixture lines: intermediate events map to correct InfoEvent variants; terminal envelope maps to TerminalEvent with preserved subtype.
- **Unit** — `parseEvents` on malformed JSON returns null.
- **Unit** — `extractStructuredOutput` pulls result from terminal envelope.
- **Integration (mocked)** — `ClaudeRunner → runRunner → FakeProcessService` scripted from `simple-success.jsonl`. Asserts full event sequence, durationMs, structured output.
- **Integration (real, gated)** — `RUN_REAL_CLAUDE=1`: real `claude` with tiny "reply with OK" prompt. Asserts final result event arrives with subtype `success`.
- **E2E-lite (real, gated)** — `RUN_REAL_CLAUDE=1`: hand-written workflow using Phase 4 DSL + real ClaudeRunner. Exercises `workflow.execute()` directly. Asserts state.json contains completed step.

## Resolved Questions

1. **Stream-json event discovery:** Research Claude CLI docs/source for the event format spec first, then capture real output to validate. Don't build the parser speculatively — ground it in documented or observed reality.

2. **`--bare` is configurable, default true:** `bare?: boolean` in `ClaudeOptions`, defaulting to `true`. Orchestrated runs should suppress interactive prompts by default, but workflow authors can disable it for edge cases.

3. **Full version preflight:** Parse `claude --version` output and enforce a minimum version that supports `--output-format stream-json` and `--verbose`. Fail fast with a clear error if the CLI is missing or too old. (Mirrors the pattern planned for CodexRunner in Phase 9.)

## Open Questions

None remaining.
