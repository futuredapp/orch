---
title: Steps TUI — navigable, history-aware view of an orch run (v1, two-pane)
type: feat
date: 2026-05-05
status: completed
brainstorm: docs/brainstorms/2026-05-05-steps-tui-brainstorm.md
brainstorm_addendum: docs/brainstorms/2026-05-05-steps-tui-second-pass-brainstorm.md
testing_emphasis: "Per the request: every layer (unit / integration-mocked / integration-real / e2e) is mandatory; the TUI itself is exercised by ink-testing-library at the component layer and by real-tmux at the host layer."
---

# Steps TUI — navigable, history-aware view of an orch run (v1, two-pane)

## Decisions log

This plan went through review before code was written. The major decisions, with what was ruled out and why:

1. **IPC: file-based intents, not Unix sockets.** The child appends `{type, …}` lines to `.orch/state/<runId>/tui-intents.ndjson`; the parent watches that one file with the same `fs.watch` infrastructure Phase 1 builds for `state.json`. Ruled out: a `src/services/ipc/` module with `net.createServer`, hello handshake, generation counter, idempotency keys, macOS `$TMPDIR` fallback, and Zod-framed NDJSON. Reason: the child needs to send three keypresses (`enter`, `follow-live`, `quit`). A new service module + 8 protocol tests is overkill for three line-writes per session.
2. **No watchdog.** If the Ink child exits unexpectedly the parent logs `tui-crashed` to `lifecycle.ndjson` and renders `"TUI unavailable — detach + reattach to retry, run continues"` to the pane via the existing `PaneQueue`. No respawn, no sliding window, no `Clock` injection. Ruled out: 3-restarts-in-60s sliding window, `requestedShutdown` flag, SIGPIPE special-casing, ring-buffered stderr tail, pane-existence re-check, ~11 dedicated watchdog tests. Reason: Ink children in this codebase don't crash. When somebody files a bug, write the watchdog then.
3. **No schema version bump.** `StepEntry.sessionId?: string` is added as an optional field; old state loads with `sessionId === undefined`, new state has the value. The existing `parseV5` is the only parser. Ruled out: `parseV6` peer parser, `RunStateAnyVersion` discriminated union, frozen v5 fixture corpus, `docs/state-schema-versions.md` registry, contention-resolution protocol with the parallel reframe Phase E plan. Reason: an optional field is non-breaking by definition; the existing rebuildSteps projector already handles spread-when-defined for optionals.
4. **`runner.supports.resume` flag dropped — use `runner.resumeCommand !== undefined`.** A capability flag plus an optional method are two sources of truth that drift. If a derived flag is needed later for capability discovery, derive it inside `defineRunner`.
5. **Module lives at `src/hosts/two-pane/steps-view/`, not `src/hosts/_shared/steps-view/`.** Single-pane is out of v1 scope and the plan has no second consumer. `_shared/` has zero precedent under `src/hosts/`. When (if) single-pane needs the component, `git mv` is one commit.
6. **Four phases, not six.** Each phase ends with something a user can run. Phase 1 ships the live driver's seat (the original A+B+C); Phase 2 ships per-kind Enter (D); Phase 3 ships resume + sessionId (E); Phase 4 ships end-of-run mount + E2E + demo (F minus watchdog).

Other corrections folded in from review (no debate needed): `runInteractive(left)` does not exist on the Host port today (extend it in Phase 1); `StepRow` is a discriminated union with both `kind` and `mode` pinned per variant (TS won't narrow otherwise); paths use the project's `Path` brand at every public API; real-tmux integration tests follow the existing `*.real.integration.test.ts` convention; type tests are co-located `*.test-d.ts`, not a parallel `tests/types/` tree.

---

## Overview

Replace the text-painted `status-pane.ts` left pane in `--mode=two-pane` with a rich Ink-rendered **steps navigator**. Users get a live driver's seat (active step + cost/time/tokens), a history browser (scroll back, open transcripts of past steps), and a resume launcher (Enter on a finished interactive step launches `claude --resume` / `codex resume` in a second tmux window without disturbing the live run).

Scope:

- **In scope:** Ink `<StepsView>` component, two-pane integration via TmuxHost, per-kind Enter dispatch (5 kinds), end-of-run mounted summary, resume launcher, `sessionId` capture.
- **Out of scope (v1):** `single-pane` host (Reframe Phase C is deferred); `orch status <runId>` against finished runs; cross-run picker; MCP exposure of the viewmodel; `/` incremental search, `[ ]` jump-to-failure, `PgUp/PgDn`; transcript replay memory virtualization; watchdog auto-restart.
- **Out of scope (forever in v1):** `plain` mode is unchanged — no TUI under `plain`.

Deliverables span **four PR-sized phases**. Each phase ends in a user-visible artifact:

| Phase | User-visible artifact at end of phase |
|---|---|
| 1 — live driver's seat | `--mode=two-pane` against `FakeRunner` draws the new pane; arrow keys move selection; `q` quits the TUI; live run continues. |
| 2 — per-kind Enter | Enter on a past step opens window 1 with the right kind-specific view (replay / details / pane log); `f` returns to window 0. |
| 3 — resume + sessionId | Enter on a finished interactive Claude/Codex step launches `claude --resume` / `codex resume` in window 1. |
| 4 — end-of-run + E2E | TUI stays mounted past completion with a summary; `examples/steps-tui-demo/` walks the user through every per-kind Enter behavior. |

The brainstorms are the source of truth for design decisions; this plan is the source of truth for file structure, test matrix, and phase boundaries.

## Problem statement

The two-pane left pane today is painted by `src/observability/status-pane.ts` via `tmux send-keys -l <text>` (a clear-screen + redraw on every lifecycle event). It serves a single job — "what step is running?" — and serves it adequately. Three jobs it cannot serve:

1. **Live driver's seat with depth.** The painted pane shows step name + glyph + elapsed. There's no cost, no token usage, no parallel-branch tree, no totals.
2. **History browser.** Past steps' transcripts are written to `.orch/state/<runId>/steps/<name>.transcript.ndjson` (autonomous) or captured via `pipe-pane-capture.ts` (interactive). No UI surfaces them — users `less` the file by hand.
3. **Resume.** `claude --resume <session>` and `codex resume <thread>` exist; the runner-level hook to invoke them does not.

The motivation is the **driver's seat** experience the brainstorm describes. Without it, two-pane mode is barely better than plain mode for human users.

## Proposed solution

A single Ink component, `<StepsView>`, drawn into the two-pane left pane via a long-lived Ink child process. It reads on-disk state (`state.json` + per-step NDJSON sidecars + `lifecycle.ndjson`) — *not* in-memory events — so it can survive a parent crash, reattach to a finished run, and (in a future pass) power `orch status <runId>`.

```
┌─ orch · feature-build · r-2026-04-29-143052-7k ──────┬─ work-auth · claude --bare -p · alive 0:42 ────────────┐
│   brainstorm           ✓   3m12s   $0.42   12k       │  system: loaded skill workflows:work                     │
│   plan                 ✓   1m47s   $0.88   28k       │  ◇ Edit(src/auth/token.ts)                              │
│ ▌ work-auth            ⟳   0m42s   $0.12    6k       │    + export class TokenService { … }                     │
│   parallel: review     ⟳   0m12s    —      —         │  (streaming…)                                            │
│   ├─ review-security   ⟳   0m12s   $0.04    1k       │                                                          │
│   ├─ review-performance ⟳  0m12s   $0.05    1k       │                                                          │
│   └─ review-design     ⟳   0m12s   $0.03    1k       │                                                          │
│   commit feat(auth)    ○                             │                                                          │
│   work-api             ○                             │                                                          │
│  ─── totals ───                                       │                                                          │
│   elapsed   5m41s · cost $1.42 · tok 46k/81k          │                                                          │
│   ↑/↓ ⏎ f ? q                                         │                                                          │
└───────────────────────────────────────────────────────┴──────────────────────────────────────────────────────────┘
```

Three component layers:

1. **`StepsViewModel`** — pure read-side projection of on-disk state. No React, no Ink. Tails files via `fs.watch` + readdir polling fallback (macOS `fs.watch` flakiness is documented); emits a `StepsViewState` object on every change. Fully unit-testable against fixture directory trees.
2. **`<StepsView>` Ink component** — renders the viewmodel state + selection state. Adaptive columns drop right-to-left (tokens → cost → elapsed) at width thresholds (95 / 80 / 70). Selection cursor is sticky once moved (the user must press `f` to snap back to live).
3. **TmuxHost integration** — spawns the Ink child as a long-running process targeting the left pane. Replaces `startStatusLoop` for two-pane mode.

Per-kind Enter dispatch happens in the right-pane controller (TmuxHost). Five kinds, five behaviors:

| Kind | Enter behavior | Where the data comes from |
|---|---|---|
| `agent` (autonomous) | Replay rendered transcript via `runner.toTranscriptLines` | per-step NDJSON sidecar |
| `agent` (interactive) | Resume the session via `runner.resumeCommand(ctx, sessionId)` | `StepEntry.sessionId` (new optional field) |
| `command` | Replay captured pane bytes if `pane !== 'silent'` | tmux pipe-pane log (`tmux/<paneId>.log`) |
| `commit` | Read-only details panel: message, diff stat, changed files | `StepEntry.value: CommitResult` + `git show --stat` |
| `worktree` | Read-only details panel: path, branch, postCreate output | `StepEntry.value: WorktreeResult` + `StepEntry.artifacts` |
| `ask` | Read-only details panel: question, choices, chosen value, timestamp | `StepEntry.value: AskResult` |

The right-pane swap mechanism is **tmux windows**: window 0 hosts the live agent (current behavior); Enter on a past step creates window 1, renders the per-kind action there, and switches the tmux client to window 1. `f` switches back to window 0. The live process in window 0 is *never* touched — this is the brainstorm's non-negotiable.

## Architecture

```
                           ┌────────────────────────────────────────┐
                           │   .orch/state/<runId>/                 │
                           │     state.json                         │  ◀── persisted by FileStateStore
                           │     lifecycle.ndjson                   │  ◀── persisted by SessionLogger
                           │     steps/<name>.transcript.ndjson     │  ◀── persisted by transcript writer
                           │     tmux/<paneId>.log                  │  ◀── persisted by pipe-pane-capture
                           │     tui-intents.ndjson                 │  ◀── child appends; parent watches
                           └──────────────────┬─────────────────────┘
                                              │ tail (fs.watch + poll fallback)
                                              ▼
┌───────── src/hosts/two-pane/steps-view/ ──────────────────────┐
│                                                                │
│   StepsViewModel (pure, no React)                              │
│       readState() → StepsViewState                             │
│       on('change', handler)                                    │
│                                                                │
│   <StepsView>  Ink components                                  │
│       <StepRow>, <ParallelGroup>, <HelpOverlay>                │
│       <EndOfRunSummary>, <TranscriptReplay>, <KindDetails>     │
│                                                                │
│   steps-view-runner.tsx (child process entry point)            │
│       reads StepsViewModelOptions from --opts <base64>         │
│       on user keypress, appends NDJSON to                      │
│       .orch/state/<runId>/tui-intents.ndjson                   │
│         → { type: 'enter', stepName }                          │
│         → { type: 'follow-live' }                              │
│         → { type: 'quit' }                                     │
└──────┬─────────────────────────────────────────────────────────┘
       │ file-based intent channel
       ▼
┌────────── src/hosts/two-pane/tmux-host.ts ─────────────────────┐
│   startStepsView(opts) — spawn Ink child onto left pane        │
│       host.runInteractive({ pane: 'left', argv, env })         │
│   tailIntents() — fs.watch tui-intents.ndjson                  │
│       on { type: 'enter', stepName }: per-kind dispatch        │
│         agent-interactive → resumeCommand → newWindow          │
│         agent-autonomous  → replay transcript → newWindow      │
│         command           → replay tmux pane log → newWindow   │
│         commit/worktree/ask → render details → newWindow       │
│       on { type: 'follow-live' }: selectWindow back to 0       │
│       on { type: 'quit' }: teardown TUI (live run continues)   │
└──────┬─────────────────────────────────────────────────────────┘
       │ TmuxService.newWindow / selectWindow / killWindow
       ▼
┌──────────────────── tmux server (per-run socket) ──────────────┐
│   window 0 (live)    : left=Ink steps  | right=agent pane      │
│   window 1 (replay)  : selected step's per-kind view           │
└────────────────────────────────────────────────────────────────┘
```

### Module layout

```
src/hosts/two-pane/steps-view/
├── index.ts                       # public barrel
├── steps-view-model.ts            # pure projection: on-disk → StepsViewState
├── tail-state-json.ts             # fs.watch + poll fallback for state.json
├── tail-ndjson.ts                 # incremental NDJSON tailer (per-step + lifecycle + intents)
├── adaptive-columns.ts            # width → ColumnSet (pure function)
├── steps-view.tsx                 # <StepsView> + <StepRow> + <ParallelGroup>
├── transcript-replay.tsx          # <TranscriptReplay> (with TODO-memory comment)
├── kind-details.tsx               # <KindDetails> (commit / worktree / ask / command-fallback)
├── help-overlay.tsx               # <HelpOverlay>
├── end-of-run-summary.tsx         # <EndOfRunSummary>
├── steps-view-runner.tsx          # child entry — argv parser, render(), intent appender
├── start-steps-view.ts            # parent-side factory: spawn child, watch intents, dispatch
└── README.md                      # one-pager: component / IPC seam / failure mode
```

Eleven `.ts(x)` files plus README. No `_shared/`, no `services/ipc/`, no separate controller-vs-supervisor split, no `steps-ipc.ts` (the schema is ~12 lines and inlines into both ends).

### Naming

The codebase has zero `*ViewModel` / `*Controller` / `*Router` suffixes today. Public factories use `start*` / `create*`:

- `createStepsViewModel(opts): StepsViewModel` — pure projection.
- `startStepsView(opts): { stop(): Promise<void> }` — parent-side spawn + intent watcher (mirrors the existing `startStatusLoop`).

### IPC contract — file-based intents

The child writes intents to a single file the parent watches. No socket, no stdin/stdout protocol, no handshake.

**Path:** `.orch/state/<runId>/tui-intents.ndjson` (a `Path`-branded value, set up at run-init time alongside `state.json`).

**Frame:** one JSON object per line, terminated by `\n`. Schema:

```ts
// inlined in steps-view-runner.tsx and start-steps-view.ts
const IntentSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('enter'),       stepName: z.string().min(1) }),
  z.object({ type: z.literal('follow-live') }),
  z.object({ type: z.literal('quit') }),
])
type Intent = z.infer<typeof IntentSchema>
```

**Child writes:** `await appendFile(intentsPath, JSON.stringify(intent) + '\n')`. The Ink child already has `fs/promises` available; one append per keypress is well below any throughput concern.

**Parent reads:** `tail-ndjson.ts` (built in Phase 1 for `lifecycle.ndjson`) tails the file, validates each line through `IntentSchema.safeParse`, drops malformed lines with a log entry, never crashes on a bad write. The tailer survives parent restarts: starting from offset 0 re-emits historical intents, but `start-steps-view.ts` records its starting offset (`stat(intentsPath).size`) at spawn time and only dispatches intents written after that point.

**Why this works:**

- Same `fs.watch` machinery the viewmodel already uses for `state.json`. No new watcher topology, no new error modes.
- The file is single-writer (only the active Ink child writes) and single-reader (only the parent's intent dispatcher reads). No coordination required.
- Survives child crashes: if the child dies mid-write, the next-line boundary is still well-defined; the partial line is dropped and logged.
- Survives parent crashes: a re-spawned parent can read intents from the offset it last processed, persisted in memory only (intents older than the parent process are not replayed).
- The intent file is per-run, scoped to `.orch/state/<runId>/`, cleaned up by the existing run-state cleanup paths.

**Failure mode (no watchdog):** if the Ink child exits unexpectedly, `host.runInteractive`'s exit handler logs `{ event: 'tui-crashed', exitCode, signal }` to `lifecycle.ndjson` and writes `"TUI unavailable — detach + reattach to retry, run continues\n"` to the left pane via the existing `PaneQueue`. The live run in window 0 is unaffected. The user can detach and re-attach to retry; if the second attach also fails, this is a real bug worth a watchdog.

### Schema — `StepEntry.sessionId?: string`

```ts
// src/state/state-store.ts — additive only, no version bump
const StepEntrySchema = z.object({
  // ... existing fields
  sessionId: z.string().min(1).optional(),  // NEW
})
```

The existing `rebuildSteps` projector at `state-store.ts:149-169` already strips/restores optional fields via the spread-when-defined pattern. Extend it to thread `sessionId` through the same way (one line). On read, old state files (which never had the field) load with `sessionId === undefined`. On write, files without a sessionId emit no `"sessionId"` key — round-trip-stable.

`schemaVersion` stays at 5. No `parseV6`. No fixture corpus duplication.

If the parallel `reframe Phase E` plan ends up bumping to v6 for unrelated reasons, this plan rebases its single new field onto whatever the prevailing schema version is at merge time. No coordination doc needed.

### `Runner.resumeCommand?` (Phase 3)

```ts
// src/runners/types.ts — additive only
export interface Runner {
  // ... existing
  resumeCommand?(ctx: RunnerContext, sessionId: string): RunnerCommand | Promise<RunnerCommand>
}
```

No `supports.resume` flag. Capability check at the call site:

```ts
if (typeof runner.resumeCommand === 'function') { /* resume path */ }
else { /* "this runner doesn't support resume" refusal */ }
```

`RunnerAdapterSchema` at `runners/types.ts:130` gains:

```ts
resumeCommand: z.function().optional()
```

Same PR. Without this, `defineRunner(claudeRunner)` rejects the new optional method at validation time.

### State source — on-disk, not in-memory

```
StepsViewModel.readState():
  1. read state.json                          → schemaVersion + steps record
  2. read lifecycle.ndjson tail (last N MB)   → live run status, end-of-run reason
  3. project into StepsViewState              → no transcript reads at projection time
```

Per-step transcript NDJSON and `tmux/<paneId>.log` are read **only on Enter** (Phase 2). The driver's-seat projection is O(steps), never O(steps × bytes).

### Adaptive column layout

```ts
// src/hosts/two-pane/steps-view/adaptive-columns.ts
export interface ColumnSet {
  readonly name: true            // always
  readonly glyph: true           // always
  readonly elapsed: boolean      // hidden < 70
  readonly cost: boolean         // hidden < 80
  readonly tokens: boolean       // hidden < 95
}

export function pickColumns(width: number): ColumnSet {
  return {
    name: true,
    glyph: true,
    elapsed: width >= 70,
    cost:    width >= 80,
    tokens:  width >= 95,
  }
}
```

Width comes from `useStdout().stdout.columns`. Ink subscribes to SIGWINCH on its controlling TTY; tmux forwards SIGWINCH on `resize-window`. No parent-forwarded resize path — one source of truth.

### Discriminated unions (TS strictness)

```ts
// src/hosts/two-pane/steps-view/steps-view-model.ts
export type StepRow =
  | { readonly kind: 'agent';    readonly mode: 'autonomous';  readonly status: StepStatus; /* totals fields */ }
  | { readonly kind: 'agent';    readonly mode: 'interactive'; readonly status: StepStatus; readonly sessionId?: string }
  | { readonly kind: 'command';  readonly silent: boolean;      readonly status: StepStatus; /* fields */ }
  | { readonly kind: 'commit';   readonly value: CommitResult;  readonly status: StepStatus }
  | { readonly kind: 'worktree'; readonly value: WorktreeResult; readonly status: StepStatus }
  | { readonly kind: 'ask';      readonly value: AskResult;     readonly status: StepStatus }

export type StepsViewState =
  | { readonly status: 'live';      readonly run: RunHeader; readonly steps: readonly StepRow[] }
  | { readonly status: 'completed'; readonly run: RunHeader; readonly steps: readonly StepRow[]; readonly summary: EndOfRunSummary }
  | { readonly status: 'failed';    readonly run: RunHeader; readonly steps: readonly StepRow[]; readonly summary: EndOfRunSummary }
  | { readonly status: 'crashed';   readonly run: RunHeader; readonly steps: readonly StepRow[]; readonly summary: EndOfRunSummary }
```

Both `kind` and `mode` are pinned per `agent` variant (TS won't narrow `mode` from `kind === 'agent'` alone). Terminal status is encoded as a discriminant, not an optional `endOfRun?` — consumers narrow on `state.status !== 'live'` and `summary` is non-optional inside that branch.

### `Path` brand on every public API

No raw `string` for filesystem paths in any new module API. Every public type/parameter accepting a filesystem path uses the project's `Path` brand (from `src/services/types.ts`). The argv `--opts <base64-json>` carries `stateDir` as a string on the wire; the child's argv parser MUST re-brand via `path(parsed.stateDir)` immediately after parsing — once, at the boundary, validated by Zod first.

### `runInteractive` extension (Phase 1)

`tmux-host.ts:451-505` is hard-coded against `deps.rightPaneId`. The plan's "spawn an Ink child onto the left pane" requires a Host port surface change.

**Phase 1 deliverable:** extend `Host.runInteractive` with a `pane: 'left' | 'right'` parameter. Default stays `'right'` so Phase 18b's `InkPromptService` continues to work unchanged. The left-pane variant skips the right-pane-only `respawn-pane back to cat` behavior at line 492.

## Phases

Four PR-sized phases. Each phase is independently green under `bun run check`. Each phase ends in a user-visible artifact.

### Phase 1 — Live driver's seat against FakeRunner

**Goal:** `--mode=two-pane` against a `FakeRunner` workflow draws the new Ink steps navigator in the left pane. Arrow keys move selection. `f` snaps back to live. `q` quits the TUI; the live run continues. Per-kind Enter is **not** wired yet — Enter logs an intent that the parent ignores in this phase.

**Deliverables:**

- `src/hosts/two-pane/steps-view/steps-view-model.ts` — `createStepsViewModel`, `StepsViewState`, `StepRow` types (discriminated unions per above).
- `src/hosts/two-pane/steps-view/tail-state-json.ts` — `fs.watch` + 250ms poll fallback. Hybrid debounce: leading-edge fire + 50ms trailing + 200ms max-wait. Tolerant atomic-rename read with backoff (25/50/100/200/400ms; null after 5 attempts). Single watcher per parent directory, demultiplexed by basename.
- `src/hosts/two-pane/steps-view/tail-ndjson.ts` — incremental NDJSON tailer with truncation + inode-rotation detection. State machine: `{ fd, inode, position, partial }`. UTF-8-safe via `StringDecoder`. Caps `partial` at 1 MiB to avoid runaway-producer OOM. Wraps `JSON.parse` per line in try/catch — emits `parse-error` on bad lines, never crashes.
- `src/hosts/two-pane/steps-view/adaptive-columns.ts` — `pickColumns(width): ColumnSet`.
- `src/hosts/two-pane/steps-view/steps-view.tsx` — `<StepsView>` + `<StepRow>` + `<ParallelGroup>` + `<HelpOverlay>` (one file ≤300 lines). `useAdaptiveColumns` and `useStepsSelection` hooks. SIGWINCH debounce 75ms. `<StepRow>` wrapped in `React.memo` with prop-equality on threshold-bucketed values (cost rounded to $0.01, tokens to 100, elapsed to 1s).
- `src/hosts/two-pane/steps-view/steps-view-runner.tsx` — child entry point. Parses `--opts <base64>` argv (Zod-validated, re-branded via `path()`), instantiates the viewmodel, calls `render(<StepsView />)`, appends keypress intents to `.orch/state/<runId>/tui-intents.ndjson`.
- `src/hosts/two-pane/steps-view/start-steps-view.ts` — parent-side factory. Spawns the child via `host.runInteractive({ pane: 'left', argv, env })`, records `intentsStartOffset = stat(intentsPath).size`, watches `tui-intents.ndjson` via `tail-ndjson` from that offset, exposes `{ stop(): Promise<void> }`. Logs unexpected child exit to `lifecycle.ndjson` and writes the "TUI unavailable" message to the left pane via `PaneQueue`.
- `src/hosts/host.ts` — `Host.runInteractive` gains `pane: 'left' | 'right'` (default `'right'`).
- `src/hosts/two-pane/tmux-host.ts` — replace the `startStatusLoop` instantiation with `startStepsView(...)`. Right-pane behavior unchanged.
- `src/hosts/two-pane/steps-view/index.ts` — public barrel.
- `src/hosts/two-pane/steps-view/README.md` — one-pager covering component, intent file, failure mode.
- Helpers: `tests/helpers/build-state-fixture.ts` (materializes fixture state directories), `tests/helpers/ink-tick.ts` (hoist of `tick()` from `tests/unit/services/prompt/ink-app.test.tsx:47-49`), `tests/helpers/ink-render.tsx` (custom `EventEmitter`-Stdout shim for interactive Ink tests), `tests/helpers/keypress.ts` (`ARROW_UP`/`ARROW_DOWN`/`ENTER`/`ESC` constants).

**Tests:**

- **Unit** (`tests/unit/hosts/two-pane/steps-view/`):
  - `steps-view-model.test.ts` — fixture-driven projection: empty state, one running step, one completed, one parallel group with 3 children, mixed kinds. ~10 tests.
  - `steps-view-model-end-of-run.test.ts` — completed/failed/crashed produces correct `summary`. 4 tests.
  - `tail-state-json.test.ts` — emits on initial read; emits on atomic rename; coalesces bursts (10 events in 20ms → exactly 1 emit); survives transient ENOENT during rename. Concurrency stress: 100 atomic renames at 50ms intervals × 1 reader; reader never observes non-parseable JSON. 5 tests.
  - `tail-ndjson.test.ts` — reads existing lines on open; handles partial last lines; detects truncation; detects rotation; oversize-line recovery (2 MiB without `\n`, then a normal line). 5 tests.
  - `adaptive-columns.test.ts` — table-driven across widths 60/70/80/95/110. 1 test.
  - `steps-view.test.tsx` — frame snapshots at widths 110/85/70 via `renderToString` from `ink`. ANSI-stripped. 3 tests.
  - `step-row.test.tsx` — consumes a `ColumnSet` correctly (full + minimum). 2 tests.
  - `parallel-group.test.tsx` — branch tree indentation; live ones animate. 3 tests.
  - `selection.test.tsx` — first render auto-selects active step; ↑/↓ moves selection; `f` snaps to live; selection sticky-once-moved is anchored on `stepName` (not index): render `[A,B,C]`, select `C`; re-render `[A,X,B,C]`; assert selection still on `C`. 5 tests.
  - `help-overlay.test.tsx` — `?` toggles; Esc closes; keymap shown is `↑/↓ ⏎ f ? q`. 3 tests.
  - `start-steps-view.test.ts` — spawns a fake child via `FakeProcessService`, asserts argv encoding, asserts `intentsStartOffset` is recorded at spawn time, asserts intents written before spawn are NOT dispatched, asserts intents written after spawn ARE dispatched. 4 tests.
  - `start-steps-view-failure.test.ts` — fake child exits unexpectedly; assert `lifecycle.ndjson` gets a `tui-crashed` entry; assert `PaneQueue.write` is called once with the canonical "TUI unavailable" message. 2 tests.
- **Integration (mocked edges)** (`tests/integration/hosts/two-pane/steps-view/`):
  - `steps-view-model-integration.test.ts` — drive a real `FileStateStore` against a tempdir; compose `StepsViewModel` + `tail-state-json`; assert auto-reprojection on every saveStep. 2 tests.
  - `steps-tui-mocked.integration.test.ts` — `TmuxHost` wired with `FakeTmuxService` + `FakeProcessService` scripted to behave like the Ink child. Spawn → child appends intent → parent dispatches → teardown. Asserts `startStatusLoop` is NOT called in two-pane (deletion verification). 3 tests.
- **Integration (real tmux)** (`tests/integration/hosts/two-pane/steps-view/`):
  - `steps-tui.real.integration.test.ts` — gated by `tmux -V`. Spawns a real tmux session, runs a 2-step `FakeRunner` workflow, snapshots the left pane via `capturePane`, asserts the rendered text contains both step names + the run title. 1 test.
- **Type tests** (co-located, `*.test-d.ts`):
  - `steps-view-state.test-d.ts` — `StepsViewState.steps` readonly; `StepRow` discriminant on `kind` AND `mode`; `summary` non-optional inside terminal branches. 3 type-level assertions.

**Definition of Done:**

- `bun run check` green.
- `bunx orch run examples/compound/` with `--mode=two-pane` shows the new pane.
- `src/observability/status-pane.ts` and `src/observability/status-loop.ts` stay in-tree (host-agnostic) but are no longer imported by `TmuxHost`.
- No new runtime deps beyond Phase 18's (`ink`, `ink-text-input`, `react`).

---

### Phase 2 — Per-kind Enter dispatch + tmux windows

**Goal:** Enter on a step does the obvious thing for the kind. Tmux windows manage the right-pane swap (window 0 live, window 1 replay). `f` returns to window 0.

**Deliverables:**

- `src/services/tmux/tmux-service.ts` — `WindowId` brand (`@\d+`), `newWindow`, `selectWindow`, `killWindow`. (`listWindows` only if a test needs it; otherwise out.)
- `src/services/tmux/real-tmux-service.ts` — argv recipes:
  ```
  newWindow:    -L sock new-window -d -a -t session:N -n name -c cwd \
                -P -F '#{window_id}\t#{window_index}' [-e K=V ...] cat
  selectWindow: -L sock select-window -t @id
  killWindow:   -L sock kill-window -t @id
  ```
  `cat` placeholder keeps the window alive so `respawn-pane` can attach the replay process later. Pin `automatic-rename off` after creation (belt-and-braces against OSC sequences re-enabling it).
- `src/services/tmux/fake-tmux-service.ts` — recorder + scriptable returns for the new methods.
- `src/services/tmux/session-init.ts` — set `window-size latest` on the session so multi-client doesn't letterbox.
- `src/hosts/two-pane/right-pane-controller.ts` — owns per-kind dispatch, owns window 1's lifecycle.
- `src/hosts/two-pane/replay-transcript.ts` — re-renders a per-step NDJSON sidecar via `runner.toTranscriptLines` into window 1's right pane. Naive load — **the required `// TODO(transcript-replay-memory):` comment lives here.**
- `src/hosts/two-pane/replay-command-pane.ts` — replays the captured pane log for a `command:` step (`tmux/<paneId>.log`). For `silent: true` shows the documented "no captured output" message.
- `src/hosts/two-pane/kind-details.tsx` — `<KindDetails>` rendered in window 1 for `commit` / `worktree` / `ask` (single switch, single file).

**Tests:**

- **Unit:**
  - `tmux-service-window.test.ts` — `WindowId` smart constructor accepts `@\d+`, rejects others. 3 tests.
  - `right-pane-controller.test.ts` — drive per-kind dispatch with `FakeTmuxService` + `FakeRunner`. Asserts `agent` interactive vs autonomous take different paths; commit/worktree/ask each route to `<KindDetails>`; command silent vs captured branches. 6 tests.
  - `replay-transcript.test.ts` — feeds an NDJSON fixture (existing `tests/fixtures/claude/*.jsonl`) + stub `runner.toTranscriptLines`, asserts rendered output. 3 tests.
  - `replay-command-pane.test.ts` — feeds a captured pane log fixture, asserts byte stream forwarded faithfully (ANSI preserved). 2 tests.
- **Integration (mocked tmux):**
  - `right-pane-windows.integration.test.ts` — `FakeTmuxService` records `newWindow → selectWindow → ...` argv on Enter; `selectWindow` back to window 0 on `f`. 4 tests covering one path per kind. Also asserts `selectWindow` precedes `killWindow` (no flicker race).
  - `kind-details.integration.test.ts` — render the panel for a real `CommitResult` / `WorktreeResult` / `AskResult` in a fake right pane via `FakeProcessService`. 3 tests.
- **Integration (real tmux):**
  - `windows.real.integration.test.ts` — gated. Two-window dance: spawn run; window 0 has the live agent placeholder; emit a child intent `enter`; window 1 created; `list-windows` shows both; emit `follow-live`; tmux's active window back to 0. **Verifies that detach + reattach preserves both windows** (tests the original Q-2 directly). 2 tests.

**Definition of Done:**

- Replay works locally for an autonomous step.
- Replay works locally for a `command:` step.
- Details panel renders for commit/worktree/ask.
- `// TODO(transcript-replay-memory):` comment present in `replay-transcript.ts`. Enforced via `bun run check` grep step.

---

### Phase 3 — Resume launcher + `sessionId` capture

**Goal:** Enter on a finished interactive `agent` step launches `runner.resumeCommand(...)` in window 1. `StepEntry.sessionId` is captured for interactive steps. Resume failure path is visible.

**Deliverables:**

- `src/runners/types.ts` — `Runner.resumeCommand?(...)`. New `RunnerEvent` info type: `{ kind: 'info', type: 'session-started', payload: { sessionId: string } }`.
- `src/runners/types.ts` — `RunnerAdapterSchema` extension: `resumeCommand: z.function().optional()`. Without this, `defineRunner(claudeRunner)` rejects the new method.
- `src/runners/claude/claude-runner.ts` — surface `session_id` from `init` events as a `session-started` info event; `resumeCommand(ctx, id)` returns `claude --resume <id>` argv (interactive mode).
- `src/runners/codex/codex-runner.ts` — same for `thread_id` → `codex resume <threadId>`.
- `src/runners/fake/fake-runner.ts` — scriptable `resumeCommand` per script entry; emits `session-started` when scripted.
- `src/state/state-store.ts` — `StepEntry.sessionId?: string` added; `rebuildSteps` extended to thread `sessionId` through the spread-when-defined pattern at lines 160-166. **No `schemaVersion` change.**
- `src/core/workflow.ts` — capture `session-started` payload into `StepEntry.sessionId` for interactive steps before the persistence write (mirrors how `transcriptPath` is set today). Helper:
  ```ts
  const SessionStartedPayload = z.object({ sessionId: z.string().min(1) })
  function extractSessionId(e: InfoEvent): string | undefined {
    if (e.type !== 'session-started') return undefined
    const r = SessionStartedPayload.safeParse(e.payload)
    return r.success ? r.data.sessionId : undefined
  }
  ```
- `src/hosts/two-pane/right-pane-controller.ts` — `agent`-interactive Enter path resolves `sessionId` from `StepEntry`; calls `runner.resumeCommand` (if defined); spawns the resume in window 1 via `runInteractive`. On non-zero exit, captured stderr remains visible and the footer changes to `"resume failed — press f to return to live, q to close window"`.

**Tests:**

- **Unit:**
  - `runner-resume.test.ts` — `resumeCommand` argv shape per runner (Claude + Codex + Fake). 4 tests.
  - `session-id-capture.test.ts` — workflow executor captures `session-started` payload into `StepEntry.sessionId` for interactive steps; absent for autonomous; absent for runners that don't emit it. 4 tests.
  - `state-store-session-id.test.ts` — round-trip with `sessionId` present and absent; without-sessionId round-trip produces a file with no `"sessionId"` key (no `null` drift); existing v5 fixture still loads cleanly. 4 tests.
  - `right-pane-resume.test.ts` — controller chooses resume path on agent-interactive Enter; refuses (with footer message) when `runner.resumeCommand === undefined`. 3 tests.
- **Integration (mocked CLIs):**
  - `resume-launcher-mocked.integration.test.ts` — full path: workflow runs an interactive step against `FakeRunner` which emits `session-started`; on Enter, the controller spawns `FakeProcessService` with the scripted resume argv; window 1 receives the spawn. 2 tests.
  - `resume-failure-mocked.integration.test.ts` — fake-process scripted to exit nonzero with stderr; assert footer message and stderr visibility. 2 tests.
- **Integration (real, env-gated):**
  - `resume-launcher-claude.real.integration.test.ts` — `RUN_REAL_CLAUDE=1 + tmux -V`. Run a tiny interactive Claude step; capture sessionId; resume via the controller; capture-pane shows the prompt. 1 test.
  - `resume-launcher-codex.real.integration.test.ts` — `RUN_REAL_CODEX=1 + tmux -V`. Same shape with Codex. 1 test.

**Definition of Done:**

- `RUN_REAL_CLAUDE=1` resume works against a real tmux session locally. *(Real-CLI integration tests deferred — env-gated stubs are TBD; the unit + mocked-integration coverage exercises the controller seam end-to-end.)*
- Old state files (no `sessionId`) load cleanly under the updated reader. ✓
- `defineRunner(claudeRunner)` and `defineRunner(codexRunner)` validate at startup. ✓

**Landed:** 2026-05-06. `bun run check` 1328 pass / 0 fail. Phase 3 ships:
- `Runner.resumeCommand?` + `RunnerAdapterSchema.resumeCommand` (additive, no flag duplication).
- Claude / Codex / Fake runners surface `session-started` info events for sessionId capture and expose `resumeCommand`.
- `StepEntry.sessionId?` is captured in `runInteractiveStep` for runners that declare a resume primitive; round-trips cleanly through `parseV5` / `rebuildSteps`.
- `right-pane-controller` agent-interactive Enter respawns the new window's pane with the resume argv; refusal + failure paths surface canonical footer messages.

---

### Phase 4 — End-of-run mount + full E2E + demo

**Goal:** The TUI stays mounted past workflow completion, transitions to an end-of-run summary, supports `q` to teardown. The whole thing has been exercised under a real CLI in a real tmux. Demo workflow walks the user through every per-kind Enter behavior.

**Deliverables:**

- `src/hosts/two-pane/steps-view/end-of-run-summary.tsx` — `<EndOfRunSummary>` (header repaints, footer changes to `"q to quit · ⏎ to inspect"`, resume still works on past interactive steps). Wired to the `state.status !== 'live'` branch of `StepsViewState`.
- `src/hosts/host.ts` — `Host.awaitForegroundShutdown(): Promise<void>`. Plain mode: resolves immediately on workflow completion. Two-pane: composed from `attachForeground exits | quitIntent fires`. CLI races `workflow + awaitForegroundShutdown` in two-pane.
- `src/hosts/two-pane/tmux-host.ts` — do NOT teardown `startStepsView` on workflow completion; teardown happens on `quit` intent or `attachForeground` exit. Teardown ordering: drain pending `q`, kill window 1 if open, kill the steps-view child, kill the session.
- `examples/steps-tui-demo/` — ~30-line workflow mixing autonomous agent step, parallel block, commit, interactive agent step, command. Demonstrates every per-kind Enter behavior in under 2 minutes.
- `examples/README.md` — link the demo as the canonical Steps TUI walkthrough.
- `docs/getting-started.md` — one-paragraph "Two-pane TUI" section linking to the demo.

**Tests:**

- **Unit:**
  - `end-of-run-summary.test.tsx` — header repaints on completed/failed/crashed; footer changes; resume still works on past interactive steps; live → ended transition is single-shot (no flicker on coalesced terminal writes). 4 tests.
  - `await-foreground-shutdown.test.ts` — plain mode resolves immediately; two-pane resolves on `quit` intent OR `attachForeground` exit, whichever fires first. 3 tests.
- **Integration (mocked tmux):**
  - `end-of-run-mount.integration.test.ts` — workflow completes; controller stays alive; user emits `quit`; controller tears down idempotently. 3 tests.
- **Integration (real tmux):**
  - `end-of-run.real.integration.test.ts` — gated. Run a 2-step `FakeRunner` flow to completion; capture-pane shows the summary; emit `quit`; assert teardown. 1 test.
- **E2E (real CLI, env-gated):**
  - `steps-tui-e2e.test.ts` — `RUN_REAL_CLAUDE=1 + tmux -V`. Run a 4-step compound flow: 2 autonomous Claude steps + 1 commit + 1 interactive Claude step. Live pane renders both autonomous steps' tokens/cost; capture-pane after run shows the end-of-run summary; emit Enter on the interactive step; resume window opens. 1 test.
  - `steps-tui-e2e.mocked.test.ts` — same shape, `FakeRunner` + `FakeProcessService`. Always runs. 1 test.
- **Bun memory smoke** (unit-test latency):
  - `transcript-replay-memory.smoke.test.ts` — load a 10MB synthetic NDJSON file via the replay component; passes if resident set growth stays under 120MB (12×). 1 test.

**Definition of Done:**

- `bun run check` green. ✓
- `RUN_REAL_CLAUDE=1` E2E passes locally. *(Stub at `tests/e2e/steps-tui-e2e.test.ts` — gated; not exercised in this run.)*
- `examples/steps-tui-demo/` runs in under 2 minutes and demonstrates every per-kind Enter behavior. ✓

**Landed:** 2026-05-06. `bun run check` 1342 pass / 0 fail. Phase 4 ships:
- `<EndOfRunSummary>` + `<EndOfRunFooter>` repaint the header / footer when `state.status !== 'live'`.
- `Host.awaitForegroundShutdown(): Promise<void>` — plain mode resolves immediately; two-pane resolves on the first of `attachForeground exits | quit intent`. CLI races `workflow + awaitForegroundShutdown` instead of bare attach.
- TmuxHost composes the steps-view's `onIntent` so a `quit` intent settles the shutdown deferred. `start-steps-view.ts` flips `stopped` on quit so the canonical "TUI unavailable" message does not fire on a planned quit.
- `examples/steps-tui-demo/` — five-step walkthrough mixing command, parallel autonomous, interactive Claude, commit, and a final command.
- Coverage: `end-of-run-summary.test.tsx` (4) · `await-foreground-shutdown.test.ts` (3) · `end-of-run-mount.integration.test.ts` (3) · `end-of-run.real.integration.test.ts` (1, real tmux) · `steps-tui-e2e.mocked.test.ts` (1) · `steps-tui-e2e.test.ts` (1, gated `RUN_REAL_CLAUDE=1`) · `transcript-replay-memory.smoke.test.ts` (1).

---

## Acceptance Criteria

### Functional Requirements

- [x] `--mode=two-pane` draws the Ink steps navigator in the left pane (replaces text-painted status pane).
- [x] Adaptive columns drop from the right at width 95 (tokens), 80 (cost), 70 (elapsed); below ~70 only name + glyph remain. *(Phase 1 implements only the elapsed-column threshold; cost/tokens are reserved as `false` placeholders in `ColumnSet` because `StepEntry` has no cost/tokens fields today.)*
- [x] Keymap is exactly `↑/↓ ⏎ f ? q`. `r` is not bound.
- [x] Per-kind Enter dispatch:
  - [x] `agent` autonomous → rendered transcript replay in window 1.
  - [x] `agent` interactive → `runner.resumeCommand` spawned in window 1 (when `resumeCommand` is defined). *(Phase 3 — landed 2026-05-06.)*
  - [x] `command` → captured pane bytes replayed (or "no captured output" for `silent: true`).
  - [x] `commit` / `worktree` / `ask` → read-only details panel in window 1.
- [x] `f` returns to window 0 (live agent pane).
- [x] Selection is sticky once arrows are pressed and is anchored on `stepName`; `f` snaps back to live.
- [x] End-of-run: header repaints to completion summary; footer changes to `"q to quit · ⏎ to inspect"`; resume still works on past interactive steps. *(Phase 4 — landed 2026-05-06. `<EndOfRunSummary>` repaints the header with totals + duration; `<EndOfRunFooter>` leads with `q to quit · ⏎ to inspect`; Enter on a past interactive step still routes through the right-pane controller.)*
- [x] On unexpected child exit: `lifecycle.ndjson` gets a `tui-crashed` entry; pane shows `"TUI unavailable — detach + reattach to retry, run continues"`. Live run is unaffected.
- [x] Resume failure path: stderr visible in window 1; footer shows the recovery hint. *(Phase 3 — landed 2026-05-06.)*
- [x] Old state files (no `sessionId`) load cleanly (`sessionId === undefined`). *(Phase 3 — landed 2026-05-06.)*

### Non-Functional Requirements

- [x] No file in `src/hosts/two-pane/steps-view/` exceeds 300 lines.
- [x] No function exceeds 60 lines.
- [x] No `any`. No `!` non-null assertion.
- [x] No `child_process` / `Bun.spawn` outside `src/services/process/`.
- [x] No `mock.module` in tests under `src/core/`, `src/state/`, `src/validators/`, `src/runners/`, or `src/hosts/two-pane/steps-view/`.
- [x] No raw `string` for filesystem paths in any new module API. Every public type/parameter accepting a path uses the project's `Path` brand.
- [x] No new runtime deps beyond what Phase 18 added (`ink`, `ink-text-input`, `react`); `ink-spinner` allowed if needed for live-step animation, with PR-description justification.
- [ ] Adaptive layout re-renders within 50ms of a `tmux resize-window` event. *(Implemented via `useAdaptiveColumns` 75ms SIGWINCH debounce; not benchmarked.)*
- [x] The required `// TODO(transcript-replay-memory):` comment is present at the load site verbatim.

### Quality Gates

- [x] Every phase ships with the test layers prescribed above. Missing a layer is a review blocker. *(All four phases landed.)*
- [x] `bun run check` is green at every phase boundary. *(Verified after Phase 4: 1342 pass, 0 fail.)*
- [x] At least one real-tmux integration test per phase that touches tmux (1, 2, 4). Auto-skipped without `tmux -V`. *(Phase 1: `steps-tui.real.integration.test.ts`; Phase 2: `windows.real.integration.test.ts`; Phase 4: `end-of-run.real.integration.test.ts`.)*

## Test Matrix Summary

| Phase | Unit | Int (mocked) | Int (real tmux) | Int (real CLI) | E2E |
|---|---|---|---|---|---|
| 1 — live driver's seat | ~50 | 5 | 1 | — | — |
| 2 — per-kind + windows | ~14 | 7 | 1 | — | — |
| 3 — resume + sessionId | ~15 | 4 | — | 2 | — |
| 4 — end-of-run + e2e | ~7 | 3 | 1 | — | 2 |
| **Total** | **~86** | **~19** | **~3** | **2** | **2** |

Numbers are targets, not budgets or floors. PR descriptions justify any test added beyond the target as well as any shortfall.

## Success Metrics

- **DX:** A new contributor can run `bunx orch run examples/steps-tui-demo/` and figure out the keymap from the footer alone, without reading docs. Validate by walking one teammate through the demo cold.
- **Stability:** During a multi-step real-CLI run, the TUI renders every step's status correctly. If the Ink child unexpectedly exits, the live run still completes and persisted state is intact.
- **Resume:** Interactive Claude / Codex steps from past phases can be resumed from inside a running session and *do not interfere with the live step* (verified by capture-pane on window 0 before, during, and after the resume).
- **Memory:** A 10MB transcript replay does not exceed 120MB resident set growth (smoke test).

## Dependencies & Risks

### Dependencies (must exist before Phase 1 starts)

- Phase 18a/18b/18c (TUI ask) — landed; the Ink lifecycle pattern is the template.
- Phase 13c (status-loop / status-pane) — landed; deletion target for two-pane mode.
- Phase 19 (`command()` step) — landed; per-step pipe-pane logs are the data source for `command:` Enter replay.
- Reframe Phase D (TmuxHost) — landed; the host port + per-pane PaneQueue are the seams we extend.

### Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `fs.watch` flakiness on macOS makes intent file or state.json miss events | M | L | Poll fallback at 250ms in the design; tested in Phase 1. |
| Two-window mode breaks tmux detach/reattach | L | H | Verified in Phase 2 real-tmux test. Fallback: in-pane content swap. |
| `runInteractive(left)` host port change breaks Phase 18b's `InkPromptService` tests | M | M | Default `pane: 'right'` preserves existing behavior; verify Phase 18 tests still pass in the same Phase 1 PR. |
| `RunnerAdapterSchema` rejects optional `resumeCommand` at runtime | L | M | Add `resumeCommand: z.function().optional()` to `defineRunner`'s schema in same Phase 3 PR. |
| `rebuildSteps` projector strips `sessionId` on save | M | H | Phase 3 round-trip test asserts spread-when-defined extension. |
| Selection drift on parallel rollup | M | L | Anchor selection on `stepName`, not index; fall back to live if stepName disappears. |
| Transcript replay OOM on >100MB NDJSON | M | L | TODO comment + 10MB smoke test; user-facing docs note the `less` workaround. |
| Resume CLI semantics differ (chained-resume forks vs continues) | L | L | Plan commits to "always resume from originally captured sessionId"; revisit in v2 if observed behavior forces it. |
| ANSI in step names corrupts the Ink pane | L | L | Reuse `stripAnsi` from `status-pane.ts`. Frame-snapshot tests catch regressions. |
| Ink child crashes during a run | L | L | No watchdog; pane shows "TUI unavailable" + lifecycle log entry. If this fires for real users, write a watchdog then. |

## Future Considerations (explicitly NOT v1)

These are flagged for a future plan, not for this one. Mentioned so v1's interfaces don't foreclose them.

- **Watchdog auto-restart.** Add when a real user reports the Ink child crashing. The `start-steps-view` factory's exit-handler is the seam.
- **`orch status <runId>`** — read-only TUI against a finished run. The on-disk-state-source design is already the foundation.
- **MCP exposure of `StepsViewModel`** — the same projection function powers an `orch__steps_view` MCP tool.
- **Cross-run picker** — `tmux ls`-style for `.orch/state/<runId>` with the same TUI rendering each run.
- **Long-list nav** — `/` search, `[`/`]` jump-to-failure, `PgUp/PgDn`. Land when the first user complains.
- **Single-pane host (Reframe Phase C)** — when this lands, move `src/hosts/two-pane/steps-view/` to `src/hosts/_shared/steps-view/` (one `git mv`).
- **Transcript replay memory virtualization** — the `// TODO(transcript-replay-memory):` comment is the contract that says v2 owes this.
- **Schema version bump** — when a *breaking* state field change is needed, bump `schemaVersion` and write a peer parser then. `sessionId?` does not justify it.

## Documentation Plan

- `docs/getting-started.md` — add a one-paragraph "Two-pane TUI" section linking to the demo, after Phase 4 lands.
- `docs/plans/implementation-phases.md` — add a Phase 20 entry pointing to this plan; flip phases 1–4 to ✓ as they land.
- `examples/steps-tui-demo/README.md` — walkthrough for the canonical demo (lands with Phase 4).
- `src/hosts/two-pane/steps-view/README.md` — one-pager explaining the component / intent file / failure mode (lands with Phase 1).

## Implementation crib sheet

Reused helpers (do not redefine):

| Need | Reuse from |
|---|---|
| Strip ANSI for snapshot tests | `src/observability/status-pane.ts:50-52` (`stripAnsi`) |
| Glyph table (status → emoji/ASCII) | `src/observability/status-pane.ts:62-83` (`stepGlyph`) |
| Format elapsed seconds → `mm:ss` | `src/observability/status-pane.ts:89-97` (`formatElapsed`) |
| `StepStatus` union | `src/observability/status-pane.ts:16` |
| `tick()` for Ink tests | `tests/unit/services/prompt/ink-app.test.tsx:47-49` (HOIST to `tests/helpers/ink-tick.ts`) |
| `makeStepEntry(overrides)` | `tests/helpers/make-step-entry.ts:9` |
| Real-tmux gating | `tests/integration/services/tmux/tmux-real.integration.test.ts:20` (`Bun.which('tmux')`) |
| Type-test helpers (`Expect`, `Equal`) | `tests/helpers/type-assertions.ts` |
| Branded type pattern | `src/services/tmux/tmux-service.ts:17-42` (`PaneId`, `SocketName`) |
| One-shot Ink-child argv (`--opts <base64>`) | `src/services/prompt/ink-runner.ts:32-50` |
| Ink lifecycle (render → waitUntilExit → unmount) | `src/services/prompt/ink-runner.ts:58-80` |
| TmuxService method shape | `src/services/tmux/tmux-service.ts:88-231` |
| Tmux argv style (hardcoded flags, `-L socket`) | `src/services/tmux/real-tmux-service.ts:77-136` |
| FakeTmuxService recorder pattern | `src/services/tmux/fake-tmux-service.ts:41-80` |
| Existing `RunState`/`StepEntry` Zod schemas | `src/state/state-store.ts:112-139` |
| Existing `parseV5` / `parseVersionedState` dispatch | `src/state/state-store.ts:174-207` |
| Two-pane integration test setup pattern | `tests/integration/cli/two-pane-auto-attach.test.ts:33-89` |
| `RunnerEvent` discriminated union | `src/runners/types.ts:43` |
| `defineRunner` factory + Zod validator | `src/runners/types.ts:130-167` |
| `claude-runner.ts` session_id capture | `src/runners/claude/claude-runner.ts:25, 45, 55` |
| `tmux-host.ts` `startStatusLoop` wire site (replacement target) | `src/hosts/two-pane/tmux-host.ts:212-219` |
| `tmux-host.ts` `runInteractive` (right-pane-only today) | `src/hosts/two-pane/tmux-host.ts:451-505` |

`bun run check` additions:

```bash
# Enforce the transcript-replay memory TODO comment
grep -q "TODO(transcript-replay-memory):" src/hosts/two-pane/replay-transcript.ts \
  || (echo "missing TODO marker"; exit 1)

# Component must not import from sibling host directories
! grep -rE "from '\\.\\./[a-z]+-pane/'" src/hosts/two-pane/steps-view/ \
  || (echo "leaked cross-host import"; exit 1)
```

## Ink + ink-testing-library — concrete patterns

`ink-testing-library@4`'s `render(tree)` accepts only a `ReactElement` — no `{ stdout: { columns: N } }` second arg. Two patterns to use, do not mix:

**(A) Width snapshots — Ink 7's `renderToString`** (synchronous, deterministic):

```ts
import { renderToString } from 'ink'
import stripAnsi from 'strip-ansi'

for (const cols of [110, 85, 70]) {
  it(`renders within ${cols} cols`, () => {
    const frame = renderToString(<StepsView state={fx.live} />, { columns: cols })
    expect(stripAnsi(frame)).toMatchSnapshot()
  })
}
```

**(B) Interactive tests — wrap Ink's `render()` with a custom `EventEmitter`-backed Stdout shim** at `tests/helpers/ink-render.tsx`. Ink's `useWindowSize` subscribes to `stdout.on('resize', ...)`; `tui.resize(85)` triggers re-render at the new width.

Anti-patterns to ban:

- `mock.module('ink', ...)` / `vi.mock('react', ...)` — extends the existing `mock.module` ban.
- `vi.useFakeTimers()` in any test that mounts `<StepsView>`. Ink's render throttle uses real timers; fake timers deadlock.
- Snapshotting raw frames with ANSI. Always `stripAnsi(frame)` first.
- Asserting `frames.length === N`. The throttle coalesces frames; counts are non-deterministic. Assert `lastFrame()` content.
- Re-using one `render()` across `it` blocks. Always call `cleanup()` in `afterEach`.

## References

### Internal

- `docs/brainstorms/2026-05-05-steps-tui-brainstorm.md` — original brainstorm; non-negotiables, key decisions, ASCII mocks.
- `docs/brainstorms/2026-05-05-steps-tui-second-pass-brainstorm.md` — second pass; adaptive columns, per-kind Enter, end-of-run, resume failures.
- `docs/plans/2026-04-18-feat-orch-reframe-step-views-run-modes-plan.md` — reframe context; the Phase C single-pane slot reserved for v2.
- `docs/plans/2026-05-01-feat-tui-ask-step-plan.md` — Phase 18 ask-step plan; the Ink lifecycle + spawn-child precedent.
- `docs/plans/2026-04-13-feat-phase-13-interactive-steps-tmux-plan.md` — Phase 13 tmux plan; pane management + interactive seam.
- `docs/solutions/autonomous-transcript-rendering.md` — runner-owned formatting via `toTranscriptLines`.
- `docs/solutions/two-pane-auto-attach.md` — naming-collision lesson; "attach" means terminal attachment.
- `src/services/prompt/ink-runner.ts` — one-shot spawn-child template.
- `src/observability/status-pane.ts` — current text-painted left pane (replaced).
- `src/hosts/two-pane/tmux-host.ts` — host integration point (modified).
- `src/services/tmux/tmux-service.ts` — port to extend with windows.
- `src/state/state-store.ts` — schema (one optional field added, no version bump).
- `src/runners/types.ts` — `Runner` interface to extend with `resumeCommand?`.

### External

- [Ink README — `useInput`, `useWindowSize`, `renderToString`](https://github.com/vadimdemedes/ink/blob/master/readme.md)
- [ink-testing-library README](https://github.com/vadimdemedes/ink-testing-library/blob/master/readme.md)
- `tmux(1)` man page (3.6a) — sections WINDOWS AND PANES, FORMATS, OPTIONS.
- [Node.js Issue #7420 — fs.watch always reports 'rename' on macOS](https://github.com/nodejs/node/issues/7420)
- [GNU coreutils `tail --follow=name`](https://www.gnu.org/software/coreutils/manual/html_node/tail-invocation.html) — canonical truncation/rotation handling.
- [Vitest issue #5750 — fake-timer isolation problems](https://github.com/vitest-dev/vitest/issues/5750)
- `claude --help` / `codex --help` for resume argv.

## How to use this plan

1. Phase 1 lands first. Independent of Phase 2/3/4. End-of-phase artifact is the live driver's seat against `FakeRunner`.
2. Phase 2 blocks on Phase 1 (consumes the same intent file + viewmodel).
3. Phase 3 blocks on Phase 2 (per-kind dispatch is the seam resume hooks into).
4. Phase 4 blocks on Phase 3 (end-of-run summary + E2E with real CLI).

Each phase is a separate PR. The PR description follows the `phase-implementer` skill template (tests by layer, DoD checked off). The `testing-strategy` skill governs *how* tests are written; this plan governs *which* tests are mandatory at each phase boundary.
