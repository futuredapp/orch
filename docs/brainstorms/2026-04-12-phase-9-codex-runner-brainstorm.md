---
date: 2026-04-12
status: active
topic: Phase 9 — Real CodexRunner deep-dive
---

# Phase 9 — Real CodexRunner brainstorm

## What We're Building

The second real CLI runner adapter: `CodexRunner`. It wraps `codex exec --json` (the OpenAI Codex CLI's non-interactive mode) into the `Runner` interface, proving the abstraction generalises beyond Claude. This is also the gate for the `parallel()` integration test — running two different real runners side by side.

**Scope:** prompt runs with `--json` NDJSON output, structured output via `--output-schema <file>`, configurable sandbox mode, version preflight. No resume (Phase 15), no escalation (Phase 15), no MCP tools.

## Why This Approach

### Key Decisions

1. **Schema delivery via FsService in the factory closure.** Codex requires `--output-schema <file-path>` (not inline JSON like Claude). Rather than changing the `Runner` interface (adding `prepare()`) or making the executor runner-aware, the `codex()` factory receives `FsService` as a dependency. `buildCommand` writes a temp file via `deps.fs.writeTempFile()` and includes the path in argv. This makes `buildCommand` impure for CodexRunner only — an acceptable trade-off since the impurity is contained in the adapter, not the interface.

2. **Configurable sandbox mode, default `--full-auto`.** `CodexOptions` exposes `sandbox?: 'full-auto' | 'workspace-write' | 'read-only' | 'danger-full-access'` defaulting to `'full-auto'` (= workspace-write + on-request approvals). This is Codex's recommended automation preset. Power users can override to `danger-full-access` when running inside an external sandbox, or `read-only` for pure analysis tasks. The roadmap's original `--sandbox workspace-write -c approval_policy='"never"'` is abandoned in favour of the cleaner preset.

3. **Terminal + flat info event parsing.** Same strategy as ClaudeRunner's two-tier approach:
   - `turn.completed` → `{ kind: 'terminal', type: 'turn-complete' }`
   - `turn.failed` / top-level `error` → `{ kind: 'terminal', type: 'error', message }`
   - Everything else (`thread.started`, `turn.started`, `item.*`) → `{ kind: 'info', type: '<codex-type>', payload }`
   
   No rich item discrimination — keeps the parser simple and forwards-compatible with new Codex event types.

4. **Closure-based accumulation for structured output.** The runner factory closes over `lastAgentMessage: string | undefined`. `parseEvents` updates it when it encounters `item.completed` with `item.type === 'agent_message'`. `extractStructuredOutput` does `JSON.parse(lastAgentMessage)`. This avoids both interface changes and stateful parser objects.

5. **Thread ID captured in closure.** `parseEvents` stores `thread_id` from the `thread.started` event in the closure. Not exposed yet — just preserved for Phase 15's `codex exec resume <thread_id>` support. Three lines of code, zero API surface.

6. **Version preflight included (per roadmap).** `checkCodexVersion(processService)` spawns `codex --version`, parses semver, fails fast if `< 0.118.0` (when `--output-schema` was introduced). Unlike ClaudeRunner (which deferred to Phase 12), this is warranted because `--output-schema` is the primary structured output mechanism and produces cryptic errors on older versions.

7. **Env allowlist: CODEX_* + OPENAI_* prefixes.** Mirrors ClaudeRunner's `ANTHROPIC_* + CLAUDE_*` pattern. `CODEX_API_KEY` is the primary auth var for exec mode; `OPENAI_API_KEY` is the fallback. Standard vars (HOME, PATH, SHELL, USER, LANG, TERM, TMPDIR, XDG_*, SSL_CERT_*) included.

8. **Flag denylist: `--dangerously-bypass-approvals-and-sandbox` / `--yolo`.** Mirrors ClaudeRunner's denylist for `--dangerously-skip-permissions`. Prevents workflow authors from accidentally disabling all safety guardrails.

9. **`--skip-git-repo-check` always on.** The orchestrator manages its own git context. Codex's default requirement for a git repo is unnecessary overhead.

10. **`--ephemeral` always on.** No need to persist Codex session files to disk when the orchestrator manages state via `StateStore`.

## Codex CLI Reference

**Install:** `npm i -g @openai/codex` (Rust-based, >= 0.118.0)

**Non-interactive command shape:**
```
codex exec --json --full-auto --skip-git-repo-check --ephemeral \
  -C <cwd> [-m <model>] [--output-schema <file>] [-o <file>] \
  "prompt"
```

**Key NDJSON events:**

| Event | When | Key fields |
|---|---|---|
| `thread.started` | First event | `thread_id` (UUID) |
| `turn.started` | Model invoked | — |
| `item.started` | Tool/message begins | `item.id`, `item.type` |
| `item.completed` | Tool/message done | `item.id`, `item.type`, `item.text` (for agent_message) |
| `turn.completed` | Turn success | `usage { input_tokens, output_tokens }` |
| `turn.failed` | Turn failure | `error.message` |
| `error` | Stream-level error | `message` |

**Item types:** `agent_message`, `reasoning`, `command_execution`, `file_change`, `mcp_tool_call`, `web_search`, `todo_list`, `error`

**Structured output:** When `--output-schema <file>` is provided, the final `agent_message` item's `text` field contains a JSON string conforming to the schema. Codex validates it server-side.

**Auth:** `CODEX_API_KEY` env var (exec mode only), `OPENAI_API_KEY` fallback.

**Sandbox modes:** `read-only` (default for exec), `workspace-write`, `danger-full-access`. Presets: `--full-auto` (workspace-write + on-request), `--yolo` (full-access + never).

## Deliverables

### Files

- `src/runners/codex/codex-runner.ts` — Zod schemas, NDJSON parser, env builder, `codex()` factory via `defineRunner()`.
- `src/runners/codex/index.ts` — module barrel.
- `src/runners/index.ts` — re-export `codex()` factory + `CodexOptions` from public barrel.
- `tests/fixtures/codex/simple-success.jsonl` — basic prompt completion.
- `tests/fixtures/codex/with-output-schema.jsonl` — structured output with agent_message containing schema-conformant JSON.
- `tests/fixtures/codex/turn-failed.jsonl` — failure mode.

### CodexOptions

```typescript
interface CodexOptions {
  model?: string                // default: undefined (CLI default)
  sandbox?: 'full-auto' | 'workspace-write' | 'read-only' | 'danger-full-access'
                                // default: 'full-auto'
  flags?: readonly string[]     // extra CLI flags
}
```

### Command Shape

```
codex exec --json --full-auto --skip-git-repo-check --ephemeral \
  -C <cwd> [--output-schema <tmpfile>] [-m <model>] [...flags] \
  "<prompt>"
```

### Runner Methods

- **`buildCommand(ctx)`** — assembles argv from `CodexOptions` + `RunnerContext.prompt` + `RunnerContext.extraArgs`. If `ctx.schema` is set, writes JSON schema to a temp file via `FsService` and adds `--output-schema <path>`. Sets env via allowlist.
- **`parseEvents(line)`** — `JSON.parse`, dispatch on `type` field. `turn.completed` → terminal success. `turn.failed` / `error` → terminal error. Everything else → info. Accumulates `lastAgentMessage` and `threadId` in closure. Parse failure → null.
- **`extractStructuredOutput(finalEvent)`** — reads `lastAgentMessage` from closure, `JSON.parse`s it. Returns `undefined` if not a string.
- **`supports`** — `{ interactive: false, structuredOutput: true }`.

### Version Preflight

```typescript
async function checkCodexVersion(ps: ProcessService): Promise<void>
```
- Spawns `codex --version`, reads first stdout line
- Parses semver (e.g. `"codex 0.120.0"`)
- Throws `CodexVersionError` if `< 0.118.0` with actionable message
- Called before first runner use (exact call site TBD in planning phase)

### Tests

- **Unit** — `buildCommand` argv construction for various option combos (default, custom model, custom sandbox, with schema, with extraArgs, flag denylist rejection).
- **Unit** — `parseEvents` on fixture lines: `thread.started` → info, `item.completed` → info, `turn.completed` → terminal, `turn.failed` → terminal error, malformed JSON → null.
- **Unit** — `extractStructuredOutput` with accumulated agent_message, without, with invalid JSON.
- **Unit** — `checkCodexVersion` with valid version, old version, missing CLI, unparseable output.
- **Unit** — env allowlist includes CODEX_*/OPENAI_* but excludes secrets not in the list.
- **Integration (mocked)** — `CodexRunner → runRunner → FakeProcessService` scripted from `simple-success.jsonl` and `with-output-schema.jsonl`. Asserts event sequence, structured output extraction, durationMs.
- **Integration (real, gated `RUN_REAL_CODEX=1`)** — real `codex exec` with tiny prompt ("Reply with exactly: OK"). Asserts `turn.completed` arrives.
- **Integration (real, gated both env vars)** — `parallel()` with `ClaudeRunner` and `CodexRunner` against real CLIs. Validates the core multi-agent promise.

## Differences from ClaudeRunner

| Aspect | ClaudeRunner | CodexRunner |
|---|---|---|
| NDJSON flag | `--output-format stream-json` | `--json` |
| Schema delivery | `--json-schema '<inline>'` | `--output-schema <file>` (temp file via FsService) |
| Terminal event | `type: "result"` envelope | `turn.completed` / `turn.failed` |
| Structured output location | `structured_output` field on result | `item.completed.item.text` (agent_message) accumulated in closure |
| Sandbox config | N/A (Claude uses permissions) | `--full-auto` default, configurable |
| Auth env var | `ANTHROPIC_API_KEY` | `CODEX_API_KEY` / `OPENAI_API_KEY` |
| Version preflight | Deferred to Phase 12 | Included (Phase 9) |
| Git repo requirement | None | `--skip-git-repo-check` needed |
| Session persistence | `--no-session-persistence` | `--ephemeral` |

## Open Questions

1. **Temp file cleanup:** When should the schema temp file be deleted? After process exit in `runRunner`? In a `finally` block? Or rely on OS temp dir cleanup? Needs resolution in the planning phase — may require a small executor change or a cleanup callback.

2. **FsService.writeTempFile:** Does this method already exist on the `FsService` interface, or does it need to be added? If added, what's the API — `writeTempFile(prefix: string, content: string): Path`?

3. **Preflight call site:** Where exactly does `checkCodexVersion` get called? In the `codex()` factory (once at construction)? Before first `buildCommand` call (lazy)? In the executor? Needs resolution in planning.

4. **`-C` vs `cwd` on spawn:** Should we use Codex's `-C <dir>` flag, or set `cwd` on the `SpawnOptions` passed to `ProcessService`? Both work. Using `SpawnOptions.cwd` is consistent with ClaudeRunner.
