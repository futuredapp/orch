---
date: 2026-06-02
topic: feat-agent-error-recovery
---

# Agent Error Recovery (fork-resume on transient API failures)

## Summary

A pluggable error-recovery layer for agent steps. When an agent run dies on a transient API error (overload, server error), orch classifies the error, waits, **forks the session from the last clean checkpoint**, sends a single "continue" nudge, and watches for a real progress event before counting another failure — instead of failing the whole workflow or stacking continues. Phase 1 covers headless runs (clean structured error signals); Phase 2 covers interactive runs (staleness detection + capture + classify + send-keys). On by default, bounded so a genuinely-down server cannot hold a run open indefinitely.

---

## Problem Frame

Today a transient API failure inside an agent CLI is fatal to the whole run. A terminal error event (or a non-zero exit) from any runner becomes a `StepError` thrown at the single agent-step error site (`src/core/workflow.ts:1045` autonomous, `:767` interactive); that error propagates, sets the run `status: 'failed'`, and halts every remaining step.

This was observed for real in `examples/.orch/state/r-2026-05-29-102541-rm/` (the captured evidence is folded into the next section so it never has to be re-derived from logs). Claude Code emitted ten `api_retry` events for HTTP 529 "Overloaded" with exponential backoff (612 ms → 38 s), exhausted `max_retries: 10`, and the run ended `failed`. The agent had done nothing wrong and the server recovered minutes later — but a multi-hour autonomous workflow was lost.

The cost shape differs by mode:

- **Headless (autonomous):** the run terminates `failed`. Hours of prior agent work in that run are discarded; a human must notice and restart.
- **Interactive:** the workflow silently stops at the dead step and waits. The CLIs expose no reliable error hook for this state (Codex exposes nothing; Claude only a terminal `StopFailure`), so orch cannot even tell whether the agent is stuck, erroring, or legitimately busy — a human has to spot it and re-run manually.

A naive fix — blindly re-sending "continue" — creates a second failure mode: a thread polluted with `error / continue / error / continue / error`, where the agent ends up responding to a pile of apologetic nudges instead of its task.

---

## Evidence (captured from `r-2026-05-29-102541-rm`)

This is the canonical reproduction. Inlined here so planning never has to re-read the run logs.

**Run context** (`state.json`, `run.meta.json`):
- Workflow `file-prompts-demo`, args `{ prompt: "joke" }`, mode `two-pane`, `claude_code_version: 2.1.156`, model `claude-opus-4-8[1m]`, `permissionMode: bypassPermissions`.
- Two steps: `slug:vars-…` succeeded (14 transcript events), then the **`research`** agent step **failed**. Run `status: "failed"`. Step wall-clock ≈ **3m39s** (`result.duration_ms: 218846`), `num_turns: 1`, `output_tokens: 0` — the agent never got to do *any* work before the server killed it.
- A single Claude session id throughout: `8814f9ea-…` (no fork happened — introducing one is exactly what R8/R11 do).

**The retry ladder** (ten `api_retry` system events, all `error_status: 529`, `max_retries: 10`):

| attempt | retry_delay_ms |  | attempt | retry_delay_ms |
|--------:|---------------:|--|--------:|---------------:|
| 1 | 612 |  | 6 | 16 056 |
| 2 | 1 190 |  | 7 | 38 493 |
| 3 | 2 493 |  | 8 | 36 945 |
| 4 | 4 978 |  | 9 | 36 638 |
| 5 | 9 236 |  | 10 | 38 475 |

Exponential until ~attempt 7, then it **plateaus at ~37–38 s** (the CLI caps its own backoff). Total internal backoff ≈ 185 s. This is the CLI's *own* retry budget being exhausted; orch's recovery wait (R13) is a **second layer** that begins only after this ladder terminalizes.

**The terminal signal — and the labeling trap.** The same 529 is labeled **three different ways** within one stream:

| Source event | Field | Value |
|---|---|---|
| `system/api_retry` (×10) | `error` | `"rate_limit"`  ⚠️ |
| `assistant` (synthetic) | `error` | `"server_error"` |
| `result` | `api_error_status` / text | `529` / "API Error: 529 **Overloaded**…" |

The authoritative terminal record is the `result` event: `is_error: true`, `api_error_status: 529`, `stop_reason: "stop_sequence"`, `terminal_reason: "completed"`, and — critically — **`subtype: "success"`**. So neither `subtype` nor the `error` string can be trusted: `subtype: "success"` is a lie on an errored run, and the `error: "rate_limit"` label on a pure server overload would, under a naive reading of R12, route to **fail-fast** — exactly the wrong verdict. The only consistent, trustworthy classification signal is the numeric **`api_error_status` / `error_status` (529)**. (This sharpens R5 and R12 below.)

The synthetic assistant turn (`model: "<synthetic>"`, content = the "API Error: 529 Overloaded…" string) is how Claude surfaces the error as a fake assistant message — a useful detection cue, but **not** real progress: R9 must not count it as an assistant event that resets the counter.

---

## Actors

- A1. **Runner adapter** (`ClaudeRunner`, `CodexRunner`, future adapters): exposes detection signals (how an error surfaces), a fork-resume primitive, and a per-runner definition of a "progress" event.
- A2. **Recovery strategy** (pluggable): the decision-maker. Given a classified error and the current attempt state, decides wait / fork-resume / fail. `no-retry` and `backoff-resume` ship in v1.
- A3. **Workflow executor**: invokes the strategy at the agent-step error site and applies its verdict (retry the step via fork-resume, or fail).
- A4. **Interactive monitor (Phase 2)**: background watcher of an interactive pane; detects staleness, captures pane state, classifies it, and triggers remediation.

---

## Key Flows

- F1. **Headless backoff-resume (Phase 1)**
  - **Trigger:** an agent step's runner produces a terminal error event or exits non-zero.
  - **Actors:** A1, A2, A3
  - **Steps:** (1) Normalize the runner's raw signal into a classified error (category + transient/terminal). (2) Strategy classifies: fail-fast classes end the run now; retryable classes continue. (3) If the give-up envelope is exceeded, fail the run with a "recovered N times then gave up" message. (4) Otherwise wait (per-class delay, honoring server retry-after when present). (5) Fork the session from the current clean checkpoint into a new session id. (6) Resume the fork with exactly one "you were interrupted, continue your work" nudge. (7) Watch the resumed stream for a progress event.
  - **Outcome (recovered):** a progress event arrives → reset consecutive-failure count to 0, advance the clean checkpoint to this branch, continue normal execution. If the step then completes, the run proceeds.
  - **Outcome (gave up):** envelope exceeded or fail-fast class → run ends `failed` with a recovery summary in state.
  - **Covered by:** R1, R2, R3, R4, R5, R6, R7, R8, R9, R10, R11

- F2. **Interactive detect-and-remediate (Phase 2)**
  - **Trigger:** an interactive pane shows no captured-content change for longer than the staleness threshold (default 10 min), OR (Claude only) a `StopFailure` hook fires.
  - **Actors:** A1, A4, A2
  - **Steps:** (1) Monitor diffs successive pane captures; on staleness, capture pane text (escalate to a PNG render only if text is ambiguous). (2) Classify the capture into `working` / `idle-done` / `waiting-for-input` / `error`. (3) `working` or `idle-done` → do nothing. (4) `waiting-for-input` or `error` → run the same backoff-resume strategy as F1, but the "act" primitive is send-keys (a nudge typed into the pane, or a key to dismiss a prompt) rather than a headless fork-resume; forking still happens underneath so nudges do not stack.
  - **Outcome:** the pane resumes producing output (progress) → reset; or the envelope is exceeded → the step fails with a recovery summary.
  - **Covered by:** R12, R13, R14, R15, R16, R17

---

## Requirements

Each group is tagged with the phase it belongs to. Phase 1 (headless) and Phase 2 (interactive) are intended to produce two separate implementation plans from this one document.

**Architecture & strategy interface [v1]**
- R1. Recovery is a **pluggable strategy object** selected via a strategy-pattern seam. The executor invokes the strategy at the agent-step error site and applies its verdict; the core never hard-codes retry logic.
- R2. Two strategies ship in v1: `no-retry` (today's fail-fast behavior) and `backoff-resume` (the recovery loop in F1). The interface must admit future strategies without core changes.
- R3. The strategy is fed by a **runner-and-mode detection adapter** that normalizes each runner's raw signal into a single classified error: `{ category, transient|terminal, httpStatus?, serverRetryAfterMs?, resetsAt? }`. The strategy is detection-mechanism-agnostic; only the adapter knows per-quadrant specifics.
- R4. A runner exposes recovery capabilities as **optional methods**, mirroring the existing `resumeCommand` / `captureSessionId` / `prepareAutoStop` pattern (presence-as-capability, no `supports.*` flag): a fork-resume primitive, a detection mapping, and a progress-event predicate. A runner lacking the fork primitive degrades to resume-in-place with the no-stacking discipline (R7).

**Detection — headless [v1]**
- R5. **Claude headless:** treat `api_retry` system events as *informational* (the CLI is self-retrying — log, do not act); treat an `isApiErrorMessage` transcript record or a missing terminal event as the *terminal* signal that triggers recovery. **Classify from the numeric status, not the string label.** The captured evidence shows one 529 labeled `"rate_limit"` (in `api_retry`), `"server_error"` (in the synthetic `assistant` event), and `subtype: "success"` (in `result`, despite `is_error: true`) — all in the same stream. The adapter must key off `error_status` / `api_error_status` (e.g. 529 → `overload`) and treat the `error` string and `subtype` as untrusted hints only.
- R6. **Codex headless:** treat process **exit code 1** plus `turn.failed` as the authoritative terminal signal; the lossy `error` line is used only for best-effort category string-matching. (Typed `codexErrorInfo` / `will_retry` are unavailable on the `exec --json` surface and are explicitly not relied upon in v1.)

**Recovery loop & no-stacking invariant [v1]**
- R7. **No nudge stacking.** At most one nudge per forked attempt. A recovery action is never issued while a prior one is in flight, and a fresh nudge is only injected after a confirmed progress event since the last nudge. Forking from the clean parent (R8) is the primary mechanism; resume-in-place with this discipline is the fallback when fork is unavailable.
- R8. **Fork from the clean checkpoint.** Each recovery attempt branches from the last session that made confirmed progress, not from the polluted tip. On confirmed progress, the clean checkpoint advances to the branch that produced it.
- R9. **Progress resets the counter.** A per-runner progress event (Claude: any assistant or tool-use activity after resume; Codex: any `item.started/updated/completed` after resume) resets `attemptsSinceProgress` to 0.
- R10. **Give-up envelope.** Stop and fail the run when `attemptsSinceProgress` reaches a ceiling (default 5) **or** total recovery wall-clock exceeds a cap (default 60 min), whichever comes first. On give-up, the run fails with a summary of what was attempted.

**Fork primitives per runner [v1]**
- R11. **Claude fork** uses the native `--fork-session` flag with `--resume <id>` in headless mode; the new session id is captured from the first `system/init` event of the forked stream. The parent session is left untouched.
- R11a. **Codex fork** is emulated: copy the rollout JSONL to a new id'd path and rewrite the internal session metadata id, then `codex exec resume <new-id>`. This is **guarded** — a rollout-format sanity check gates the copy, the behavior is pinned to the shipped Codex version, and on any copy/rewrite failure the runner **degrades to resume-in-place** (R7) rather than crashing. (See Key Decisions for the rejected safer alternative.)

**Error classification & policy [v1]**
- R12. Classification and per-class policy. **Classify by numeric HTTP status first; the runner's `error` string label is an unreliable tiebreaker only** (see Evidence — a 529 overload was string-labeled `"rate_limit"`, which would mis-route to fail-fast). Map status to class: `529`/`503` → `overload`; `500`/other `5xx` → `server_error`; `429` → `rate_limit`/`usage_limit`; `401`/`403` → `auth`; etc.
  - `overload` (529 / 503 server-overloaded) → **retry**
  - `server_error` (500 / other 5xx) → **retry**
  - `rate_limit` / `usage_limit` (429 with reset info) → **fail fast** in v1, surfacing the reset time in the failure message (do not spin)
  - `auth` / `billing` / `invalid_request` / `model_not_found` → **fail fast** (retry cannot help)
  - `unknown` / unclassifiable → **retry within the envelope** (treated as possibly-transient)
- R13. **Wait policy:** default per-class wait ≈ 5 min, honoring a server-supplied retry-after / reset hint when present; configurable (including an exponential option). Orch's wait is a second layer applied *after* the CLI's own internal backoff has already terminalized.

**Configuration [v1]**
- R14. **Opt-out default.** `backoff-resume` is the default recovery strategy for every workflow. A step opts out with `recovery: noRetry()`; a workflow can set a different default; a step can override the workflow default. All thresholds (ceiling, wall-clock cap, per-class waits) are configurable on the strategy.
- R15. Because the default changes existing behavior, the failure path must make recovery **legible**: a run that recovered and later gave up states how many times it recovered, the error class, and total time spent, so the new default is never silently surprising.

**Persistence & audit [v1]**
- R16. Each agent step records a **recovery log**: one entry per attempt with error class, wait duration, fork/session id, and outcome (progressed / errored-again / gave-up), persisted in run state + logs so a recovered or failed run is fully auditable. The fork chain of session ids is recoverable from this log.

**Testing [v1]**
- R17. The strategy state machine is unit-tested deterministically with a **fake clock** (no real waits) and the **scripted-fake runner** emitting canned error/progress event sequences. Edge integration (subprocess, fork file-copy) is mocked only at the `*Service` / runner-port seams per the project's "mock only at the edge" rule. Cases covered include: recover-then-succeed, recover-then-give-up-on-attempts, give-up-on-wall-clock, progress-resets-counter, no-nudge-stacking, fail-fast classes, and Codex fork-copy-failure degrading to resume-in-place.

**Interactive detection [v2]**
- R18. **Claude interactive:** register a `StopFailure` hook that writes `{ error, error_details, last_assistant_message, session_id }` to a channel orch watches; map the typed `error` enum into the classified error. This is the terminal signal; transient retries remain hook-invisible and are covered only by the staleness path (R19).
- R19. **Codex interactive (and Claude transient):** since no error hook exists, detection is a **staleness poller** keyed on **time since the last observed event/output arrived**, not on a fixed number of polls. The poller records a `lastActivityAt` timestamp whenever a fresh event arrives (or, where events are unavailable, whenever a pane capture differs from the previous one), and triggers when `now − lastActivityAt ≥` the staleness threshold (default 10 min). Concretely: an agent that has produced nothing for 10 minutes is stale regardless of poll cadence — the poll interval only sets sampling granularity, and any new activity resets `lastActivityAt`. (This also means the threshold and the poll interval are decoupled and independently configurable.)

**Capture & classify [v2]**
- R20. **Pane capture** reuses the existing tmux `capturePane` (text, ANSI-aware) and adds a `screenshotPane()` that renders the captured ANSI grid to a PNG via an external renderer behind `ProcessService` (the `freeze` path validated in the POC). Lead with text; escalate to PNG only when text is ambiguous.
- R21. **State classifier** maps a capture into exactly one of `working` / `idle-done` / `waiting-for-input` / `error`, with an explicit three-way discipline so it never pokes a session that is legitimately finished or busy. The classifier must ignore placeholder/ghost composer text and key off concrete signals (visible menu/prompt, error string, real entered text, a spinner unchanged between two captures).
- R22. The classifier runs as a **separate, independent judgment** that must not share the failure mode of the agent being diagnosed — i.e., it should not depend on the same provider that may be overloaded (prefer cheap local text heuristics first, and a different provider / cheap API call when an LLM judgment is needed). (See Outstanding Questions for the exact classifier substrate.)

**Remediation [v2]**
- R23. Remediation reuses the existing tmux `sendKeys` (literal text + Enter): send a nudge into the pane on `error`, or the appropriate key to clear a `waiting-for-input` prompt. The same backoff-resume strategy, no-stacking invariant (R7), fork-from-checkpoint (R8), progress-reset (R9), and give-up envelope (R10) apply — only the act/detect primitives differ from headless.

---

## Acceptance Examples

- AE1. **Covers R5, R7, R8, R9.** Given a Claude headless step that dies on a 529 after doing partial work, when recovery runs, then orch forks from the clean checkpoint, sends exactly one nudge, and — on the first assistant event in the fork — resets the failure counter; the thread contains a single "continue" nudge, not a stack.
- AE2. **Covers R10.** Given consecutive forked attempts that each die before emitting any progress event, when the 5th no-progress attempt fails, then the run ends `failed` with a recovery summary; no 6th attempt is made.
- AE3. **Covers R10, R13.** Given an `overload` that never recovers, when total recovery wall-clock passes 60 min, then the run gives up even if the attempt ceiling has not been reached.
- AE4. **Covers R9, R10.** Given a step that recovers, does real work, then dies again three times total but makes progress between each death, when evaluated, then it never gives up on the attempt ceiling because progress keeps resetting the counter (wall-clock cap still applies).
- AE5. **Covers R12.** Given a `usage_limit` (429 with reset info) in headless mode, when classified, then the run fails fast immediately with the reset time surfaced — no waiting, no fork.
- AE6. **Covers R11a.** Given a Codex headless step whose rollout file fails the format sanity check, when fork is attempted, then orch degrades to resume-in-place with the no-stacking discipline rather than crashing.
- AE7. **Covers R14.** Given an existing workflow with no recovery config, when a step hits a transient overload, then backoff-resume runs by default; given the same step annotated `recovery: noRetry()`, then it fails fast as it does today.
- AE8. **Covers R19, R21.** Given a Codex interactive pane that is genuinely running a long background command (spinner advancing, output changing), when the monitor samples it, then each fresh capture resets `lastActivityAt` so `now − lastActivityAt` never reaches the staleness threshold — the pane is never even classified, let alone poked. (Even if a momentary still frame did cross the threshold, `classify_state` would return `working` and decline to poke.)
- AE9. **Covers R21.** Given a Claude interactive pane sitting at an idle composer (done, awaiting a human), when classified, then it is `idle-done` and not poked.
- AE10. **Covers R18, R23.** Given a Claude interactive step where `StopFailure` fires with `server_error`, when recovery runs, then orch forks and nudges via send-keys under the same envelope as headless.

---

## Pseudo-code (per-quadrant algorithm)

Deliberately shallow — intended to lock the algorithm, not the implementation.

```
# ---- Shared strategy: backoff-resume ----
state = { attemptsSinceProgress: 0, recoveryStartedAt: null, checkpoint: originalSessionId }

on terminal_error(rawSignal, runner, mode):
    err = runner.classify(rawSignal, mode)          # -> {category, transient/terminal, retryAfter?, resetsAt?}

    if err.category in FAIL_FAST:                    # auth/billing/invalid/usage_limit
        fail_run(reason=err, includeResetsAt=err.resetsAt)   # do not spin
        return

    if state.recoveryStartedAt == null:
        state.recoveryStartedAt = clock.now()

    if state.attemptsSinceProgress >= CEILING            # default 5
       or clock.now() - state.recoveryStartedAt > WALLCLOCK_CAP:   # default 60m
        fail_run(reason="recovered N times then gave up", summary=recoveryLog)
        return

    wait( pick_delay(err) )                          # default ~5m; honor retryAfter; configurable

    fork = runner.forkResume(state.checkpoint)       # NEW session id from clean parent
        # Claude:  claude -p "<nudge>" --resume <checkpoint> --fork-session --output-format stream-json
        #          new id <- first system/init line
        # Codex :  copy rollout(checkpoint) -> new id (guarded); codex exec resume <new id> "<nudge>"
        #          on copy failure -> resumeInPlace(checkpoint) + no-stacking discipline
    send_one_nudge(fork, "You were interrupted by an error. Continue your work as normal.")
    state.attemptsSinceProgress += 1
    recoveryLog.append({err, delay, fork.id, outcome: pending})

    watch(fork):                                     # consume the resumed stream
        on progress_event:                           # runner.isProgress(evt) == true
            state.attemptsSinceProgress = 0          # RESET
            state.checkpoint = fork.id               # advance clean checkpoint
            recoveryLog.last.outcome = progressed
            continue_normal_execution()
        on terminal_error(evt):
            recoveryLog.last.outcome = errored_again
            on terminal_error(evt, runner, mode)     # loop (re-enter, no nudge stacking)
        on turn_complete:
            recoveryLog.last.outcome = completed
            succeed_step()

# ---- Detection adapters (what feeds runner.classify / isProgress) ----
ClaudeRunner.classify(headless):
    api_retry events            -> INFORMATIONAL (log only; CLI is self-retrying)
    isApiErrorMessage / no terminal event -> TERMINAL; category from error_status/error
ClaudeRunner.isProgress(evt, headless): evt is assistant or tool_use after resume

CodexRunner.classify(headless):
    exit_code == 1 + turn.failed -> TERMINAL (authoritative)
    error line                   -> best-effort category via string match (lossy)
CodexRunner.isProgress(evt, headless): evt is item.started/updated/completed after resume

# ---- Interactive (Phase 2): detection differs, strategy is the same ----
# Staleness is measured as wall-clock SINCE THE LAST EVENT/OUTPUT ARRIVED,
# not as a count of unchanged polls. POLL is only the sampling cadence;
# STALE_THRESHOLD is compared against lastActivityAt and is configured independently.
monitor(pane):                                   # background, per interactive step
    lastActivityAt = clock.now()
    loop every POLL:                             # POLL = sampling cadence only
        cap = capturePane(pane, text)
        if cap != lastCap:                       # fresh output == an event arrived
            lastActivityAt = clock.now(); lastCap = cap
        if ClaudeStopFailureFired(): trigger(error_signal)        # Claude only
        if clock.now() - lastActivityAt >= STALE_THRESHOLD:       # default 10m of silence
            verdict = classify_state(cap or screenshotPane(pane)) # working/idle-done/waiting/error
            if verdict in {working, idle-done}:  # still alive, or done on purpose
                lastActivityAt = clock.now(); continue            # do NOT poke
            if verdict in {waiting-for-input, error}:
                # same backoff-resume strategy; act primitive = send-keys, fork underneath
                run_recovery(pane, act = sendKeys, nudge = verdict==error ? "<continue>" : "<dismiss key>")
```

---

## Success Criteria

- A headless autonomous run that hits a transient 529/503 (like `r-2026-05-29-102541-rm`) recovers automatically and completes, with no human intervention, in the common case where the server returns within the envelope.
- Recovery never produces a thread with stacked `error/continue/error/continue`; at most one nudge exists per forked attempt.
- A genuinely-down server can never hold a run open beyond the give-up envelope; on give-up the failure message makes the recovery history legible.
- A downstream implementer can build Phase 1 from the v1 requirement groups and Phase 2 from the v2 groups without inventing product behavior, classification policy, or the no-stacking semantics.
- The strategy state machine is provable by deterministic, fast unit tests (fake clock, scripted-fake runner) covering all branches in the Testing requirement.

---

## Scope Boundaries

### Deferred for later (Phase 2 — specified here, separate plan)

- Interactive recovery for both runners: `StopFailure` hook (Claude), staleness poller, `screenshotPane()`, the state classifier, and send-keys remediation (R18–R23).

### Out of scope entirely (v1 and v2)

- Predicting or pre-empting limits before they are hit, and waiting-until-reset on `rate_limit` / `usage_limit` (explicitly postponed; v1 fails fast and surfaces the reset time).
- Driving Codex through the app-server / codex-sdk transport to obtain a supported `thread/fork` RPC and typed `codexErrorInfo` / `will_retry` (rejected in favor of rollout file-copy — see Key Decisions).
- Upstreaming a `codex exec fork` subcommand.
- Recovery for non-agent steps (`command` steps, validators) — only autonomous/interactive agent steps are in scope.

---

## Key Decisions

- **Two axes, not two modes:** session mode (headless/interactive) selects the *detection* mechanism; recovery strategy is an orthogonal pluggable object. One strategy serves all quadrants; only detect/act primitives differ. Rationale: keeps the no-stacking + envelope logic in one tested place.
- **Real fork from a clean checkpoint over resume-with-discipline:** native fork (Claude) cleanly prevents nudge stacking by branching from the pre-error state each attempt; the checkpoint advances only on confirmed progress. Resume-in-place is the fallback, not the primary.
- **Codex fork via rollout file-copy (accepted with eyes open):** chosen over the supported app-server `thread/fork` RPC for the smaller build (no new transport). Known risk: undocumented rollout layout, version drift, silent breakage on a Codex point release. Mitigated by a format sanity check, version pinning, and degrade-to-resume-in-place on failure. The RPC path remains the documented upgrade if the file-copy proves fragile.
- **Opt-out, backoff-resume default:** maximum protection out of the box; the give-up envelope + legible failure message bound the behavior change for existing runs.
- **Usage/rate-limit fails fast in v1:** retrying a limit is pure waste; waiting-until-reset is a known, deferred follow-up.

---

## Dependencies / Assumptions

- Native `claude --fork-session` works headless and emits the new id in `system/init` (confirmed against official docs, 2026-06). Pin to the shipped Claude Code version.
- Codex has **no** headless fork in the shipped version; `codex exec fork` is an open upstream request. The file-copy emulation depends on the current rollout-on-disk format and is version-pinned.
- The existing primitives recovery builds on already exist: `resumeCommand`, `captureSessionId`, `ResumeRegistry`, tmux `capturePane` / `sendKeys`, and the auto-stop `wait-for` channel. The two net-new building blocks are `screenshotPane()` and the staleness poller (both Phase 2).
- The agent CLIs' own internal backoff still runs underneath; orch's recovery is a second layer applied only after the CLI has already terminalized.

---

## Outstanding Questions

### Resolve Before Planning

- (none — all scope-shaping decisions resolved in dialogue.)

### Deferred to Planning

- [Affects R3, R4][Technical] Exact shape of the runner recovery-capability methods and the normalized classified-error type, and the precise interception seam in the executor (the throw-site is known; whether the strategy wraps at step-level or runner-level is a planning call).
- [Affects R11a][Needs research] Exact Codex rollout-on-disk layout and the minimal id-rewrite needed for `codex exec resume` to load a copied rollout; the sanity-check predicate that gates the copy.
- [Affects R16][Technical] Storage location/schema for the per-step recovery log within the existing state-store (v5) and transcript-sidecar handling across a fork-resume (sidecar currently truncates on resume).
- [Affects R13][Technical] How a server retry-after / `resets_at` hint is extracted per runner and reconciled with the configured per-class wait.
- [Affects R22][Needs research] The classifier substrate for Phase 2 — local text heuristics vs a small cross-provider LLM call vs a cascade — chosen so the classifier does not share the overloaded-provider failure mode of the agent it diagnoses.
- [Affects R20][Technical] Whether `screenshotPane()` depends on the external `freeze` binary at runtime or vendors an equivalent renderer; pane-geometry/scale handling to keep PNGs small.
