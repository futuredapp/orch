---
title: "Phase 9 — Real CodexRunner"
type: feat
status: landed
date: 2026-04-12
deepened: 2026-04-12
---

# Phase 9 — Real CodexRunner

## Enhancement Summary

**Deepened on:** 2026-04-12
**Sections enhanced:** 9
**Agents used:** architecture-strategist, security-sentinel, performance-oracle, kieran-typescript-reviewer, pattern-recognition-specialist, code-simplicity-reviewer, spec-flow-analyzer, agent-native-reviewer, repo-research-analyst, best-practices-researcher, context7 docs

### Critical Fixes Required (unanimous across reviewers)

1. **Closure state reset** — `lastAgentMessage` and `threadId` must be reset to `undefined` at the top of `buildCommand`. Without this, a runner instance reused across sequential steps leaks structured output from step N into step N+1. Every review agent flagged this independently.
2. **Missing `ProcessService` in factory deps** — Plan shows `{ fs }` but `checkCodexVersion` needs `ProcessService`. Factory signature must be `codex(opts, { fs, ps })`.
3. **`extractStructuredOutput` must guard on error events** — Add `if (finalEvent.type === 'error') return undefined` as the first line. Without it, a failed turn that emitted an `agent_message` before `turn.failed` returns incorrect output.
4. **Use `path()` instead of `as Path`** — The branded type's smart constructor validates for empty strings, NUL bytes, and `..` traversal. `as Path` bypasses all validation.

### Security Findings (3 HIGH, 4 MEDIUM)

5. **Expand flag denylist** — Add `--config`, `--sandbox`, `-c`, `--approval-mode`. Current denylist blocks obvious "yolo" flags but misses flags that reconfigure safety from underneath.
6. **Filter ctxEnv through allowlist** — `ctxEnv` can currently inject `LD_PRELOAD`, `NODE_OPTIONS`, `DYLD_INSERT_LIBRARIES` into the subprocess. Filter unknown keys through the same allowlist/prefix rules.
7. **Add `--` separator before prompt in argv** — Prevents flag injection if prompt starts with `--`.
8. **Gate `danger-full-access`** — Require explicit env var `CODEX_ALLOW_DANGER=1` or a typed opt-in flag.
9. **Narrow `OPENAI_*` prefix** — `OPENAI_BASE_URL` can redirect all API traffic to an attacker-controlled endpoint. Consider explicit allowlist for `OPENAI_` vars.

### Architecture Improvements

10. **Export parser as standalone function** — Match ClaudeRunner's `parseClaudeLine` pattern for direct unit testing. Wrap in factory for accumulation side-effects.
11. **Consider stashing accumulated text into terminal event `data`** — Makes `extractStructuredOutput` a pure function of `finalEvent`, matching ClaudeRunner's stateless contract.
12. **Remove `cwd` from `checkCodexVersion` signature** — `codex --version` doesn't need a working directory.

### Simplification Opportunities

13. **Version preflight is YAGNI** — ClaudeRunner deferred to Phase 12. Consider deferring here too (~135 LOC savings). Counter: `--output-schema` produces cryptic errors on old versions.
14. **Thread ID capture is YAGNI** — 3 lines of code but cognitive overhead for every reader. Add in Phase 15 when resume lands.
15. **Trim decision log** — D4, D5, D8, D9, D12 are obvious implementation details, not architectural decisions.

---

## Overview

Second real CLI runner adapter. Wraps `codex exec --json` (OpenAI Codex CLI's non-interactive mode) into the `Runner` interface, proving the abstraction generalises beyond Claude. Also the gate for the `parallel()` cross-runner integration test — two different real runners side by side.

**Scope:** prompt runs with `--json` NDJSON output, structured output via `--output-schema <file>`, configurable sandbox mode, version preflight. No resume (Phase 15), no escalation (Phase 15), no MCP tools.

Source brainstorm: [`docs/brainstorms/2026-04-12-phase-9-codex-runner-brainstorm.md`](../brainstorms/2026-04-12-phase-9-codex-runner-brainstorm.md).

### Research Insights

**Codex CLI Documentation (Context7, 2026-04-12):**
- Codex SDK `outputSchema` is a JSON object passed per-turn. CLI delivers it via `--output-schema <file>`.
- Sandbox policy types in the SDK: `workspaceWrite`, `readOnly`, `dangerFullAccess`, `externalSandbox`. CLI presets: `--full-auto` (workspace-write + on-request approvals), `--yolo` (full-access + never).
- `--ephemeral` is documented for `codex exec` to prevent session rollout file persistence.
- Codex CLI is Rust-based — subprocess startup is fast (~10-30ms vs ~50-100ms for Node-based CLIs).

**Agent-Native Assessment (14/14 capabilities agent-accessible):**
- Every configuration option is a TypeScript value — no YAML, no interactive prompts, no manual steps.
- Error types are programmatically distinguishable via `instanceof` (`CodexVersionError`, `ProcessSpawnError`, `StepError`).
- The `--skip-git-repo-check` and `--ephemeral` flags correctly remove interactive friction for automated orchestration.

## Problem Statement / Motivation

Phases 1-8 built a complete pipeline (sequential + parallel) but only exercised one real runner (ClaudeRunner). Phase 9 is the "abstraction proof" milestone: if `CodexRunner` slots in cleanly without interface changes to `Runner`, `runRunner`, or `workflow`, the multi-agent architecture holds. The parallel integration test (ClaudeRunner + CodexRunner) is the core multi-agent promise of the project.

### Research Insights

**Architecture Assessment:** The plan correctly validates that no changes to `Runner`, `runRunner`, or `workflow` are needed beyond the backward-compatible `buildCommand` async widening. This confirms the hexagonal architecture: adding a new agent backend requires zero changes to the core orchestration layer.

**SOLID Compliance (verified):**
- Single Responsibility: CodexRunner handles only Codex CLI concerns
- Open/Closed: Interface is widened (additive), not broken
- Liskov Substitution: CodexRunner satisfies the same contract via `await`
- Interface Segregation: FsService stays out of the Runner interface
- Dependency Inversion: Core depends on abstractions, CodexRunner depends on service ports

## Proposed Solution

### Command shape

```
codex exec --json --full-auto --skip-git-repo-check --ephemeral \
  [--output-schema <tmpfile>] [-m <model>] [...flags] \
  -- "<prompt>"
```

- `--json` emits NDJSON to stdout (Codex equivalent of Claude's `--output-format stream-json`)
- `--full-auto` is the recommended automation preset (workspace-write + on-request approvals)
- `--skip-git-repo-check` bypasses Codex's default git-repo requirement (orchestrator manages its own git context)
- `--ephemeral` prevents session file persistence (orchestrator manages state via `StateStore`)
- `--output-schema <file>` delivers the JSON schema as a temp file (Codex doesn't accept inline JSON)
- `--` separates flags from prompt (prevents flag injection if prompt starts with `--`)
- Working directory via `SpawnOptions.cwd` (not `-C` flag — consistency with ClaudeRunner)

### Research Insights: Command Shape

**Security (flag injection via prompt):** The `--` separator before the prompt is critical. Without it, a prompt like `--config /etc/shadow` could be misinterpreted as a CLI flag. The separator is standard POSIX convention — zero cost, full protection.

**Best Practice:** Do not use `-C <cwd>` — use `SpawnOptions.cwd` on the subprocess spawn. This is consistent with ClaudeRunner and keeps the argv cleaner.

### Options-object factory

```ts
const agent = codex(
  { model: 'o4-mini', sandbox: 'read-only' },
  { fs: myFsService, ps: myProcessService },
)
```

Returns a frozen `Runner` via `defineRunner()`. Factory captures `FsService` (for writing schema temp files) and `ProcessService` (for version preflight) as dependencies.

### Research Insights: Factory Pattern

**Missing dependency (flagged by architecture + TypeScript reviewers):** The plan originally showed `{ fs }` but `checkCodexVersion` needs `ProcessService`. The factory signature must be `codex(opts, { fs, ps })`.

**Pattern consistency:** The two-argument form `codex(opts, deps)` cleanly separates configuration from infrastructure dependencies. This is preferable to mixing them in one bag (e.g., `codex({ model: 'o4-mini', fs: myFs })`) — it keeps the same conceptual separation as the existing `WorkflowDeps`.

**Dependency injection best practice:** Consider narrowing deps to only what's needed: `Pick<FsService, 'tempDir' | 'writeFile'>`. However, if `FsService` is already small (15 methods), `Pick` adds noise. Keep the full interface unless it causes testing friction.

### Two-tier NDJSON parser (same strategy as ClaudeRunner)

1. **Terminal events** — `turn.completed` (success) / `turn.failed` + top-level `error` (failure). Drives memoization and error handling.
2. **All other events** — generic passthrough: `{ kind: 'info', type: '<codex-type>', payload: <raw object> }`. No per-item-type mapping until observability.

### Event mapping: Codex CLI -> Runner events

| Codex CLI event | -> Runner event |
|---|---|
| `turn.completed` | `{ kind: 'terminal', type: 'turn-complete', data: <envelope> }` |
| `turn.failed` | `{ kind: 'terminal', type: 'error', message: error.message, data: <envelope> }` |
| `error` (stream-level) | `{ kind: 'terminal', type: 'error', message, data: <envelope> }` |
| Everything else (`thread.started`, `turn.started`, `item.*`) | `{ kind: 'info', type: <raw type>, payload: <raw object> }` |

## Technical Approach

### Architecture

```
codex(opts, { fs, ps }) ──> defineRunner() ──> frozen Runner
                                                  |
workflow.run(step) ──> runRunner(runner, ctx, deps)
                          |
                  runner.buildCommand(ctx) ──> Promise<RunnerCommand>
                    |  (1. resets lastAgentMessage to undefined)
                    |  (2. runs version preflight if first call)
                    |  (3. writes temp schema file via FsService if ctx.schema)
                          |
                  processService.spawn(opts) ──> SpawnHandle
                          |
                  for await (line of stdout)
                    runner.parseEvents(line) ──> RunnerEvent | null
                      |  (accumulates lastAgentMessage in closure)
                      |  (stashes lastAgentMessage into terminal event data)
                          |
                  isTerminalEvent(evt) ──> stop
                          |
                  runner.extractStructuredOutput(finalEvent) ──> value
                    |  (reads from finalEvent.data._accumulatedText, JSON.parse)
                    |  (pure function of finalEvent — matches ClaudeRunner pattern)
```

### Research Insights: Architecture

**Pattern consistency with ClaudeRunner (pattern-recognition-specialist):** Export the NDJSON parser as a standalone function (`parseCodexLine`) — matching ClaudeRunner's `parseClaudeLine` pattern. The factory wraps it to add accumulation side-effects:

```ts
// Standalone, exported, directly testable:
export function parseCodexLine(line: string): RunnerEvent | null { /* ... */ }

// Inside factory, wraps for accumulation:
parseEvents(line: string): RunnerEvent | null {
  const evt = parseCodexLine(line)
  if (evt && isAgentMessageItem(evt)) {
    lastAgentMessage = extractText(evt)
  }
  return evt
}
```

**Section order in implementation file (from repo-research-analyst):** Match ClaudeRunner's structure exactly:
1. Zod schemas (terminal events + usage)
2. Exported type aliases
3. `CodexOptions` interface
4. Env allowlist + `buildCodexEnv()` (exported, testable)
5. Flag denylist + `assertFlagAllowed()`
6. Standalone NDJSON parser `parseCodexLine()` (exported, testable)
7. Version preflight
8. `codex()` factory function

**Shared utility extraction opportunity (consider):** `buildClaudeEnv` and `buildCodexEnv` share identical structure. A shared `buildRunnerEnv(ctxEnv, processEnv, { allowlist, prefixes })` could eliminate duplication. Similarly, `assertFlagAllowed` could be `makeAssertFlagAllowed(denylist, runnerName)`. Defer extraction to Phase 10+ (rule of three), but note the seam exists at `src/runners/shared/`.

**Sandbox mode argv mapping (from spec-flow-analyzer):**

| `CodexOptions.sandbox` | CLI argv |
|---|---|
| `'full-auto'` (default) | `--full-auto` (preset flag) |
| `'read-only'` | `--sandbox read-only` |
| `'workspace-write'` | `--sandbox workspace-write` |
| `'danger-full-access'` | `--sandbox danger-full-access` |

### Prerequisite: make `buildCommand` async-compatible

**Problem:** Codex needs `--output-schema <file>`, which means writing a temp file in `buildCommand`. `FsService` methods are all async, but `Runner.buildCommand` currently returns `RunnerCommand` synchronously.

**Solution:** Widen `Runner.buildCommand` return type to `RunnerCommand | Promise<RunnerCommand>`. Update `runRunner` to `await` the result. This is fully backwards-compatible: `await syncValue` returns `syncValue`, so ClaudeRunner and FakeRunner continue working unchanged without code changes.

```ts
// src/runners/types.ts — one type change
interface Runner {
  buildCommand(ctx: RunnerContext): RunnerCommand | Promise<RunnerCommand>  // was: RunnerCommand
  // ... rest unchanged
}

// src/runners/execute.ts — one line change
const cmd = await runner.buildCommand(ctx)  // was: runner.buildCommand(ctx)
```

**Why not other approaches:**
- `writeTempFileSync` on FsService: Breaks the all-async interface pattern.
- Separate `prepare()` method on Runner: Overengineered; `buildCommand` already prepares the command.
- `Bun.writeSync` directly in adapter: Violates the FsService boundary.

### Research Insights: buildCommand Widening

**TypeScript type safety (verified):** An `async` function returns `Promise<RunnerCommand>`, which satisfies `RunnerCommand | Promise<RunnerCommand>`. A sync function returns `RunnerCommand`, which also satisfies the union. Both directions are type-safe. `Awaited<RunnerCommand | Promise<RunnerCommand>>` correctly resolves to `RunnerCommand`.

**defineRunner validation (verified):** The `RunnerAdapterSchema` at `types.ts:81` validates `buildCommand` with `typeof v === 'function'`. This check remains valid for both sync and async functions. The generic parameter `z.custom<Runner['buildCommand']>` auto-updates when the interface changes.

**Contract documentation:** Add a JSDoc comment on the widened signature explaining that async is permitted specifically for adapter-specific preparation (temp files, version checks), not for business logic. This prevents future runner authors from treating it as a general-purpose hook.

**Consumer invariant:** All consumers must always `await` the result — no `instanceof Promise` branching. The executor already does this correctly. Document that this is a permanent commitment: the widened type cannot be narrowed back.

**Do not create a `MaybeAsync<T>` utility type** for this single use. If more methods need widening later, introduce it then.

### Schema temp file via existing FsService methods

No new `writeTempFile` method needed. Use existing `tempDir()` + `writeFile()`:

```ts
// Inside codex factory's buildCommand
if (ctx.schema) {
  const dir = await deps.fs.tempDir('codex-schema')
  const filePath = path(`${dir}/schema.json`)  // Use path() constructor, NOT `as Path`
  await deps.fs.writeFile(filePath, ctx.schema.jsonSchema)
  argv.push('--output-schema', filePath)
}
```

**Temp file cleanup:** Rely on OS temp dir cleanup. Files are ~1KB JSON schemas. Explicit cleanup can be added in a later phase if profiling shows accumulation.

### Research Insights: Temp File Handling

**Use `path()` not `as Path` (flagged by TypeScript reviewer):** The branded `Path` type's smart constructor at `src/services/types.ts` validates for empty strings, NUL bytes, and `..` traversal. Using `as Path` bypasses all validation. Use `path(\`${dir}/schema.json\`)` for consistency and safety.

**Security — `mkdtemp` is sufficient (verified):** `FsService.tempDir` uses `mkdtemp` which creates a unique directory with a cryptographically random suffix. This prevents symlink attacks and TOCTOU race conditions. The fixed filename `schema.json` inside the random directory is acceptable since the directory itself is unpredictable.

**Accumulation concern (medium priority):** For long-running orchestrators executing hundreds of workflows, temp files accumulate (~1KB each). The natural cleanup seam is a `finally` block in `runRunner` or a `cleanup` callback on `RunnerCommand`. Not needed now, but document the extension point:

```ts
// Future: RunnerCommand could grow a cleanup hook
interface RunnerCommand {
  readonly argv: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly cleanup?: () => Promise<void>  // future extension point
}
```

**Do not use project-relative temp dirs** (e.g., `.orch-tmp/`) — this creates files in the git working tree that can be accidentally committed or interfere with the tool being orchestrated.

### Closure-based accumulation for structured output

The `codex()` factory closes over mutable state. `parseEvents` updates it; `extractStructuredOutput` reads it.

```ts
let lastAgentMessage: string | undefined

// In parseEvents — when building the terminal event for turn.completed:
if (obj.type === 'item.completed' && item.type === 'agent_message') {
  lastAgentMessage = item.text
}

// When turn.completed arrives, stash lastAgentMessage into the terminal event data:
if (obj.type === 'turn.completed') {
  return {
    kind: 'terminal',
    type: 'turn-complete',
    data: { ...obj, _accumulatedText: lastAgentMessage },
  }
}

// In extractStructuredOutput — reads from finalEvent.data, matching ClaudeRunner's pattern:
extractStructuredOutput(finalEvent: TerminalEvent): unknown {
  if (finalEvent.type === 'error') return undefined
  const data = finalEvent.data as Record<string, unknown> | undefined
  const text = data?._accumulatedText
  if (typeof text !== 'string') return undefined
  try { return JSON.parse(text) }
  catch { return undefined }
}
```

**Why closure (not interface extension):** No changes to `Runner`, `TerminalEvent`, or `runRunner`. The impurity is contained entirely within the adapter.

### Research Insights: Closure State Management (CRITICAL)

**Unanimous finding across all 9 review agents:** The original plan's closure-based `extractStructuredOutput` (reading `lastAgentMessage` directly from closure) creates two correctness bugs:

**Bug 1 — Stale state across sequential invocations:** If a runner instance is reused across steps (the natural pattern: `const agent = codex(...)` referenced in multiple `step.define` calls), `lastAgentMessage` from step N leaks into step N+1 if step N+1 fails before accumulating its own agent message.

**Bug 2 — Race condition in parallel:** If the same runner instance is used in `parallel()` branches, concurrent `parseEvents` calls write to the same closure variable nondeterministically.

**Required fix (state reset):** Reset `lastAgentMessage` to `undefined` at the top of `buildCommand`:

```ts
async buildCommand(ctx: RunnerContext): Promise<RunnerCommand> {
  lastAgentMessage = undefined  // MUST reset per invocation
  // ... rest of buildCommand
}
```

**Preferred fix (stash into terminal event data):** Instead of reading from the closure in `extractStructuredOutput`, stash the accumulated text into the terminal event's `data` field during `parseEvents` (shown in the code above). This makes `extractStructuredOutput` a **pure function of `finalEvent`**, matching ClaudeRunner's stateless contract. The `_accumulatedText` field is adapter-internal — it never leaks past the runner boundary.

**Error guard (CRITICAL):** `extractStructuredOutput` must check `if (finalEvent.type === 'error') return undefined` as the first line. Without this, a failed turn that emitted an `agent_message` before `turn.failed` would incorrectly return output. The acceptance criteria list this test case but the original pseudocode omitted the guard.

**Thread ID (YAGNI — deferred to Phase 15):** The original plan captured `threadId` from `thread.started` events for future resume support. Per simplicity review: adding code for Phase 15 during Phase 9 is textbook YAGNI. The 3 lines are trivial to add when Phase 15 lands. Remove for now.

### Version preflight

```ts
async function checkCodexVersion(ps: ProcessService): Promise<void>
```

- Spawns `codex --version`, reads first stdout line
- Parses semver from `"codex 0.120.0"` format via `/(\d+)\.(\d+)\.(\d+)/`
- Throws `CodexVersionError` if `< 0.118.0` (when `--output-schema` was introduced)
- **Call site:** Lazy — first `buildCommand` invocation, gated by `versionChecked` boolean in closure. Not in the factory (too early — runner may never be invoked).

### Research Insights: Version Preflight

**Simplicity debate:** The code-simplicity-reviewer argues this is YAGNI — ClaudeRunner deferred to Phase 12. The full subsystem is ~50 LOC implementation + ~80 LOC tests. The counter-argument: `--output-schema` produces cryptic errors on old versions, and the check runs once with ~100ms overhead. **Decision: Keep, but simplify.**

**Simplifications applied:**

1. **Remove `cwd` parameter** — `codex --version` doesn't need a working directory. Use a neutral cwd (or let ProcessService use its default).
2. **Hand-roll semver parser (20 lines)** — Do not add `node-semver` as a dependency (50KB for 20 lines of needed functionality).
3. **Use `Bun.which('codex')` guard** before spawning — avoids noisy `ENOENT` errors.
4. **Error message pattern: what happened + what is required + how to fix it:**

```ts
export class CodexVersionError extends Error {
  constructor(found: string, required: string) {
    super(
      `codex CLI version ${found} is too old. ` +
      `orch requires >= ${required}. ` +
      `Upgrade with: npm i -g @openai/codex`
    )
    this.name = 'CodexVersionError'
  }
}
```

5. **Pass minimal env to version check** — only `PATH` and `HOME` are needed. No API keys.

**Thread-safety note:** If two parallel branches share the same runner instance and both call `buildCommand` before either sets `versionChecked = true`, both will check the version. This is harmless (two checks instead of one). Not worth adding locking complexity.

### Environment allowlist

> **Superseded by [2026-04-27 env passthrough plan](2026-04-27-feat-env-passthrough-plan.md).** The allowlist (and the `ctxEnv` filter and `OPENAI_BASE_URL` exclusion) below are preserved for archaeology; the live contract is passthrough via `mergeEnv(process.env, {}, ctx.env)` from `src/runners/_shared/merge-env.ts`.

Mirrors ClaudeRunner pattern with Codex-specific prefixes:

```ts
const CODEX_ENV_ALLOWLIST = [
  'HOME', 'PATH', 'SHELL', 'USER', 'TMPDIR', 'LANG', 'LC_ALL',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
] as const

// Prefix-based: CODEX_* pass through unconditionally.
// OPENAI_* restricted to explicit allowlist (see security note below).
// CODEX_API_KEY is primary auth; OPENAI_API_KEY is fallback.
```

### Research Insights: Environment Security (HIGH priority)

**Finding 1 — `ctxEnv` bypass (security sentinel, HIGH):** The current `buildClaudeEnv` pattern (which this plan mirrors) uses `{ ...ctxEnv, ...base }` so the allowlist wins for known keys. However, `ctxEnv` can inject **arbitrary unknown keys** not in the allowlist: `LD_PRELOAD`, `NODE_OPTIONS`, `DYLD_INSERT_LIBRARIES`. These give arbitrary code execution in the subprocess. Fix: filter `ctxEnv` through the same allowlist/prefix rules. Only pass through keys that match the static allowlist or the prefix pattern:

```ts
export function buildCodexEnv(
  ctxEnv: Readonly<Record<string, string>>,
  processEnv: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const base: Record<string, string> = {}
  for (const key of CODEX_ENV_ALLOWLIST) {
    const val = processEnv[key]
    if (val !== undefined) base[key] = val
  }
  for (const [key, val] of Object.entries(processEnv)) {
    if ((key.startsWith('CODEX_') || key === 'OPENAI_API_KEY' || key === 'OPENAI_ORG_ID') && val !== undefined) {
      base[key] = val
    }
  }
  // Filter ctxEnv through the same rules — DO NOT spread raw ctxEnv
  for (const [key, val] of Object.entries(ctxEnv)) {
    if (CODEX_ENV_ALLOWLIST.includes(key as typeof CODEX_ENV_ALLOWLIST[number])
        || key.startsWith('CODEX_')
        || key === 'OPENAI_API_KEY' || key === 'OPENAI_ORG_ID') {
      if (!(key in base)) base[key] = val  // allowlist wins
    }
  }
  return base
}
```

**Finding 2 — `OPENAI_BASE_URL` is dangerous (security sentinel, MEDIUM):** The `OPENAI_*` prefix pass-through is too broad. `OPENAI_BASE_URL` can redirect all API traffic to an attacker-controlled endpoint, capturing every prompt and response. Narrow to an explicit allowlist: `OPENAI_API_KEY` and `OPENAI_ORG_ID` only. Keep `CODEX_*` as prefix-based since the namespace is newer and less populated.

**Finding 3 — Remove `TERM` (security sentinel, LOW):** The Codex subprocess runs non-interactively (`codex exec`). It has no terminal. `TERM` is unnecessary and leaks host information.

**Finding 4 — Backport `SSL_CERT_FILE`/`SSL_CERT_DIR` to ClaudeRunner:** The Codex plan includes these but ClaudeRunner omits them. Corporate proxy/firewall environments need them. File a follow-up to backport.

### Flag denylist

```ts
const CODEX_FLAG_DENYLIST = [
  '--dangerously-bypass-approvals-and-sandbox',
  '--yolo',
  '--config',
  '--sandbox',
  '-c',
  '--approval-mode',
] as const
```

Prevents workflow authors from accidentally disabling safety guardrails **or reconfiguring them via side channels**.

### Research Insights: Flag Denylist (HIGH priority)

**Finding (security sentinel, HIGH):** The original denylist only blocked `--yolo` and `--dangerously-bypass-approvals-and-sandbox`. Missing flags that can reconfigure safety:

- **`--config <path>`** — Loads an arbitrary TOML/JSON config file that can override sandbox mode, approval policy, and all other settings. A compromised upstream step passing `extraArgs: ['--config', '/tmp/evil.toml']` completely bypasses the factory's sandbox setting.
- **`--sandbox <mode>`** ��� Direct sandbox override. If `extraArgs: ['--sandbox', 'danger-full-access']` is appended after the factory's `--full-auto`, CLI flag precedence (last wins) could take effect.
- **`-c <key>=<value>`** — Codex configuration overrides. Can override any setting.
- **`--approval-mode <mode>`** — Can disable human-in-the-loop approval.

**Note:** The factory's own built-in flags (`--full-auto`) are added **before** the denylist check. The denylist only checks user-supplied `flags` and `ctx.extraArgs`, so the factory itself is not affected.

**`danger-full-access` sandbox mode consideration:** The plan allows this as a first-class `CodexOptions.sandbox` value. Consider requiring an explicit env var gate (`CODEX_ALLOW_DANGER=1`) or removing it from the typed API and forcing callers to use the escape hatch of manually constructing flags. This creates deliberate friction for the dangerous path.

### Differences from ClaudeRunner

| Aspect | ClaudeRunner | CodexRunner |
|---|---|---|
| NDJSON flag | `--output-format stream-json` | `--json` |
| Schema delivery | `--json-schema '<inline>'` | `--output-schema <file>` (temp file via FsService) |
| Terminal event | `type: "result"` envelope | `turn.completed` / `turn.failed` |
| Structured output location | `structured_output` field on result | `item.completed.item.text` (agent_message) stashed into terminal event `data` |
| Sandbox config | N/A (Claude uses permissions) | `--full-auto` default, configurable |
| Auth env var | `ANTHROPIC_API_KEY` | `CODEX_API_KEY` / `OPENAI_API_KEY` |
| Version preflight | Deferred to Phase 12 | Included (Phase 9) |
| Git repo requirement | None | `--skip-git-repo-check` needed |
| Session persistence | `--no-session-persistence` | `--ephemeral` |
| buildCommand | Sync | Async (temp file write) |
| Factory dependencies | None | `{ fs: FsService, ps: ProcessService }` |
| Parser export | `parseClaudeLine` (standalone) | `parseCodexLine` (standalone) |
| `--` separator | Not used | Before prompt (security) |
| Env prefix pass | `ANTHROPIC_*`, `CLAUDE_*` | `CODEX_*`, `OPENAI_API_KEY` only |

### Research Insights: Performance

**No critical performance issues (performance-oracle).** The dominant cost is always the subprocess execution time (API round-trip ~200-500ms), not anything the orchestrator does in-process.

**NDJSON parsing:** `JSON.parse` on a single NDJSON line (typically 200-2000 bytes) takes microseconds. Zod `safeParse` only fires on terminal events (once per invocation). Even at 10,000 lines per invocation, parsing cost would remain sub-millisecond per line.

**Temp file I/O:** `mkdtemp` + one `writeFile` of ~1KB completes in under 1ms. Entirely off the critical path.

**`await` on sync buildCommand:** A no-op microtask — zero measurable overhead for ClaudeRunner.

**Subprocess startup:** Codex is Rust-based (~10-30ms startup vs ~50-100ms for Node-based CLIs). Version preflight adds ~100ms on first call only.

**State store under parallel:** The `FileStateStore` write queue serializes concurrent `saveStep` calls per `runId`. For 2 parallel branches, at most 2 writes queued — negligible. For high-concurrency homogeneous parallel (100+ items), the full-state re-parse becomes O(n^2) in total I/O. Known, deferred to future phase.

## Open Question Resolutions

**Q1: Temp file cleanup.** Rely on OS temp dir cleanup. Files are tiny (~1KB). Revisit if profiling shows accumulation. Future extension point: `RunnerCommand.cleanup?: () => Promise<void>`.

**Q2: FsService.writeTempFile.** Not needed. Use existing `tempDir('codex-schema')` + `writeFile(path(...), content)`. Use `path()` constructor, not `as Path`.

**Q3: Preflight call site.** Lazy on first `buildCommand`, gated by `versionChecked` boolean in closure. Use `Bun.which('codex')` guard before spawn. Remove `cwd` parameter — `codex --version` doesn't need a working directory.

**Q4: `-C` vs `cwd` on spawn.** Use `SpawnOptions.cwd` for consistency with ClaudeRunner. Do not use Codex's `-C` flag.

**Q5 (NEW): Closure state reset.** Reset `lastAgentMessage` to `undefined` at the top of `buildCommand`. This prevents stale data from leaking across sequential invocations. `versionChecked` is NOT reset (correctly persistent).

**Q6 (NEW): Parallel runner sharing.** Document that each `parallel()` branch should use its own runner instance. The closure-based state is not concurrency-safe. This matches the existing test pattern where each branch creates its own `FakeRunner`.

**Q7 (NEW): Factory dependencies.** Factory receives `{ fs: FsService, ps: ProcessService }`. Consider lazy-importing a default `BunFsService`/`BunProcessService` (like `buildClaudeEnv` defaults `processEnv` to `process.env`) for DX parity with `claude()`.

**Q8 (NEW): `extractStructuredOutput` contract.** Stash `lastAgentMessage` into the terminal event's `data._accumulatedText` field during `parseEvents`. This makes `extractStructuredOutput` a pure function of `finalEvent`, matching ClaudeRunner's stateless contract.

## Implementation Steps

### Step 1: Make `buildCommand` async-compatible (prerequisite)

**Files modified:**
- `src/runners/types.ts` — widen `buildCommand` return type to `RunnerCommand | Promise<RunnerCommand>`. Add JSDoc explaining async is for adapter preparation (temp files, version checks).
- `src/runners/execute.ts` — `await runner.buildCommand(ctx)` (1-line change)

**Tests:** Existing tests pass unchanged (sync return is valid `RunnerCommand | Promise<RunnerCommand>`). Run `bun run check` to confirm.

**Research insight:** The `defineRunner` Zod schema's `z.custom<Runner['buildCommand']>` auto-updates via the type reference. No Zod changes needed.

### Step 2: NDJSON test fixtures

**Files created:**
- `tests/fixtures/codex/simple-success.jsonl` — `thread.started` -> `turn.started` -> `item.completed` (agent_message "OK") -> `turn.completed`
- `tests/fixtures/codex/with-output-schema.jsonl` — same flow but `item.completed` text is JSON string conforming to a schema
- `tests/fixtures/codex/turn-failed.jsonl` — `thread.started` -> `turn.started` -> `turn.failed` with error message

Hand-crafted from Codex CLI reference in brainstorm. Format: one JSON object per line.

### Step 3: CodexRunner implementation

**Files created:**
- `src/runners/codex/codex-runner.ts` (~220 lines) — Zod schemas for Codex events, standalone `parseCodexLine()` parser (exported), `buildCodexEnv()` (exported), flag denylist, `codex()` factory via `defineRunner()`, `checkCodexVersion()`, `CodexVersionError`.
- `src/runners/codex/index.ts` (~5 lines) — module barrel

**Files modified:**
- `src/runners/index.ts` — re-export `codex` factory, `CodexOptions`, `CodexVersionError`, `buildCodexEnv`, `parseCodexLine`

**Research insights for implementation:**
- Section order must match ClaudeRunner: Zod schemas, types, options, env allowlist, flag denylist, parser, version preflight, factory.
- `parseCodexLine` exported as standalone function (testable without factory instantiation).
- `buildCodexEnv` exported with injected `processEnv` parameter (testable without `process.env`).
- Factory signature: `codex(opts: CodexOptions, deps: { fs: FsService; ps: ProcessService })`.
- `buildCommand` resets `lastAgentMessage` at the top, before any other work.
- `extractStructuredOutput` reads from `finalEvent.data._accumulatedText`, guards on error events.
- `assertFlagAllowed` checks both `flags` and `ctx.extraArgs`.
- Argv includes `--` before the prompt.

### Step 4: Unit tests

**Files created:**
- `tests/unit/runners/codex/build-command.test.ts` (~200 lines)
- `tests/unit/runners/codex/parse-events.test.ts` (~250 lines)

**buildCommand tests:**
- Default argv: `codex exec --json --full-auto --skip-git-repo-check --ephemeral` + prompt last
- Custom model: `[-m <model>]` included
- Custom sandbox: `--read-only` replaces `--full-auto`
- With schema: temp file written via FsService, `--output-schema <path>` in argv
- With extraArgs: appended after built-in flags
- Flag denylist: `--yolo` and `--dangerously-bypass-approvals-and-sandbox` throw from both `flags` and `extraArgs`
- Env allowlist: includes HOME, PATH, CODEX_API_KEY, OPENAI_API_KEY; excludes DATABASE_URL

**parseEvents tests:**
- `thread.started` -> info event with `thread_id` in payload
- `turn.started` -> info event
- `item.started` / `item.completed` -> info events
- `turn.completed` -> terminal `turn-complete` with usage data
- `turn.failed` -> terminal `error` with message
- Stream-level `error` -> terminal `error` with message
- Malformed JSON -> null
- Empty/whitespace line -> null
- JSON without `type` field -> null
- Non-object JSON -> null

**extractStructuredOutput tests:**
- With accumulated agent_message -> parsed JSON object
- Without agent_message -> undefined
- With invalid JSON in agent_message -> undefined
- Error terminal event -> undefined (even if agent_message accumulated)

**checkCodexVersion tests:**
- Valid version `"codex 0.120.0"` -> resolves
- Old version `"codex 0.117.0"` -> throws `CodexVersionError` with actionable message
- Missing CLI -> throws `ProcessSpawnError`
- Unparseable output `"unknown"` -> throws `CodexVersionError`

**Env tests:**
- `CODEX_API_KEY` and `OPENAI_API_KEY` included
- `CODEX_ANYTHING` prefix included
- `OPENAI_ANYTHING` prefix included
- `DATABASE_URL`, `STRIPE_SECRET_KEY` excluded
- `ctxEnv` merged with lower precedence than allowlist

### Step 5: Integration tests (mocked)

**Files created:**
- `tests/integration/runners/codex/codex-mocked.test.ts` (~100 lines)

**Tests:**
- Simple success: `simple-success.jsonl` -> terminal `turn-complete`, exit 0, `extractStructuredOutput` returns `"OK"`
- Structured output: `with-output-schema.jsonl` -> terminal `turn-complete`, `extractStructuredOutput` returns parsed JSON matching schema
- Turn failed: `turn-failed.jsonl` -> terminal `error`, exit 1, error message present
- Argv shape: `buildCommand` produces correct array for spawned process (schema temp file path in argv)

### Step 6: Integration tests (real, gated)

**Files created:**
- `tests/integration/runners/codex/codex-real.test.ts` (~40 lines)

**Test:** Gated by `RUN_REAL_CODEX=1` + `Bun.which('codex')`.
- Prompt: `"Reply with exactly: OK"`
- Sandbox: `full-auto` (default)
- Validates: terminal `turn-complete`, exit 0
- Timeout: 30s

### Step 7: Cross-runner parallel integration test (real, gated)

**Files created:**
- `tests/integration/runners/cross-runner-parallel.test.ts` (~60 lines)

**Test:** Gated by both `RUN_REAL_CLAUDE=1` + `RUN_REAL_CODEX=1` + both CLIs available.
- `parallel([run(CLAUDE_STEP), run(CODEX_STEP)])` with tiny prompts
- Both return terminal `turn-complete`
- Validates the core multi-agent promise: two different real runners completing in parallel
- Timeout: 60s

### Step 8: Roadmap update

**Files modified:**
- `docs/plans/implementation-phases.md` — update Phase 9 block: replace placeholder deliverables with actual deliverables, mark ✓, add `**Landed:** YYYY-MM-DD`

## Files

### New files

| File | Purpose | Est. lines |
|---|---|---|
| `src/runners/codex/codex-runner.ts` | Zod schemas, standalone `parseCodexLine`, `buildCodexEnv`, flag denylist, version preflight, factory | ~220 |
| `src/runners/codex/index.ts` | Module barrel | ~5 |
| `tests/fixtures/codex/simple-success.jsonl` | Basic prompt completion NDJSON | ~5 |
| `tests/fixtures/codex/with-output-schema.jsonl` | Structured output NDJSON | ~5 |
| `tests/fixtures/codex/turn-failed.jsonl` | Failure mode NDJSON | ~4 |
| `tests/unit/runners/codex/build-command.test.ts` | Unit: buildCommand, factory, env, denylist, version, closure reset | ~220 |
| `tests/unit/runners/codex/parse-events.test.ts` | Unit: parseCodexLine, extractStructuredOutput, error guard | ~200 |
| `tests/integration/runners/codex/codex-mocked.test.ts` | Mocked integration via FakeProcessService + FakeFsService | ~100 |
| `tests/integration/runners/codex/codex-real.test.ts` | Real CLI, gated `RUN_REAL_CODEX=1` | ~40 |
| `tests/integration/runners/cross-runner-parallel.test.ts` | ClaudeRunner + CodexRunner parallel, gated both env vars | ~60 |

### Modified files

| File | Change |
|---|---|
| `src/runners/types.ts` | `buildCommand` return type widened to `RunnerCommand \| Promise<RunnerCommand>` + JSDoc |
| `src/runners/execute.ts` | `await runner.buildCommand(ctx)` (1-line change) |
| `src/runners/index.ts` | Re-export `codex`, `CodexOptions`, `CodexVersionError`, `buildCodexEnv`, `parseCodexLine` |
| `docs/plans/implementation-phases.md` | Update Phase 9 deliverables, mark landed |

## Acceptance Criteria

### Unit tests

- [x] `buildCommand` produces correct default argv (`codex exec --json --full-auto --skip-git-repo-check --ephemeral -- <prompt>`)
- [x] `buildCommand` includes `--` separator before prompt
- [x] `buildCommand` includes `-m <model>` when provided
- [x] `buildCommand` replaces `--full-auto` with `--sandbox <mode>` for non-preset modes
- [x] `buildCommand` writes temp schema file via `path()` (not `as Path`) and adds `--output-schema <path>` when `ctx.schema` set
- [x] `buildCommand` appends user `flags` and `extraArgs` after built-in flags, before `--`
- [x] `buildCommand` rejects `--yolo`, `--dangerously-bypass-approvals-and-sandbox`, `--config`, `--sandbox`, `-c`, `--approval-mode`
- [x] `buildCommand` resets `lastAgentMessage` to undefined (closure state reset)
- [x] `buildCodexEnv` includes CODEX_* prefix, `OPENAI_API_KEY`, `OPENAI_ORG_ID`, allowlisted vars; excludes others
- [x] `buildCodexEnv` excludes `OPENAI_BASE_URL` (not in explicit allowlist)
- [x] `buildCodexEnv` filters `ctxEnv` through allowlist (does not pass raw unknown keys like `LD_PRELOAD`)
- [x] `parseCodexLine` `thread.started` -> info event with thread_id
- [x] `parseCodexLine` `turn.completed` -> terminal `turn-complete` with usage data and `_accumulatedText`
- [x] `parseCodexLine` `turn.failed` -> terminal `error` with message
- [x] `parseCodexLine` stream-level `error` -> terminal `error` with message
- [x] `parseCodexLine` unknown event types -> info passthrough
- [x] `parseCodexLine` malformed JSON / missing type / non-object -> null
- [x] `extractStructuredOutput` with error terminal event -> undefined (even if agent_message accumulated)
- [x] `extractStructuredOutput` with `_accumulatedText` in terminal data -> parsed JSON
- [x] `extractStructuredOutput` without `_accumulatedText` -> undefined
- [x] `extractStructuredOutput` with invalid JSON in `_accumulatedText` -> undefined
- [x] `extractStructuredOutput` after closure reset (second invocation, no agent_message) -> undefined
- [x] `checkCodexVersion` valid version -> resolves
- [x] `checkCodexVersion` old version -> throws CodexVersionError with actionable message
- [x] `checkCodexVersion` missing CLI -> throws CodexVersionError (not ProcessSpawnError — use Bun.which guard)
- [x] `checkCodexVersion` unparseable output -> throws CodexVersionError
- [x] `codex()` factory returns valid runner with `name: 'codex'`, `structuredOutput: true`

### Integration tests (mocked)

- [x] Full round-trip `CodexRunner -> runRunner -> FakeProcessService` from `simple-success.jsonl`: correct events, terminal `turn-complete`, `durationMs`
- [x] Structured output round-trip from `with-output-schema.jsonl`: temp file written, `extractStructuredOutput` returns parsed JSON
- [x] Error round-trip from `turn-failed.jsonl`: terminal `error`, message present

### Integration tests (real, gated)

- [x] `RUN_REAL_CODEX=1` + `Bun.which('codex')`: tiny prompt, `turn-complete`, exit 0
- [x] `RUN_REAL_CLAUDE=1` + `RUN_REAL_CODEX=1`: parallel with both runners, both complete

### Quality gates

- [x] `bun run check` green
- [x] Files <= 300 lines, functions <= 60 lines
- [x] No `any`, `!`, or unsafe `as` casts on `unknown`
- [x] No `child_process`/`Bun.spawn` outside `src/services/process/`
- [x] No `as Path` — use `path()` constructor everywhere
- [x] Existing ClaudeRunner and FakeRunner tests pass unchanged after `buildCommand` type widening
- [x] `parseCodexLine` exported as standalone function (testable without factory)
- [x] `buildCodexEnv` exported with injected `processEnv` parameter (testable without `process.env`)
- [x] `extractStructuredOutput` guards on `finalEvent.type === 'error'`
- [x] `buildCommand` resets closure state at the top
- [x] `ctxEnv` filtered through allowlist (no raw unknown key passthrough)
- [x] Argv includes `--` separator before prompt

## Edge Cases and Gaps (from spec-flow analysis)

### Resolved in this plan

| Gap | Resolution |
|---|---|
| Closure state leaks across invocations | Reset `lastAgentMessage` in `buildCommand` (D13) |
| Parallel runner sharing race condition | Document constraint: one instance per parallel branch (Q6) |
| `extractStructuredOutput` missing error guard | Added guard: `finalEvent.type === 'error' → undefined` (D6) |
| `buildClaudeEnv` typo in acceptance criteria | Fixed to `buildCodexEnv` |
| Sandbox mode argv mapping ambiguous | Explicit table added (Architecture section) |
| `checkCodexVersion` unnecessary `cwd` param | Removed from signature (D3) |
| Flag injection via prompt | `--` separator added (D15) |

### Deferred (documented for future phases)

| Gap | Status |
|---|---|
| Temp file cleanup for long-running orchestrators | Deferred; future `RunnerCommand.cleanup` hook |
| Exit code 0 + terminal error disagreement | Verify against real Codex CLI in Step 6 |
| Auth failure NDJSON behavior | Test in Step 6 real integration |
| Timeout support for hung subprocesses | Future: add `timeoutMs` to `SpawnOptions` |
| Process-level SIGTERM handler for active subprocesses | Future: orchestrator lifecycle concern |
| AbortSignal for cancellation in parallel | Future: `SpawnOptions.signal` |

## Decisions Log

| ID | Decision | Rationale |
|---|---|---|
| D1 | `buildCommand` return type widened to `RunnerCommand \| Promise<RunnerCommand>` | Codex needs temp file write; fully backwards-compatible; 1-line executor change |
| D2 | No `FsService.writeTempFile` convenience method | Existing `tempDir()` + `writeFile()` sufficient; avoids interface churn |
| D3 | Version preflight lazy on first buildCommand, no `cwd` param | Factory is too early (runner may never run); executor is runner-agnostic; `codex --version` doesn't need cwd |
| D6 | Structured output stashed into terminal event `data._accumulatedText` | Makes `extractStructuredOutput` a pure function of `finalEvent`; avoids closure-based race conditions; matches ClaudeRunner's stateless contract |
| D10 | `FsService` + `ProcessService` injected into factory (not runner interface) | Adapter-specific dependencies; kept out of generic `Runner` interface |
| D11 | No Zod schema for Codex event payloads (except terminal) | Forward-compatible; new Codex event types pass through as info |
| D13 | Closure state reset in `buildCommand` | Prevents stale `lastAgentMessage` from leaking across sequential invocations of the same runner instance |
| D14 | Thread ID deferred to Phase 15 | YAGNI — 3 lines trivial to add when resume lands; removes cognitive overhead for Phase 9 readers |
| D15 | `--` separator before prompt in argv | Prevents flag injection if prompt starts with `--`; zero cost, standard POSIX convention |
| D16 | Expanded flag denylist: `--config`, `--sandbox`, `-c`, `--approval-mode` | Original denylist only blocked obvious flags; these reconfigure safety from underneath |
| D17 | `OPENAI_*` prefix narrowed to explicit allowlist (`OPENAI_API_KEY`, `OPENAI_ORG_ID`) | `OPENAI_BASE_URL` can redirect all API traffic to attacker-controlled endpoint |
| D18 | `ctxEnv` filtered through allowlist/prefix rules | Prevents injection of `LD_PRELOAD`, `NODE_OPTIONS` via `RunnerContext.env` |
| D19 | `parseCodexLine` exported as standalone function | Matches ClaudeRunner's `parseClaudeLine` pattern; enables direct unit testing without factory instantiation |

## References

### Internal
- Brainstorm: [`docs/brainstorms/2026-04-12-phase-9-codex-runner-brainstorm.md`](../brainstorms/2026-04-12-phase-9-codex-runner-brainstorm.md)
- ClaudeRunner (reference impl): `src/runners/claude/claude-runner.ts`
- Runner interface: `src/runners/types.ts` | Executor: `src/runners/execute.ts`
- FakeRunner: `src/runners/fake/fake-runner.ts` | Workflow: `src/core/workflow.ts`
- ProcessService: `src/services/process/process-service.ts`
- FsService: `src/services/fs/fs-service.ts`
- Parallel helper: `src/core/parallel.ts`
- Phase 8 parallel mocked tests: `tests/integration/core/parallel-mocked.test.ts`

### External
- Codex CLI: `npm i -g @openai/codex` (Rust-based, >= 0.118.0)
- Codex exec mode: non-interactive NDJSON streaming via `codex exec --json`
- Auth: `CODEX_API_KEY` (exec mode primary), `OPENAI_API_KEY` (fallback)
- Sandbox modes: `read-only`, `workspace-write`, `danger-full-access`; presets: `--full-auto`, `--yolo`
