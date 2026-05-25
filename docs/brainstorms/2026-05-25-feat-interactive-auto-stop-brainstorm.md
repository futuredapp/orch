---
date: 2026-05-25
topic: interactive-auto-stop
---

# Interactive Auto-Stop

## Summary

Add a boolean `autoStop` flag to interactive steps. When set, orch injects a per-run, no-script hook into the agent CLI (Claude `Stop`/`StopFailure`, Codex `notify` on `agent-turn-complete`) whose only job is to signal orch over a tmux channel that the agent finished a turn; orch then terminates the pane externally. This is the first step toward "interactive UI, autonomous behavior" sessions — the part that stops a finished interactive session from idling forever.

---

## Problem Frame

orch's interactive steps run the real agent TUI inside a tmux pane (one tmux session per source). The pane is observable and pleasant to watch, scroll back through, and debug — which is exactly why you want to keep using interactive sessions for multi-step, hours-long workflows rather than headless runs.

But an interactive session never ends on its own. When the agent finishes its work it returns to an idle prompt and waits for a human. orch's interactive host reflects this: `src/hosts/two-pane/tmux-host.ts` waits on the pane's `pane-exit` channel with **no timeout** (deliberately, so a human can pause the agent for arbitrarily long, `src/services/tmux/tmux-service.ts`). So today a human must close every interactive step by hand. In a workflow meant to run unattended for hours, a single finished-but-not-closed step stalls the entire pipeline — the precise failure mode this work exists to remove.

The agent CLIs cannot close themselves: a Claude `Stop` hook and Codex `notify` can *detect* turn completion but cannot terminate the process (the "hook exits the session" capability was requested upstream and closed as not-planned, twice). So the close must be driven externally by orch — which already owns the tmux pane and can kill it.

---

## Actors

- A1. **Workflow author**: writes the step; opts a step into auto-stop via the flag.
- A2. **orch host (tmux)**: owns the tmux session/socket and the pane; injects the signal env, waits for the signal, and terminates the pane.
- A3. **Runner adapter** (`ClaudeRunner` / `CodexRunner`): knows *how* to register a stop-signal hook for its own CLI without disturbing the user's config.
- A4. **The agent CLI** (`claude` / `codex`): runs in the pane; fires its lifecycle hook on turn completion.
- A5. **The injected hook**: a generated inline command that does nothing but emit the signal to orch.
- A6. **Human observer**: watches the live pane; unaffected except that finished steps now close on their own.

---

## Key Flows

- F1. **Happy-path auto-stop**
  - **Trigger:** an interactive step with `autoStop: true` is reached; the agent finishes its turn.
  - **Actors:** A2, A3, A4, A5.
  - **Steps:** (1) orch host allocates a stop channel name and exposes the tmux socket + channel to the runner via env. (2) Runner materializes a per-run inline hook referencing those env vars and builds the launch command. (3) Agent runs in the pane, does its work, finishes the turn. (4) The agent's lifecycle hook fires and emits the signal on the channel. (5) orch, racing the stop channel against `pane-exit`, wakes on the signal and terminates the pane (clean exit preferred, kill as fallback). (6) Per-run injected config is cleaned up.
  - **Outcome:** the step completes without human input; the pipeline advances; the pane history remains for post-mortem until teardown.
  - **Covered by:** R1, R2, R3, R4, R5, R6, R8, R9, R11.

- F2. **Abnormal stop with no signal (known gap)**
  - **Trigger:** the agent stops without firing any hookable event (Claude bug #29881: silent stop after a tool result with exit code 1).
  - **Actors:** A2, A4.
  - **Steps:** the agent is idle at the prompt; no signal is emitted; orch keeps waiting on the stop channel and `pane-exit`.
  - **Outcome:** **the step hangs** — same as today's manual-close behavior. Not solved in this iteration; closing this gap is the deferred watchdog (see Scope Boundaries / Outstanding Questions).
  - **Covered by:** R10.

---

## Requirements

**API surface**
- R1. Interactive steps accept a boolean `autoStop` flag (default `false`). When `false`, behavior is exactly today's (wait for manual/agent-driven pane close, no injection). No new `StepMode` literal is introduced; `mode: 'interactive'` is unchanged.
- R2. `autoStop` is opt-in per step and flows through the existing config path that carries `mode` from the workflow definition to the runner and host. When the active runner cannot support auto-stop, orch fails fast with a clear error rather than silently running without it.

**Signal mechanism (both CLIs)**
- R3. When `autoStop` is set, orch injects a hook into the agent whose sole effect is to emit a completion signal to orch. The hook performs no termination, no mutation of agent state, and produces no output that would alter the agent's behavior.
- R4. For Claude, orch registers both the `Stop` and `StopFailure` events (the latter covers API-error terminations where `Stop` does not fire). For Codex, orch registers `notify` for `agent-turn-complete`.
- R5. The hook command is generated inline per run — **no hook script file is shipped, installed, or version-managed**. Its only runtime dependencies are tools orch already requires (tmux) or universally present (a shell builtin for the file-sentinel fallback).

**Per-run injection without disturbing the user**
- R6. Claude injection is via a per-run `.claude/settings.local.json` written into the run working directory containing only the auto-stop hooks. It must not overwrite or clobber a user's existing Claude settings or hooks; the user's own hooks continue to fire. (Driven by `--settings` being on orch's Claude denylist; hook configs merge across settings sources.)
- R7. Codex injection is via a per-run `CODEX_HOME` pointed at a temporary directory that inherits the user's real `~/.codex` (including working auth) and adds only the `notify` line. The user's real `~/.codex/config.toml` is never modified, and authentication (ChatGPT-login or API key) continues to work.
- R8. orch passes the tmux socket and stop-channel identifiers to the agent process via its existing env-merge, and the injected hook reads them from its inherited environment.
- R9. Per-run injected artifacts (the Claude settings file, the temp `CODEX_HOME`) are cleaned up after the step, and cleanup never touches the user's real config or credentials.

**Transport, termination, observability**
- R10. orch waits for the stop signal by racing the stop channel against the existing pane-exit wait, replacing the unconditional infinite wait for auto-stop steps. The signal source is the tmux `wait-for` channel (reusing orch's existing tmux-signal primitive); a file sentinel is the documented fallback if the channel proves unreliable.
- R11. On receiving the signal, orch terminates the pane, preferring a clean shutdown (so the agent flushes its transcript and the CLI's own end-of-session hooks run) over a hard kill, with a hard kill as the timeout-bounded fallback.
- R12. Auto-stop lifecycle is observable in the run logs: the channel/signal setup, the signal arrival, and the termination path taken (clean vs forced) are emitted as lifecycle events alongside the existing pane events.

---

## Acceptance Examples

- AE1. **Covers R1.** Given an interactive step without `autoStop`, when the agent finishes its turn, the pane stays open and orch waits indefinitely for a manual close — identical to current behavior.
- AE2. **Covers R3, R4, R10, R11.** Given an interactive Claude step with `autoStop: true`, when the agent completes its turn and the `Stop` hook fires, then orch receives the signal and terminates the pane without any human keystroke, and the step resolves.
- AE3. **Covers R4.** Given an interactive Claude step with `autoStop: true`, when the turn ends via an API error (rate limit / auth / billing) and `StopFailure` fires instead of `Stop`, then orch still receives a signal and terminates the pane.
- AE4. **Covers R6, R7, R9.** Given a user with existing Claude hooks / Codex config, when an auto-stop step runs and completes, then the user's real configuration and credentials are unchanged afterward and their own hooks fired during the run.
- AE5. **Covers R2.** Given an `autoStop: true` step whose runner does not implement auto-stop support, when the step starts, then orch fails fast with an explanatory error instead of running as if auto-stop were active.
- AE6. **Covers R10 (gap).** Given an interactive Claude step with `autoStop: true`, when the agent stops silently after a failed tool call without firing any hook (bug #29881), then no signal is emitted and the step hangs — the documented limitation this iteration does not address.

---

## Success Criteria

- A multi-step workflow of interactive steps with `autoStop: true` runs end-to-end with no human keystrokes on the happy path, and each step's pane closes on its own when the agent finishes.
- The same flag works for both Claude and Codex steps with no per-CLI knobs leaking into the workflow author's surface.
- Running an auto-stop step leaves the invoking user's `~/.claude` / `~/.codex` configuration and credentials byte-for-byte unchanged.
- A downstream implementer can build this from the requirements + research doc without having to re-derive the CLI hook mechanics or injection strategy.
- The residual hang case (F2) is visible and understood, not a silent surprise — it is documented and has a named follow-up.

---

## Scope Boundaries

- **Watchdog / idle + wall-clock backstop** — the mechanism that closes the F2 hang gap. Explicitly the next step; not in this iteration (your call to ship signal-only first).
- **Disabling `AskUserQuestion` and permission-bypass / sandbox flags** — already achievable today via runner flags; orthogonal to auto-stop and not bundled here.
- **Capturing the agent's real exit code for interactive steps** — orch currently always reports exit code 0 for interactive (tmux's `pane-died` hook does not surface the child code). Auto-stop does not fix this; pass/fail capture is separate.
- **Transcript persistence / richer post-mortem artifacts for interactive steps** — interactive steps emit only `session.json` today; teeing pane output is separate work.
- **Rendering a headless run as an interactive-looking view** — the alternative direction we considered and set aside; not pursued.
- **Sandboxing, network egress control, cost/rate-limit recovery, auth-expiry handling** — real concerns for hours-long autonomy (captured in the research doc) but out of scope for auto-stop itself.

---

## Key Decisions

- **Flag, not a new mode.** `autoStop: true` on `mode: 'interactive'` rather than a third `StepMode` literal — keeps the author surface small and avoids plumbing a new mode through all the mode-branching layers. (Your stated preference.)
- **Hook signals; orch terminates.** The agent CLIs cannot self-terminate (closed-not-planned upstream), so the hook is a pure signal and termination is orch-driven via the tmux pane it already owns.
- **Inline hook, no shipped script.** Generating the hook command inline per run removes the entire "install/distribute/version a hook script for other users" problem — there is no file to ship; the command is regenerated by whatever orch version runs, and references env vars orch injects.
- **tmux `wait-for` channel as transport.** Reuses orch's existing tmux-signal primitive (`TmuxService.waitFor`) and its existing race-on-`pane-exit` structure, rather than introducing file-polling, a socket, or an HTTP listener. File sentinel kept as the fallback.
- **Least-invasive injection per CLI.** Claude `--settings` is denylisted, so use a merged `.claude/settings.local.json` in cwd; Codex ignores `notify` in project-local config, so use a per-run `CODEX_HOME` that symlinks the real one except a `config.toml` carrying the added `notify`. Both preserve user config and credentials.
- **Hook `Stop` + `StopFailure` for Claude.** Strictly better completion coverage at zero extra surface, still signal-only.
- **Responsibility split.** Runner adapter knows how to register its CLI's stop hook; the tmux host owns the socket, channel, and pane termination. No concrete-runner knowledge leaks into core.
- **Ship signal-only; document the hang.** Per your scope call, accept the F2 residual hang now and name the watchdog as the follow-up rather than blocking this iteration on it.

---

## Dependencies / Assumptions

- tmux is already a hard dependency of the two-pane host; the `wait-for` transport adds no new dependency.
- Hooks/notify programs inherit the environment orch sets on the agent process — confirmed for both CLIs in the research doc.
- `--settings` (Claude) and `-c`/`--config`/`--sandbox`/`--approval-mode` (Codex) remain on orch's denylists; the injection strategies are chosen specifically to work around those denylists without relaxing them.
- **CLAUDE.md drift to fix in passing:** the env-merge helper lives at `src/services/process/merge-env.ts`, not `src/runners/_shared/merge-env.ts` as CLAUDE.md states. Any plan referencing it should use the real path.
- Version sensitivity: behaviors were verified around Claude Code v2.1.14x and Codex 0.133.0. A few items (e.g. whether `StopFailure` fires on the exact #29881 trace; Codex `--profile-v2` layering) are flagged unverified in the research doc and should be smoke-tested during planning.

---

## Outstanding Questions

### Resolve Before Planning

- *(none — scope is settled for signal-only auto-stop.)*

### Deferred to Planning

- [Affects R10, R11][Technical] Final choice between the tmux `wait-for` channel and a file sentinel as the primary transport, and the exact clean-termination sequence (e.g. `/exit` vs EOF vs send-keys, and the kill-fallback timeout). Both are spelled out in the research doc; pick during planning with a smoke test.
- [Affects R6][Needs research] Whether writing `.claude/settings.local.json` into a fresh/untrusted cwd retriggers a trust/hook-review prompt in the target Claude version — write-before-launch is the mitigation; verify.
- [Affects R7][Needs research] Whether to copy `config.toml` + symlink the rest of `~/.codex`, or use `--profile-v2` layering; the latter is cleaner but unverified for the interactive TUI in 0.133.0.
- [Affects R2][Technical] The exact shape of the Runner-interface capability for registering a stop hook (new optional method vs folding into `buildCommand` when `ctx.autoStop` is set).
- [Affects R12][Technical] Which lifecycle event names to emit and how they slot into the existing `lifecycle.ndjson` schema.

---

## Companion document

Deep CLI mechanics, exact flags, injection recipes, reliability caveats, and full citations live in [`docs/brainstorms/2026-05-25-interactive-auto-stop-research.md`](2026-05-25-interactive-auto-stop-research.md). Read it before planning — it answers most of the Deferred-to-Planning questions and prevents re-running the research.
