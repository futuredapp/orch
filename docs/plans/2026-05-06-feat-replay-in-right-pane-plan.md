---
title: Replay step output in the right pane (drop window-1)
type: feat
status: active
date: 2026-05-06
---

# Replay step output in the right pane (drop window-1)

## Context

A real user (2026-05-06) hit Enter on a completed step expecting the right pane to update with replay content; instead the steps-TUI spawned a brand-new tmux window 1, hid both panes, and showed the replay full-screen. They reported it as a bug. The brainstorm at `docs/brainstorms/2026-05-06-steps-tui-replay-in-right-pane-brainstorm.md` discusses a "Direction B" redesign: keep the single window 0 + two-pane layout always; on Enter, swap the right pane in place from "live" to "replay-of-step-X". This plan adopts Direction B.

The brainstorm also flagged a pty-echo doubling bug in window 1 ("resume unavailable" appearing twice) that any design must avoid. Our chosen approach — `respawn-pane -- cat <file>` — sidesteps it entirely (no `sendKeys` for replay content means no echo loop).

## Goal

- Pressing **Enter** on a step (when the right pane is **idle**) swaps the right pane in place to a `cat <replay-file>` view of that step. The left steps-view stays mounted. No new tmux windows.
- Pressing **f** (follow-live) respawns the right pane back to the `cat` placeholder so the next live step can take over cleanly.
- Pressing **Enter** while a step is currently running on the right pane (autonomous transcript flowing OR interactive agent live) is a **no-op with a footer message**, logged as `replay-blocked-busy`.
- Window 1 is **gone**: no `newWindow` / `selectWindow` / `killWindow` from the right-pane-controller.

## Design

### 1. Reuse the right pane via `respawn-pane -- cat <file>`

Each Enter renders the replay payload to a per-step file under `<stateDir>/.replay/<stepName>.txt`, then issues:

```
tmux respawn-pane -k -t <rightPaneId> -- cat <file>
```

The `-k` kills whatever was running (placeholder `cat`, or the previous step's replay). The new `cat <file>` reads the replay bytes once and exits; `remain-on-exit on` (already set in `session-init.ts`) keeps the pane visible afterwards.

**Why files instead of `sendKeys`:** sendKeys writes bytes to the pane's stdin, which interacts with pty echo and the running `cat` process — that's the doubling bug from the brainstorm. `cat <file>` writes content via the process's *stdout*, so pty echo is irrelevant. Single tmux command, no race window between many sequential `sendKeys` calls.

**Per-kind dispatch** (all paths converge on `respawn-pane -- cat <something>`):
- **Autonomous agent step**: render the NDJSON transcript to a string via `replayTranscript`'s renderer, write it to `<stateDir>/.replay/<stepName>.txt`, respawn `cat <file>`.
- **Command step**: source log already exists at `<stateDir>/logs/tmux/<rightPaneId>.log` (when `--debug`). Respawn `cat <existing-log>` directly. When the log is missing, write a placeholder file ("(no captured output — re-run with --debug)") and respawn cat against it.
- **commit / worktree / ask**: `renderKindDetails` returns a string, write to file, respawn `cat <file>`.
- **Interactive agent (resume)**: unchanged — `respawn-pane -- <runner.resumeCommand argv>` (already does this today; we just redirect the target paneId from "new pane in window 1" to `rightPaneId`).

### 2. Busy gate (right-pane-controller refuses Enter while a step is live)

The right pane is "busy" while:
- A step is between `step:start` and `step:complete | step:failed` (covers autonomous transcript flowing AND interactive agent in `runInteractive(right)`), OR
- Any parallel-branch is in flight on the right pane.

Implementation: `tmux-host.ts` maintains an `inFlight: Set<StepName>` flipped on `step:start` (autonomous/interactive) and cleared on `step:complete`/`step:failed`. It exposes `isRightPaneBusy = () => inFlight.size > 0` to `RightPaneControllerOptions`.

When `dispatchEnter` is invoked and `isRightPaneBusy()` returns true:
- Log `replay-blocked-busy` to `lifecycle`.
- Write a one-line refusal message to the pane via `sendKeys` ("⏎ disabled while step running — press q to quit"). This goes to the live cat placeholder, mixing into the live transcript briefly. Acceptable trade-off; the alternative is a silent no-op that mystifies the user.
- Do NOT respawn-pane.

After live takeover ends and `inFlight.size === 0`, Enter is allowed again.

### 3. Pure renderers + controller orchestrates I/O

Today's renderers (`replay-transcript.ts`, `replay-command-pane.ts`, `kind-details.tsx`) mix rendering with `paneQueue.enqueue(... sendKeys ...)`. We split them:

- **Pure**: each renderer exports a `renderXxx(...): string` function that returns the rendered payload as one UTF-8 string. No tmux calls, no I/O.
- **Controller**: `dispatchEnter` calls the pure renderer, writes the string to `<stateDir>/.replay/<stepName>.txt` via `FsService`, then enqueues `tmux.respawnPane(...)` through `paneQueue` keyed on `rightPaneId`.

The single `paneQueue.enqueue(rightPaneId, async () => { writeFile + respawnPane })` closure keeps file-write and respawn atomic with respect to other Enters and to the live runner's writes — no inter-Enter race where step-A's respawn cats step-B's content.

### 4. follow-live (`f`) restores placeholder

`closeReplay()` (renamed from `closeReplayWindow`):
- Enqueues `tmux.respawnPane(rightPaneId, ['cat'], killRunning: true)` so the next live step has a known-good placeholder.
- No-op if no prior Enter has fired.

### 5. Logging renames

The 2026-05-06 diagnostic chain (`tui-intent → replay-intent → replay-window-opened/selected`) stays useful in shape but the entry types change:

| Old | New | Notes |
|-----|-----|-------|
| `replay-window-opened` | `replay-pane-opened` | Same payload (stepName, paneId). Drop windowId. |
| `replay-window-closing` | `replay-pane-closing` | Now fires on follow-live, not before kill. |
| `replay-window-selected` | (removed) | No window switch happens. |
| `replay-window-failed` | `replay-pane-failed` | Wraps respawn-pane errors. |
| `replay-window-select-failed` | (removed) | No selectWindow. |
| `replay-window-close-failed` | `replay-pane-close-failed` | |
| (new) | `replay-blocked-busy` | Gate hit. Records intent + step name. |
| `replay-intent` | (unchanged) | Still useful at the controller layer. |

### 6. Footer / keymap text

`src/hosts/two-pane/steps-view/steps-view.tsx`:
- Replace `<Text>⏎ inspect step</Text>` with `<Text>⏎ replay step in right pane</Text>` in `<HelpOverlay>`.
- Add `<Text>⏎ disabled while a step is running</Text>` to the help overlay.
- The terse `<Keymap>` line `↑/↓ ⏎ f ? q` stays as-is.

## Files to modify

```
src/hosts/two-pane/right-pane-controller.ts          // drop window lifecycle, route to rightPaneId
src/hosts/two-pane/replay-transcript.ts              // pure: renderTranscriptToString(opts) → string
src/hosts/two-pane/replay-command-pane.ts            // pure: renderCommandPaneSource(opts) → { kind: 'file', path } | { kind: 'inline', text }
src/hosts/two-pane/kind-details.tsx                  // already pure (renderKindDetails); no change
src/hosts/two-pane/tmux-host.ts                      // drop resolveLiveWindowId/liveWindowId; add inFlight Set + isRightPaneBusy
src/hosts/two-pane/steps-view/steps-view.tsx         // help overlay text
```

## Files / functions to delete

- `right-pane-controller.ts`: `closeReplayWindow`, `currentWindow1` state, all `newWindow`/`selectWindow`/`killWindow` call sites, the `replayWindowName` helper, the `liveWindowId`/`session` options.
- `tmux-host.ts`: `resolveLiveWindowId` helper (lines 403–418); the `liveWindowId` capture before controller creation (line 334).

## Critical files referenced

- `src/hosts/two-pane/right-pane-controller.ts` — owns the new Enter dispatch.
- `src/hosts/two-pane/tmux-host.ts:651` — `runInteractive` already shows the respawn-pane primitive we're copying for replay.
- `src/services/tmux/real-tmux-service.ts:305` — `respawnPane` implementation; verify it accepts `argv: ['cat', '<absolute path>']`.
- `src/services/tmux/session-init.ts` — `remain-on-exit on` already keeps the dead pane visible after `cat` exits; nothing to change.
- `src/hosts/two-pane/pane-queue.ts` — serialize file-write + respawnPane in one closure.

## Acceptance criteria

### Functional

- [x] Pressing Enter on a completed autonomous step swaps the right pane to the replay transcript without spawning a new window.
- [x] Pressing Enter on a commit / worktree / ask step shows the kind-details payload in the right pane.
- [x] Pressing Enter on a command step with a captured pane log shows the log content in the right pane.
- [x] Pressing Enter on a command step without a captured pane log shows the "(no captured output …)" placeholder.
- [x] Pressing Enter on an interactive agent step with a wired `resumeRunner` and captured `sessionId` respawns the right pane with the runner's resume argv.
- [x] Pressing Enter while a step is running shows the "disabled while step running" message and logs `replay-blocked-busy`. The right pane's live content is not destroyed.
- [x] Pressing `f` after a prior Enter respawns the right pane with the `cat` placeholder.
- [x] When a new live step starts after a replay was visible, the host's `runInteractive(right)` respawns over the replay (replay content is discarded — expected).
- [x] No `newWindow` / `selectWindow` / `killWindow` is called by the right-pane-controller in any of the above paths.
- [x] The lifecycle log chain `tui-intent → replay-intent → replay-pane-opened` is intact for every successful Enter.

### Non-functional

- [x] No `bun run check` regressions: lint, typecheck, unit, mocked-integration all green.
- [x] File-size discipline: `right-pane-controller.ts` stays under 300 lines after the refactor (it should *shrink* — window-1 lifecycle was ~80 lines).

## Tests (three layers, per `testing-strategy` skill)

> Layer rules: unit tests mock `*Service` ports only; `mock.module` / `vi.mock` are banned in `src/core/`, `src/state/`, `src/runners/`. Tests read like sentences (full-sentence test names). Arrange-Act-Assert with blank-line separators.

### Unit (`tests/unit/hosts/two-pane/`)

#### `right-pane-controller.test.ts` — **rewrite**

Replace the `newWindow → sendKeys → selectWindow` ordering assertions with respawn-pane assertions on `rightPaneId`.

Test names (full sentences):
- `respawns the right pane with cat <transcript-file> when Enter fires on an autonomous agent step`
- `respawns the right pane with cat <pane-log-file> when Enter fires on a command step that has a captured log`
- `respawns the right pane with cat <placeholder-file> when Enter fires on a command step with no captured log`
- `respawns the right pane with cat <kind-details-file> for commit / worktree / ask kinds`
- `writes a refusal notice to the right pane for an interactive agent step when no resume runner is wired`
- `emits replay-pane-opened with the rightPaneId on a successful enter`
- `emits replay-lookup-miss when Enter targets a step the state store does not know about`
- `emits replay-intent for every intent received (enter, follow-live, quit)`

Pseudocode for one test (autonomous):
```ts
// tests/unit/hosts/two-pane/right-pane-controller.test.ts
it('respawns the right pane with cat <transcript-file> when Enter fires on an autonomous agent step', async () => {
  const tmux = new FakeTmuxService()
  const harness = await makeController({ tmux, steps: { plan: makeStep({ name: 'plan', mode: 'autonomous', transcriptPath: 'steps/plan.events.ndjson' }) } })
  await writeFile(`${harness.stateDir}/steps/plan.events.ndjson`, ndjson({ text: 'hello-world' }))

  harness.onIntent({ type: 'enter', stepName: 'plan' })
  await flush()

  const respawn = tmux.recordedCalls.find((c) => c.method === 'respawnPane')
  expect(respawn).toBeDefined()
  expect(respawn.opts.target).toBe(paneId('%1'))         // rightPaneId, not a new pane
  expect(respawn.opts.argv[0]).toBe('cat')
  expect(respawn.opts.argv[1]).toMatch(/\.replay\/plan\.txt$/)
  expect(tmux.recordedCalls.some((c) => c.method === 'newWindow')).toBe(false)
  await harness.stop()
})
```

#### `right-pane-resume.test.ts` — **update**

The five existing resume tests stay structurally identical; only the assertion on `respawn.opts.target` changes from "newWindow's pane" to `paneId('%1')`. No new test names needed.

#### `right-pane-busy-gate.test.ts` — **new file**

- `is a no-op when isRightPaneBusy returns true and Enter targets a completed step`
- `logs replay-blocked-busy with the intent's stepName when the gate fires`
- `does not respawn the right pane while the gate is closed`
- `allows Enter once isRightPaneBusy returns false again`

Pseudocode:
```ts
it('is a no-op when isRightPaneBusy returns true and Enter targets a completed step', async () => {
  let busy = true
  const harness = await makeController({ steps: { /*…*/ }, isRightPaneBusy: () => busy })

  harness.onIntent({ type: 'enter', stepName: 'plan' })
  await flush()

  expect(harness.tmux.recordedCalls.some((c) => c.method === 'respawnPane')).toBe(false)
  busy = false
  harness.onIntent({ type: 'enter', stepName: 'plan' })
  await flush()
  expect(harness.tmux.recordedCalls.some((c) => c.method === 'respawnPane')).toBe(true)
})
```

#### `right-pane-follow-live.test.ts` — **new file**

- `respawns the right pane with the cat placeholder on follow-live after a prior enter`
- `is a no-op on follow-live when no prior enter has fired`
- `emits replay-pane-closing on follow-live`

#### Pure-renderer tests (existing, light touch):

- `tests/unit/hosts/two-pane/replay-transcript.test.ts` — adapt to new `renderTranscriptToString(...)` signature; assert returned string contains transcript bytes. Drop any sendKeys assertions.
- `tests/unit/hosts/two-pane/replay-command-pane.test.ts` — adapt to new `renderCommandPaneSource(...)` returning `{ kind: 'file', path }` or `{ kind: 'inline', text }`.
- `tests/unit/hosts/two-pane/kind-details.test.ts` — already pure; no change.

### Integration / mocked tmux (`tests/integration/hosts/two-pane/`)

#### `right-pane-windows.integration.test.ts` → **rename to `right-pane-replay.integration.test.ts`**

Drop window-1 ordering assertions; assert `respawnPane` on `rightPaneId('%1')` end-to-end.

Test names:
- `drives a single respawnPane(rightPaneId, [cat, <file>]) on enter for a commit step`
- `respawns rightPaneId with cat <transcript-file> for an enter on an autonomous step`
- `does not call newWindow / selectWindow / killWindow on any path`
- `respawns rightPaneId with the cat placeholder on follow-live`

#### `kind-details.integration.test.ts` — **update**

- Replace the `sendKeys` payload assertions with respawnPane argv + on-disk file content assertions:
  - `payload appears in <stateDir>/.replay/<stepName>.txt`
  - `respawnPane argv targets that file`

#### `resume-launcher-mocked.integration.test.ts` & `resume-failure-mocked.integration.test.ts` — **update**

Change target paneId in respawnPane assertions from the (synthetic) new-window pane to `rightPaneId('%1')`. Resume semantics unchanged.

#### `right-pane-busy-gate.integration.test.ts` — **new**

End-to-end through `tmux-host`: simulate a `step:start` (autonomous), fire an Enter intent through the composed handler, assert the controller's `respawnPane` is NOT called. Then fire `step:complete`, fire Enter again, assert respawnPane IS called.

Pseudocode:
```ts
it('blocks Enter while a step is in flight and unblocks on step:complete', async () => {
  const fakeTmux = new FakeTmuxService()
  const host = await createTmuxHost({ tmux: fakeTmux, /* … */ })

  host.onLifecycleEvent({ type: 'step:start', stepName: 'plan', mode: 'autonomous' })
  await appendIntent({ type: 'enter', stepName: 'plan' })
  await flush()
  expect(fakeTmux.recordedCalls.filter((c) => c.method === 'respawnPane' && /^cat /.test(c.opts.argv.join(' ')))).toHaveLength(0)

  host.onLifecycleEvent({ type: 'step:complete', stepName: 'plan' })
  await appendIntent({ type: 'enter', stepName: 'plan' })
  await flush()
  expect(fakeTmux.recordedCalls.filter((c) => c.method === 'respawnPane' && /^cat /.test(c.opts.argv.join(' ')))).toHaveLength(1)

  await host.teardown()
})
```

#### `steps-tui-e2e.mocked.test.ts` — **light touch**

Currently exercises only the quit pathway, which is unaffected. Verify it still passes after the rename. If we want to extend it, add a "Enter on a completed step lands in right pane (mocked)" case.

### E2E (`tests/e2e/`, real tmux, env-gated)

#### `steps-tui-e2e.test.ts` — **add cases**

- `Enter on a completed step swaps the right pane (real tmux)`: skips when `tmux -V` is missing. Boots a real two-pane session, runs a tiny workflow with one autonomous step, presses Enter via writing to `tui-intents.ndjson`, captures the right pane via `tmux capture-pane -p`, asserts replay text appears.
- `f restores the cat placeholder (real tmux)`: same setup, then `f`, capture again, assert no replay residual.
- `Enter is gated while step is in-flight (real tmux)`: harder — needs a workflow with a long-running step. Optional, only if reliable to write.

These run only when `ORCH_E2E_TMUX=1` (existing convention).

### Pre-flight tmux spike (one-time, before any code changes)

The Plan-agent review flagged this as the load-bearing assumption. **Run manually first**, in 60s, no TS code involved:

```sh
# Two terminal panes via tmux at the CLI:
tmux -L spike new-session -d -s s 'cat'
tmux -L spike split-window -h -t s 'cat'
PANE=$(tmux -L spike list-panes -t s -F '#{pane_id}' | tail -1)
tmux -L spike set-option -t s -g remain-on-exit on
echo 'replay-1' > /tmp/r1.txt
tmux -L spike respawn-pane -k -t $PANE -- cat /tmp/r1.txt
sleep 1
tmux -L spike capture-pane -p -t $PANE        # expect: replay-1
echo 'replay-2' > /tmp/r2.txt
tmux -L spike respawn-pane -k -t $PANE -- cat /tmp/r2.txt
sleep 1
tmux -L spike capture-pane -p -t $PANE        # expect: replay-2 only (no replay-1)
tmux -L spike kill-server
```

If `respawn-pane -k` over a `[exited]` pane misbehaves visually, fall back to `kill-pane` + `split-window` workaround. This validates the architectural assumption *before* writing any TS.

## Verification (manual)

After landing the change:

1. `bun run check` — green.
2. `bun run dev examples/steps-tui-demo` (or equivalent demo) — open a two-pane session, run a workflow with autonomous + commit + ask steps, press Enter on each completed step, verify:
   - The left pane (steps view) stays mounted continuously.
   - The right pane swaps in place with no window flicker.
   - `f` clears replay back to `cat` placeholder.
   - Pressing Enter while the workflow is mid-step shows the "disabled while step running" footer.
3. `tail -f .orch/state/<runId>/logs/lifecycle.ndjson` during step 2 — confirm the chain `tui-intent → replay-intent → replay-pane-opened` for each Enter, and `replay-blocked-busy` for the gated case.

## Open trade-offs / things this plan does not solve

- **Pre-replay buffer capture.** The brainstorm asked whether `f` should restore the bytes that were on the right pane before Enter overwrote it. We chose **no** — `tmux capture-pane -p` round-trip per Enter is overkill, and the live runner respawning in is the natural recovery. Surfaced here so a future iteration can reverse the call.
- **Live takeover discards replay.** When a new live step starts while the user is reading a replay, `runInteractive(right)`'s respawn-pane wins. The user loses their replay. This matches what users expect from "live" — surfaced for the record.
- **Unrelated to this plan: Phase 3 resumeRunner wiring.** The brainstorm flagged that the CLI doesn't yet pass `resumeRunner` through `HostFactoryInputs`. That's a separate gap — Direction B inherits the existing refusal path when `resumeRunner` is missing.
- **`.replay/` cleanup on teardown.** Add `await fs.rm(<stateDir>/.replay, { recursive: true, force: true })` to host teardown, or leave files for post-mortem (they're tiny and inside the run's stateDir which is already kept). **Decision: leave them**, same precedent as `logs/tmux/<paneId>.log` files.
