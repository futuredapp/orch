---
title: Codex runner parity (interactive + transcript rendering)
type: feat
status: active
date: 2026-05-01
---

# Codex runner parity with Claude runner

## Overview

Bring `CodexRunner` up to feature parity with `ClaudeRunner` along two axes that a workflow author trips over today:

1. **Interactive step mode** — `mode: 'interactive'` against a `codex(...)` agent currently throws `RunnerCapabilityError` because `supports.interactive: false` is hardcoded at `src/runners/codex/codex-runner.ts:201`. The Codex CLI itself supports interactive use (`codex [PROMPT]` opens the TUI by default; `codex exec` is the non-interactive variant), so this is purely an adapter gap.
2. **Transcript rendering** — replace the Phase A placeholder `toTranscriptLines: () => []` (`codex-runner.ts:286`) with a real formatter that covers all seven `item.completed` Codex item types plus the two terminal events, on par with `toClaudeTranscriptLines`. Today autonomous Codex steps render as **nothing** in the transcript pane even though the underlying NDJSON stream is rich.

Out of scope (explicit): resume / `codex resume <thread_id>` (slated for Phase 15), Claude-side gaps (autonomous-argv `--` separator, version preflight), and any Codex-specific features beyond what brings it level with Claude. Thread-id capture stays deferred — Phase 9 brainstorm flagged it as Phase 15 prep and we keep that boundary clean.

## Problem statement

A workflow author who reads `examples/riddle-solver/index.ts` (Claude, mixes `mode: 'interactive'` step 1 + autonomous step 2) and then opens `examples/codex-riddle-solver/index.ts` (Codex, fully autonomous) immediately notices two things missing:

- The "interactive write-riddle" pattern doesn't compile against Codex — but the README explicitly tells them why and tells them to go use Claude. We tell users to pick Claude for the interactive demo despite the underlying Codex CLI fully supporting interactive use.
- During an autonomous Codex run, the transcript pane is dead silent. There's no `tool-call` line for `command_execution`, no `assistant>` line for `agent_message`, no `done`/`failed` block at the end. The same workflow under Claude produces a rich, scrolling transcript. The data is on disk in `<runId>/steps/<step>.transcript.ndjson` — it just never reaches the eyeballs.

Both are pure adapter-layer gaps. Neither requires changes to `core`, `state`, `validators`, `services`, or any host. The brainstorm at `docs/brainstorms/2026-05-01-codex-runner-parity-brainstorm.md` made the design decisions; this plan turns them into a concrete implementation slice with file paths, mapping tables, and tests.

## Proposed solution

Three implementation phases, each PR-sized and individually verifiable:

| Phase | Scope | Touches |
|---|---|---|
| **A — Interactive argv** | `supports.interactive: true`, new `buildInteractiveArgv` helper + early interactive branch in `buildCommand` (autonomous block stays inline), schema+interactive eager throw, `FORCE_COLOR=3` extra in interactive mode | `src/runners/codex/codex-runner.ts`, `tests/unit/runners/codex/build-command.test.ts` |
| **B — Formatter** | New `src/runners/codex/format-event.ts`; replace `toTranscriptLines: () => []`; cover all 7 `item.completed` item types + 2 terminal events + unknown-event fallback | `src/runners/codex/codex-runner.ts`, `src/runners/codex/format-event.ts`, `tests/unit/runners/codex/format-event.test.ts`, fixture additions under `tests/fixtures/codex/` |
| **C — Demo + docs sweep** | `examples/codex-riddle-solver` step 1 → `mode: 'interactive'`; rewrite README's "Interactive vs non-interactive" section + table; sweep `docs/getting-started.md` for stale "Codex doesn't support interactive" claims | `examples/codex-riddle-solver/{index.ts,README.md}`, `docs/getting-started.md` |

Phases land in order; A is the prerequisite for C. B can land before or after C (independent). Each phase ships its own tests behind `bun run check`.

## Technical approach

### Architecture impact: zero core changes

The executor already routes interactive steps runner-agnostically:

- `src/core/workflow.ts:334` — `runInteractiveStep` checks `config.agent.supports.interactive` and (if true) calls `deps.host.runInteractive(...)` with the runner's `buildCommand({ ..., mode: 'interactive' })` argv.
- `src/runners/execute.ts:118` — `runInteractive` takes any `Runner` and shells out via `processService.spawnForeground`.
- `src/hosts/plain/plain-host.ts:146` and `src/hosts/two-pane/tmux-host.ts:405` both accept a `Runner` agnostically; the plain host calls `spawnForeground`, the tmux host calls `respawn-pane -k`.

So the **only** edit needed for interactive is in `codex-runner.ts`. The `RunnerCapabilityError` thrown at `workflow.ts:348` flips to a no-op once the runner declares `supports.interactive: true`.

The transcript rendering path is similarly self-contained: `runRunner` calls `runner.toTranscriptLines(event)` for each parsed event in `src/runners/execute.ts`, and the host renders the returned `TranscriptLine[]`. The formatter is pure — runners stay free of ANSI and pane-width concerns; categories carry semantic intent (see `src/runners/types.ts:58`). Replacing the `() => []` placeholder is purely additive.

### Resolved open questions (from plan-phase research)

The brainstorm flagged two open questions. Both are now resolved enough to commit to the implementation.

#### Open Question 1: Codex interactive flag matrix

**Audit done against `codex 0.125.0` (real `codex --help` and `codex exec --help`).**

| Flag | `codex` (interactive) | `codex exec` (autonomous) | Notes |
|---|---|---|---|
| `-m, --model <MODEL>` | ✅ | ✅ | Carries to interactive |
| `-s, --sandbox <MODE>` | ✅ | ✅ | Carries to interactive |
| `--full-auto` | ✅ | ✅ | Carries to interactive |
| `-c, --config <k=v>` | ✅ | ✅ | Already on denylist; no change |
| `--enable / --disable <FEATURE>` | ✅ | ✅ | User-supplied via `flags`; no special handling |
| `-p, --profile <NAME>` | ✅ | ✅ | Carries; user-supplied |
| `-i, --image <FILE>` | ✅ | ✅ | Carries; user-supplied |
| `--oss` / `--local-provider` | ✅ | ✅ | Carries; user-supplied |
| `-C, --cd <DIR>` | ✅ | ✅ | Carries; user-supplied |
| `--add-dir <DIR>` | ✅ | ✅ | Carries; user-supplied |
| `--dangerously-bypass-approvals-and-sandbox` | ✅ | ✅ | Already on denylist; no change |
| **`--skip-git-repo-check`** | **❌** | ✅ | **Exec-only.** Verified: `codex --skip-git-repo-check` returns `error: unexpected argument`. Drop from interactive argv. |
| **`--ephemeral`** | **❌** | ✅ | **Exec-only.** Confirms brainstorm decision. Drop from interactive argv. |
| **`--ignore-user-config`** | ❌ | ✅ | Exec-only |
| **`--ignore-rules`** | ❌ | ✅ | Exec-only |
| **`--output-schema <FILE>`** | ❌ | ✅ | Exec-only. Schema+interactive must throw eagerly (already a brainstorm decision). |
| **`--color <COLOR>`** | ❌ | ✅ | Exec-only |
| **`--json`** | ❌ | ✅ | Exec-only — alone justifies the subcommand split |
| **`-o, --output-last-message <FILE>`** | ❌ | ✅ | Exec-only |
| **`-a, --ask-for-approval <POLICY>`** | ✅ | ❌ | **Interactive-only.** User-supplied via `flags` if needed. |
| **`--search`** | ✅ | ❌ | Interactive-only; user-supplied |
| **`--no-alt-screen`** | ✅ | ❌ | Interactive-only; user-supplied. Useful escape hatch under tmux/pane environments. |

**Net effect on `buildInteractiveArgv`:** the brainstorm's tentative carry-over list said `--skip-git-repo-check` would carry. It does not. The interactive argv shape becomes:

```
codex
  [-m <model>]
  [--full-auto | --sandbox <mode>]
  [<user flags>]
  [<extraArgs>]
  -- <prompt>
```

The flag denylist (`--dangerously-bypass-approvals-and-sandbox`, `--yolo`, `--config`, `--sandbox`, `-c`, `--approval-mode`) applies identically to both modes — `assertFlagAllowed` runs once at the top of `buildCommand` regardless of mode.

#### Open Question 2: TTY/Ratatui under inherited stdio

**Verdict: expected to work, manual smoke required as a Definition-of-Done item.** Same `inherit`-stdio path Claude's Ink TUI uses today (`BunProcessService.spawnForeground`, `src/services/process/bun-process-service.ts:67-69`); `FORCE_COLOR=3` is harmless for Ratatui (it does its own TTY/COLORTERM detection). Risk row 1 captures the fallback; PTY introduction is **explicitly not** in scope.

### Implementation Phases

#### Phase A — Interactive argv

Files touched:

- **`src/runners/codex/codex-runner.ts`** (~50-line delta)
  - Flip `supports.interactive: false` → `true` (line 201).
  - **Do not extract `buildAutonomousArgv`.** The two modes share nothing — keep the existing autonomous block inline and add an early interactive branch above it. This keeps the autonomous argv byte-identical to today (Risk row 4) by construction: the existing code path is untouched.
  - Sketch:
    ```ts
    // top of buildCommand, after assertFlagAllowed(...)
    if (ctx.mode === 'interactive') {
      if (ctx.schema) {
        throw new Error(
          `codex(): schema-typed steps cannot run in interactive mode — ` +
            `--output-schema is exec-only, and schema-shaped output has no ` +
            `meaning in the interactive TUI`,
        )
      }
      lastAgentMessage = undefined  // explicit cross-mode reset; never let autonomous state leak into a subsequent interactive invocation
      await ensureVersionChecked(deps)  // shared with autonomous path; same versionChecked closure flag
      return {
        argv: buildInteractiveArgv(ctx, { model, sandbox, flags }),
        env: mergeEnv(process.env, { FORCE_COLOR: '3' }, ctx.env),
      }
    }
    // existing autonomous block continues unchanged below
    ```
  - `buildInteractiveArgv` shape:
    ```ts
    function buildInteractiveArgv(
      ctx: RunnerContext,
      opts: { model?: string; sandbox: SandboxMode; flags?: readonly string[] },
    ): readonly string[] {
      const argv: string[] = ['codex']
      if (opts.sandbox === 'full-auto') argv.push('--full-auto')
      else argv.push('--sandbox', opts.sandbox)
      if (opts.model) argv.push('-m', opts.model)
      argv.push(...(opts.flags ?? []))
      argv.push(...ctx.extraArgs)
      argv.push('--', ctx.prompt)
      return argv
    }
    ```
  - `lastAgentMessage` is reset at the **top** of every `buildCommand` invocation regardless of mode. This makes the cross-mode invariant explicit and removes the latent leak if `parseEvents` ever runs under interactive (e.g. a future transcript tee).

- **`tests/unit/runners/codex/build-command.test.ts`** (~50-line addition; one inversion)
  - Invert the assertion at line 32: `expect(runner.supports.interactive).toBe(true)`.
  - Add `describe('buildCommand interactive mode', () => { ... })` — every `it` name is a full sentence, no parentheticals:
    - `it('builds the default interactive argv with --full-auto, the -- separator, and the prompt', ...)` — asserts `['codex', '--full-auto', '--', 'hello world']`. This single test also proves no `exec` / `--json` / `--skip-git-repo-check` / `--ephemeral` leak into the interactive path.
    - `it('replaces --full-auto with --sandbox <mode> when the user picks a non-default sandbox', ...)`.
    - `it('places model, user flags, and extraArgs after the sandbox flag and before the -- separator', ...)` — one parameterized assertion covers `-m`, `flags`, and `extraArgs` ordering.
    - `it('throws synchronously when ctx.schema is set and ctx.mode is interactive', ...)` — verifies the eager throw, naming `--output-schema` and "exec-only" in the message.
    - `it('applies the same flag denylist in interactive mode as in autonomous mode', ...)` — passes `--config` via `flags`, expects rejection.
    - `it('reuses the versionChecked closure flag across modes so the preflight runs once total', ...)` — explicitly mixes one autonomous + one interactive `buildCommand` call and asserts `codex --version` spawn count is 1.
    - `it('sets FORCE_COLOR=3 in env for interactive mode', ...)` — read `cmd.env.FORCE_COLOR`.
    - The existing autonomous `'produces correct default argv'` test at `build-command.test.ts:44` gains one extra invariant assertion: `cmd.env.FORCE_COLOR === undefined`.

  Cuts vs. the original list: the "runs version preflight in interactive mode" and "omits --output-schema in interactive mode" tests are dropped. The first is folded into the cross-mode preflight test (the only invariant that actually matters); the second is fully covered by the schema-throw test (`--output-schema` is added downstream of the throw, so it can't reach argv).

- **No new file in `tests/integration/runners/codex/codex-real.test.ts`.** The "shim test" originally proposed only re-asserted argv shape, which the unit tests already cover. Real-TTY foreground spawn is the manual DoD step below; there's no integration-layer behavior to exercise that the unit suite doesn't already cover.

**Definition of Done (Phase A):**

- `bun run check` green.
- `RUN_REAL_CODEX=1 bun run test:int` green for the autonomous + new interactive tests.
- Manual smoke: in a real terminal, run `examples/codex-riddle-solver/index.ts` after Phase C lands (or run a temporary one-step interactive workflow stub). Confirm: Codex TUI renders, `--full-auto` is honored (no approval prompts), TUI exits cleanly.

#### Phase B — Formatter

Files touched:

- **`src/runners/codex/format-event.ts`** (new file, ~230 lines budget)

  Section order mirrors `claude/format-event.ts`: truncation constants, public entry, `formatInfo` dispatcher, per-item-type helpers (one function per `item.type` from the start — don't write a single 70-line `formatItemCompleted` then split it), `formatTerminal`, util helpers (private to file).

  Public entry:

  ```ts
  export function toCodexTranscriptLines(event: RunnerEvent): readonly TranscriptLine[] {
    if (event.kind === 'terminal') return formatTerminal(event)
    return formatInfo(event)
  }
  ```

  `formatInfo` dispatches on `event.type`:

  | `event.type` | Handler |
  |---|---|
  | `'item.completed'` | `formatItemCompleted(event)` — dispatches to one per-type helper (`formatAgentMessage`, `formatCommandExecution`, `formatFileChange`, `formatMcpToolCall`, `formatWebSearch`, `formatReasoning`, `formatErrorItem`). |
  | `'item.started'` | `[]` — too noisy; the `item.completed` carries the same data with results. Documented choice in code comment. |
  | `'thread.started'` | `[]` — suppressed. Only consumer would be Phase 15 (resume); rendering it today produces a `· thread …` line the user can't act on. Add when Phase 15 lands. |
  | `'turn.started'` | `[]` — no useful payload. |
  | default (unknown info event) | `[{ kind: 'line', category: 'system', body: \`· ${event.type}\` }]` — mirrors Claude's line 44 fallback. Keeps "where did my event go" debugging cheap. |

  `formatItemCompleted` reads `event.payload.item.type` (string) and delegates to the per-item helper above. **Mapping table:**

  | `item.type` | TranscriptCategory | `label` | `body` (truncation) | Example output |
  |---|---|---|---|---|
  | `agent_message` | `assistant` | `assistant>` | `truncate(text, MAX_ASSISTANT_TEXT)` | `assistant> OK` |
  | `reasoning` | `thinking` | `thinking` | `''` (Codex hides reasoning text by default; we render the marker only — same shape as Claude's `thinking` block) | `thinking` |
  | `command_execution` | `tool-call` (success) / `tool-error` (non-zero exit) | `bash` | `truncate(firstLine(command), MAX_BASH_COMMAND)`; on error append `\n  exit ${exit_code}` as a second line | `bash $ /bin/zsh -lc ls` |
  | `file_change` | `tool-call` | `edit` | `(${middleEllipsis(path, MAX_FILE_PATH)})` | `edit (/.../foo.ts)` |
  | `mcp_tool_call` | `tool-call` (success) / `tool-error` (error) | `mcp:${server}:${tool}` (or just `mcp` if either is missing) | `truncate(safeJson(arguments), MAX_GENERIC_INPUT)` | `mcp:fs:read {…}` |
  | `web_search` | `tool-call` | `web` | `truncate(query, MAX_GENERIC_INPUT)` | `web "rust ratatui colors"` |
  | `error` | `tool-error` | (none) | `truncate(message, MAX_ERROR_TEXT)` | `(error) failed to run command` |
  | unknown `item.type` | `system` | (none) | `· item.${item.type}` | `· item.unknown_thing` |

  Truncation constants reused from Claude's table (importing them from a shared file is **not** in scope — copy verbatim, and at the top of the constants block include the literal comment `// PROMOTE-WHEN: a third runner needs these — extract to src/runners/_shared/format-helpers.ts at that point.` Make the deferral grep-able so the next runner author finds the trigger).

  **Schema validation policy:** unlike `claude/format-event.ts`, Codex's per-item shapes are not Zod-validated upstream (they pass through `parseCodexLine` as raw `info` events). The formatter applies `passthrough` reads via small `readString` / `readObject` / `readNumber` helpers (same shape as Claude's). This keeps the formatter forward-compatible: a Codex CLI that adds new fields to `command_execution` doesn't break us, and a missing field falls back to a default (e.g. unknown command → empty body, not a crash).

  Real-world `command_execution` shape captured during plan-phase research (`codex 0.125.0`):

  ```json
  {
    "type": "item.completed",
    "item": {
      "id": "item_0",
      "type": "command_execution",
      "command": "/bin/zsh -lc ls",
      "aggregated_output": "...",
      "exit_code": 0,
      "status": "completed"
    }
  }
  ```

  `formatTerminal` covers the two terminal events:

  | Terminal | Heading | Rows |
  |---|---|---|
  | `turn-complete` | `done` | `tokens` (in/out from `usage`), `cache` (cached_input_tokens if present), `reasoning` (reasoning_output_tokens if present), `result` (truncated `_accumulatedText`) |
  | `error` | `failed` | `message` |

  **Cross-module coupling note:** `_accumulatedText` is set by `parseEvents` on the terminal event's `data` (`codex-runner.ts:263`). The leading underscore signals the runner-internal origin. The formatter reads it via `readString(event.data, '_accumulatedText')` and falls back to omitting the `result` row when it's absent — keeps the formatter pure and unit-testable without coupling to the runner's mutation. Add a one-line comment at the read site documenting the coupling. The Phase B unit tests for `turn-complete` must construct `data: { usage: {...}, _accumulatedText: '…' }` explicitly (since they don't go through `parseEvents`).

  Sparser than Claude where data isn't there: no `cost`, no `num_turns`, no `permission_denials`, no `session_id`, no `duration` (Codex doesn't carry `duration_ms` in the envelope; the runner result carries it, but `formatTerminal` only sees the `TerminalEvent`, so we omit). **No fabricated rows.**

- **`src/runners/codex/codex-runner.ts`**
  - Replace `toTranscriptLines: () => []` with `toTranscriptLines: toCodexTranscriptLines` (import from sibling module).
  - Delete the placeholder comment at lines 283-286.

- **`src/runners/codex/index.ts`** — exports unchanged at the public barrel; `toCodexTranscriptLines` stays internal.

- **`tests/unit/runners/codex/format-event.test.ts`** (new file, ~180 lines budget; one assertion per test)
  - `describe('toCodexTranscriptLines — info dispatch')` — 3 tests: `'dispatches item.completed events to the per-item formatter'`, `'returns an empty list for suppressed event types (item.started, turn.started, thread.started)'` (parameterized), `'renders an unknown info event.type as a single system fallback line'`.
  - `describe('toCodexTranscriptLines — item.completed: agent_message')` — 1 test combining basic + truncation: `'renders agent_message as an assistant line, truncated at MAX_ASSISTANT_TEXT'`.
  - `describe('toCodexTranscriptLines — item.completed: reasoning')` — 1 test: `'renders reasoning as a thinking marker line with no body'`.
  - `describe('toCodexTranscriptLines — item.completed: command_execution')` — 2 tests: `'renders successful command_execution as a tool-call bash line with the first line of the command, truncated'`, `'renders non-zero exit command_execution as a tool-error with the exit code appended on a second line'`.
  - `describe('toCodexTranscriptLines — item.completed: file_change')` — 1 test: `'renders file_change as a tool-call edit line with a middle-ellipsised path'`.
  - `describe('toCodexTranscriptLines — item.completed: mcp_tool_call')` — 1 test parameterized over `is_error`: `'renders mcp_tool_call as tool-call on success and tool-error when is_error is true'`.
  - `describe('toCodexTranscriptLines — item.completed: web_search')` — 1 test: `'renders web_search as a tool-call web line with the query'`.
  - `describe('toCodexTranscriptLines — item.completed: error')` — 1 test: `'renders an error item as a tool-error line with the message truncated at MAX_ERROR_TEXT'`.
  - `describe('toCodexTranscriptLines — item.completed: unknown item.type')` — 1 test: `'renders an unknown item.type as a single system fallback line'`.
  - `describe('toCodexTranscriptLines — terminal events')` — 2 tests: `'renders turn-complete as a done block with tokens, cache, reasoning, and a truncated result row, omitting rows whose data is absent'`, `'renders error terminal as a failed block with one message row'`.

  Cuts vs. the original list: dropped the "missing command field → empty body", "multi-line command → first line only", agent_message basic-vs-truncation split, mcp success-vs-error split, file_change basic-vs-long-path split, and the four-way terminal split. The truncation/firstLine helpers are copied verbatim from Claude where they're already tested; redoing it through every dispatch site only inflates the count.

- **`tests/fixtures/codex/full-transcript.jsonl`** (new fixture, ~12 lines)
  - Real-shape NDJSON exercising agent_message + command_execution (success + failure) + reasoning + turn.completed. Used by integration test below to verify end-to-end runner → formatter wiring without spawning real codex.

- **`tests/integration/runners/codex/codex-mocked.test.ts`** (~30-line addition)
  - New test: `it('formats command_execution and agent_message into the expected transcript lines via runRunner', ...)`.
  - Wires `onEvent` to capture every event, then asserts that `runner.toTranscriptLines(event)` produces the expected sequence.

**Definition of Done (Phase B):**

- `bun run check` green.
- `RUN_REAL_CODEX=1 bun run test:int` green.
- Manual smoke: `bun run examples/codex-riddle-solver/index.ts` (autonomous), pipe `tee` over stdout, confirm transcript pane shows `bash` lines for command executions and `assistant>` lines for the model's responses, plus a `done` block at the end.

#### Phase C — Demo + docs sweep

Files touched:

- **`examples/codex-riddle-solver/index.ts`**
  - Step 1 (`write-riddle`) gains `mode: 'interactive'` (matching `examples/riddle-solver/index.ts`).
  - Drop the `Note on "interactive" mode:` comment block (lines 12-19).
  - Adjust prompt to match the interactive/Claude-side wording (the prompt in `riddle-solver` step 1 is already prose-y; mirror it exactly so the two demos stay diff-friendly).
  - The header comment block at the top still notes "Mirrors examples/riddle-solver but swaps Claude for Codex".

- **`examples/codex-riddle-solver/README.md`**
  - Delete the "Interactive vs non-interactive — what works with Codex" section (lines 28-37).
  - Replace with a one-paragraph note matching `examples/riddle-solver/README.md`'s tone: "Step 1 runs interactively (foreground TTY); step 2 runs autonomously."
  - Add a "Requires a TTY" line (mirroring the Claude demo) since interactive mode requires `process.stdin.isTTY === true` under the plain host.

- **`docs/getting-started.md`** — sweep for stale claims:
  - Line 235 (`agent: claude({ interactive: true })`) — unrelated, keep.
  - Lines 285, 553, 655 — about right pane / interactive vs autonomous — verify text doesn't say "Codex doesn't support interactive."
  - Line 317 (`uses primitives that only exist on codex exec (not interactive codex)`) — accurate (it's about `--output-schema`, which truly is exec-only). Keep.
  - **Line 756** (`Interactive steps are Claude-only in v1`) — **delete or revise**. Becomes: "Both Claude and Codex support interactive steps. Codex's interactive TUI is Ratatui; Claude's is Ink."
  - **Line 757** (`Structured outputs use codex exec, not codex or codex resume … there are no interactive Codex steps in v1 anyway`) — keep the first half (`--output-schema` truly exec-only), delete the second half.
  - Line 99 (`{ model, interactive, extraArgs }`) — fine; documents the API surface.

**Definition of Done (Phase C):**

- `bun run check` green.
- Manual smoke: `bun run examples/codex-riddle-solver/index.ts` shows step 1 dropping the user into the Codex TUI (with the riddle-writing prompt seeded), then exiting → step 2 autonomously reads the riddle and writes the solution.
- Optional: `bun run examples/codex-riddle-solver/index.ts --noninteractive` still works (step 1 is now interactive but we have no `ask()` step; the workflow-level interactivity flag still threads through).

## Alternative approaches considered

The brainstorm at `docs/brainstorms/2026-05-01-codex-runner-parity-brainstorm.md` evaluated three: interactive only, full parity incl. resume, and the chosen interactive + transcript rendering. The chosen approach closes the two visible gaps a workflow author actually notices today (can't `mode: 'interactive'`, can't see what Codex did) and leaves resume as a Phase 15 problem. No new alternatives surfaced during plan-phase research.

## Acceptance criteria

### Functional requirements (per phase)

**Phase A:**

- [ ] `codex({...}, deps).supports.interactive === true`.
- [ ] Interactive argv matches the documented shape: `['codex', '--full-auto', '--', '<prompt>']` by default; `--sandbox <mode>` replaces `--full-auto` for non-default sandboxes; `-m`, user `flags`, and `extraArgs` slot in after the sandbox flag and before the `--` separator.
- [ ] `await runner.buildCommand({ mode: 'interactive', schema: { jsonSchema: '...' } })` throws synchronously with a message naming `--output-schema` and "exec-only".
- [ ] Interactive `cmd.env.FORCE_COLOR === '3'`; autonomous `cmd.env.FORCE_COLOR` is undefined.
- [ ] Flag denylist applies in both modes (e.g. `flags: ['--config', 'evil.toml']` rejected with the same error in interactive as in autonomous).
- [ ] Version preflight runs once across the runner's lifetime regardless of mode (one autonomous + one interactive `buildCommand` call together produce a single `codex --version` spawn).
- [ ] Autonomous argv is byte-identical to today's output (the existing `'produces correct default argv'` test at `build-command.test.ts:44` passes unchanged).

**Phase B:**

- [ ] `toTranscriptLines(turnCompleteEvent)` returns a `block` line with heading `done` and rows matching the table above (tokens, optionally cache/reasoning/result).
- [ ] `toTranscriptLines(turnFailedEvent)` returns a `block` line with heading `failed` and one row `('message', <err>)`.
- [ ] `toTranscriptLines(itemCompletedEvent)` returns the correct `TranscriptLine[]` per the seven `item.type` mappings.
- [ ] Unknown `item.type` produces a single `system` line `· item.<type>`.
- [ ] Unknown info `event.type` produces a single `system` line `· <event.type>`.
- [ ] `item.started`, `turn.started`, `thread.started` produce `[]` (suppressed; `thread.started` revisited in Phase 15).
- [ ] Truncation limits match Claude's table for each comparable category.
- [ ] Unknown payload fields fall back gracefully (passthrough reads via typed helpers; missing field → omitted row, not a crash).

**Phase C:**

- [ ] `examples/codex-riddle-solver/index.ts` step 1 declares `mode: 'interactive'`.
- [ ] `examples/codex-riddle-solver/README.md` no longer says "Codex declares supports.interactive = false" or that interactive mode "is not supported."
- [ ] `docs/getting-started.md` line 756/757 corrected.
- [ ] Running the demo in a real terminal produces a TUI for step 1 and an autonomous transcript for step 2.

### Non-functional requirements

(Project-wide rules from CLAUDE.md — file/function size, no `any`/`!`, strict TS, single barrel — apply by default and aren't restated here.)

- [ ] No new `*Service` ports. No new edges in the dep graph; `format-event.ts` is pure (no imports outside `src/runners/types.ts`).
- [ ] Strict env policy preserved: `mergeEnv(process.env, extras, ctx.env)`. No filtering, no allowlist.
- [ ] `formatItemCompleted` is split into per-item helpers from the start (one function per `item.type`), not written as one block then refactored.

### Quality gates

- [ ] `bun run check` green at end of every phase.
- [ ] `RUN_REAL_CODEX=1 bun run test:int` green at end of every phase (until Phase 15 lands resume, this is the gating real-runner sweep).
- [ ] PR description for each phase lists tests added at each layer (unit / integration-mocked / integration-real / e2e). Missing layer must be justified.
- [ ] Manual smoke logs (a terminal-recording or a paste of the transcript) attached to the PR for Phase A and Phase C — those exercise behaviors the automated suite cannot reproduce (real TTY render).

## Test plan summary

| Layer | Phase A | Phase B | Phase C |
|---|---|---|---|
| Unit | ~7 new + 1 inverted in `build-command.test.ts` | New `format-event.test.ts` (~12 tests) | n/a (demo + docs) |
| Integration (mocked) | n/a | 1 new in `codex-mocked.test.ts` (transcript wiring) | n/a |
| Integration (real, gated) | n/a (no integration-layer behavior beyond what unit covers) | (existing tests cover) | n/a |
| Manual smoke (DoD) | 1 (real TTY render) | 1 (real autonomous transcript) | 1 (full demo) |

Layered testing follows the project rules: unit tests construct envelopes by hand; integration tests use NDJSON fixtures; real-runner tests are env-gated and auto-skip when `codex` is missing.

## User flows + edge cases (SpecFlow-style)

A workflow author's path through this feature, with edge cases pre-flagged:

1. **Author wants an interactive Codex step.** Writes `step.define('chat', { agent: codex({...}, deps), prompt: '...', mode: 'interactive' })`.
   - **Edge:** runs without a TTY (e.g., Docker container, `bun run … < /dev/null`). Plain host throws `Interactive step "chat" requires a TTY or an onInteractive handler` (existing core check at `workflow.ts:409`). No new code needed.
   - **Edge:** runs inside a non-tmux non-TTY orchestration. Same path — covered by the existing `onInteractive` agent-native hook.
   - **Edge:** runs inside `parallel()`. `InteractiveParallelError` thrown at `workflow.ts:343`. Existing behavior, unchanged.

2. **Author wants schema + interactive.** Writes `step.define('classify', { agent: codex(...), prompt: '...', returns: schema(...), mode: 'interactive' })`.
   - `buildCommand` throws synchronously with an actionable message. Workflow exits cleanly. **Tested in Phase A unit.**

3. **Author runs an autonomous Codex step.** Identical to today.
   - **New behavior:** transcript pane now shows `bash` / `edit` / `assistant>` / `thinking` / `web` / `mcp:…` lines and a final `done` / `failed` block. **Tested in Phase B integration.**

4. **Author resumes a crashed Codex run.** Phase 15. Out of scope. Today: same as current behavior — full re-execution of the failed step.

5. **Author runs a Codex step inside a tmux two-pane layout.** The right pane gets the formatted transcript (was previously dead silent for Codex). The interactive step uses `respawn-pane -k` (tmux host) — same path Claude uses; nothing Codex-specific to verify here beyond the manual smoke.

6. **Author parallels a Claude branch and a Codex branch.** Phase 9's existing cross-runner integration test still passes. Now both branches' transcripts render in their respective panes (under `--observe`) instead of only Claude's rendering.

7. **Author passes `--no-alt-screen` via `flags: ['--no-alt-screen']`.** The denylist allows it (not on the list). Codex interactive runs in inline mode — useful for terminal multiplexers that misbehave with alt-screen. Documented escape hatch.

8. **Author passes `flags: ['--ask-for-approval', 'on-request']`.** Codex interactive prompts for command approvals in the TUI. Workflow author opted in explicitly. No mode-aware default in the runner — the brainstorm's "sandbox/approval is user-defined, not mode-aware" decision.

9. **Codex CLI emits an unrecognized item.type in a future version.** Formatter falls back to `· item.<type>` line. **Tested in Phase B unit.**

10. **Codex CLI emits a malformed `command_execution` (missing `command` field).** Formatter renders `bash ` with empty body — no crash, no exception. **Tested in Phase B unit.**

## Risk analysis & mitigation

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Ratatui TUI doesn't render under inherited stdio | **Low** | High (forces PTY scope expansion) | DoD manual smoke catches this immediately. Fallback: `--no-alt-screen` documented escape hatch. PTY introduction explicitly out of scope; would re-open brainstorm. |
| Codex CLI changes `item.completed` shape between versions | Medium | Low (renders fallback line) | Passthrough Zod-style reads via `readString`/`readObject` helpers; unknown fields never crash. Version pin via `MIN_CODEX_VERSION`. |
| `--full-auto` interaction with `--ask-for-approval` user flag | Low | Low | User-supplied; the user owns the conflict. Codex CLI itself emits a clear error if the combo is invalid. |
| Existing autonomous tests break from the interactive branch | Low | Low (caught by `bun run check`) | The autonomous block stays inline and untouched; the interactive branch is added above it as an early return. Byte-equivalence is structural, not contractual. The existing `'produces correct default argv'` test at `build-command.test.ts:44` is the gate. |
| `formatItemCompleted` exceeds 60-line function budget | Low | Low | Pre-split into per-item helpers from the start (one function per `item.type`); mirrors Claude's `formatAssistantBlock`. |
| Phase B mapping table doesn't match real Codex output for one of the seven types | Low | Medium | Plan-phase research captured `command_execution` real shape from `codex 0.125.0`. Other types use Codex's documented protocol. Schemas use `passthrough`; missing fields fall back gracefully. Manual smoke catches gross mismatches. |

## Resource requirements

- 1 engineer-day for Phase A (argv split + tests).
- 1.5-2 engineer-days for Phase B (formatter + tests + fixture).
- 0.5 engineer-day for Phase C (example + docs sweep + manual smoke).

Total ~3-4 engineer-days. Each phase ships its own PR; no batching.

## Future considerations

- **Phase 15 (resume).** Once thread-id capture lands, interactive Codex steps can be `codex resume <thread_id>`-ed. The current plan deliberately drops `--ephemeral` in interactive (session persists to `~/.codex`), positioning Phase 15 as additive.
- **Shared formatter helpers.** If Aider or another runner needs the same truncation table and `readString`/`readObject` helpers, promote them out of the per-runner format-event files into `src/runners/_shared/format-helpers.ts`. Two consumers is the trigger.
- **PTY support on `ProcessService`.** If the Ratatui smoke fails (Risk row 1 fires), the path forward is a `spawnPty` method on `ProcessService` with adapter implementations for Bun (via `node-pty` behind the existing service boundary). Not in scope.

## Documentation plan

- `docs/getting-started.md` — sweep in Phase C.
- `examples/codex-riddle-solver/README.md` — rewrite in Phase C.
- `docs/plans/implementation-phases.md` — add a one-line entry for this plan under the "Reframe" section or the upcoming-Phase area, marked ◐ in progress until all three sub-phases land.
- `docs/solutions/` — if the Ratatui smoke surfaces a learning (e.g. "Codex needs `--no-alt-screen` under tmux"), document it. Otherwise no new solution doc needed.

## References & research

### Internal references

- Brainstorm: [`docs/brainstorms/2026-05-01-codex-runner-parity-brainstorm.md`](../brainstorms/2026-05-01-codex-runner-parity-brainstorm.md)
- Codex runner today: `src/runners/codex/codex-runner.ts:201` (capability), `:286` (formatter placeholder)
- Claude runner reference: `src/runners/claude/claude-runner.ts:161-195` (argv split pattern), `src/runners/claude/format-event.ts` (formatter pattern)
- Executor (runner-agnostic): `src/runners/execute.ts:118` (runInteractive), `src/core/workflow.ts:334` (runInteractiveStep)
- Process service: `src/services/process/bun-process-service.ts:56` (spawnForeground inherits stdio)
- Existing tests: `tests/unit/runners/codex/{build-command,parse-events}.test.ts`, `tests/integration/runners/codex/codex-{mocked,real}.test.ts`, `tests/fixtures/codex/{simple-success,with-output-schema,turn-failed}.jsonl`
- Negative test to invert: `tests/unit/runners/codex/build-command.test.ts:32`
- Demo to update: `examples/codex-riddle-solver/{index.ts,README.md}`
- Stale claims to revise: `docs/getting-started.md` lines 756-757
- Related learnings: [`docs/solutions/interactive-mode-colors.md`](../solutions/interactive-mode-colors.md) (FORCE_COLOR rationale, inherit-stdio behavior), [`docs/solutions/autonomous-transcript-rendering.md`](../solutions/autonomous-transcript-rendering.md) (why runner-owned formatting matters; the bug the placeholder reproduces for Codex today)
- Related plans: [`docs/plans/2026-04-12-feat-phase-9-codex-runner-plan.md`](2026-04-12-feat-phase-9-codex-runner-plan.md) (original CodexRunner phase), [`docs/plans/2026-04-27-feat-env-passthrough-plan.md`](2026-04-27-feat-env-passthrough-plan.md) (env policy contract)

### External references

- Codex CLI help (`codex 0.125.0`, captured 2026-05-01): top-level `codex --help`, `codex exec --help`. Audit logged in the "Resolved open questions" section above.
- Ratatui (Codex's TUI library): https://docs.rs/ratatui/ — color detection via `crossterm`, which uses TTY isatty check + COLORTERM/TERM. Confirms `FORCE_COLOR=3` is a no-op for Codex (harmless).
- Codex thread-event protocol (`item.completed` types): documented in the Codex repo; the seven types `agent_message`, `reasoning`, `command_execution`, `file_change`, `mcp_tool_call`, `web_search`, `error` are stable as of CLI 0.118+.
