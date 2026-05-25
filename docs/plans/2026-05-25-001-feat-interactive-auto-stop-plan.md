---
date: 2026-05-25
type: feat
status: completed
title: "feat: Interactive auto-stop for finished agent turns"
origin: docs/brainstorms/2026-05-25-feat-interactive-auto-stop-brainstorm.md
research: docs/brainstorms/2026-05-25-interactive-auto-stop-research.md
depth: deep
---

# feat: Interactive auto-stop for finished agent turns

## Summary

Add an opt-in `autoStop` boolean to interactive steps. When set, orch injects a per-run, signal-only hook into the agent CLI (Claude `Stop` + `StopFailure`; Codex `notify` on `agent-turn-complete`) whose sole effect is to ping orch over a tmux `wait-for` channel when the agent finishes a turn. orch — which already owns the tmux pane — races that channel against the existing `pane-exit` wait and terminates the pane externally (clean exit attempt, then the existing kill-session teardown as fallback). This removes the one failure mode that stalls an unattended interactive pipeline: a finished-but-idle step that waits forever for a human.

This is **signal-only auto-stop**. The known residual hang (Claude bug #29881: silent stop with no hook event) is explicitly out of scope and named as a follow-up watchdog (see origin: `docs/brainstorms/2026-05-25-feat-interactive-auto-stop-brainstorm.md`, F2 / Scope Boundaries).

---

## Problem Frame

orch's interactive host runs the real agent TUI inside a tmux pane and waits on `pane-exit-<paneId>` with **no timeout** (`src/hosts/two-pane/tmux-host.ts:1137-1140`) — deliberately, so a human can pause an agent for arbitrarily long. An interactive agent session never ends on its own: both Claude and Codex return to an idle prompt after a turn and wait for input, and neither CLI can self-terminate from a hook (closed "not planned" twice upstream — see research §0). So today every interactive step must be closed by hand. In an unattended hours-long pipeline, one finished step stalls everything.

The fix the research establishes as non-negotiable: **the hook is a completion *signal*; orch performs the *termination* externally** because it owns the pane.

---

## Requirements Traceability

Carried from the origin requirements doc (`docs/brainstorms/2026-05-25-feat-interactive-auto-stop-brainstorm.md`). Each requirement maps to the unit(s) that advance it.

| Req | Summary | Units |
| --- | --- | --- |
| R1 | `autoStop` boolean on interactive steps, default `false`, no new `StepMode` | U1 |
| R2 | Opt-in per step; flows through existing config path; **fail fast** when runner can't support it | U1, U4 |
| R3 | Injected hook is signal-only — no termination, no state mutation, no behavior-altering output | U2, U3 |
| R4 | Claude: register `Stop` + `StopFailure`. Codex: `notify` for `agent-turn-complete` | U2, U3 |
| R5 | Hook command generated inline per run — **no shipped/installed/versioned hook script** | U2, U3 |
| R6 | Claude injection via per-run `.claude/settings.local.json` in cwd; never clobbers user hooks | U2 |
| R7 | Codex injection via per-run `CODEX_HOME` temp dir inheriting real `~/.codex`; real config/auth untouched | U3 |
| R8 | Socket + stop-channel identifiers passed via env-merge; hook reads them from inherited env | U4, U5 |
| R9 | Per-run injected artifacts cleaned up after the step; cleanup never touches real config/creds | U2, U3, U4 |
| R10 | Race the stop channel against `pane-exit`, replacing the unconditional infinite wait | U5 |
| R11 | On signal, terminate the pane — clean shutdown preferred, hard kill as bounded fallback | U5 |
| R12 | Auto-stop lifecycle observable in `lifecycle.ndjson` (setup, signal, termination path) | U5, U6 |

Acceptance Examples (AE1–AE6) are mapped onto test scenarios in the units below via the `Covers AE<N>` convention.

---

## High-Level Technical Design

> This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.

**Responsibility split** (origin Key Decisions): the *runner adapter* knows how to register its CLI's stop hook; the *tmux host* owns the socket, channel, and pane termination. No concrete-runner knowledge leaks into core.

```
 workflow author        executor (core)            runner adapter            tmux host
 ───────────────        ───────────────            ──────────────            ─────────
 mode:'interactive'  →  reads config.autoStop
 autoStop:true          guard: runner has
                        prepareAutoStop? ──fail-fast (AE5) if absent
                        ctx.autoStop=true  ──────→  buildCommand(ctx)
                        prepareAutoStop(ctx) ─────→ writes inline hook
                                                    referencing $ORCH_SOCKET
                                                    /$ORCH_STOP_CHANNEL;
                                                    returns {env, cleanup}
                        merge env; pass
                        {argv,env,autoStop,
                         cleanup} ────────────────────────────────────────→ runInteractive(spawn)
                                                                              alloc channel
                                                                              auto-stop-<paneId>;
                                                                              inject ORCH_SOCKET +
                                                                              ORCH_STOP_CHANNEL;
                                                                              register+show pane;
                                                                              race(pane-exit,
                                                                                   stop-channel)
                            agent finishes turn → Stop/notify hook fires →
                            tmux -S $ORCH_SOCKET wait-for -S $ORCH_STOP_CHANNEL ───────────────┐
                                                                              stop-channel wins ◄┘
                                                                              clean exit (EOF) +
                                                                              bounded wait, then
                                                                              unregisterSource
                                                                              (kill-session);
                                                                              cleanup(); emit
                                                                              lifecycle events
```

**Why an optional `prepareAutoStop` method, not a `buildCommand` branch** (resolves origin Outstanding Question on R2 capability shape): the codebase already expresses optional runner capability as *method presence* (`resumeCommand`, `captureSessionId` — `src/runners/types.ts:127-147`), and the executor checks `typeof runner.x === 'function'`. This gives R2's fail-fast for free and is the established convention. It also returns a `cleanup` handle that `buildCommand`'s `{argv, env}` return cannot express (R9). The hook only references env-var *names*; the host injects the actual socket/channel values at spawn, so `prepareAutoStop` needs no values from the host.

**Transport decision** (resolves origin Outstanding Question on R10): tmux `wait-for` channel is the **primary** transport — it reuses orch's existing `signalChannel`/`waitFor` primitive (`src/services/tmux/tmux-service.ts:469-472`) and the existing race-on-`pane-exit` structure. The file sentinel is documented as the fallback only; it is **not implemented this iteration**. The host arms the wait before the agent does any work, and the agent runs a full turn before its hook fires, so the "signal arrives before orch is waiting" race window is negligible. Verifying this is a smoke-test item (see Risks).

**Termination decision** (resolves origin Outstanding Question on R11): on the stop signal, attempt a clean exit by sending EOF (`Ctrl-D`) to the pane and bounded-waiting on `pane-exit-<paneId>` (a few seconds). Because sessions run with `remain-on-exit on`, a clean agent exit fires the `pane-died` hook and resolves the `pane-exit` branch naturally. If the bounded wait elapses, fall through to the **existing** `controller.unregisterSource` teardown (idempotent `kill-session`) in the `finally` block — no new kill mechanism is invented (per learning: reuse `teardownSourceSession`).

---

## Output Structure

No new directory hierarchy. All work modifies existing files plus two new test files. Per-unit `**Files:**` are authoritative.

---

## Key Technical Decisions

- **Flag, not a new `StepMode`.** `autoStop?: boolean` on `AgentStepConfig` / `InteractiveStepInput`, default `false`. Autonomous steps self-terminate, so `autoStop:true` on a non-interactive step is a definition-time error (mirrors the existing `returns`-in-interactive guard at `src/core/step.ts:167-172`).
- **Capability = optional method.** New `Runner.prepareAutoStop?(ctx) => Promise<AutoStopPreparation>` where `AutoStopPreparation = { env: Record<string,string>; cleanup: () => Promise<void> }`. Capability check is `typeof runner.prepareAutoStop === 'function'`. Added to `RunnerAdapterSchema` as `.optional()`.
- **Claude needs an `fs` dep.** `claude()` currently takes no deps; `codex()` already takes `deps: {fs, ps}`. Give `claude()` an `fs` dep so `prepareAutoStop` can write `.claude/settings.local.json`. This keeps hook-file writing inside the runner adapter (where CLI-specific knowledge belongs) rather than leaking it into core.
- **Codex injection needs `FsService.symlink`.** The `CODEX_HOME` strategy symlinks the real `~/.codex` except `config.toml`. `FsService` has no `symlink` today — add it to the port (+ Bun adapter + fake). `--profile-v2` overlay is the documented alternative if symlinking proves problematic (smoke-test item).
- **Env injection via the `extras` slot.** `ORCH_SOCKET`/`ORCH_STOP_CHANNEL` (host-injected) and `CODEX_HOME` (runner-injected) ride the `extras` layer of `mergeEnv(processEnv, extras, ctxEnv)` (`src/services/process/merge-env.ts:26-38`), exactly like the existing `{ FORCE_COLOR: '3' }`.
- **Interactive still returns `exitCode: 0`.** A hook-driven turn completion is a clean finish; the host's unconditional `exitCode: 0` (`tmux-host.ts:1216-1219`) stays consistent. Real exit-code capture is separately out of scope (origin Scope Boundaries).

---

## Implementation Units

```
U1 (config + contract) ──┬─→ U2 (Claude inject) ──┐
                         ├─→ U3 (Codex inject) ───┤
                         └─→ U4 (executor wiring) ─┴─→ U5 (host race + terminate) ─→ U6 (telemetry + docs)
                                                                                       │
                              U1..U6 ───────────────────────────────────────────────→ U7 (real-tmux integration)
```

### U1. Config surface, runner contract, and fail-fast error

**Goal:** Land the `autoStop` author surface, the `prepareAutoStop` runner capability contract, the new error type, and FakeRunner support — the foundation every other unit builds on.

**Requirements:** R1, R2 (config + capability shape).

**Dependencies:** none.

**Files:**
- `src/core/step.ts` — add `readonly autoStop?: boolean` to `AgentStepConfig` and `InteractiveStepInput`; add a `defineStep` guard rejecting `autoStop:true` when `mode !== 'interactive'`.
- `src/core/types.ts` — (verify) no change needed beyond `StepMode`; `autoStop` lives on the step config, not `StepMode`.
- `src/runners/types.ts` — add `RunnerContext.autoStop?: boolean`; add optional `Runner.prepareAutoStop?(ctx) => Promise<AutoStopPreparation>`; export `AutoStopPreparation` interface (`{ env: Readonly<Record<string,string>>; cleanup: () => Promise<void> }`). Add `prepareAutoStop` to `RunnerAdapterSchema` as `.optional()` `z.custom(...)`.
- `src/core/errors.ts` — add `AutoStopUnsupportedError(stepName, runnerName)` mirroring `RunnerCapabilityError` (`src/core/errors.ts:43-54`).
- `src/runners/fake-runner.ts` (or wherever `FakeRunner` lives) — add a no-op `prepareAutoStop` returning `{ env: {}, cleanup: async () => {} }`; add a constructor option (e.g. `{ supportsAutoStop?: boolean }`, default `true`) that omits the method when `false`, so tests can exercise the unsupported path.
- `tests/unit/core/step.test.ts`, `tests/unit/core/errors.test.ts` (or co-located) — see scenarios.

**Approach:** `autoStop` is a plain optional boolean carried alongside `mode`. The `defineStep` guard fails at definition time (cheapest fail-fast). The runner contract addition is interface + Zod-schema only; concrete implementations land in U2/U3. `AutoStopUnsupportedError` message should be long and actionable (codebase convention, see `AskNoDefaultError`), naming the step and runner and pointing at the fact that Claude/Codex support it.

**Patterns to follow:** `returns`-in-interactive guard (`src/core/step.ts:167-172`); `resumeCommand` optional-method capability doc (`src/runners/types.ts:122-131`); `RunnerCapabilityError` (`src/core/errors.ts:43-54`).

**Test scenarios:**
- `step.define` with `mode:'interactive', autoStop:true` produces a config carrying `autoStop:true`. **Covers AE2 (setup).**
- `step.define` with `mode:'interactive'` and no `autoStop` defaults to `autoStop` absent/`false` — behavior unchanged. **Covers AE1.**
- `step.define` with an autonomous step and `autoStop:true` throws a definition-time error naming the step.
- `AutoStopUnsupportedError` constructs with the expected `name`, message containing the step and runner names, and is `instanceof Error`.
- `FakeRunner` default instance exposes `prepareAutoStop` as a function; `new FakeRunner(fps, { supportsAutoStop: false })` omits the method (`typeof === 'undefined'`). **Covers AE5 (setup).**

**Verification:** `bun run check` green; `defineStep` rejects the bad combination; FakeRunner can be constructed in both capability states.

---

### U2. Claude `Stop` + `StopFailure` hook injection

**Goal:** Implement `prepareAutoStop` on the Claude runner: write a per-run, merge-safe `.claude/settings.local.json` in cwd containing only the signal-only `Stop` and `StopFailure` hooks, and a cleanup that restores the prior state.

**Requirements:** R3, R4 (Claude), R5, R6, R9 (Claude).

**Dependencies:** U1.

**Files:**
- `src/runners/claude/claude-runner.ts` — add `fs: FsService` to the `claude()` factory deps; implement `prepareAutoStop(ctx)`.
- `tests/unit/runners/claude/claude-auto-stop.test.ts` (new) — FakeFsService-backed.

**Approach:** The hook command is the inline one-liner `tmux -S "$ORCH_SOCKET" wait-for -S "$ORCH_STOP_CHANNEL"` registered under both `Stop` and `StopFailure` (research §1.5). `prepareAutoStop`:
1. Resolve `<cwd>/.claude/settings.local.json` via `path(...)`; `fs.mkdir(<cwd>/.claude, {recursive:true})`.
2. If the file exists, read + parse it, **merge** the two hook entries into any existing `hooks` (do not clobber the user's hooks); remember the original content for restore.
3. Write the merged JSON **before launch**.
4. Return `{ env: {}, cleanup }` — Claude reads the file from cwd, so no env additions are needed. `cleanup` restores the original file content (or removes the file if none existed), and never touches `~/.claude`.

`prepareAutoStop` does not need the socket/channel values — the hook references the env-var names the host injects at spawn (U5).

**Patterns to follow:** Codex's async-file-write-in-`buildCommand` precedent (`src/runners/codex/codex-runner.ts:253-258`); branded `Path` via `path(...)`; the `--settings` denylist stays intact — we write a cwd file, not pass a flag (research §1.5, confirms this dodges the denylist).

**Test scenarios:**
- With no pre-existing `.claude/settings.local.json`, `prepareAutoStop` writes a file containing `Stop` and `StopFailure` hooks whose command is exactly the `tmux ... wait-for -S "$ORCH_STOP_CHANNEL"` one-liner. **Covers R4, R5.**
- With a pre-existing `.claude/settings.local.json` carrying a user `PreToolUse` hook, after `prepareAutoStop` the file still contains the user's hook plus the two injected hooks (no clobber). **Covers R6.**
- The hook command contains no termination verb and no stdout-producing side effect beyond the signal. **Covers R3.**
- `cleanup()` with no pre-existing file removes the written file; `cleanup()` with a pre-existing file restores its original bytes; neither touches any `~/.claude` path. **Covers R9, AE4.**
- The file is written before `prepareAutoStop` resolves (write-before-launch ordering).

**Verification:** Unit tests pass against `FakeFsService`; injected JSON is valid and merge-safe; cleanup is a true inverse.

---

### U3. Codex `notify` injection via per-run `CODEX_HOME`

**Goal:** Implement `prepareAutoStop` on the Codex runner: build a temp `CODEX_HOME` that inherits the real `~/.codex` (symlinks, including `auth.json`) except a copied `config.toml` with one appended `notify` line, return `CODEX_HOME` in env, and clean up only the temp dir.

**Requirements:** R3, R4 (Codex), R5, R7, R9 (Codex).

**Dependencies:** U1. Adds `FsService.symlink` (shared with no other unit — owned here).

**Files:**
- `src/services/fs/fs-service.ts` — add `symlink(target: Path, linkPath: Path): Promise<void>` to the port.
- `src/services/fs/bun-fs-service.ts` — implement via Bun/node `fs.symlink`.
- `src/services/fs/fake-fs-service.ts` — implement an in-memory symlink (track link→target; `exists`/`readDir` honor it as needed for tests).
- `src/runners/codex/codex-runner.ts` — implement `prepareAutoStop(ctx)` using `deps.fs`.
- `tests/unit/runners/codex/codex-auto-stop.test.ts` (new); `tests/unit/services/fs/symlink.test.ts` (new, for the port addition).

**Approach** (research §2.4):
1. `realCodexHome = ctx.env.CODEX_HOME ?? <HOME>/.codex` (resolve via env).
2. `runCodexHome = await fs.tempDir('orch-codex')`.
3. For each entry in `realCodexHome` (`fs.readDir`), `fs.symlink(entry, runCodexHome/<name>)` — **except** `config.toml`.
4. Copy `config.toml` content (if present) into `runCodexHome/config.toml`, then append the `notify` line: `notify = ["bash", "-lc", "tmux -S \"$ORCH_SOCKET\" wait-for -S \"$ORCH_STOP_CHANNEL\""]`.
5. Return `{ env: { CODEX_HOME: runCodexHome }, cleanup: () => fs.remove(runCodexHome) }`. Removing the temp dir drops only symlinks + the copied config — never the real `~/.codex`.

`CODEX_HOME` is an env var (not the denylisted `-c`/`--config`), so it passes orch's Codex denylist (research §2.1, §2.4).

**Patterns to follow:** `codex()` already takes `deps:{fs,ps}` and writes temp files in `buildCommand` (`src/runners/codex/codex-runner.ts:253-258`); `fs.tempDir` + branded `path(...)`.

**Test scenarios:**
- `prepareAutoStop` creates a temp dir, symlinks every real-home entry except `config.toml`, and writes a `config.toml` copy whose tail is the `notify = [...]` line referencing `$ORCH_SOCKET`/`$ORCH_STOP_CHANNEL`. **Covers R4, R5, R7.**
- `auth.json` is present in the temp home as a symlink to the real one (auth inheritance). **Covers R7, AE4.**
- Returned env contains `CODEX_HOME` pointing at the temp dir; the real `~/.codex/config.toml` content is never written to. **Covers R7, AE4.**
- The `notify` command is signal-only (no termination, no state mutation). **Covers R3.**
- `cleanup()` removes the temp dir and only the temp dir; the real home entries remain. **Covers R9.**
- `FsService.symlink` creates a link that `exists()` reports true and that resolves to the target (port-level test).

**Verification:** Unit tests pass against `FakeFsService`; `symlink` lands in port + both adapters; real config/auth never mutated.

---

### U4. Executor wiring: thread `autoStop`, fail-fast, prepare, flow cleanup

**Goal:** In the interactive executor, read `config.autoStop`, fail fast when the runner can't support it, thread `autoStop` into the `buildCommand` context, invoke `prepareAutoStop`, merge its env, and pass `autoStop` + the `cleanup` handle to the host.

**Requirements:** R2 (fail-fast), R8 (env plumbing), R9 (cleanup flow).

**Dependencies:** U1. Behaviorally exercised once U2/U3 land, but only depends on the U1 contract.

**Files:**
- `src/core/workflow.ts` — in `runInteractiveStep` (`src/core/workflow.ts:373-573`): read `config.autoStop`; guard `autoStop && typeof agent.prepareAutoStop !== 'function'` → `throw new AutoStopUnsupportedError(...)` before spawn; set `autoStop` on the `buildCommand` ctx (`:477-484`); `await agent.prepareAutoStop(ctx)` when present; merge the returned `env` into the spawn env; pass `autoStop` + `cleanup` on the `InteractiveSpawn` (`:487-492`).
- `src/hosts/host.ts` — extend `InteractiveSpawn` (`src/hosts/host.ts:49-69`) with `readonly autoStop?: boolean` and `readonly onCleanup?: () => Promise<void>`.
- `tests/unit/core/workflow-auto-stop.test.ts` (new) or extend existing executor tests.

**Approach:** The guard runs before any spawn so AE5 is a clean pre-flight failure. `prepareAutoStop` runs after `buildCommand` (or independently — it only needs `ctx`); its `env` is merged into the command env the host receives. The `cleanup` handle is handed to the host so it runs in the host's `finally` regardless of how the step ends (signal, manual close, error). Keep functions ≤60 lines — extract an `prepareAutoStopForStep(...)` helper if `runInteractiveStep` would exceed the limit.

**Patterns to follow:** existing capability guard (`src/core/workflow.ts:387-389`, `RunnerCapabilityError`); `buildCommand` ctx assembly (`:477-484`); lifecycle emit helpers (`emitStepLifecycle`, `logInteractiveSpawn`).

**Test scenarios:**
- An `autoStop:true` interactive step whose runner lacks `prepareAutoStop` throws `AutoStopUnsupportedError` before any host spawn call. **Covers AE5, R2.**
- An `autoStop:true` step with a supporting runner calls `prepareAutoStop` once and passes `autoStop:true` to `host.runInteractive`. **Covers R8.**
- The env returned by `prepareAutoStop` is merged into the `InteractiveSpawn.env` handed to the host. **Covers R7/R8 plumbing.**
- The `cleanup` handle is passed to the host (assert it appears on the spawn the fake host receives).
- An interactive step **without** `autoStop` never calls `prepareAutoStop` and spawns exactly as today. **Covers AE1.**

**Verification:** Executor unit tests (fake host + fake runner) pass; fail-fast precedes spawn; cleanup handle propagates.

---

### U5. tmux host: race `pane-exit` vs stop channel, clean termination, lifecycle

**Goal:** When the spawn is `autoStop`, allocate the stop channel, inject `ORCH_SOCKET`/`ORCH_STOP_CHANNEL`, race the stop channel against the existing `pane-exit` wait, terminate the pane on signal (clean exit then existing teardown fallback), run `onCleanup`, and emit lifecycle events.

**Requirements:** R8 (host-side env injection), R10, R11, R12 (emission).

**Dependencies:** U1, U4. This is the behavioral core.

**Files:**
- `src/hosts/two-pane/tmux-host.ts` — in `runInteractive` (right-pane branch, around `:1054-1219`): when `spawn.autoStop`, derive `channel = auto-stop-<hiddenPaneId>`, add `ORCH_SOCKET = deps.socket` and `ORCH_STOP_CHANNEL = channel` to the spawn env **before** `registerSource`; replace the lone `await deps.tmux.waitFor({pane-exit})` (`:1137-1140`) with a `Promise.race` of the `pane-exit` wait and a no-timeout `waitFor` on the stop channel; on stop-channel win, attempt clean exit (`deps.tmux.sendKeys` EOF) + bounded `waitFor({channel: pane-exit, timeoutMs})`, then proceed; run `spawn.onCleanup?.()` and emit lifecycle in the existing `finally`.
- `tests/integration/hosts/two-pane/tier-1/...` — covered in U7 (the real-tmux test); host-level argv/env contract may also get a Tier 3 unit test here.

**Approach:**
1. **Arm before work.** Inject env and arm both waits before/at `showSource` so orch is blocked on the channel long before the agent's hook can fire (closes the transport race — research §8 item 6).
2. **Race.** `Promise.race([waitFor(pane-exit), waitFor(stop-channel)])`. Track which won. A manual human close still resolves via `pane-exit` (AE1 path preserved for non-autoStop, and even autoStop tolerates manual close).
3. **Terminate on signal.** Emit `interactive-auto-stop-signaled`; `sendKeys` EOF to the hidden pane; bounded-wait `pane-exit` (a few seconds). Whether clean or timed-out, fall through to the existing `finally` `unregisterSource` (idempotent `kill-session`) — the kill fallback already exists. Emit `interactive-auto-stop-terminated` with `path: 'clean' | 'forced'`.
4. **Cleanup.** Call `spawn.onCleanup?.()` in `finally` (the runner's artifact cleanup), guarded so a cleanup failure is logged, not thrown.

**Patterns to follow:** existing `pane-exit` wait + `interactive-wait-*` lifecycle (`tmux-host.ts:1125-1149`); `buildPaneDiedCommand`'s `-L <socket>` requirement for run-shell tmux clients (`:96-104`); `appendLifecycleSoon`/`appendLifecycle` (`:711-717`); idempotent `unregisterSource` teardown (`:1182-1213`); `WaitForOptions.timeoutMs` (`src/services/tmux/tmux-service.ts:213-222`).

**Test scenarios:** (host behavior is proven deterministically in U7's Tier 1 test; these enumerate what that test and any host-unit tests must assert)
- With `autoStop:true`, the host injects `ORCH_SOCKET` and `ORCH_STOP_CHANNEL=auto-stop-<paneId>` into the spawn env before registering the source. **Covers R8.**
- When the stop channel is signaled (simulating the hook), the host attempts a clean exit then tears the pane down, and `runInteractive` resolves with `exitCode:0` — **without** the pane dying on its own first. **Covers AE2, R10, R11.**
- When the pane dies on its own (manual close / agent exits), the `pane-exit` branch wins and behavior is unchanged. **Covers AE1.**
- `onCleanup` runs in `finally` on both the signal path and the error path; a throwing `onCleanup` is logged, not propagated. **Covers R9.**
- Lifecycle records `interactive-auto-stop-armed`, `-signaled`, `-terminated` (with the path taken) are appended in order. **Covers R12.**

**Execution note:** Start from the U7 Tier 1 real-tmux test (it pins the user-visible outcome) and drive the host change to green.

**Verification:** U7 Tier 1 test green; race resolves on either branch; lifecycle events present; `bun run check` green.

---

### U6. Lifecycle telemetry schema + documentation, and CLAUDE.md drift fix

**Goal:** Define the auto-stop lifecycle event types in the schema, document them and the feature, and fix the known `merge-env` path drift in passing.

**Requirements:** R12 (schema + docs).

**Dependencies:** U5.

**Files:**
- `src/hosts/two-pane/tmux-host.ts` (or the lifecycle-event type module it imports) — add `interactive-auto-stop-armed | interactive-auto-stop-signaled | interactive-auto-stop-terminated` to the lifecycle event union/type.
- `docs/logging.md` — document the three events under the pane-map lifecycle section (`docs/logging.md:62-89`).
- `CLAUDE.md` — fix the env-merge path: it lives at `src/services/process/merge-env.ts` (re-exported via `src/services/index.ts`), **not** `src/runners/_shared/merge-env.ts`; there is no `src/runners/_shared/` directory (origin Dependencies/Assumptions).
- `.claude/skills/runner-author/SKILL.md` (if it repeats the wrong path) — same fix.

**Approach:** Telemetry slots into the existing `lifecycle.ndjson` append path; no new log file. The doc additions are short. The CLAUDE.md fix is a one-line correction flagged by the origin doc.

**Patterns to follow:** existing `interactive-*` event documentation in `docs/logging.md`.

**Test scenarios:** `Test expectation: none — documentation + type-union additions; the emission behavior is asserted in U5/U7. The type-union change is exercised by the compiler and the U5 lifecycle-ordering assertion.`

**Verification:** `bun run check` green (types compile); `docs/logging.md` lists the three events; CLAUDE.md path corrected.

---

### U7. Real-tmux integration test (Tier 1) + env-gated full-loop test (Tier 4)

**Goal:** Prove the host-side auto-stop loop on **real tmux** deterministically with a FakeRunner (Tier 1), and prove the full real-CLI loop end-to-end behind the env gate (Tier 4). The Tier 1 test is the mandated real-tmux integration test.

**Requirements:** R10, R11, R12 end-to-end; AE2.

**Dependencies:** U1–U6.

**Files:**
- `tests/integration/hosts/two-pane/tier-1/auto-stop.real.integration.test.ts` (new) — **the real-tmux integration test.**
- `tests/e2e/tier-4/auto-stop.real.e2e.test.ts` (new) — env-gated real-Claude full loop.

**Approach:**
- **Tier 1 (real tmux, FakeRunner, deterministic):** Use `createRealTmuxFixture` + `mountTmuxHost` with a `FakeProcessService` and a `FakeRunner` that supports auto-stop. Run an `autoStop:true` interactive step via `harness.runWorkflow`. The FakeRunner's "agent" cannot fire a real Claude hook, so **the test plays the hook's role**: after the pane is up, call the fixture's tmux `signalChannel({ socket, channel: 'auto-stop-<paneId>' })` to simulate turn completion. Assert that `runWorkflow` resolves (the step closes itself) and the source pane is torn down — **without** the test ever killing the pane or sending a manual close. Apply the triage rule: this would fail if the host never armed/raced the channel (the step would hang past the timeout).
- **Tier 4 (real Claude, env-gated):** `describe.skipIf(!canRunRealTmuxE2E('claude'))`. Real `claude()` runner, `autoStop:true`, a prompt that finishes a turn quickly. Assert the pane closes on its own (the real `Stop` hook fires the real signal) and the workflow resolves with no keystroke, within a generous timeout. This proves the inline-hook injection + real env inheritance + real `wait-for` transport that Tier 1's fake cannot.

**Patterns to follow:** Tier 1 skeleton (`docs/testing-strategy.md:32-59`, `tests/helpers/real-tmux/README.md`); `canRunRealTmux()` / `canRunRealTmuxE2E('claude')` gates; `afterEach` fixture/harness disposal; `right.waitForText` / `waitFor` bounded polling; promotion diff (`docs/testing-strategy.md:156-165`).

**Test scenarios:**
- **Tier 1:** an `autoStop:true` step on real tmux + FakeRunner closes itself when the stop channel is signaled, and the pane is torn down — the workflow resolves with no manual close. **Covers AE2, R10, R11.**
- **Tier 1:** lifecycle log for the run contains `interactive-auto-stop-signaled` and `interactive-auto-stop-terminated` (read via the harness `logger`/`stateStore`). **Covers R12.**
- **Tier 1 (control):** the same step **without** `autoStop`, when the FakeRunner pane stays alive, does **not** self-close on a stop-channel signal it never armed — i.e. non-autoStop ignores the channel. **Covers AE1.**
- **Tier 4 (env-gated):** a real Claude `autoStop:true` step finishes its turn and the pane closes on its own with no keystroke. **Covers AE2 end-to-end.**

**Execution note:** Tier 1 is the primary deliverable here and drives U5. Tier 4 is env-gated and developer-opt-in (`RUN_REAL_TMUX_E2E=1`); it auto-skips in normal CI.

**Verification:** `bun test tests/integration/hosts/two-pane/tier-1/auto-stop.real.integration.test.ts` green on a machine with tmux; Tier 4 green when run with `RUN_REAL_TMUX_E2E=1` and `claude` on PATH; both auto-skip otherwise.

---

## System-Wide Impact

| Surface | Change | Risk |
| --- | --- | --- |
| `src/core/step.ts`, `types.ts`, `errors.ts` | New optional flag + error; additive | Low |
| `src/runners/types.ts` | New optional method on the `Runner` port | Low — optional, third-party runners stay source-compatible |
| `src/runners/claude` | `claude()` gains an `fs` dep | **Medium** — call sites of `claude()` must supply `fs`; audit all constructions |
| `src/runners/codex` | New `prepareAutoStop` | Low |
| `src/services/fs` | New `symlink` port method (+ 2 adapters) | Low — additive port method |
| `src/core/workflow.ts` | New guard + prepare/cleanup wiring in `runInteractiveStep` | Medium — central executor path |
| `src/hosts/two-pane/tmux-host.ts` | The infinite wait becomes a race; new termination path | **Medium** — the file is already over 300 lines (documented); keep additions tight, consider extracting an `armAutoStop`/`terminateOnSignal` helper |
| `docs/logging.md`, `CLAUDE.md` | Doc updates | Low |

**Affected parties:** workflow authors (new opt-in flag), anyone constructing `claude()` directly (must pass `fs`), operators reading `lifecycle.ndjson` (three new event types).

---

## Risk Analysis & Mitigation

- **R-A — `claude()` gains a required `fs` dep, breaking existing call sites.** *Mitigation:* grep all `claude(` constructions (workflows, tests, fixtures) and update them in U2; `bun run check` (typecheck) catches every miss. Consider a defaulted dep (`fs = new BunFsService()`) only if call-site churn is large — but a real dep is cleaner and testable.
- **R-B — Transport race: hook signals before orch arms the wait.** *Mitigation:* host arms the channel wait before the agent does any work; the agent runs a full turn before its hook fires, so the window is negligible. **Smoke-test** that `wait-for -S` from the hook reaches orch reliably (research §8 item 6). File-sentinel fallback is documented but deferred — escalate only if the smoke test shows flakiness.
- **R-C — Stale-pane-id orphaning on the new kill path** (learning: `docs/findings/2026-05-25-issue-3-swap-pane-cant-find-pane.md`). Auto-stop terminates the *currently visible* source, so the existing `killHiddenSource` relocation guard (`currentKey === skey`) fires correctly — but verify the U7 Tier 1 test asserts the pane-ownership invariant, not just "didn't throw" (`FakeTmuxService.swapPane` does not validate panes).
- **R-D — Foreground-shutdown race trap** (learning: `docs/handovers/2026-05-20-q-and-ctrl-c-mid-step-handover.md`). The auto-stop termination must not get caught behind `await trackedWorkflow`. *Mitigation:* termination happens *inside* `runInteractive` and resolves the interactive wait, so the workflow advances normally; do not widen the foreground `quitDeferred` race to include auto-stop.
- **R-E — Codex slowness** (learning: `docs/handovers/2026-05-18-codex-capture-empty-timeout-handover.md`). Codex `/exit` takes ~10s and Codex is slow to first-write. *Mitigation:* prefer EOF over `/exit`; tie the clean-exit bounded wait to a generous timeout; rely on the kill-session fallback rather than assuming a fast clean exit.
- **R-F — Claude trust/hook-review prompt on a fresh cwd** (research §8 item 2). *Mitigation:* write `.claude/settings.local.json` before launch (already the host order); **smoke-test** whether a fresh/untrusted cwd retriggers a review prompt in the target Claude version.
- **R-G — `allowManagedHooksOnly` enterprise setting** would suppress injected hooks (research §8 item 3). *Mitigation:* out of scope to handle; document as an environment precondition; the F2-style hang would result (visible, not silent corruption).

---

## Scope Boundaries

Carried verbatim from the origin (`docs/brainstorms/2026-05-25-feat-interactive-auto-stop-brainstorm.md`).

**Deferred for later (named follow-ups):**
- **Idle + wall-clock watchdog** — the mechanism that closes the F2 / #29881 silent-stop hang. The explicit next step; not in this iteration.
- **Real exit-code capture for interactive steps** — orch reports `exitCode:0` unconditionally; auto-stop does not change this.
- **Transcript persistence / richer post-mortem artifacts for interactive steps** — separate work.

**Outside this product's identity / not pursued:**
- Disabling `AskUserQuestion` and permission-bypass/sandbox flags (already achievable via runner flags; orthogonal).
- Rendering a headless run as an interactive-looking view (the alternative direction, set aside).
- Sandboxing, network egress control, cost/rate-limit recovery, auth-expiry handling (real for hours-long autonomy; out of scope for auto-stop itself).

**Deferred to follow-up work (plan-local):**
- File-sentinel transport implementation — documented as the fallback; build only if R-B's smoke test shows the `wait-for` channel is unreliable.
- Real-CLI Tier 5 lifecycle variants for auto-stop — Tier 4 covers the full real loop; a Tier 5 signal-handler variant can follow if needed.

---

## Smoke Tests to Run During Implementation

From research §8 — verify against the installed Claude/Codex before relying on the mechanics:
1. `wait-for -S` from the injected hook reliably reaches orch when orch is already waiting (R-B).
2. Writing `.claude/settings.local.json` into a fresh cwd does not retrigger a trust/hook-review prompt (R-F).
3. `allowManagedHooksOnly` is not set in the target environment (R-G).
4. Codex `CODEX_HOME` symlink strategy works for the interactive TUI in the installed Codex version (or fall back to `--profile-v2`).
5. EOF (`Ctrl-D`) cleanly exits the idle interactive REPL and flushes the transcript.

---

## Verification (whole feature)

- A multi-step interactive workflow with `autoStop:true` runs end-to-end with no keystrokes on the happy path; each pane closes itself when the agent finishes (success criterion 1).
- The same flag works for Claude and Codex with no per-CLI knobs on the author surface (success criterion 2).
- After an auto-stop run, the user's `~/.claude` / `~/.codex` config and credentials are unchanged (success criterion 3; AE4).
- `bun run check` green: lint + typecheck + unit + mocked-integration.
- The Tier 1 real-tmux integration test passes on a tmux-equipped machine; the Tier 4 test passes under `RUN_REAL_TMUX_E2E=1` with `claude` on PATH.
- The F2 / #29881 hang is documented, observable, and named as the watchdog follow-up — not a silent surprise (success criterion 5).
