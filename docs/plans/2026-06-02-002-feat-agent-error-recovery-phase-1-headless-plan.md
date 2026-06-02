---
date: 2026-06-02
sequence: 002
type: feat
slug: agent-error-recovery-phase-1-headless
status: active
origin: docs/brainstorms/2026-06-02-feat-agent-error-recovery-requirements.md
depth: deep
phase: 1 of 2 (headless)
ships-as: branch A
---

# feat: Agent Error Recovery — Phase 1 (headless), branch A

## Summary

Ship the **headless** half of the error-recovery requirements as one branch (branch A). When an
autonomous agent step dies on a transient API error (529/503 overload, 5xx server error), orch
classifies the error from its **numeric HTTP status**, waits, **forks the session from the last
clean checkpoint**, sends exactly **one** "continue" nudge, and watches the resumed stream for a
real progress event before counting another failure — instead of failing the whole run or stacking
nudges. Recovery is a **pluggable strategy** (`backoffResume()` default, `noRetry()` opt-out),
bounded by a give-up envelope (5 no-progress attempts **or** 60 min wall-clock) so a genuinely-down
server can never hold a run open forever.

Branch A covers requirement groups **R1–R17 (v1)** for the headless quadrants of both runners. The
interactive quadrants (R18–R23, `StopFailure` hook, staleness poller, `screenshotPane()`, state
classifier, send-keys remediation) are **Phase 2 / branch B** and ship from a separate plan against
this same origin document.

Two realities of the current code shape this plan and are *not* assumed away by the requirements:

1. **Headless Claude runs with `--no-session-persistence`** (`claude-runner.ts:301`) and
   `resumeCommand` launches Claude **interactive-only** (`:360-375`). The native
   `--fork-session --resume` headless primitive R11 calls for **does not exist today** and is the
   single largest build item (U3). Recovery cannot fork a session that was never persisted.
2. The terminal `result` event's `data` is preserved via `.passthrough()` (`claude-runner.ts:47/62/73`),
   so `api_error_status` survives untyped on the event — classification reads it off `data` without a
   schema change to the happy path (U1).

---

## Problem Frame

Today a transient API failure inside an agent CLI is fatal to the whole run. `produceAgentStep`
throws `StepError` at `workflow.ts:1071-1076` the moment the runner returns a terminal `error` event
or a non-zero exit; `withStepLifecycle` rethrows (`step-lifecycle.ts:166-182`); the workflow-level
catch (`workflow.ts:1576-1608`) sets run `status: 'failed'` and halts every remaining step.

The canonical reproduction is `examples/.orch/state/r-2026-05-29-102541-rm/` (evidence inlined in the
origin doc so we never re-derive it from logs): Claude emitted ten `api_retry` events for HTTP 529
"Overloaded", exhausted its own `max_retries: 10`, and the run ended `failed` with
`output_tokens: 0` — the agent never did any work, the server recovered minutes later, and a
multi-hour autonomous workflow was lost. The naive fix (blindly re-sending "continue") creates a
second failure mode: a thread polluted with `error / continue / error / continue`. Branch A fixes the
headless case without either failure mode.

---

## Vocabulary

Pin these before the unit list.

- **Quadrant** — (runner) × (mode). Branch A covers the two **headless** quadrants: Claude-headless
  and Codex-headless. Phase 2 covers the two interactive quadrants.
- **Classified error** — the normalized `{ category, transient|terminal, httpStatus?, serverRetryAfterMs?, resetsAt? }`
  a runner's detection adapter produces from its raw terminal signal (R3). The strategy never sees a
  runner's raw event.
- **Recovery strategy** — a pluggable decision object (R1, R2). Given a classified error + attempt
  state + a clock, it returns a **verdict** (`fail` / `wait-then-fork`). It performs no I/O.
- **Checkpoint** — the session id of the last attempt that made confirmed progress. Forks branch
  from the checkpoint, never from the polluted tip (R8). Advances only on confirmed progress.
- **Progress event** — a per-runner predicate (R9). Claude: any `assistant` or `tool_use` activity
  *after* the resume (the **synthetic** `model: "<synthetic>"` assistant turn that carries the error
  string does **not** count). Codex: any `item.started/updated/completed` after resume.
- **Nudge** — the single "you were interrupted, continue your work" message injected per forked
  attempt. At most one in flight, ever (R7).
- **Give-up envelope** — `attemptsSinceProgress ≥ CEILING` (default 5) **or**
  `now − recoveryStartedAt > WALLCLOCK_CAP` (default 60 min), whichever first (R10).
- **Recovery log** — the persisted per-attempt audit trail on the step (R16); one entry per fork
  attempt: error class, wait, fork/session id, outcome.

---

## Requirements Traceability

| Origin ID | Plan unit | Notes |
|---|---|---|
| R1 pluggable strategy seam | U2, U4 | Strategy object invoked at the agent-step error site inside `produceAgentStep`; core hard-codes no retry logic. |
| R2 `no-retry` + `backoff-resume` in v1 | U2 | Two strategy factories. Interface admits future strategies. |
| R3 detection adapter → classified error | U1 | New `ClassifiedError` type + optional `Runner.classify`. Strategy is detection-agnostic. |
| R4 optional runner methods (presence-as-capability) | U1, U3, U5 | New optional `classify?`, `isProgress?`, `forkResume?` mirroring `resumeCommand?`/`captureSessionId?`. No `supports.*` flag. |
| R5 Claude headless detection (status-first) | U1 | `api_retry` informational; terminal = `is_error` result / missing terminal event; classify off `api_error_status` numeric, `error`/`subtype` strings untrusted. |
| R6 Codex headless detection | U1 | exit 1 + `turn.failed` authoritative; `error` line lossy string-match only. |
| R7 no nudge stacking | U2, U4 | ≤1 nudge per forked attempt; fork-from-checkpoint primary, resume-in-place fallback. |
| R8 fork from clean checkpoint | U3, U4, U5 | Checkpoint advances only on confirmed progress. |
| R9 progress resets counter | U1, U4 | Per-runner `isProgress`; synthetic error-assistant excluded. |
| R10 give-up envelope | U2 | Ceiling 5 / wall-clock 60 min; fail with summary. |
| R11 Claude native fork | U3 | `--fork-session --resume <id>` headless; new id from first `system/init`. **Requires dropping `--no-session-persistence` (KTD §1).** |
| R11a Codex emulated fork (guarded) | U5 | Rollout JSONL copy + id rewrite; sanity-check gate; degrade to resume-in-place on failure. |
| R12 classification + per-class policy | U1, U2 | status→class map; overload/server_error→retry; rate/usage/auth/billing/invalid→fail-fast; unknown→retry-in-envelope. |
| R13 wait policy | U2 | Default ~5 min per class; honor server retry-after; configurable (incl. exponential). |
| R14 opt-out default | U6 | `backoffResume` default for every step; `recovery: noRetry()` opts out; workflow default + per-step override. |
| R15 legible give-up message | U4, U6 | Failure states recover count, error class, total time. |
| R16 recovery log persistence | U7 | `StepEntry.recoveryLog`; `schemaVersion` 5→6 + migration; mirrored to `lifecycle.ndjson`. |
| R17 deterministic strategy tests | U2, U4 | Fake clock + scripted-fake runner; all envelope branches + no-stacking + fail-fast + Codex copy-failure degrade. |
| AE1 (R5,R7,R8,R9) | U4 | Claude 529 after partial work → fork from checkpoint, one nudge, reset on first real assistant event. |
| AE2 (R10) | U4 | 5 no-progress attempts → fail with summary, no 6th. |
| AE3 (R10,R13) | U4 | overload that never recovers → give up on wall-clock before ceiling. |
| AE4 (R9,R10) | U4 | progress between deaths keeps resetting; never gives up on ceiling (wall-clock still applies). |
| AE5 (R12) | U6 | `usage_limit` (429 + reset) → fail fast, reset time surfaced, no wait/fork. |
| AE6 (R11a) | U5 | Codex rollout fails sanity check → degrade to resume-in-place, no crash. |
| AE7 (R14) | U6 | unconfigured step recovers by default; `noRetry()` fails fast as today. |

*(AE8–AE10 are interactive — Phase 2 / branch B.)*

---

## High-Level Technical Design

*Directional guidance for review, not implementation specification. Treat sketches as context.*

### New runner-port methods (R3, R4) — `src/runners/types.ts`

Three optional methods, presence-as-capability, mirroring `resumeCommand?`:

```ts
// Normalize a runner's raw terminal signal + exit into one classified error.
classify?(input: { finalEvent: TerminalEvent; exitCode: number; mode: 'autonomous' }): ClassifiedError
// Per-runner progress predicate over the resumed stream.
isProgress?(event: RunnerEvent): boolean
// Build the argv+env that FORKS from a clean checkpoint and resumes headless with one nudge.
// New session id is captured from the resumed stream's first `session-started` info event.
forkResume?(ctx: RunnerContext, checkpointSessionId: string, nudge: string): RunnerCommand | Promise<RunnerCommand>
```

```ts
export type ErrorCategory =
  | 'overload' | 'server_error'            // retry
  | 'rate_limit' | 'usage_limit'           // fail fast (v1), surface resetsAt
  | 'auth' | 'billing' | 'invalid_request' | 'model_not_found'  // fail fast
  | 'unknown'                              // retry within envelope
export interface ClassifiedError {
  readonly category: ErrorCategory
  readonly terminal: boolean
  readonly httpStatus?: number
  readonly serverRetryAfterMs?: number
  readonly resetsAt?: number
}
```

A runner that omits `forkResume` degrades to **resume-in-place** via the existing `resumeCommand`
plus the no-stacking discipline (R7 fallback). A runner that omits `classify` is treated as
"`no-retry` only" — the strategy cannot run without a classified error.

### Strategy interface (R1, R2) — `src/core/recovery/`

```ts
export type RecoveryVerdict =
  | { kind: 'fail'; reason: string; resetsAt?: number }
  | { kind: 'wait-then-fork'; delayMs: number }
export interface RecoveryState {
  attemptsSinceProgress: number
  recoveryStartedAt: number | null
  checkpoint: string                 // session id
}
export interface RecoveryStrategy {
  readonly name: string
  decide(err: ClassifiedError, state: RecoveryState, now: number): RecoveryVerdict
}
export const noRetry = (): RecoveryStrategy => ...        // always { kind: 'fail' }
export const backoffResume = (cfg?: BackoffConfig): RecoveryStrategy => ...
```

`decide` is **pure** (no I/O, no clock of its own — `now` is passed in). The *loop* that waits,
forks, watches the stream, and advances the checkpoint lives in the executor (U4), so the
no-stacking + envelope logic is provable with a fake clock and zero subprocesses.

### Recovery loop seam (R1, R7, R8, R9, R10) — `produceAgentStep` in `src/core/workflow.ts`

The bare throw at `:1071-1076` becomes the entry to a recovery loop. Sketch:

```
result = await runRunner(agent, ctx, deps)              // first attempt (unchanged)
while (result is a terminal error or exit≠0):
    err = agent.classify({ finalEvent: result.finalEvent, exitCode: result.exitCode, mode })
    if !agent.classify or !strategy: throw StepError(...)            // today's behavior
    verdict = strategy.decide(err, state, clock.now())
    recoveryLog.append({ class: err.category, ... outcome: 'pending' })
    if verdict.kind === 'fail':
        throw StepError(key, exitCode, summarize(recoveryLog, err))  // R15 legible message
    await sleep(clock, verdict.delayMs)                              // honors server retry-after
    cmd = agent.forkResume?(ctx, state.checkpoint, NUDGE) ?? resumeInPlace(...)   // R7 fallback
    result = await runRunner(agent, ctx', deps, { watchProgress: agent.isProgress })
    if a progress event was seen:                                   # R9
        state.attemptsSinceProgress = 0
        state.checkpoint = newSessionId(result)                     # R8 advance
        recoveryLog.last.outcome = 'progressed'
    else:
        state.attemptsSinceProgress += 1
        recoveryLog.last.outcome = 'errored_again'
# fell out of loop ⇒ a clean terminal (turn-complete) ⇒ success path continues unchanged
```

`runRunner` already tees every event through `onEvent` (`execute.ts:69-77`); U4 adds a small
progress observer on that same hook (no new spawn machinery). The new session id is read from the
forked stream's `session-started` info event — Claude synthesizes it from `system/init`
(`claude-runner.ts:255-260`), Codex from `thread.started` (`codex-runner.ts:140-145`).

### Persistence (R16)

`StepEntry` gains `recoveryLog?: ReadonlyArray<RecoveryAttempt>`; `RunState.schemaVersion` goes 5→6
with a forward migration that defaults the field to absent (a v5 run loads as a v6 run with no
recovery log). Each attempt is also appended to `lifecycle.ndjson` so a streaming consumer sees it
without re-reading `state.json`. **Transcript-sidecar note:** the sidecar truncates only on the first
write of a *new process* (`transcript-sidecar.ts:84-101`); a fork-resume inside the **same** live run
is not a process resume, so each fork's events append to the one step transcript — no truncation, the
full fork chain is captured. (`orch resume` crash-recovery truncation is unchanged and out of scope.)

---

## Units

Each unit is tests-first, lands green behind `bun run check`, and is independently reviewable. Order
is the merge order. U1→U2→U3 are the spine; U4 is the first end-to-end-usable point (Claude headless
recovers); U5 adds Codex; U6 makes it the default; U7 makes it auditable.

### U1 — Classified-error type + per-runner detection (R3, R4, R5, R6, R9, R12)
- Add `ClassifiedError` / `ErrorCategory` and the optional `classify?` / `isProgress?` methods to the
  `Runner` port (`src/runners/types.ts`), re-exported via the barrel.
- **Claude** `classify`: `api_retry` → informational (never reaches `classify`; it is not terminal);
  terminal = `is_error` result event or a missing terminal event. Read `api_error_status` /
  `error_status` off the passthrough `data`; map status→category (529/503→`overload`, other 5xx→
  `server_error`, 429→`rate_limit`/`usage_limit` by reset presence, 401/403→`auth`, …). Treat the
  `error` string and `subtype` as **untrusted hints only** (Evidence: one 529 labeled `"rate_limit"`).
- **Claude** `isProgress`: `assistant`/`tool_use` info events, **excluding** the synthetic
  `model: "<synthetic>"` error-carrier turn.
- **Codex** `classify`: `exitCode === 1` + `turn.failed` authoritative terminal; `error` line →
  best-effort category via string match (lossy, documented).
- **Codex** `isProgress`: `item.started/updated/completed`.
- **Tests:** pure unit tests over canned `finalEvent`/exit fixtures incl. the three-way-labeled 529
  from the Evidence table (proves status-first classification). No subprocess.

### U2 — Recovery strategy state machine (R1, R2, R7, R10, R12, R13, R17)
- New module `src/core/recovery/` (barrel `index.ts`): `RecoveryStrategy`, `RecoveryVerdict`,
  `RecoveryState`, `noRetry()`, `backoffResume(cfg?)`.
- `backoffResume.decide`: FAIL_FAST categories → `fail` (surfacing `resetsAt`); else stamp
  `recoveryStartedAt`; envelope check (ceiling 5 / wall-clock 60 min) → `fail` with summary; else
  `wait-then-fork` with `pick_delay(err)` (default ~5 min, honor `serverRetryAfterMs`, exponential
  option in `cfg`).
- **Tests (fake clock, no I/O):** recover-then-succeed, give-up-on-attempts, give-up-on-wall-clock,
  progress-resets-counter, fail-fast classes, unknown→retry-in-envelope, delay honors retry-after.

### U3 — Claude headless fork-resume primitive (R8, R11) — **largest unit, see KTD §1**
- Add `forkResume(ctx, checkpointSessionId, nudge)` to `claude()`: `claude -p <nudge> --resume <id>
  --fork-session --output-format stream-json --verbose` (no `--bare` strip needed; keep stream-json).
- **Enable session persistence on autonomous steps** so a session exists to fork: remove
  `--no-session-persistence` from `buildAutonomousArgv` (KTD §1 weighs the alternatives). Establish
  the initial checkpoint from the first attempt's `result.session_id` (already on the success/error
  event).
- New-session-id capture: first `session-started` info event of the forked stream
  (`parseClaudeLine` already synthesizes it from `system/init`).
- **Tests:** argv-shape unit test (fork flags, persistence on); mocked-`ProcessService` integration
  that the forked command is spawned with the checkpoint id and the new id is captured.

### U4 — Wire the recovery loop into the autonomous executor (R1, R7, R8, R9, R10, R15, F1)
- Replace the throw at `workflow.ts:1071-1076` with the recovery loop (design sketch above). Thread a
  resolved `RecoveryStrategy` and the `clock` (already in `deps`) through `produceAgentStep`. Add a
  progress observer onto the existing `onEvent` hook (no new spawn path).
- Degrade-to-resume-in-place when `forkResume` is absent (R7), using `resumeCommand` + single-nudge
  discipline. Build the legible give-up `StepError` message (R15).
- **Tests:** behavioral integration with the **scripted-fake runner** + **fake clock** emitting canned
  error→progress sequences — **AE1, AE2, AE3, AE4**. Asserts exactly one nudge per attempt
  (no-stacking), checkpoint advance on progress, and the give-up summary. (Default strategy wiring is
  U6; U4 tests pass `backoffResume()` explicitly.)

### U5 — Codex headless emulated fork + degrade (R8, R11a, AE6)
- **Spike first** (resolves origin Outstanding Question on R11a): pin the Codex rollout-on-disk layout
  under `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` and the minimal `session_meta.id` rewrite that
  makes `codex exec resume <new-id>` load a copied rollout. Record findings in `docs/findings/`.
- Implement `forkResume` for `codex()`: guarded copy (sanity-check predicate gates it) + id rewrite,
  then `codex exec resume <new-id> "<nudge>"`. On any copy/rewrite/sanity failure → degrade to
  resume-in-place. All filesystem work through `FsService`; copy/spawn mocked at the `*Service` seam.
  Version-pin the behavior to the shipped Codex version (documented).
- **Tests:** mocked-edge integration for the happy copy path + **AE6** (sanity-check fail → degrade,
  no crash). Real integration auto-skips when `codex` is absent.

### U6 — Recovery config surface + opt-out default (R14, R15, AE5, AE7)
- Add `recovery?: RecoveryStrategy` to the agent-step config and a workflow-level default; resolve
  per-step → workflow → built-in **`backoffResume()`** default. `recovery: noRetry()` opts a step out.
- Thresholds (ceiling, wall-clock cap, per-class waits, exponential) are `backoffResume(cfg)` args.
- **Tests:** `expect-type` on the config surface; integration **AE7** (unconfigured recovers by
  default; `noRetry()` fails fast as today) and **AE5** (`usage_limit` fails fast with reset surfaced).

### U7 — Recovery log persistence + audit (R16)
- Add `recoveryLog?: ReadonlyArray<RecoveryAttempt>` to `StepEntry`; bump `RunState.schemaVersion`
  5→6 with a forward migration (v5 → v6 with field absent); persist one entry per attempt (class,
  waitMs, fork/session id, outcome) via `saveStep`; mirror each attempt to `lifecycle.ndjson`.
- Document the field in `docs/logging.md` (per-step folder + state schema).
- **Tests:** real `FileStateStore` + fake `FsService` at the *Service seam (no `mock.module` per the
  state-test rule); round-trip a recovered run and a gave-up run; migration test loads a v5 fixture.

---

## Key Technical Decisions

### KTD §1 — Headless Claude session persistence (the load-bearing decision)
The native fork R11 needs a persisted session to `--resume --fork-session`, but
`buildAutonomousArgv` passes `--no-session-persistence` today and `resumeCommand` is interactive-only.
Options:
- **(A, recommended) Drop `--no-session-persistence` from autonomous argv unconditionally.** Recovery
  is the default (R14), so almost every autonomous step needs a persisted session anyway; one code
  path, no per-step branching. Cost: every autonomous run now writes a Claude session to disk.
  Document the footprint; it is bounded and already the norm for interactive steps.
- **(B) Gate persistence on `recovery !== noRetry()`.** Smaller disk footprint for opted-out steps,
  but the argv now depends on recovery config threaded into `buildCommand`, coupling the runner to a
  core concept it otherwise doesn't know. Rejected for v1 as the wrong coupling; revisit if footprint
  proves real.
- **(C) Don't persist; capture the transcript and replay-resume.** Re-implements what `--fork-session`
  gives natively. Rejected.

Recommendation: **(A)**, called out explicitly because it changes on-disk behavior for *every*
autonomous run, not just recovering ones. **This is the one decision worth a human ack before U3.**

### KTD §2 — Recovery loop lives in the executor, not the strategy
`decide` stays pure (verdict only); the executor owns wait/fork/watch/checkpoint-advance. Keeps the
envelope + no-stacking logic in one fake-clock-testable place and keeps strategies trivially pluggable
(R1, R17). Mirrors the origin's "two axes, not two modes" decision.

### KTD §3 — `forkResume` as a new optional method, not an overload of `resumeCommand`
`resumeCommand` means "interactive continue" today and is wired to the right-pane controller. Fork-
resume is headless + carries a nudge + is recovery-specific. A distinct optional method keeps the
presence-as-capability pattern clean and avoids overloading an existing contract (R4).

### KTD §4 — Codex fork via rollout copy, accepted with eyes open (origin Key Decision)
Chosen over the app-server `thread/fork` RPC for the smaller build. Risk (undocumented layout,
version drift) mitigated by sanity-check + version-pin + degrade-to-resume-in-place (U5). The RPC
path remains the documented upgrade if the copy proves fragile.

### KTD §5 — Status-first classification (origin Evidence)
The same 529 is labeled `"rate_limit"`, `"server_error"`, and `subtype:"success"` in one stream. Only
the numeric `api_error_status` is trustworthy. `classify` keys off status; string labels are
tiebreakers for `unknown` only.

---

## Scope Boundaries

**In branch A (Phase 1, headless):** R1–R17 for Claude-headless and Codex-headless.

**Explicitly out (Phase 2 / branch B, separate plan):** the `StopFailure` hook (Claude interactive),
the staleness poller, `screenshotPane()`, the state classifier, send-keys remediation (R18–R23,
AE8–AE10).

**Out entirely (v1 and v2, per origin):** predicting/pre-empting limits; waiting-until-reset on
rate/usage limits (v1 fails fast, surfaces reset); the Codex app-server transport; upstreaming
`codex exec fork`; recovery for non-agent steps (`command`, validators).

---

## Outstanding Questions resolved into this plan

- **R3/R4 seam (origin "Deferred to Planning"):** resolved — new optional runner methods + a recovery
  loop *inside* `produceAgentStep` wrapping the runner call (KTD §2, U4); strategy wraps at the
  agent-step error site, not the runner level.
- **R16 storage:** resolved — `StepEntry.recoveryLog` + `schemaVersion` 5→6 migration, mirrored to
  `lifecycle.ndjson` (U7).
- **R13 retry-after extraction:** resolved — extracted per-runner in `classify` into
  `ClassifiedError.serverRetryAfterMs`/`resetsAt`; `pick_delay` reconciles with configured waits (U1, U2).
- **R11a Codex layout (Needs research):** carried as the U5 spike (first task), findings recorded in
  `docs/findings/` before the copy is implemented.

---

## `bun run check` gate

Every unit lands green: lint + typecheck (strict, `noUncheckedIndexedAccess`, no `any`/`!`) + unit +
mocked-integration. Real-CLI integration (Claude/Codex fork) is env-gated and auto-skips when the CLI
is missing, per the testing-strategy three-layer rule. Strategy + classification + the recovery loop
are provable entirely from fake-clock + scripted-fake-runner tests (R17) — no real waits, no real
subprocesses in the default suite.
