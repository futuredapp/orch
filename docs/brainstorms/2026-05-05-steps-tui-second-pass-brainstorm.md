---
date: 2026-05-05
topic: steps-tui-second-pass
status: brainstorm — addendum to 2026-05-05-steps-tui-brainstorm.md
extends: 2026-05-05-steps-tui-brainstorm.md
---

# Steps TUI — second-pass brainstorm (DevEx, step-kind coverage, failure modes)

## What This Is

A targeted second pass over [`2026-05-05-steps-tui-brainstorm.md`](./2026-05-05-steps-tui-brainstorm.md),
re-reading the design through three lenses the first pass under-explored:

1. **DevEx & usability** — what happens at the day-1 edges (terminal width, end-of-run).
2. **Step-kind coverage** — five kinds exist (`agent`, `command`, `commit`, `worktree`, `ask`),
   not just the agent + parallel pair the original mocks imagined.
3. **Failure modes** — Ink crash, large transcripts, resume failure paths.

The original brainstorm stands. This addendum adds decisions, refines a few keybinds,
and surfaces what the planner needs to know before turning this into a phased plan.

A fourth lens — **reuse & future-proofing** (`orch status <runId>`, MCP exposure of
the viewmodel, cross-run picker, NDJSON↔TUI format coupling) — was deliberately
deferred. Flag for a future pass.

## What Changes vs. the Original

### 1. Adaptive column layout (new)

The original mocks assume ≥110 cols. Real users run orch in vertical IDE splits
(~80 cols) and laptop screens with sidebars. v1 commits to **adaptive columns**:

```
Wide (≥110):    work-auth   ⟳  0m42s   $0.12   6k
Medium (~85):   work-auth   ⟳  0m42s   $0.12
Narrow (~70):   work-auth   ⟳  0m42s
Very narrow:    work-auth   ⟳
```

Columns drop from the right as width shrinks: tokens first (<95), cost (<80),
elapsed (<70). Below ~70 cols only name + glyph remain. Right pane width compresses
proportionally. Same component, fewer columns visible — no mode switch, no
breakpoint discontinuity.

### 2. Enter semantics, refined per kind (new — supersedes original §Keybinds)

The original treated Enter and `r` as orthogonal: Enter opens transcript, `r`
resumes. After this pass Enter does **the obvious thing for the kind**, which
is different per kind, and `r` disappears from v1.

| Kind | Enter behavior |
|---|---|
| `agent` (autonomous) | Render the formatted transcript replay (same renderer as live, sourced from per-step NDJSON). Fall back to raw NDJSON / raw bytes if no formatter is registered. |
| `agent` (interactive) | **Resume** the session via the captured `sessionId` — Enter *is* the resume. No separate "view replay" affordance for interactive in v1. |
| `command` | Replay the captured pane output (line-framed stdout/stderr) **if** the step ran with `pane: true`. If `silent: true` / no pane, show "no captured output for this command — pane was disabled." |
| `commit` | Per-kind details panel: commit message + diff stat + changed files. Read-only. |
| `worktree` | Per-kind details panel: worktree path, branch, postCreate hook output (if any). Read-only. |
| `ask` | Per-kind details panel: the question, the choices, the chosen value, timestamp. Read-only. |

Rationale: an interactive transcript replay has little value (the user remembers
their own typing); the natural "open" for an interactive step is "let me talk to
this session again." Collapsing Enter and resume for that case removes a key
without losing capability.

### 3. Keymap shrinks (new — supersedes original §Keybinds)

```
↑/↓   move selection
⏎     open per-kind action (see table above)
f     follow live (snap to active step + window 0)
?     help overlay
q     close TUI (only meaningful at end-of-run; see §4)
```

`r` is dropped. Resume happens through Enter on interactive agent steps and
nowhere else in v1. If a kind appears later where Enter has different semantics
from "resume" (e.g., codex non-interactive resume), `r` can be re-introduced as
a "force resume" alias.

`Runner.resumeCommand(ctx, sessionId)` interface from the original brainstorm
**stays** — Enter on an interactive step calls it. Only the user-facing key
binding changes.

### 4. End-of-run UX is explicit (new)

When the run terminates (success, failure, halt), the TUI **stays mounted**.
Header re-paints to `✓ completed in 7m12s · $2.41` or `✖ failed at work-auth`.
Footer changes to `q to quit · ⏎ to inspect any step · ↑/↓ to browse · ? help`.
The user decides when to leave.

```
├─ orch · feature-build · ✓ completed 7m12s · $2.41 ─┐
│   brainstorm           ✓  3m12s   $0.42           │
│   plan                 ✓  1m47s   $0.88           │
│ ▌ work-auth            ✓  2m13s   $1.11           │
│   commit feat(auth)    ✓                          │
│                                                    │
│  ─── totals ───                                    │
│   elapsed   7m12s · cost $2.41 · tok 81k          │
│                                                    │
│   q quit   ⏎ inspect   ↑/↓ browse   ? help         │
└────────────────────────────────────────────────────┘
```

Resume still works on finished runs since selection state is preserved and the
state dir is still on disk — Enter on any past interactive step launches a
fresh resumed session in window 1. This is the natural foundation for a future
`orch status <runId>` view (the deferred reuse lens).

### 5. Long-list navigation is punted to v2

The original brainstorm doesn't address runs with 30+ steps; this pass
considered `/` incremental search, `[ ]` jump-to-failure, and PgUp/PgDn page
nav. **All deferred.** v1 ships with `↑/↓` only. Add when a real user
complains. (YAGNI.)

## New Failure-Mode Decisions

### Ink renderer crash → watchdog auto-restart

`TmuxHost` owns a watchdog around the Ink child process. On unexpected exit:

1. Log to `.orch/state/<runId>/logs/lifecycle.ndjson` (`event: tui-crashed`,
   exit code, stderr tail).
2. Respawn within ~500ms.
3. The new instance re-tails `state.json` + per-step NDJSON from disk —
   `StepsViewModel` is a pure read-side projection, so it picks up state
   without any cross-process handover.
4. User sees a brief `reconnecting…` frame, then the live view resumes.
5. **Live agent process in window 0 is untouched throughout.** This is the
   non-negotiable from the original brainstorm — the TUI is a display, not the
   process.
6. **Cap: 3 restarts in 60s.** After that, fall back to a "TUI unavailable —
   detach + reattach to retry, run continues" footer message in the right
   pane. The run keeps going; we just stop fighting whatever is making Ink
   crash.

### Resume failures → visible in window 1

Two common failure modes that the original brainstorm didn't address:

- **Binary missing.** `claude` / `codex` not on `PATH` at resume time
  (e.g., user changed shells, removed the install). The subprocess exits
  immediately with ENOENT.
- **Session expired / revoked.** Provider returns "session not found" or
  similar.

In both cases the failure surfaces in **window 1**: the captured stderr is
visible, the footer shows `resume failed — press f to return to live, q to
close window`. The TUI doesn't crash; the live run in window 0 is unaffected.
The user reads the error and decides what to do.

No pre-flight validation in v1 (we considered `--dry-run` style checks but
the round-trip cost on every resume isn't worth it for the rare expired case).

### Chained resume → ignore, always start from the original session-id

If the user resumes step-3, the resumed session runs for a while and ends, then
the user wants to "resume again": v1 always launches a new subprocess from the
**originally captured** session-id, not from any intermediate session-id the
resumed run may have emitted.

Rationale: it's how `claude --resume` and `codex resume` are believed to behave
server-side already (resuming an existing session-id continues from where it
last left off, not where it was originally captured). We don't need to track a
chain client-side for the same effect.

**Open question for the planner: confirm this assumption** with both runners
before committing. If it turns out the CLIs treat each resume as a fresh fork
from the original capture point, we'll need `StepEntry.resumeChain: string[]`
later — out of scope for v1 either way.

### Transcript replay memory → DEFERRED

Long autonomous runs (e.g., an hour of `claude --bare -p`) can produce >50 MB
of NDJSON. Naive replay slurps the file into memory and freezes the TUI.

**v1 explicitly defers this.** Document the limit in user-facing docs:
"rich replay is best for steps under ~10 MB; for larger transcripts, read the
file directly with `less .orch/state/<runId>/steps/<name>.transcript.ndjson`."

**Required code marker:** the planner must drop a clear comment in the replay
component when implementing:

```ts
// TODO(transcript-replay-memory): naive load of full file. Will OOM
// on transcripts > ~100MB. Stream + virtualize on PgUp/PgDn before
// removing this comment. Tracked in 2026-05-05-steps-tui-second-pass-brainstorm.md §Transcript replay memory.
```

This is a contract: the comment lands with the v1 implementation so future
contributors find it without spelunking the brainstorm.

## New Resolved Questions

- **Q: How does the layout handle terminals narrower than ~110 cols?**
  A: Adaptive columns. Drop tokens (<95) → cost (<80) → elapsed (<70). No mode
  switch, no breakpoint. Below ~70 cols we render name + glyph only and trust
  the user's terminal can handle it.

- **Q: What's the keymap, finalized?**
  A: `↑/↓ ⏎ f ? q`. `r` is dropped. Enter does the right thing per kind (see
  §2). Resume happens via Enter on interactive agent steps.

- **Q: What does the TUI look like at end-of-run?**
  A: Stays mounted; header repaints to a completion summary; footer changes to
  reflect post-run actions; user closes with `q`. Resume still works on
  finished runs (foundation for `orch status <runId>` in a future pass).

- **Q: What happens for non-streaming step kinds (commit, worktree, ask)?**
  A: Per-kind read-only details panel on Enter. All data is already in
  `StepEntry` (artifacts, validations) or the workflow config (commit message,
  ask choices) — no new on-disk format.

- **Q: What if the Ink TUI crashes mid-run?**
  A: Watchdog auto-restart, capped at 3 restarts in 60s, falling back to a
  "TUI unavailable" message in the right pane. Live run is independent and
  untouched.

- **Q: What if resume fails (binary missing, session expired)?**
  A: Failure surfaces in window 1 with the captured stderr; TUI keeps running;
  live run in window 0 unaffected. No pre-flight validation in v1.

- **Q: Chained resume — do we capture intermediate session-ids?**
  A: No. Always resume from the original captured session-id. Provider CLIs
  are believed to handle "resume from existing id" as continuation already.
  Confirm in the plan.

## New Open Questions

1. **Confirm runner-CLI resume semantics.** Does `claude --resume <id>` and
   `codex resume <id>` continue from the latest server-side state of that
   session, or does it fork from the original snapshot? If the latter, v1
   needs to revisit chained-resume capture. Verify before implementation.

2. **Ink IPC pattern for a long-running stream.** The existing
   `src/services/prompt/ink-runner.ts` (Phase 18) is one-shot: PromptSpec
   passed via base64 argv, PromptResult written to a reserved file. The Steps
   TUI is long-running and event-driven — needs a different pattern (likely
   stdin-piped JSON events from host to child). Plan should pick the seam
   and reuse where it can without forcing a one-shot pattern onto a stream.

3. **Width detection cadence and resize handling.** Adaptive columns require
   re-measuring on `SIGWINCH`. Ink supports this natively at the React level,
   but inside a tmux pane the resize events flow differently (tmux owns the
   pane size, child sees the inner dimensions). Plan should verify the resize
   event makes it down and pick a debounce window.

4. **Per-kind details panel data sources for `worktree` and `ask`.** Worktree
   `postCreate` hook output: where is it captured today? Ask choices and
   chosen value: `ask-executor.ts` produces these — are they persisted to
   `StepEntry.artifacts`, or only to in-memory step output? If the latter,
   v1 needs a small persistence addition.

## What's Explicitly NOT Explored Here

The fourth lens — **reuse & future-proofing** — was deliberately deferred:

- `orch status <runId>` reusing the same TUI for finished runs (read-only mode,
  what `q` means, how detach/reattach works against a non-running process).
- MCP read-only exposure of the `StepsViewModel` (giving agents the same
  inspector that humans get).
- Cross-run picker design (keeps v1 design from foreclosing it).
- Runner-NDJSON ↔ TUI format coupling and versioning (today the TUI couples
  directly to runner emit shape; future runner changes could break replay).

Flag these for a third-pass brainstorm or for the planner's "future work"
section, depending on whether the planner needs decisions on any of them
before committing v1's interfaces.

## Next Steps

→ `/workflows:plan` against **both** brainstorm documents (this one + the
original). The plan should incorporate:

- Adaptive column layout in `<StepsView>` (drop columns at width thresholds).
- Per-kind Enter dispatch in the right-pane controller (5 kinds, including
  agent's interactive vs. autonomous split).
- The shrunk keymap (`↑/↓ ⏎ f ? q`) — `r` is gone.
- End-of-run mounted summary state.
- Watchdog auto-restart in `TmuxHost` for the Ink child (3 in 60s cap).
- Resume failure path in window 1 (captured stderr + footer).
- Required `// TODO(transcript-replay-memory):` comment in the replay
  component.
- Verification step: confirm `claude --resume` / `codex resume` semantics
  before committing to the chained-resume design.
- Open questions §2 (Ink IPC), §3 (resize cadence), §4 (worktree/ask
  artifact persistence) need decisions in the plan.
