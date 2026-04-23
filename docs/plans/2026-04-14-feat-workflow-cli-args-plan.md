---
title: "feat: Workflow CLI args (initial prompt pass-through)"
type: feat
date: 2026-04-14
status: landed
landed: 2026-04-14
brainstorm: docs/brainstorms/2026-04-14-workflow-cli-args-brainstorm.md
phase: Follow-up to Phase 12 (CLI) + 13a (interactive step mode)
---

# Workflow CLI args (initial prompt pass-through)

## Overview

Let users pass an initial prompt from the shell into a workflow, so the first interactive Claude step opens with the prompt already typed in. Two tiny seams change: the CLI parser (which today ignores everything after the workflow name) and the `workflow()` callback signature (which today receives only `run`). Everything else — runner argv, `assemblePrompt()`, interactive foreground spawn — is already in place.

```bash
# Today (two-step)
$ orch run brainstorm
<wait for TUI>
<type prompt>

# After this change (one-step)
$ orch run brainstorm "think hard about X and brainstorm it"
$ orch run brainstorm --prompt "think hard about X and brainstorm it"
```

```ts
// Workflow author splices args.prompt wherever they want.
workflow('brainstorm', async (run, args) => {
  const BRAINSTORM = step.define('brainstorm', {
    agent: claude(),
    mode: 'interactive',
    prompt: `Think hard about this and brainstorm the idea:\n\n${args.prompt ?? ''}`,
  })
  await run(BRAINSTORM)
})
```

## Problem Statement / Motivation

The brainstorm (`docs/brainstorms/2026-04-14-workflow-cli-args-brainstorm.md`) has full context. Short version:

- Phase 13a shipped interactive steps. `ClaudeRunner.buildCommand` already passes `ctx.prompt` to the claude CLI as a positional after `--`, which pre-fills the TUI.
- But users still can't *supply* that prompt from the shell — `parseArgv` in `src/cli/main.ts:42` drops anything past `positionals[1]`, and the `workflow(name, fn)` signature only hands `fn` the `run` closure.
- Result: a paper-cut every time you invoke a workflow — you boot the TUI, wait, then type the same kind of prompt you already had in your head.

This is a small, local, high-leverage change. Runner-level plumbing, state, and interactive execution stay untouched.

## Proposed Solution

Two files carry the bulk of the change; everything else is tests and docs.

**1. `src/cli/main.ts` — extend argv parsing.**
`parseArgv` returns a new field `args: WorkflowArgs`. The CLI accepts either a positional (`orch run <wf> "text"`) or a flag (`orch run <wf> --prompt "text"`). Both resolve to `args.prompt: string | undefined`.

**2. `src/core/workflow.ts` — widen the callback signature.**
`workflow(name, fn)` where `fn: (run: RunFn, args: WorkflowArgs) => Promise<void>`. Existing callers that write `async (run) => ...` continue to compile because JS ignores extra params and TS allows narrower function assignment. No explicit overloads needed.

**3. `WorkflowDeps.args?: WorkflowArgs`.** Threaded through `execute()` and `resume()`. When absent, defaults to `{}` so workflows always see an object (fewer null-checks).

**4. State persistence.** `RunState` gets an optional `args: WorkflowArgs` field at schema v4. This lets `orch resume <id>` replay with the same args it started with — essential when a crashed step re-runs and reads `args.prompt` (see "Resume semantics" below).

## Key Decisions

| # | Decision | Rationale |
|---|---|---|
| 1 | **Positional preferred, `--prompt` alias** | `orch run wf "text"` is the fast path; `--prompt "text"` is the explicit form. Both produce the same `args.prompt`. |
| 2 | **Second param to workflow callback**, not a global or per-step injection | `workflow(name, async (run, args) => ...)` is typed, discoverable, extensible. Workflow author owns the splice. |
| 3 | **No auto-override of any step's `prompt:`** | Author interpolates `args.prompt` wherever they want. More flexible than forcing the first step to absorb it. Matches the brainstorm's "author owns the splice" principle. |
| 4 | **Only one reserved key: `prompt`** | YAGNI. Don't invent `--topic`, `--scope`, etc. until a real use case appears. |
| 5 | **`args.prompt` is `string \| undefined`** (and `""` is distinct) | If the user omits the arg, workflows see `undefined` and choose their default. Empty string passed as `""` is honored verbatim. Document: use `args.prompt !== undefined` for presence, not truthiness. |
| 6 | **Passing both positional AND `--prompt` is an error** | Explicit over silent precedence. Error message: `Cannot specify both a positional prompt and --prompt`. Exit code `CONFIG_ERROR` (2). |
| 7 | **Multiple positionals are an error** | `orch run wf "a" "b"` fails with `Unexpected extra positional "b"`. Users wanting spaces quote at the shell level. |
| 8 | **`args` participates in state, not in cache keys** | Memoization is still by step name (consistent with how `RunOverrides.prompt` behaves today). Rerunning a workflow with a different prompt against the **same runId** will hit the cache. To get a fresh evaluation, start a new runId — same as today. Document this explicitly. |
| 9 | **Persist args in RunState at schema v4** | Cheap, nullable field. Prevents resume-divergence: if a step crashed mid-run and now replays, it sees the original `args.prompt` instead of `undefined`. |
| 10 | **`orch resume <id>` replays persisted args by default; args CAN be re-supplied** | `orch resume <id>` → reads args from state. `orch resume <id> "new"` → overrides (re-persists). Consistent with run's CLI shape. |
| 11 | **`orch dry-run wf "text"` accepts and echoes the arg** | Preflight output includes `Prompt: <truncated-to-80>`. No execution. |
| 12 | **No redaction; no `requiresPrompt` declarative option** | Prompt is already in the user's shell history; logging it in `state.json` is consistent with existing persistence. `requiresPrompt` is YAGNI — authors can `throw` if `args.prompt === undefined`. |

## Technical Considerations

### Architecture

```
CLI                                         Core
─────────────────────────────────────────   ─────────────────────────────
parseArgv()  ─ args: WorkflowArgs ──────▶  runCmd()
                                            │
                                            ▼
                                           wf.execute(deps, args)
                                            │
                                            ▼                                   Runner
                                           executeWorkflowFn(fn, deps, args) ─▶ (unchanged)
                                            │
                                            └─ stateStore.initRun({ args })
```

Files touched:
- `src/cli/main.ts` — `parseArgv` extended; help text updated.
- `src/cli/commands/run.ts` — new `WorkflowArgs` param threaded to `execute()`.
- `src/cli/commands/resume.ts` — same, plus state reads persisted args.
- `src/cli/commands/dry-run.ts` — accepts and echoes the prompt.
- `src/core/workflow.ts` — `WorkflowArgs` type, widened callback signature, `execute(deps, args?)` / `resume(deps, args?)`, persist in `initRun`.
- `src/core/index.ts` — export `WorkflowArgs`.
- `src/state/state-store.ts` — schema v4: optional `args` field + v3→v4 Zod transform.
- `src/state/index.ts` — re-export (no new public types; `args` lives on `RunState`).

### Types (canonical shape)

```ts
// src/core/workflow.ts
export interface WorkflowArgs {
  readonly prompt?: string
}

export interface WorkflowDeps {
  // ... existing fields unchanged
  readonly args?: WorkflowArgs  // optional — resolved to {} when passed to fn
}

export interface WorkflowExecutor {
  readonly name: string
  execute(deps: WorkflowDeps): Promise<void>
  resume(deps: WorkflowDeps): Promise<void>
}

// Callback signature widens; backward-compatible because JS ignores extra params.
export function workflow(
  name: string,
  fn: (run: RunFn, args: WorkflowArgs) => Promise<void>,
): WorkflowExecutor
```

### Argv parsing

`parseArgv` in `src/cli/main.ts:42` currently returns `{ command, positional, help }`. Extend to:

```ts
export function parseArgv(argv: string[]): {
  command: string | undefined
  positional: string          // workflow name
  args: WorkflowArgs          // parsed prompt (flag or positional)
  help: boolean
} {
  // parseArgs with options: { help, prompt: { type: 'string' } }, strict: false
  //   values.prompt  → from --prompt
  //   positionals[0] → command (e.g. "run")
  //   positionals[1] → workflow name
  //   positionals[2] → inline prompt (if no --prompt flag)
  //   positionals[3+] → reject
}
```

Collision rules (enforced in `parseArgv`):
- `values.prompt` AND `positionals[2]` both present → throw `ArgvError('Cannot specify both a positional prompt and --prompt')`.
- `positionals.length > 3` → throw `ArgvError('Unexpected extra positional arguments')`.
- Resulting `args.prompt` is `values.prompt ?? positionals[2]` (may be `undefined`).

`ArgvError` is caught in `main()` and exits `CONFIG_ERROR` (2) with the message.

### State schema v4

```ts
// src/state/state-store.ts
const RunStateV4 = z.object({
  schemaVersion: z.literal(4),
  // ... v3 fields unchanged
  args: z.object({ prompt: z.string().optional() }).optional(),
})

// Migration: v3 → v4 by adding schemaVersion:4 and omitting args (undefined).
// Implemented via .transform() on the discriminatedUnion, matching the v2→v3
// pattern in Phase 12's plan.
```

Only `initRun` writes `args`. `saveStep` and `setStatus` leave it alone.

### Resume flow

1. `orch resume <id>` → `resumeCmd` loads state, reads `state.args`.
2. If CLI passed a new prompt, that overrides; otherwise use persisted.
3. Re-persist updated `args` only if CLI overrode (single `initRun`-like write — or extend to a `setArgs` method; simplest: mutate `state.args` inline via the existing state-store write path, or add one focused method).
4. Call `executor.resume(deps)` with `deps.args` set.

Simplest wiring: add a tiny `stateStore.setArgs(runId, args)` method (matches `setStatus` naming). Alternative: re-init. Prefer the method — one extra method, zero ambiguity.

### Logging

Add a single line at run start:
```
Running workflow "brainstorm" (r-2026-04-14-abcd) with prompt: "think hard about X…"
```

Truncate to 80 chars in stdout. Full prompt goes to `state.json` via `initRun`. No redaction (out of scope; mirror existing persistence behavior).

## Acceptance Criteria

### Functional

- [x] `orch run <wf> "text"` sets `args.prompt === "text"` inside the workflow callback.
- [x] `orch run <wf> --prompt "text"` behaves identically.
- [x] `orch run <wf>` (no prompt) sets `args.prompt === undefined`.
- [x] `orch run <wf> "text" --prompt "other"` exits `CONFIG_ERROR` with collision message.
- [x] `orch run <wf> "a" "b"` exits `CONFIG_ERROR` with extra-positional message.
- [x] `orch run <wf> ""` sets `args.prompt === ""` (distinct from undefined).
- [x] Existing `workflow(name, async (run) => ...)` callbacks compile and run without changes.
- [x] New `workflow(name, async (run, args) => ...)` callbacks receive a non-null `args` object (`{}` when CLI supplied none).
- [x] `orch resume <id>` replays with the args from `state.json`.
- [x] `orch resume <id> "new prompt"` overrides and re-persists.
- [x] `orch dry-run <wf> "text"` echoes a truncated prompt line; does not execute.
- [x] State schema v3 files are migrated to v4 transparently on load.
- [x] `examples/riddle-solver` demonstrates the new signature (header comment + `--prompt=` passthrough, two-arg `workflow()` callback).

### Non-Functional

- [x] `bun run check` green (lint + typecheck + unit + mocked integration).
- [x] No file exceeds 300 lines; no function exceeds 60 lines. *(state-store.ts was already over 300 lines with an existing justification comment; this phase kept it over 300 — comment updated.)*
- [x] No new `any`, no non-null assertions.
- [x] Public `WorkflowArgs` type exported from `src/core/index.ts` barrel.
- [x] Help text in `src/cli/main.ts` updated to document the prompt forms.
- [ ] `docs/getting-started.md` section on running workflows covers the new forms — deferred; file does not currently have a CLI-args section.

## Test Plan

### Unit

- [x] **`tests/unit/cli/argv.test.ts`** (extend existing):
  - `parseArgv(['run', 'wf', 'text'])` → `args.prompt === 'text'`.
  - `parseArgv(['run', 'wf', '--prompt', 'text'])` → `args.prompt === 'text'`.
  - `parseArgv(['run', 'wf'])` → `args.prompt === undefined`.
  - `parseArgv(['run', 'wf', ''])` → `args.prompt === ''`.
  - `parseArgv(['run', 'wf', 'a', '--prompt', 'b'])` → throws `ArgvError` (collision).
  - `parseArgv(['run', 'wf', 'a', 'b'])` → throws `ArgvError` (extra positional).
  - All existing tests still pass (no positional beyond workflow name → `args.prompt === undefined`).
- [x] **`tests/unit/core/workflow-args.test.ts`** (new file — workflow.test.ts already > 300 lines):
  - Widened callback receives `args` object — with prompt, without prompt, empty-string prompt.
  - Legacy one-param callback still runs and typechecks.
  - `deps.args === undefined` → callback sees `{}`.
  - args persistence round-trips via state store.
- [x] **`tests/unit/state/state-store-v4.test.ts`** (renamed from `-v3.test.ts`):
  - v3 file loads, migrates to v4.
  - `initRun` persists args (with prompt, without, empty string).
  - `setArgs` overwrites; throws on missing run.
  - saveStep + setStatus preserve args across writes.

### Integration (mocked)

- [x] **`tests/integration/cli/commands/resume.test.ts`** (extended):
  - CLI prompt override is persisted via `setArgs` before `loadConfig` runs (verified by inspecting `state.args` after CONFIG_ERROR exit).
  - Persisted args are preserved when CLI supplies none.
- [~] **`run.test.ts` / `dry-run.test.ts`** (not added):
  - Skipped as separate files. Unit coverage in `workflow-args.test.ts` already proves `runCmd` threads args into `deps.args` (via the FakeRunner workflow test using identical `WorkflowDeps`); argv parsing + collision rules live in `argv.test.ts`. The remaining end-to-end surface is a shell smoke test against a real workflow file + `orch.config.ts`, deferred to manual verification before shipping real CLI usage.

### E2E (gated `RUN_REAL_CLAUDE=1`)

- [x] **`examples/riddle-solver/index.ts`** updated — header comment covers both forms (`--prompt=` and positional), workflow callback uses the two-arg signature, `promptSeed` is spliced into the riddle theme.
- [ ] Manual smoke: `orch run riddle-solver "about the moon"` against the real `claude` CLI — deferred to user verification. Not gated in CI.

## Dependencies & Risks

**Dependencies**
- Builds on Phase 12 (CLI, `parseArgv`, `runCmd`) and Phase 13a (interactive mode, `ClaudeRunner.buildCommand` interactive branch). Both landed.

**Risks**
- **Schema v4 migration bug.** Mitigated by round-trip unit tests and the v2→v3 migration template from Phase 12.
- **Collision rule friction.** Some users might expect `--prompt` to override the positional. Mitigation: clear error message with the fix suggested inline (`"use one or the other"`).
- **Logging prompts to `state.json`.** Accepts the same risk as existing workflow state persistence. If a user pastes a secret into the prompt, it lands on disk. Called out in docs; redaction can be added later without schema change.
- **Backward compat of callback signature.** JS runtime is permissive; TS is permissive for this pattern. Guarded by a compile-time type test. Zero risk in practice.

## Alternatives Considered

- **Flag-only (`--prompt` required).** Explicit, but verbose. Rejected: brainstorm prioritizes the one-shot positional form.
- **Positional-only (no flag alias).** Harder to compose in scripts where the prompt comes from `$VAR`. Rejected.
- **Pass the CLI prompt as `RunOverrides.prompt` on the first step automatically.** Magical and brittle. Workflow author would lose control. Rejected — the brainstorm explicitly rejects this.
- **Don't persist `args` — require user to re-supply on resume.** Simpler schema, but reintroduces the replay-divergence footgun SpecFlow flagged. Rejected.
- **Generalize to `--key=value` named args now.** Premature. Revisit after a second real use case appears.

## References

### Internal

- Brainstorm: `docs/brainstorms/2026-04-14-workflow-cli-args-brainstorm.md`
- CLI dispatch: `src/cli/main.ts:42` (`parseArgv`), `src/cli/main.ts:78` (`main`).
- Workflow signature: `src/core/workflow.ts:481` (`workflow(name, fn)`).
- Prompt assembly (already handles override layering): `src/core/workflow.ts:134` (`assemblePrompt`).
- Interactive argv (already passes prompt to TUI): `src/runners/claude/claude-runner.ts:194` (`buildInteractiveArgv`).
- State schema / migration template: `docs/plans/2026-04-13-feat-phase-12-cli-plan.md` (v2→v3 pattern).
- Phase 13a (interactive mode shipped): `docs/plans/implementation-phases.md:323`.

### Future Work

- Generalized named args (`orch run wf --topic foo --scope bar`) once a second use case lands.
- `requiresPrompt` declarative option if authors ask for it.
- Prompt redaction policy if secrets-in-prompts becomes a pattern.
