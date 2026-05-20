---
date: 2026-05-18
topic: codex-capture-empty-timeout
type: bug-handover
plan: docs/plans/2026-05-13-001-feat-history-step-resume-plan.md
run_id: r-2026-05-18-123526-p0
status: blocking-u10
---

# Handover: Codex thread_id capture times out at 5s before Codex writes session_meta

## TL;DR

Real-world `bunx orch run codex-riddle-solver` finished with `sessionIdCaptureError: 'empty'` on the interactive `write-riddle` step, even though the Codex rollout file was created on disk. **Root cause: Codex creates the rollout file empty at session start, then writes its first `session_meta` line ~9 seconds later — well past the helper's hardcoded 5-second timeout.** U6's helper logic is correct; the default `timeoutMs` is wrong for Codex's real behavior.

This blocks U10's manual spot-check (the user cannot exercise the happy-path resume because capture never succeeds in a real run).

## Repro

```bash
cd /Users/martinsumera/projects/futured/claude-orchestration/examples
bunx orch run codex-riddle-solver
# (interact briefly with the Codex TUI, exit)
# Press Enter on the past `write-riddle` step in the steps view
# Right pane shows:
#   resume unavailable — Codex thread_id was not captured for this step
#   (no rollout file appeared within the capture window;
#    Codex may have failed to start)
```

State file confirms persistence:

```json
"write-riddle": {
  "mode": "interactive",
  "runnerName": "codex",
  "sessionIdCaptureError": "empty"
  // no `sessionId` at the top level
}
```

(see `examples/.orch/state/r-2026-05-18-123526-p0/state.json`)

## Proof: the rollout file existed but was empty during the capture window

The rollout WAS written to the expected path; my helper's directory math is correct.

```
~/.codex/sessions/2026/05/18/rollout-2026-05-18T12-35-28-019e3aa7-aff3-73e0-a2ea-c87f164f9637.jsonl
```

`payload.cwd` in the rollout matched orch's `ctx.cwd` exactly:

```
rollout payload.cwd: /Users/martinsumera/projects/futured/claude-orchestration/examples
orch    ctx.cwd:     /Users/martinsumera/projects/futured/claude-orchestration/examples
```

**The killer timing:**

| Time (UTC) | Event | Source |
|---|---|---|
| `10:35:26.906` | orch step start; capture window opens | `lifecycle.ndjson` |
| `10:35:28` | Codex creates the rollout file (empty) | filename `rollout-2026-05-18T12-35-28-...` (local time = UTC+2) |
| `10:35:31.906` | orch capture deadline hits → returns `{error: 'empty'}` | `timeoutMs: 5000` default |
| `10:35:37.261` | Codex writes its first `session_meta` line | `head -1 <rollout>.jsonl \| jq .timestamp` |

So Codex created the file inside the capture window, but did not write the first line for another **~11 seconds**. My helper saw the empty file each iteration (via `readDir`), called `readFile`, got `""`, treated it as "not ready yet" (correct per design), and timed out before the line ever landed.

The "treats empty file as not-ready" branch is exercised in:
`src/runners/codex/capture-thread-id.ts:155` (`if (raw.length === 0) return undefined`)

## Suspect ladder (what I ruled in / out)

| Hypothesis | Verdict | Evidence |
|---|---|---|
| Wrong sessions root path | **Ruled out** | `homedir()` returns `/Users/martinsumera`, helper polls `/Users/martinsumera/.codex/sessions/2026/05/18/`, file IS there |
| UTC vs local-time directory mismatch | **Ruled out for this run** (still a latent bug for users near midnight UTC) | At 10:35 UTC = 12:35 local, the UTC date and local date both = `05/18` |
| `payload.cwd` doesn't match `ctx.cwd` | **Ruled out** | Both are exactly `/Users/martinsumera/projects/futured/claude-orchestration/examples` (string-equal, no trailing slash, no symlinks involved) |
| File never written | **Ruled out** | File exists on disk |
| **Codex creates file, then delays writing session_meta past the 5s window** | **CONFIRMED** | `head -1` shows `timestamp: 2026-05-18T10:35:37.261Z`, 11s after step start |
| Sandbox / permissions issue | Ruled out | File was written successfully (eventually) |

## Latent secondary bugs found during investigation

These are NOT the cause of this run's failure but should be fixed alongside:

1. **UTC vs local-time directory layout.** My helper uses `getUTCFullYear/Month/Date()` in `src/runners/codex/capture-thread-id.ts:183`. The filename `rollout-2026-05-18T12-35-28-...` uses local time (12:35 = CEST = UTC+2 → 10:35 UTC). If Codex also uses LOCAL time for the directory, then for a user in `UTC+10` running at 23:30 local (= 13:30 UTC, previous day), Codex writes to `YYYY/MM/(DD)/` (local) while my helper polls `YYYY/MM/(DD-1)/` (UTC). **Needs verification on a non-UTC machine.** If confirmed, switch to local time or watch BOTH (UTC + local) directories.

2. **No debug observability for capture lifecycle.** There is currently no orch-side log line saying "capture started for step X with sessionsRoot Y, deadline Z, files in snapshot: [...]". Adding one (gated on `orchLog`) would have turned this 2-hour investigation into a 2-minute grep. See plan's Documentation Plan section which lists this as a follow-up.

3. **Default timeout assumption.** The plan (`docs/plans/2026-05-13-001-feat-history-step-resume-plan.md` § "Key Technical Decisions") describes a 5s poll window assuming Codex writes session_meta within ~100ms of spawn. That assumption is empirically wrong on Codex 0.130.0 / macOS / GPT-5 backend.

## What's already in place (and works correctly)

All U6–U9 plumbing is correct and verifiable:

- The R9 `'empty'` refusal text rendered correctly in the real two-pane right pane (screenshot in chat history).
- `state.json` correctly persists `sessionIdCaptureError: 'empty'` and `runnerName: 'codex'`.
- The capture helper correctly handles the "empty file" case as not-ready and continues polling (it just runs out of time).
- 1603 unit + integration tests pass (`bun run check` is green).

## Suggested fix paths (pick one with the user)

### Option A — bump default timeout to ~60s (cheapest, least invasive)

**Change:** `DEFAULT_TIMEOUT_MS = 60000` in `src/runners/codex/capture-thread-id.ts:6`.

**Why it works:** Interactive Codex sessions typically run much longer than the model's first response, so a 60s window catches the first `session_meta` line. The capture promise is awaited AFTER `host.runInteractive` returns (workflow.ts), so users never see the 60s wait — it just runs in parallel with the interactive session.

**Caveats:**
- A user who exits Codex within 10s and before session_meta is written still sees `{error: 'empty'}`. Acceptable — at that point the session genuinely has no captured turn worth resuming to.
- A user who immediately exits with Ctrl-C before any LLM response: same as above.

**Test:** Add a unit test in `tests/unit/runners/codex/capture-thread-id.test.ts` that drives the "file exists empty for many iterations, then content lands at iter N=60+" timeline.

### Option B — drop the timeout, tie capture lifetime to interactive session

**Change:** In `src/core/workflow.ts:runInteractiveStep`, race `captureHandle.result` against `interactivePromise`. Whichever ends first wins. If interactive exits before capture, signal the helper to stop polling.

**Why it works:** Capture is logically bounded by the spawn's lifetime, not by a wall clock. As long as the user is in Codex, the rollout is a meaningful target.

**Caveats:**
- Requires plumbing an `AbortController` from the workflow into the helper. The helper already supports `signal?: AbortSignal` (capture-thread-id.ts:18) — just needs to be wired.
- More invasive (workflow.ts changes).

### Option C — extend the empty-file detection to wait for the file's mtime to settle

**Change:** When the helper sees an empty file, record its mtime. If on a subsequent poll the file is STILL empty and the mtime hasn't moved for >N seconds, abandon it. If the mtime ticks forward, give it more time.

**Why it's worse:** Adds complexity for marginal gain. Codex's behavior of "create empty, fill ~10s later" is consistent; we should just wait it out.

### Recommended: Option A short-term + Option B for v1.1

A is a 1-line change that unblocks U10 today. B is the cleaner long-term shape.

## Where to pick up

1. **Confirm the diagnosis** by running the user's repro and watching `~/.codex/sessions/2026/05/<today>/` with `watch -n 0.5 'ls -la ~/.codex/sessions/2026/05/$(date -u +%d)/ | tail -3'` during the spawn. Verify the file appears within ~2s but stays size 0 until the first model response (~10s).
2. **Implement Option A** (bump default to 60000 ms) — see exact line ref above.
3. **Add a regression unit test** for "file exists empty for many iterations then content lands at iter N" — use the existing pattern in `tests/unit/runners/codex/capture-thread-id.test.ts` for empty-then-valid timing (the "keeps retrying an unparseable file" test is close — just stretch the iteration count).
4. **Re-run the riddle-solver example** to confirm `sessionIdCaptureError` is gone and `sessionId` equals the captured `019e3aa7-aff3-73e0-a2ea-c87f164f9637` (or whatever the new run produces).
5. **Now perform the U10 manual spot-check**: with capture working, press Enter on the past `write-riddle` step and verify the prior conversation re-renders as scrollback (this is the original U10 prerequisite question the plan demands before any test code).
6. **If the spot-check passes**, proceed with U10's Tier-1 + Tier-4 tests per the plan's "Files" section.
7. **If the spot-check fails**, halt and re-scope per the plan's "Risk: Codex resume does not actually re-render prior turns in TTY mode" mitigation.

## Relevant files (with line refs)

- Plan: `docs/plans/2026-05-13-001-feat-history-step-resume-plan.md` — see § "Outstanding Questions (Deferred to Implementation)" and U10
- Helper: `src/runners/codex/capture-thread-id.ts:6` (`DEFAULT_TIMEOUT_MS`), `:155` (empty-file branch), `:183` (UTC date computation)
- Runner: `src/runners/codex/codex-runner.ts:362` (`runCaptureSessionId`)
- Workflow integration: `src/core/workflow.ts:417` (capture-aware branch), `:481` (await both promises)
- Refusal text: `src/hosts/two-pane/pane-map/right-pane-controller.ts:805` (R9 dispatch)

## Log files for further analysis

All logs from the failing run live under:

```
/Users/martinsumera/projects/futured/claude-orchestration/examples/.orch/state/r-2026-05-18-123526-p0/
```

Most useful files:

| File | Why |
|---|---|
| `state.json` | Confirms `sessionIdCaptureError: 'empty'` on `write-riddle` |
| `logs/lifecycle.ndjson` | Step start/complete timestamps; pin the 5s window |
| `logs/spawns.ndjson` | Exact argv, env, cwd for both interactive + autonomous spawns |
| `logs/run.meta.json` | orch's process state — argv, cwd, env at run start |
| `logs/agents/write-riddle/session.json` | The interactive step's persisted session record (durationMs: 39011) |
| `.replay/write-riddle.txt` | The visible refusal text rendered in the right pane |

And the corresponding Codex rollout file (proves it WAS written, just late):

```
~/.codex/sessions/2026/05/18/rollout-2026-05-18T12-35-28-019e3aa7-aff3-73e0-a2ea-c87f164f9637.jsonl
```

Useful one-liners:

```bash
# Verify the timing claim:
head -1 ~/.codex/sessions/2026/05/18/rollout-2026-05-18T12-35-28-019e3aa7-aff3-73e0-a2ea-c87f164f9637.jsonl \
  | jq '{outer_ts: .timestamp, payload_ts: .payload.timestamp, cwd: .payload.cwd}'
# Outer ts (10:35:37) >> step start (10:35:26.906) + 5s default timeout (10:35:31.906)

# Confirm orch's cwd vs payload.cwd are byte-identical:
diff <(jq -r .payload.cwd ~/.codex/sessions/2026/05/18/rollout-2026-05-18T12-35-28-*.jsonl | head -1) \
     <(jq -r '.steps["write-riddle"].value | "/Users/martinsumera/projects/futured/claude-orchestration/examples"' \
        examples/.orch/state/r-2026-05-18-123526-p0/state.json)
```

## Context the next agent needs

- Plan status: U1–U9 complete (uncommitted on `main`). U10 was blocked at the "manual spot-check" gate.
- User's constraint: stay on `main`, do not commit.
- `bun run check` was green when this handover was written.
- The plan's "Implementation-Time Unknowns" section warned about this exact class of risk under "Codex resume does not actually re-render prior turns" — but the failure mode we hit is one step earlier: capture itself never succeeds, so the resume path is never reached.
- The user (Martin) ran the real example in cmux/ghostty terminal on macOS. Codex version 0.130.0. GPT-5 model. Timezone CEST (UTC+2).
