---
date: 2026-05-01
topic: codex-runner-parity
---

# Codex Runner Parity with Claude Runner

## What We're Building

Bring `CodexRunner` up to feature parity with `ClaudeRunner` along two axes:

1. **Interactive step mode** — let workflow steps declare `mode: 'interactive'` against a `codex(...)` agent. Today this throws `RunnerCapabilityError` because `supports.interactive: false` is hardcoded (`src/runners/codex/codex-runner.ts:201`). The Codex CLI itself supports interactive use (`codex [PROMPT]` opens the TUI by default; `codex exec` is the non-interactive variant), so this is purely an adapter gap.

2. **Transcript rendering** — replace the Phase A placeholder `toTranscriptLines: () => []` (`codex-runner.ts:286`) with a real formatter that covers all seven `item.completed` Codex event types, on par with `toClaudeTranscriptLines`. Today autonomous Codex steps are silent in the transcript pane even though the underlying NDJSON stream is rich.

Out of scope: resume / `codex resume <thread_id>` (slated for Phase 15), Claude-side gaps (autonomous-argv `--` separator, version preflight), and any Codex-specific features beyond what brings it level with Claude.

## Why This Approach

Three approaches were considered:

- **Interactive only** — fastest unlock, but autonomous Codex steps would stay silent in the transcript pane indefinitely, which contradicts "similar to current state of claude code."
- **Full parity incl. resume** — matches everything but pulls Phase 15 forward; resume touches state model and `codex resume` ergonomics, which is a separate, larger conversation.
- **Interactive + transcript rendering** ← chosen. Closes the two visible gaps a workflow author actually notices today (can't `mode: 'interactive'`, can't see what Codex did). Resume stays a Phase 15 problem.

## Key Decisions

- **`supports.interactive` flips to `true`** once the interactive argv path lands; the executor's `runInteractiveStep` (`src/core/workflow.ts:334`) and `runInteractive` (`src/runners/execute.ts:118`) are runner-agnostic, so no core changes needed.
- **Argv dispatch on `ctx.mode`** mirrors ClaudeRunner's pattern — split into `buildInteractiveArgv` / `buildAutonomousArgv` in `codex-runner.ts`. Interactive uses `codex [flags] -- <prompt>` (no `exec` subcommand); autonomous keeps the existing `codex exec --json …` shape. The interactive form **mirrors autonomous flag-for-flag minus `exec` / `--json` / `--ephemeral` / `--output-schema`**: `--skip-git-repo-check`, `-m <model>`, `--full-auto` / `--sandbox <mode>`, and any user-supplied `flags`/`extraArgs` carry over. Final shape pending the plan-phase `codex --help` audit (see Open Questions).
- **Schema + interactive eagerly throws.** If `ctx.schema` is set and `ctx.mode === 'interactive'`, `buildCommand` throws a clear capability error instead of silently dropping `--output-schema`. Schema-shaped output has no meaning in TUI mode, and a silent drop hides a misconfig the workflow author wants to know about.
- **Env extras** — interactive mode adds `{ FORCE_COLOR: '3' }` via `mergeEnv(process.env, extras, ctx.env)`, mirroring Claude. Note: Codex's TUI is Ratatui (Rust), not Ink/chalk, so this may be ineffective; verifying that interactive Codex renders correctly under inherited (non-PTY) stdio is an explicit Open Question. Autonomous stays `{}`.
- **Formatter covers all seven `item.completed` types**: `agent_message`, `reasoning`, `command_execution`, `file_change`, `mcp_tool_call`, `web_search`, `error`. Map onto existing `TranscriptCategory` values (`assistant`, `thinking`, `tool-call`/`tool-result`/`tool-error`, `system`). The `item.completed.error` variant is the formatter's concern; top-level `{type:'error'}` events are already mapped to a terminal `RunnerEvent` by `parseTerminalEvent` (`codex-runner.ts:82-85`) and need no formatter changes.
- **Terminal events render as Claude-style blocks.** `turn.completed` → `block` heading `done` with rows for `tokens` (in/out from `usage`), `duration` (from runner result, since Codex doesn't carry `duration_ms` in the envelope), and a short result preview from the accumulated `agent_message`. `turn.failed` → `block` heading `failed` with a `message` row, mirroring `formatTerminal` in `format-event.ts:160`. Sparser than Claude where the data simply isn't there (no `cost`, no `num_turns`, no `permission_denials`); no fabricated rows.
- **Unknown info-event fallback: `· <type>` line.** Mirrors Claude's `format-event.ts:44` behavior: any info event that isn't one of the seven `item.completed` types emits a single `system`-category line `· <event.type>` (e.g. `· turn.started`, `· item.started`). Nothing silently disappears; debugging "where did my event go" stays cheap.
- **Test parity matches Claude's pattern**: unit (argv shapes for both modes, formatter per event type, schema+interactive throws, fallback `· <type>` line), integration mocked + real for both modes, plus an interactive integration test gated behind `RUN_REAL_CODEX=1`. The existing negative test that asserts "interactive throws" — wherever it lives — gets removed/inverted as part of the test sweep.
- **Demo + docs update is broader than one bullet.** `examples/codex-riddle-solver/index.ts` step 1 (`write-riddle`) switches to `mode: 'interactive'`. The `Note on "interactive" mode:` comment block (`index.ts:14-19`) gets deleted. The README's whole "Interactive vs non-interactive — what works with Codex" section + table (`README.md:28-37`) gets rewritten to match Claude's demo. A docs sweep checks `docs/getting-started.md` and other docs for stale "Codex doesn't support interactive" claims.
- **Prompt seeding: auto-submit (Claude parity).** Interactive argv passes the prompt as a positional arg so Codex starts immediately, mirroring `claude ... -- <prompt>`. Lowest friction for scripted workflows.
- **`--ephemeral` dropped in interactive mode.** Autonomous keeps `--ephemeral`; interactive omits it so session history persists to `~/.codex` and the user can `codex resume` it manually outside orch. This also positions Phase 15 well (resume becomes additive, not a refactor).
- **Sandbox/approval is user-defined, not mode-aware.** `CodexOptions.sandbox` and `flags` apply identically in both modes — no implicit "interactive defaults to ask-for-approval" branching in the runner. Workflow authors flip `sandbox: 'workspace-write'` or pass `--ask-for-approval` via `flags` themselves. Keeps the option surface flat and behavior predictable. Whether each value of `--sandbox` actually applies to the interactive subcommand is part of the plan-phase flag audit.
- **Thread-id capture deferred** — explicitly NOT introduced in this round. The Phase 9 brainstorm flagged it as Phase 15 prep; we keep that boundary clean.

## Resolved Questions

- **Prompt auto-submission** → Auto-submit via positional arg, Claude parity.
- **`--ephemeral` in interactive** → Drop it; persist to `~/.codex`.
- **Formatter detail (item.completed)** → Match Claude's depth across all seven event types.
- **Formatter detail (terminal events)** → `turn.completed` / `turn.failed` render as Claude-style `done` / `failed` blocks; sparser rows where Codex doesn't carry the data, no fabrication.
- **Formatter detail (unknown info events)** → Mirror Claude's `· <type>` fallback line; nothing disappears silently.
- **Schema + interactive** → `buildCommand` throws eagerly; no silent drop.
- **Approval/sandbox default in interactive** → User-defined via existing `CodexOptions.sandbox` / `flags`; no mode-aware branching.
- **Top-level `error` events** → No formatter work needed; the parser already routes them to a terminal `RunnerEvent`.

## Open Questions

- **Codex interactive flag matrix** — `codex --help` audit in plan-phase pins down which of `--skip-git-repo-check`, `-m`, `--full-auto`, `--sandbox`, `--ask-for-approval` actually apply to the interactive subcommand vs `codex exec`. Affects the exact carry-over list in `buildInteractiveArgv`.
- **TTY/color compatibility under inherited stdio** — Codex's Ratatui TUI may not render correctly under `BunProcessService.spawnForeground`'s inherited (non-PTY) stdio, and `FORCE_COLOR=3` may have no effect (Ratatui doesn't honor it the way chalk does). Plan-phase needs to (a) verify on real `codex` that the TUI renders under current `spawnForeground`, and (b) if it doesn't, decide whether to introduce a PTY spawn path on `ProcessService`. The latter would be a meaningful scope expansion that could re-open this brainstorm.

## Next Steps

→ `/workflows:plan` for implementation details (argv shape audit incl. flag matrix, TTY/Ratatui spike, formatter mapping table for all 7 `item.completed` + 2 terminal + fallback, test plan, demo + docs sweep).
