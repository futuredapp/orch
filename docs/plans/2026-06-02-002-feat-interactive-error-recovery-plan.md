---
date: 2026-06-02
type: feat
status: active
title: "feat: Interactive error-recovery — detect-and-remediate on a stalled agent pane (Phase 2 / branch B)"
origin: docs/brainstorms/2026-06-02-feat-agent-error-recovery-requirements.md
depends_on: docs/plans/<TBD>-feat-headless-error-recovery-plan.md
depth: deep
---

# feat: Interactive error-recovery — detect-and-remediate on a stalled agent pane (Phase 2 / branch B)

> **Branch mapping.** The error-recovery requirements doc is explicitly designed to spawn **two implementation plans** ("Phase 1 (headless) and Phase 2 (interactive) are intended to produce two separate implementation plans from this one document"). This is **branch B = Phase 2 = interactive** (requirements R18–R23). Branch A = Phase 1 = headless (R1–R17) is a hard dependency — see [Dependency on branch A](#dependency-on-branch-a-the-shared-backoff-resume-seam). If you meant branch A, stop and replan against R1–R17 instead.

## Summary

Phase 1 (headless) gives orch a pluggable **`backoff-resume` strategy**: classify a transient error, wait, fork from the last clean checkpoint, send one nudge, watch for a progress event, and give up inside a bounded envelope. Phase 2 reuses that strategy **verbatim** for interactive (tmux-pane) steps and only swaps the two primitives the strategy delegates: **detection** and **act**.

For an interactive step there is no structured error stream — the agent TUI just goes quiet. So Phase 2 adds (1) a per-step background **staleness monitor** that diffs successive `capturePane` snapshots and fires when the pane has produced nothing for longer than a threshold; (2) a **state classifier** that maps the captured pane into exactly one of `working` / `idle-done` / `waiting-for-input` / `error` so orch never pokes a session that is legitimately busy or finished; (3) a Claude **`StopFailure` payload channel** that turns the existing signal-only stop hook into a typed terminal-error signal; and (4) a **send-keys act primitive** so the shared strategy's "send one nudge" lands as keystrokes in the pane (with a fork happening underneath, so nudges never stack). On give-up, the same legible failure summary from Phase 1 is emitted.

The classifier is a **separate judgment that must not share the agent's failure mode** (R22): it leads with cheap local text heuristics and escalates to a *different-provider* judge only when text is ambiguous — so a Claude pane stalled on an Anthropic overload is never diagnosed by another Anthropic call.

---

## Problem Frame

orch's interactive host runs the real agent TUI inside a tmux pane and waits on `pane-exit-<paneId>` with **no timeout** by design, so a human can pause an agent arbitrarily long (`src/hosts/two-pane/tmux-host.ts`, `awaitInteractivePaneExit` at :207–239; the auto-stop race `racePaneExitVsStop` at :1199). Phase 1 (auto-stop, `2026-05-25-001`) added a completion *signal* so a finished-but-idle step no longer stalls forever.

Error recovery is the inverse problem. When the agent CLI hits a transient API failure (the canonical 529 overload in the requirements doc's Evidence section), an interactive run does **not** fail loudly the way a headless run does — it *silently stops at the dead step and waits*. The CLIs expose no reliable error hook for the transient state: Codex exposes nothing, and Claude exposes only a terminal `StopFailure` (transient retries are hook-invisible). So orch cannot even tell whether the pane is stuck, erroring, or legitimately busy — today a human has to notice and re-run by hand.

Two failure modes must be avoided simultaneously:

- **Never poke a live session.** A pane mid-task (spinner advancing, output streaming) or a pane sitting at an intentional idle composer (done, awaiting a human) must be left alone. This is the whole reason for the classifier's three-way `working` / `idle-done` / `{waiting,error}` discipline.
- **Never stack nudges.** Blindly re-typing "continue" pollutes the thread with `error / continue / error / continue`. The Phase 1 no-stacking invariant (R7) — fork from the clean checkpoint each attempt, advance the checkpoint only on confirmed progress — solves this for interactive too; send-keys is just the delivery mechanism.

The infrastructure Phase 2 builds on already exists: `tmux.capturePane` (`src/services/tmux/real-tmux-service.ts:454–462`, ANSI-aware via `-e`), `tmux.sendKeys` (`:269–281`, literal text + optional `Enter`), `ProcessService.spawn` for the external renderer (`src/services/process/process-service.ts:76–80`), the pane-serialization `PaneQueue` (`src/hosts/two-pane/pane-queue.ts`), and the Claude stop-hook injection that already registers `StopFailure` (`src/runners/claude/claude-runner.ts:109–193`). The only net-new building blocks are the **staleness monitor**, the **state classifier**, and **`screenshotPane()`**.

---

## Dependency on branch A (the shared `backoff-resume` seam)

Phase 2 does **not** re-implement the recovery loop. It consumes these seams that branch A (Phase 1) is responsible for landing first. If branch A is not yet merged, this plan's U5 is blocked; U1–U4 (detection, classification, screenshot, hook-channel) are independent and can land ahead.

| Seam branch A provides | Phase 2 consumes it for |
| --- | --- |
| The `backoff-resume` strategy object (R1, R2) and its strategy-pattern seam at the agent-step error site | U5 invokes the same object with interactive primitives |
| The normalized **classified-error** type `{ category, transient\|terminal, httpStatus?, serverRetryAfterMs?, resetsAt? }` (R3) | U3/U4 produce this type from a pane capture / hook payload instead of from a headless stream |
| Optional runner capability methods via presence-as-capability (R4): `forkResume`, `classify`, `isProgress` | U4/U5 reuse `forkResume` + `isProgress`; add an *interactive* classify path |
| No-stacking (R7), fork-from-checkpoint (R8), progress-reset (R9), give-up envelope (R10), wait policy (R13) | U5 inherits all of these unchanged — only act/detect differ |
| Opt-out config + thresholds (R14) and legible give-up summary (R15) | U5/U6 reuse; interactive adds the staleness threshold + poll cadence knobs |
| Per-step **recovery log** storage in `StepEntry` (R16) + the deterministic **fake-clock + scripted-fake runner** test harness (R17) | U6 appends interactive attempts; U7 reuses the harness |

**Contract the strategy must already expose for Phase 2 to plug in:** a way to invoke recovery with an injected `detect` source and an `act(nudge)` callback, rather than hard-coding the headless fork-resume act. If branch A wires the act primitive too tightly to headless fork, U5 carries a small refactor to extract the act seam — flagged in [Risk Analysis](#risk-analysis--mitigation) as **R-A**.

---

## Requirements Traceability

Carried from the origin requirements doc (`docs/brainstorms/2026-06-02-feat-agent-error-recovery-requirements.md`). v2 requirements only; v1 (R1–R17) belong to branch A and appear above as consumed seams.

| Req | Summary | Units |
| --- | --- | --- |
| R18 | Claude interactive: `StopFailure` hook writes `{error, error_details, last_assistant_message, session_id}` to a channel orch watches; map typed `error` enum → classified error. Terminal signal only; transient retries stay hook-invisible (covered by R19). | U4 |
| R19 | Codex interactive (+ Claude transient): **staleness poller keyed on `now − lastActivityAt`**, not a poll count. `lastActivityAt` resets on any fresh capture/event; trigger at threshold (default 10 min). Poll interval and threshold are decoupled, independently configurable. | U2 |
| R20 | Pane capture reuses `tmux capturePane` (text, ANSI-aware); add `screenshotPane()` rendering the ANSI grid to PNG via an external renderer behind `ProcessService` (the `freeze` POC path). Lead with text; escalate to PNG only when text is ambiguous. | U1, U3 |
| R21 | State classifier maps a capture into exactly one of `working` / `idle-done` / `waiting-for-input` / `error`, with an explicit three-way discipline so it never pokes a finished or busy session. Ignore placeholder/ghost composer text; key off concrete signals (visible menu/prompt, error string, real entered text, a spinner unchanged between two captures). | U3 |
| R22 | The classifier is a **separate, independent judgment** that must not share the failure mode of the agent it diagnoses — prefer cheap local heuristics first, and a *different provider* / cheap call when an LLM judgment is needed. | U3 |
| R23 | Remediation reuses `tmux sendKeys` (literal text + Enter): nudge into the pane on `error`, or the key that clears a `waiting-for-input` prompt. The same `backoff-resume` strategy, no-stacking (R7), fork-from-checkpoint (R8), progress-reset (R9), and give-up envelope (R10) apply — only the act/detect primitives differ. | U5 |

Acceptance Examples **AE8 (R19, R21)**, **AE9 (R21)**, **AE10 (R18, R23)** are mapped onto test scenarios in the units below via the `Covers AE<N>` convention.

---

## High-Level Technical Design

> Directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.

**Responsibility split.** The *tmux host* owns the pane and runs the monitor loop. The *classifier* is a standalone module (no runner or provider coupling in its core). The *runner adapter* knows how to turn its CLI's terminal signal into a classified error (Claude `StopFailure` payload; Codex has none, so Codex relies entirely on staleness + classifier). The *shared strategy* (branch A) owns the loop, envelope, and no-stacking. The *executor/core* never imports a concrete runner and never hard-codes the act primitive.

```
 tmux host (owns pane)            classifier (standalone)        runner adapter            shared strategy (branch A)
 ────────────────────             ──────────────────────        ──────────────            ──────────────────────────
 monitor loop:
   every POLL:
     cap = capturePane(-e)
     if cap != lastCap:
        lastActivityAt = now   ◄── fresh output == activity (R19)
        continue
     if now-lastActivityAt ≥ STALE:
        verdict ───────────────────►  classify(cap)            (R21,R22)
                                        text heuristics first
                                        ↳ screenshotPane() +    ──► PaneRenderer.screenshotPane()
                                          different-provider judge    (R20, U1)
        ◄────────────────────────────  working | idle-done
        working|idle-done → reset lastActivityAt, do NOT poke
        waiting | error  ─────────────────────────────────────────────────────►  runRecovery({
                                                                                     detect: monitor,
   (Claude only) StopFailure ──► hook payload file ──► map enum ──► classified-error    act: sendKeys(nudge),
                                  (U4, R18)                                            forkResume underneath })
                                                                                       ↳ no-stacking (R7)
                                                                                       ↳ fork from checkpoint (R8)
                                                                                       ↳ progress resets (R9)
                                                                                       ↳ give-up envelope (R10)
 progress event ◄── isProgress(evt) after resume ── resets counter, advances checkpoint
```

Pseudo-code is already locked in the requirements doc's `monitor(pane)` block (lines 226–239) and the shared `backoff-resume` block (lines 169–209). Phase 2 implements `monitor`, `classify_state`, and the `act = sendKeys` binding; everything else is branch A.

---

## Key Technical Decisions

**KTD-1 — Staleness is wall-clock since last activity, poll is sampling cadence only.** The monitor records `lastActivityAt` whenever a fresh `capturePane` differs from the previous snapshot (or a fresh event arrives where events exist), and triggers when `now − lastActivityAt ≥ STALE_THRESHOLD` (default 10 min). The poll interval only sets sampling granularity; threshold and interval are decoupled and independently configurable (R19). This makes AE8 hold: a long-running pane whose output keeps changing keeps resetting `lastActivityAt` and is never even classified.

**KTD-2 — Classifier substrate: local-heuristics-first cascade, different-provider judge behind a port (R22).** Default v2 ships **text-heuristics-only** (no LLM dependency, deterministic, fast): detect a visible menu/prompt, a known error string, real entered text, or an unchanged spinner across two captures. An optional `StateJudge` port allows escalating ambiguous captures to a small LLM call — but the judge **must use a different provider than the agent under diagnosis** (a Claude pane overloaded on Anthropic is judged by a non-Anthropic / cheaper path). The judge is opt-in config; with no judge configured, an ambiguous capture is treated conservatively as `working` (decline to poke) so the safe default never pokes a live session. This resolves the requirements' Outstanding Question on classifier substrate.

**KTD-3 — `screenshotPane()` depends on an external renderer at runtime, presence-as-capability, degrade to text.** `screenshotPane()` captures the pane with ANSI (`capturePane({ escapeCodes: true })`) and pipes it to the external `freeze` binary via `ProcessService.spawn` (project rule: no `Bun.spawn` outside `src/services/process`). We **do not vendor** a renderer. If the binary is absent or fails, the classifier stays on text only (R20: "lead with text; escalate to PNG only when text is ambiguous"). This keeps v2 shippable on hosts without `freeze`.

**KTD-4 — Recovery log lives in `StepEntry`, not the sidecar (R16 + sidecar-truncation OQ).** The transcript sidecar **truncates on the first write of a resumed step** (`src/state/transcript-sidecar.ts:84–101`), and fork-resume re-enters the step — so the sidecar cannot be the authoritative recovery record. The per-attempt recovery log (`{ errorClass, waitMs, forkSessionId, outcome }`) is appended to a new `StepEntry.recoveryAttempts` array (parallel to `validations`, `src/state/state-store.ts:7–94`), which is atomic and survives forks. The fork chain of session ids is reconstructable from it. A mirror `interactive-recovery-*` event family is emitted to `lifecycle.ndjson` (alongside the existing `interactive-auto-stop-*` family) for live observability. This is shared with branch A's R16 storage — Phase 2 only adds the interactive event family and an `via: 'send-keys'` discriminator.

**KTD-5 — Send-keys is *only* the act primitive; fork still happens underneath (R23, R7).** When the strategy decides to nudge, the interactive act callback (a) forks the clean checkpoint via the runner's `forkResume` (Claude `--fork-session`; Codex emulated copy), (b) respawns the pane onto the forked session, and (c) `sendKeys` the single nudge. The nudge never stacks because each attempt branches from the pre-error checkpoint — identical to headless, the only difference is the keystroke delivery. For `waiting-for-input`, the act is the dismiss key rather than a text nudge, and no fork is needed (the session is alive, just blocked).

**KTD-6 — Monitor races alongside the existing wait, never replaces it.** The monitor runs as a concurrent task next to `racePaneExitVsStop` / `awaitInteractivePaneExit` (`tmux-host.ts:1169–1217`). Pane-exit and auto-stop still win normally; the monitor only ever *adds* a recovery trigger on staleness/StopFailure. All `capturePane` / `sendKeys` / respawn calls route through `PaneQueue.enqueue` (`pane-queue.ts`) so the monitor never races the right-pane controller for the same pane.

---

## Implementation Units

```
dependency graph
────────────────
U1 screenshotPane()                 (independent)
U2 staleness monitor                (independent)
U3 state classifier  ──── needs U1 (for PNG escalation; degrades without it)
U4 Claude StopFailure payload channel  (independent; Claude-only signal)
U5 interactive recovery wiring  ──── needs U2, U3, U4, and branch A's strategy seam
U6 persistence + legibility     ──── needs U5 (extends branch A's R16 store)
U7 tests                        ──── needs U2..U6
```

### U1. `screenshotPane()` pane renderer

- **Goal:** render a captured pane's ANSI grid to a PNG via an external renderer, behind `ProcessService`, presence-as-capability.
- **Requirements:** R20.
- **Dependencies:** none.
- **Files:** new `src/services/tmux/pane-renderer.ts` (or extend `TmuxService` with `screenshotPane`); wire through `src/services/tmux/real-tmux-service.ts`. Renderer subprocess goes through `src/services/process/process-service.ts` (no `Bun.spawn` outside the process service).
- **Approach:** `screenshotPane({ socket, target }) → capturePane({ escapeCodes: true })`, then `ProcessService.spawn(['freeze', ...])` writing the ANSI on stdin and reading PNG bytes from stdout. Detect renderer presence once (probe `freeze` on PATH); absent/error → return `undefined` so the classifier stays text-only. Keep PNGs small (pane-geometry/scale handling) per the requirements OQ.
- **Patterns to follow:** mirror `capturePane`/`sendKeys` shape on `TmuxService` (`tmux-service.ts:201–293`); branded `Path`/`SocketName`/`PaneId` types; no side effects at import.
- **Test scenarios:** `screenshotPane returns PNG bytes when the renderer is present` (mocked `ProcessService`); `screenshotPane returns undefined and does not throw when the renderer binary is missing` (Covers the R20 degrade path).
- **Verification:** unit test against a fake `ProcessService`; manual Tier-1 smoke renders a real pane if `freeze` is installed (auto-skipped otherwise).

### U2. Interactive staleness monitor

- **Goal:** a per-interactive-step background task that detects silence by wall-clock since last activity and triggers classification.
- **Requirements:** R19.
- **Dependencies:** none.
- **Files:** new `src/hosts/two-pane/interactive-monitor.ts`; consumed from `src/hosts/two-pane/tmux-host.ts` interactive wait path (~:1169–1217).
- **Approach:** loop every `POLL` (sampling cadence, default e.g. 15 s): `cap = capturePane` via `PaneQueue`; if `cap !== lastCap` → `lastActivityAt = clock.now()`, `lastCap = cap`, continue; if `clock.now() − lastActivityAt ≥ STALE_THRESHOLD` (default 10 min) → emit a `stale` trigger carrying the latest capture; if classifier says `working`/`idle-done`, reset `lastActivityAt` (do **not** poke) and continue. Inject `Clock` (fake-clock testable, R17). `POLL` and `STALE_THRESHOLD` are independent config.
- **Patterns to follow:** the existing background-poll shape in `awaitInteractivePaneExit` (`tmux-host.ts:207–239`) — concurrent task, `settled` guard, `Promise.race` against the primary wait (KTD-6).
- **Test scenarios:** `a pane whose capture changes every poll never reaches the staleness threshold` (Covers AE8); `a pane silent past the threshold fires exactly one stale trigger`; `any fresh capture after a near-miss resets lastActivityAt`; `the poll interval and the threshold are honored independently` (fake clock).
- **Verification:** unit tests with fake `Clock` + fake `TmuxService` capture sequence; Tier-1 real-tmux with the scripted-fake runner emitting silence.

### U3. State classifier (`working` / `idle-done` / `waiting-for-input` / `error`)

- **Goal:** map a capture into exactly one state, leading with local heuristics, escalating to a different-provider judge only when ambiguous, defaulting safe (decline to poke).
- **Requirements:** R21, R22 (and R20 escalation).
- **Dependencies:** U1 (for PNG escalation; degrades to text-only without it).
- **Files:** new `src/hosts/two-pane/state-classifier.ts` (standalone, no runner/provider import in core); optional `StateJudge` port in the same module with a default no-op judge.
- **Approach:** text heuristics first — concrete signals only: a visible menu/prompt → `waiting-for-input`; a known error string (e.g. `API Error: 5xx`, "Overloaded") → `error`; a spinner/frame unchanged across the two latest captures with no prompt → `working`; an idle composer with no entered text and no prompt → `idle-done`. **Ignore placeholder/ghost composer text** (R21). On ambiguity, optionally call `StateJudge` (cross-provider, R22); if no judge configured, return `working` (safe default — never poke a possibly-live session). The judge receives text and, when present, the PNG from U1.
- **Patterns to follow:** pure function + injected port; deterministic; no LLM dependency in the default path.
- **Test scenarios:** `an advancing spinner with no prompt classifies as working`; `an idle composer with ghost placeholder text classifies as idle-done, not waiting-for-input` (Covers AE9); `a visible permission menu classifies as waiting-for-input`; `an API-error banner classifies as error`; `an ambiguous capture with no judge configured falls back to working (declines to poke)` (Covers R22 safe default).
- **Verification:** table-driven unit tests over canned captures; no network in the default path.

### U4. Claude `StopFailure` payload channel

- **Goal:** turn the existing signal-only Claude stop hook into a typed terminal-error signal carrying `{error, error_details, last_assistant_message, session_id}`, and map the enum to the branch-A classified error.
- **Requirements:** R18.
- **Dependencies:** none (Claude-only).
- **Files:** extend `src/runners/claude/claude-runner.ts:109–193` (the `mergeStopHooks` / `prepareClaudeAutoStop` block); add a payload-writing hook command + a watcher the monitor consumes. Map enum → classified error in the Claude runner's `classify` (the method branch A declares).
- **Approach:** today the hook is signal-only (`tmux ... wait-for -S "$ORCH_STOP_CHANNEL"`, registered for `Stop` + `StopFailure`). Extend the `StopFailure` arm to first write the hook's JSON payload to a per-run path orch watches, then signal. The watcher parses `error` (typed enum) → classified error via the same numeric-status-first discipline as headless (R5/R12: trust `error_status`, treat the string label as a hint). `Stop` stays signal-only (it is auto-stop, not an error). Transient retries remain hook-invisible and are covered only by U2's staleness path.
- **Patterns to follow:** the existing `AUTO_STOP_HOOK_EVENTS`/`mergeStopHooks` merge that never clobbers user hooks; per-run artifact + cleanup in `prepareClaudeAutoStop`.
- **Test scenarios:** `a StopFailure payload with server_error maps to the overload/server_error class`; `Stop without failure does not produce an error signal`; `the payload watcher tolerates a malformed/partial write` (Covers AE10 detection half).
- **Verification:** unit test the enum→class mapping and payload parse; mocked-edge integration through the runner port.

### U5. Interactive recovery wiring (send-keys act, fork underneath)

- **Goal:** invoke branch A's `backoff-resume` strategy from the interactive path with `detect = monitor/StopFailure` and `act = sendKeys`, fork happening underneath.
- **Requirements:** R23 (reuses R7, R8, R9, R10, R13 from branch A).
- **Dependencies:** U2, U3, U4, and branch A's strategy seam.
- **Files:** `src/hosts/two-pane/tmux-host.ts` interactive wait path; a small interactive-act adapter (new, host-layer) that the strategy calls.
- **Approach:** when U2/U4 yield `error` or `waiting-for-input`, call the strategy. The act callback: for `error` → `forkResume(checkpoint)` (Claude `--fork-session`; Codex emulated copy, degrade to resume-in-place per R11a) → respawn the pane onto the forked session → `sendKeys` exactly one nudge ("You were interrupted by an error. Continue your work."); for `waiting-for-input` → `sendKeys` the dismiss key, no fork. Progress (runner `isProgress` after resume — Claude assistant/tool-use, Codex `item.*`) resets the counter and advances the checkpoint; the give-up envelope and legible summary are branch A's. No-stacking holds because each `error` attempt branches from the checkpoint. All pane ops route through `PaneQueue` (KTD-6).
- **Patterns to follow:** `racePaneExitVsStop` concurrency (`tmux-host.ts:1199`); `ResumeRegistry` (`src/core/resume-registry.ts:23–26`) to resolve the runner for respawn; presence-as-capability guards for `forkResume`.
- **Test scenarios:** `an error verdict forks the clean checkpoint, sends exactly one nudge, and resets on the first progress event — the pane shows a single nudge, not a stack` (Covers AE10 remediation half, mirrors AE1 for interactive); `a waiting-for-input verdict sends the dismiss key without forking`; `consecutive no-progress forked attempts give up at the ceiling with a recovery summary` (reuses branch-A AE2 path through the interactive act); `a runner lacking forkResume degrades to resume-in-place with no-stacking`.
- **Verification:** Tier-1 real-tmux + scripted-fake runner + fake clock driving the full monitor→classify→act loop; assert the visible pane content (single nudge) — Tier-2/Tier-1 per the two-pane testing strategy.

### U6. Persistence + legibility for interactive attempts

- **Goal:** record interactive recovery attempts in the per-step recovery log and emit a lifecycle event family.
- **Requirements:** R16 (extends branch A), R15 legibility.
- **Dependencies:** U5.
- **Files:** `src/state/state-store.ts` (`StepEntry.recoveryAttempts` if branch A has not already added it; otherwise add an `via: 'send-keys'` discriminator); lifecycle events documented in `docs/logging.md` (new `interactive-recovery-armed` / `-attempted` / `-progressed` / `-gave-up` family alongside `interactive-auto-stop-*`).
- **Approach:** on each interactive attempt append `{ errorClass, waitMs, forkSessionId, outcome, via: 'send-keys' }` to `recoveryAttempts`; mirror to `lifecycle.ndjson`. The give-up summary (branch A R15) already states recovered-count / class / total time — Phase 2 just ensures the interactive attempts feed the same store (KTD-4).
- **Patterns to follow:** append-only NDJSON via the session logger; `validations`-array shape on `StepEntry`.
- **Test scenarios:** `each interactive attempt appends one recoveryAttempts entry survivable across a fork-resume sidecar truncation`; `the give-up summary reflects interactive attempts`.
- **Verification:** unit test the state mutation; assert `lifecycle.ndjson` lines in a Tier-1 run.

### U7. Tests (deterministic + behavioral)

- **Goal:** prove the interactive loop deterministically and confirm the visible pane behavior.
- **Requirements:** R17 (reused), plus AE8/AE9/AE10.
- **Dependencies:** U2–U6.
- **Files:** unit tests beside each module; Tier-1 real-tmux harness (`tests/helpers/real-tmux/`) for the end-to-end loop.
- **Approach:** reuse branch A's fake-clock + scripted-fake runner (no real waits) for the strategy edges; add interactive-specific cases — `working`/`idle-done` never poked (AE8, AE9), `error`→fork+single-nudge+reset (AE10), no-nudge-stacking, give-up-on-ceiling, give-up-on-wall-clock, classifier safe-default-when-ambiguous, screenshot-absent degrade, Codex fork-copy-failure → resume-in-place. Apply the two-pane triage rule: any test that would still pass with an empty/wrong pane is demoted or deleted.
- **Patterns to follow:** "mock only at the edge" — fakes via `*Service` / runner ports only; no `mock.module` inside `src/core`, `src/state`, `src/runners`.
- **Verification:** `bun run check` green; Tier-1 suite green (watch for the known leaked-puppet-daemon flakiness — see memory `real-tmux-suite-flakiness-root-cause`).

---

## System-Wide Impact

| Surface | Change | Risk |
| --- | --- | --- |
| `TmuxService` / `real-tmux-service.ts` | + `screenshotPane()` (optional capability) | Low — additive |
| `src/hosts/two-pane/` | + `interactive-monitor.ts`, `state-classifier.ts`, interactive-act adapter; monitor raced into the existing wait path | Medium — touches the interactive wait loop |
| `Runner` interface | interactive `classify` path consumes branch-A's optional methods; no new *required* methods | Low — presence-as-capability |
| `claude-runner.ts` | `StopFailure` hook gains a payload write (still never clobbers user hooks) | Low–Medium — extends a shipped hook |
| `state-store.ts` (`StepEntry`) | + `recoveryAttempts` (shared with branch A) / `via` discriminator | Low — additive field, no schema bump needed |
| `docs/logging.md`, public docs | new `interactive-recovery-*` lifecycle family; reconcile any public API surface if `screenshotPane` is exported | Low |
| `ProcessService` | new caller (`freeze`); no API change | Low |

---

## Risk Analysis & Mitigation

- **R-A — Branch A wires the act primitive too tightly to headless fork.** If the `backoff-resume` strategy hard-codes the headless fork as its act, U5 cannot inject send-keys cleanly. *Mitigation:* the [Dependency](#dependency-on-branch-a-the-shared-backoff-resume-seam) section makes the injectable-act contract explicit; if absent, U5 carries a small extract-the-act-seam refactor (still inside branch A's strategy module, behind its tests).
- **R-B — Classifier false-positive pokes a live session.** A mis-read could nudge a working agent. *Mitigation:* three-way discipline with a **safe default** (ambiguous → `working`, decline to poke, KTD-2); spinner-unchanged check requires two captures; AE8/AE9 are explicit regression tests.
- **R-C — Cross-provider judge unavailable or shares the failure mode.** *Mitigation:* judge is opt-in behind a port; default ships heuristics-only with the safe default — no judge means no poke on ambiguity, never a wrong poke.
- **R-D — `freeze` renderer absent on host.** *Mitigation:* presence-as-capability; classifier stays text-only (KTD-3); no hard dependency.
- **R-E — Monitor races the right-pane controller for the pane.** *Mitigation:* every pane op through `PaneQueue.enqueue`; monitor only *adds* a trigger, never replaces the pane-exit/auto-stop wait (KTD-6).
- **R-F — Sidecar truncation loses the recovery record across a fork.** *Mitigation:* recovery log lives in `StepEntry`, not the sidecar (KTD-4).
- **R-G — Tier-1 suite flakiness from leaked puppet daemons.** *Mitigation:* known issue (see memory); ensure each interactive test tears down its monitor task and pane.

---

## Scope Boundaries

**In scope (branch B / Phase 2):** staleness monitor (R19), state classifier with safe default (R21, R22), `screenshotPane()` text→PNG escalation (R20), Claude `StopFailure` payload channel (R18), send-keys remediation reusing the shared strategy (R23), interactive recovery-log entries + lifecycle events (R16/R15 extension), deterministic + Tier-1 behavioral tests (R17).

**Deferred for later:**
- A mandatory cross-provider LLM judge (ships opt-in; default is heuristics-only).
- Vendoring a PNG renderer (depends on external `freeze` at runtime).
- Waiting-until-reset on `rate_limit` / `usage_limit` (v1 + v2 both fail fast and surface the reset time).

**Explicitly not done:**
- The headless recovery loop, strategy object, classified-error type, fork primitives, and give-up envelope — those are **branch A (Phase 1)** and a hard dependency here.
- Recovery for non-agent steps (`command` steps, validators).
- Driving Codex through an app-server transport for a typed fork RPC.

---

## Verification

- A Codex interactive step silent past the staleness threshold is classified and, if `error`, recovered via fork + single send-keys nudge, then resumes — no human intervention (the F2 success criterion).
- A long-running interactive pane (output changing) is **never** classified or poked (AE8); an idle done composer is `idle-done` and left alone (AE9).
- A Claude interactive `StopFailure` with `server_error` forks and nudges via send-keys under the same envelope as headless (AE10); the visible pane shows a single nudge, never a stack.
- A genuinely-down server cannot hold an interactive run past the give-up envelope; the failure summary states recovered-count, class, and total time (branch A R15).
- `bun run check` green; Tier-1 real-tmux suite green; `bun run docs:build` green after the logging/public-docs reconciliation.
