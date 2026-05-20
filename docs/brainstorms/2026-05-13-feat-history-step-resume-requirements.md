---
date: 2026-05-13
topic: feat-history-step-resume
---

# History-Step Resume for Interactive Sessions (Claude + Codex)

## Summary

Replace the deferred "resume unavailable" placeholder in the two-pane history view with a working flow that, when the user presses Enter on a past interactive step, spawns the CLI's own `--resume` (Claude) or `resume` (Codex) so the user sees the full prior session in the right pane and can keep typing if they want. For Codex, add post-spawn `thread_id` capture (lock + snapshot of `~/.codex/sessions/`) since Codex has no pre-set ID flag.

---

## Problem Frame

orch's two-pane host already supports pressing Enter on a past step to re-view it. For autonomous-agent steps this works — the frozen `formatted_output.ansi` is tailed and the transcript renders. For **interactive** agent steps it does not: the right pane shows "resume unavailable" regardless of context, because the host-level `resumeRunner` was never wired into `createTmuxHost` and Codex's real `thread_id` was never captured.

The user wants to look back at what happened during a past interactive Claude or Codex run — read the conversation, see the tool calls, optionally continue. Today they can't: the message has no remediation, and even if it were wired, Codex's interactive resume would fail because the stored "sessionId" is an orch-generated UUID Codex never saw. The cost is low per occurrence (just frustration) but it compounds: every interactive past step is a dead end in the history view.

CLI behavior makes this tractable. `claude --resume <id>` re-renders the entire prior session in the TUI as scrollback before allowing continuation (empirically confirmed). `codex resume <thread_id>` is documented to do the same. So the orch-side change is "make resume actually fire with the right ID," not "build our own transcript renderer."

---

## Key Flows

- F1. View past Claude-interactive step
  - **Trigger:** User selects a past Claude-interactive step in the steps view and presses Enter.
  - **Actors:** orch right-pane controller, Claude CLI.
  - **Steps:**
    1. Right-pane controller resolves the step's stored `sessionId`.
    2. Controller calls `runner.resumeCommand(sessionId)` and spawns the resulting argv as a PTY in the right pane.
    3. Claude TUI launches with `--resume <id>`, re-renders prior turns as scrollback, presents a fresh prompt.
    4. User scrolls to read history; optionally types to continue.
  - **Outcome:** User sees the full past session and can resume the conversation in-place.
  - **Covered by:** R1, R2, R6.

- F2. View past Codex-interactive step
  - **Trigger:** User selects a past Codex-interactive step in the steps view and presses Enter.
  - **Actors:** orch right-pane controller, Codex CLI.
  - **Steps:**
    1. Right-pane controller resolves the step's stored `sessionId` (which for Codex is the real `thread_id` captured during the run — see F3).
    2. Controller calls `runner.resumeCommand(threadId)` and spawns the resulting argv as a PTY in the right pane.
    3. Codex TUI launches with `codex resume <thread_id>`, re-renders prior turns, presents a fresh prompt.
    4. User scrolls to read history; optionally types to continue.
  - **Outcome:** Same as F1, for Codex.
  - **Covered by:** R1, R3, R6.

- F3. Capture Codex `thread_id` at spawn time
  - **Trigger:** Workflow starts an interactive Codex step.
  - **Actors:** orch workflow executor, Codex CLI, local filesystem (`~/.codex/sessions/YYYY/MM/DD/`).
  - **Steps:**
    1. Acquire the Codex-capture lock (in-process semaphore).
    2. Snapshot the current set of `rollout-*.jsonl` files in today's session directory.
    3. Spawn Codex via the existing interactive path (PTY owned by the host).
    4. Poll the session directory for a new `rollout-*.jsonl` file matching the step's `cwd` (parsed from `SessionMeta`) until one appears or a short timeout elapses.
    5. Extract `conversation_id` from the new rollout's `SessionMeta` line and store it as the step's `sessionId`.
    6. Release the lock.
  - **Outcome:** Step state holds Codex's real `thread_id`, suitable for later `codex resume`.
  - **Failure paths:** Zero new files within timeout → record capture failure on the step. Two or more matching new files → record ambiguity failure on the step. In both cases F2 surfaces a runner-specific refusal message.
  - **Covered by:** R3, R4, R5, R7.

---

## Requirements

**Right-pane resume wiring (both runners)**
- R1. Pressing Enter on a past interactive agent step in the two-pane host MUST spawn the active runner's `resumeCommand` for that step's stored session id, mirroring how autonomous-agent replay already works. The spawn surfaces in the right pane (window 1) as an interactive PTY.
- R2. For Claude-interactive steps the existing `--session-id <uuid>` capture path is sufficient; no additional ID-capture code is required for Claude.
- R6. The CLI surface that constructs the two-pane host MUST forward the workflow's primary runner as `resumeRunner` into `createTmuxHost`, so the right-pane controller receives a non-undefined runner. Tests that intentionally exercise the refusal path may omit it.

**Codex `thread_id` capture**
- R3. Interactive Codex steps MUST replace today's orch-generated UUID with Codex's actual `conversation_id` in the step's stored `sessionId` field, so that subsequent `codex resume <id>` invocations succeed.
- R4. Capture MUST happen via a lock-guarded snapshot diff: acquire a Codex-capture lock, snapshot `~/.codex/sessions/YYYY/MM/DD/`, spawn Codex, poll until a new `rollout-*.jsonl` appears that matches the step's `cwd` (read from its first-line `SessionMeta`), extract `conversation_id`, release lock.
- R5. The capture lock MUST scope to "startup window only," not the lifetime of the interactive session. Once the new file is observed (or the poll times out), the lock releases and the user's interactive Codex session continues unrestricted. Parallel interactive Codex steps within the same orch run remain concurrent; only their capture windows serialize.
- R7. When snapshot-diff is ambiguous (≥2 new matching files in the window) or empty (no new file within timeout), the step records a capture failure with a runner-specific reason. No fallback heuristic. The step still completes normally — capture failure does not abort the run.

**User-facing refusal messages**
- R8. When a past step cannot be resumed because the step pre-dates this feature (no usable id captured), the right pane MUST show a refusal message that names the legacy cause specifically, not the current generic "resume unavailable."
- R9. When a past step cannot be resumed because Codex thread-id capture failed (see R7), the refusal message MUST identify the capture failure (e.g., "Codex thread_id was not captured for this step — Codex sessions can be hard to identify when other sessions race in the same window").
- R10. When the right pane is configured without a `resumeRunner` (tests, plain host) the existing "no runner wired" message is preserved — that path is intentional.

---

## Acceptance Examples

- AE1. **Covers R1, R2, R6.** Given a workflow that ran a Claude-interactive step named `feature` to completion, when the user selects `feature` in the steps view and presses Enter, then the right pane spawns `claude --resume <captured-session-id>` as a PTY, Claude's TUI renders prior turns visibly above the prompt, and the user can scroll up to read history and type to continue.
- AE2. **Covers R3, R4, R5.** Given a workflow that starts an interactive Codex step, when the step is spawned, then within a few seconds a new `rollout-*.jsonl` file appears in `~/.codex/sessions/YYYY/MM/DD/`, orch reads its `SessionMeta.conversation_id`, stores it as the step's `sessionId`, and releases the capture lock — the user's Codex TUI session continues without further interference and can run for as long as they want.
- AE3. **Covers R7, R9.** Given two interactive Codex sessions start within the same capture window from different processes (orch + a manually-launched terminal session), when orch's snapshot-diff observes two new files matching the step's `cwd`, then orch records a capture failure on the step. Later, when the user presses Enter on that past step in the history view, the right pane shows a refusal that names Codex thread-id ambiguity as the cause.
- AE4. **Covers R8.** Given a past Claude-interactive step recorded before this feature shipped (no `sessionId` in state.json), when the user presses Enter on it, then the right pane shows a refusal that identifies the step as pre-dating the resume feature, not the generic "resume unavailable."

---

## Success Criteria

- A developer running orch can press Enter on any Claude-interactive step recorded after this feature ships and see the full prior session re-rendered in the right pane, with the option to continue typing.
- The same is true for Codex-interactive steps, in the common case where no other Codex sessions race orch's spawn window.
- When Codex capture fails (ambiguous or empty snapshot diff), the user sees a refusal message that explains *why* — not the generic "resume unavailable" they see today.
- ce-plan can implement this without re-deciding scope: which runner gets ID capture, which mechanism (lock + snapshot), where the lock lives (in-process), and what happens when capture fails are all answered.
- The change does not regress autonomous-step replay or any other right-pane path.

---

## Scope Boundaries

- Out: parsing Claude or Codex JSONL files directly to render a transcript. The brainstorm explored this (Approach B) and rejected it — each CLI's own TUI is the renderer.
- Out: migrating pre-feature interactive steps to retrofit IDs. Legacy steps stay unresumable; only the refusal message improves (R8).
- Out: coordinating with externally-launched (non-orch) Codex sessions on the same machine. If the user manually runs `codex` in another terminal during orch's capture window, ambiguity surfaces as a capture failure (R7) — orch does not try to disambiguate by `originator`, model, or pid.
- Out: file-locking across orch processes (e.g., `~/.orch/codex-capture.lock`). v1 uses an in-process semaphore; cross-process coordination is deferred unless evidence of multi-orch Codex collisions appears.
- Out: any change to the autonomous-step replay path (`formatted_output.ansi` tail / JSON re-render). Already works.
- Out: any change to Claude's session-id capture. `--session-id <uuid>` already does the right thing.
- Out: changing the right-pane controller's overall pane-spec dispatch (`resolveReplaySpec`). The dispatch shape stays; only the inputs change (a non-undefined `resumeRunner` reaches it, and Codex steps carry real ids).

---

## Key Decisions

- **Use the CLIs' own resume rendering, not a third-party transcript view.** Claude TUI on `--resume` empirically re-renders prior turns as scrollback. Codex TUI is documented to do the same. Building a JSONL parser/renderer would be more work, depend on undocumented formats with breaking-change history (Codex PR #3380), and would not give the user the "continue typing" affordance.
- **Approach A (wire resume + Codex capture), not C (hybrid with JSONL fallback).** YAGNI: most "resume unavailable" cases disappear once wiring lands. Legacy-step coverage is not worth a second renderer.
- **Lock guards the capture window, not the session lifetime.** Otherwise parallel-block Codex usage would serialize end-to-end, defeating orch's parallel-step feature. The new `rollout-*.jsonl` appears at Codex startup (before any user input), so capture takes a few seconds at most.
- **In-process semaphore, not a file lock.** No evidence today of multiple orch processes spawning Codex concurrently. Cross-process locking can be added later if collisions surface in practice.
- **No fallback heuristic on capture failure.** When snapshot-diff is ambiguous, surface the failure clearly rather than guess (by pid, mtime tie-break, or "most likely"). Wrong-ID resume would silently load the wrong conversation — worse than a clean refusal.
- **Match candidates by `cwd` from `SessionMeta`, not just mtime window.** Multiple cwds → multiple distinct file groups in the same window; mtime alone would conflate them. Reading the first line of each candidate is cheap.

---

## Dependencies / Assumptions

- `claude --resume <id>` in TTY mode re-renders prior turns as scrollback. **Verified** via user screenshot (Claude Code v2.1.140).
- `codex resume <thread_id>` in TTY mode re-renders prior turns the same way. **Unverified** — documented behavior per the official Codex CLI docs the user pasted, but not spot-checked. Listed below in Outstanding Questions.
- Codex CLI writes a `SessionMeta` line containing `conversation_id` and `cwd` at session **start**, before any user input. Source: openai/codex PR #3380 and discussion #3827.
- Codex CLI has no pre-set-id flag analogous to Claude's `--session-id`. Source: official Codex CLI reference + repo grep.
- The orch workflow already generates a `sessionId` UUID upfront (`src/core/workflow.ts:386`) and passes it to runners via `ctx.sessionId`. Claude consumes it via `--session-id`; Codex ignores it. Today's stored sessionId for Codex interactive steps is therefore the orch UUID, not Codex's `thread_id` — explicitly the bug R3 fixes.
- `createTmuxHost` already accepts `resumeRunner` (`src/hosts/two-pane/tmux-host.ts:186`) and forwards it to the right-pane controller; the gap is purely that `src/hosts/host-registry.ts:124` does not pass it. **Verified.**

---

## Outstanding Questions

### Resolve Before Planning

- *(none — direction is locked, mechanism is chosen.)*

### Deferred to Planning

- [Affects R3, R4][Needs verification] Does `codex resume <thread_id>` in TTY mode actually re-render prior turns in the TUI? Documented behavior implies yes; planning (or first implementation pass) should spot-check before relying on it. If it doesn't, Codex F2 still launches the resume TUI but with a blank scrollback — which would invalidate part of the user goal. Mitigation: a one-minute manual test.
- [Affects R4][Technical] Where exactly should the in-process Codex-capture semaphore live? Most natural is the Codex runner module itself (since it owns the lifetime), but planning may prefer a small shared helper if other runners ever grow similar needs.
- [Affects R4, R5][Technical] What is the appropriate poll timeout for "new rollout-*.jsonl appears"? 3-5 seconds is plausible, but planning should pick a number based on real Codex startup time on the user's machine.
- [Affects R7][Technical] Should capture failure be a separate field on the step (e.g., `sessionIdCaptureError: 'ambiguous' | 'empty'`) so the refusal message can be precise per R9, or just absence of `sessionId` plus a single generic Codex refusal? The doc currently assumes the former; planning may simplify if the diagnostic detail isn't worth the schema surface.
- [Affects R3][Technical] When the user resumes a past Codex step, that resume itself creates a new rollout file (Codex forks). Does orch need to handle this — e.g., decide whether subsequent resumes show the original transcript or the most-recent fork? For v1 this is delegated to Codex's own resume behavior; revisit only if it surprises users.
