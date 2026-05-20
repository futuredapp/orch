---
date: 2026-05-20
topic: q-and-ctrl-c-mid-step
type: bug-handover
plan: docs/plans/2026-05-20-001-feat-two-pane-behavioral-test-dsl-plan.md
findings: docs/findings/2026-05-20-lifecycle-campaign-findings.md
snapshots:
  - tests/integration/lifecycle/__snapshots__/pane-q-during-run.last.json
  - tests/integration/lifecycle/__snapshots__/attach-tty-ctrl-c.last.json
status: ready-for-fix
---

# Handover: `q` and Ctrl-C during a running step do not tear orch down

> **Update 2026-05-20 — DSL rename pass.** The behavioral DSL was renamed for
> readability after this handover was written. The bugs and fix surfaces are
> unchanged; only symbol names moved. Mapping you'll need while reading the
> rest of this doc:
>
> | Old (in this handover) | New (in code today) |
> | --- | --- |
> | `expectInvariantViolation` | `assertContractViolatedThroughout` |
> | `assertAllInvariants` | `assertContractedOutcome` |
> | `cleanly()` | `exitedNormally()` |
> | `doesNotExist()` | `tmuxIsTornDown()` |
> | `balancedEscapes()` | `terminalRestoredCleanly()` |
> | `hasIntactPerStepFiles()` | `stepArtifactsIntact()` |
> | `isInState(...)` | `showsInkState(...)` |
> | `assertTerminalState(...)` | `assertTerminalEscapeStream(...)` |
> | `assertWorkflowState(...)` | `assertPersistedState(...)` |
> | `typeInAttachTty(...)` | `typeIntoOrchStdin(...)` |
> | `closeStdin()` | `closeOrchStdin()` |
>
> One cell was also semantically flipped in the same pass:
> **`q-during-fake-mid-step.real.test.ts`** was switched from the Risk R-D
> sentinel (`assertContractViolatedThroughout`) to the direct contract
> assertion (`assertContractedOutcome`). It now FAILS today (with the bug
> present) and will PASS when the fix lands — the deletion gate no longer
> applies to this one cell. The four other cells listed in §Repro still use
> the sentinel and STILL must be DELETED on fix.

## TL;DR

Two distinct bugs reproduce deterministically in the Tier 5 lifecycle harness:

1. **`q` during a running step does not quit orch.** The Ink `useInput` handler at `src/hosts/two-pane/steps-view/steps-view.tsx:136` fires `onIntent({ type: 'quit' })` correctly, and `quitDeferred` resolves in `tmux-host.ts:429`. But `execute-with-attach.ts:116` then `await`s the still-running workflow, which blocks forever (the held step never completes). The footer advertises `q quit` but the actual semantics are `q detach`. The two paths (real detach + intent-driven quit) are conflated under the same `awaitForegroundShutdown` race.

2. **Ctrl-C in the attached tmux pane never becomes a SIGINT.** A real terminal's tty driver converts `^C` keystrokes into SIGINT for the foreground process. When the user is attached to the orch tmux session, keystrokes go to tmux and through to the pane's child process — Ink sees the raw `\x03` byte but `steps-view.tsx`'s `useInput` has no `\x03` case (it only handles `q`, `f`, `?`, arrows, return, escape). The orch process's signal handlers at `src/cli/commands/execute-with-attach.ts:63-78` never fire because no kernel-level signal is delivered.

The §2.1 reproduction snapshot proves bug (1); the Ctrl-C snapshot proves bug (2). Both bugs likely share a fix: route the user's "I want to quit" intent (whatever the input vector) to `host.teardown() → process.exit(EXIT.SIGINT)` via the existing signal-handler path.

## Repro

The cells are already in place. Run them:

```bash
bun test tests/integration/lifecycle/q-during-fake-mid-step.real.test.ts \
         tests/integration/lifecycle/q-during-emitting-fake-mid-step.real.test.ts \
         tests/integration/lifecycle/ctrl-c-once-in-attached-during-mid-step.real.test.ts \
         tests/integration/lifecycle/ctrl-c-twice-in-attached-during-mid-step.real.test.ts \
         tests/integration/lifecycle/ctrl-c-thrice-in-attached-during-mid-step.real.test.ts
```

**Important — passing-while-broken semantics.** Four of the five cells use
`assertContractViolatedThroughout(scenario, withinMs(5_000))` (formerly
`expectInvariantViolation`), which:
- **PASSES while the bug exists** (violations non-empty for the full budget) — the test runner shows green
- **FAILS the moment the bug is fixed** (any snapshot with empty violations during the budget) — the assertion throws `"orch reached the contracted clean state; the bug appears fixed. DELETE this cell, do not invert the assertion."`

When you ship the fix, those four cells WILL start failing in CI. **The
correct response is to DELETE them**, not to invert the assertion or mark them
`it.skip`. The plan's Risk R-D is the rationale; the failure message itself
names the deletion gate.

The fifth cell — **`q-during-fake-mid-step.real.test.ts`** — was deliberately
flipped during the DSL rename pass to use `assertContractedOutcome` instead.
That cell already FAILS today (it reports the three §6.5 violations
directly) and will PASS when the fix lands. It does NOT need deletion — keep
it as a permanent regression test.

To refresh the committed bug-evidence snapshots (during a debugging cycle):

```bash
LIFECYCLE_SNAPSHOT_DIR=tests/integration/lifecycle/__snapshots__ \
  bun test tests/integration/lifecycle/
```

## Proof

### Bug 1: `q` during running step

Snapshot: [`tests/integration/lifecycle/__snapshots__/pane-q-during-run.last.json`](../../tests/integration/lifecycle/__snapshots__/pane-q-during-run.last.json)

The smoking gun is in `leftPaneText`:

```
qorch · tier5-two-step-linear · r-2026-05-20-153605-0z
───────────────────────────────────────────────────────────
  plan  ◐
───────────────────────────────────────────────────────────

▶ live · ⏎ view step · q quit · ? help
```

The literal `q` at the start of the buffer is the keystroke we injected (server-side via `tmux send-keys -t <pane> -l q`). The Ink `useInput` handler did receive it, fired the quit intent (confirmed by tracing — see "Suspect ladder" below), and yet orch is still alive (`orchAlive: true, orchExit: null`), the tmux session is still up (`tmuxSessionExists: true`), and `state.json` still reports `stateStatus: "running"`.

### Bug 2: Ctrl-C in attached tmux pane

Snapshot: [`tests/integration/lifecycle/__snapshots__/attach-tty-ctrl-c.last.json`](../../tests/integration/lifecycle/__snapshots__/attach-tty-ctrl-c.last.json)

The cells inject `\x03` (one, two, three bytes) via the harness's `typeInAttachTty` action, which calls `writeStdin` on the orch subprocess. orch reads the bytes via its Ink stdin, but `steps-view.tsx`'s input handler has no `\x03` branch. Snapshot shows the same shape as Bug 1: `orchAlive: true, tmuxSessionExists: true, stateStatus: "running"`.

## Suspect ladder

Bug 1's tracing path — verified during this campaign:

| Hypothesis | Verdict | Evidence |
|---|---|---|
| `q` keystroke is never received by Ink | **Ruled out** | `leftPaneText` starts with literal `q` — the byte reached the Ink terminal driver |
| `useInput` handler is missing the `q` case | **Ruled out** | Handler exists at `src/hosts/two-pane/steps-view/steps-view.tsx:136`; it fires `onIntent({ type: 'quit' })` |
| `onIntent` dispatch is broken | **Ruled out** | Composed in `src/hosts/two-pane/tmux-host.ts:427-430`; resolves `quitDeferred` on type=quit |
| `quitDeferred` never resolves | **Ruled out** | `awaitForegroundShutdown` races on it (`tmux-host.ts:506-508`) |
| Signal handlers are wired incorrectly | **Ruled out** | Handlers at `src/cli/commands/execute-with-attach.ts:63-78` work fine for SIGINT/SIGTERM/SIGHUP — verified by the PASS cells `sigint-/sigterm-/sighup-to-orch-during-mid-step.real.test.ts` |
| **`await trackedWorkflow` blocks at `execute-with-attach.ts:116` because the workflow is held** | **Confirmed root cause** | The quit intent fires, the foreground race resolves, the "detached" message would print at line 107 — but then line 116 waits for the workflow to finish. With a held step, that never happens |

Bug 2's tracing path:

| Hypothesis | Verdict | Evidence |
|---|---|---|
| `\x03` never reaches orch's stdin | **Ruled out** | The harness writes via `BunProcessService.spawn({ rawStreams: true }).writeStdin(...)`; orch is `stdin: 'pipe'` so the bytes arrive |
| Kernel converts `\x03` to SIGINT for piped stdin | **Ruled out** | Kernel-level `^C → SIGINT` only happens when stdin is a CONTROLLING TTY. Bun.spawn with `stdin: 'pipe'` does not give the child a controlling TTY |
| Ink consumes `\x03` and calls a handler | **Partial** — Ink reads the byte; `useInput` is called with `input=''`/`key.ctrl=true, key.input='c'` per Ink's docs. **No case for it exists in `steps-view.tsx:92-143`** |
| SIGHUP-style fallback fires when stdin closes | **Ruled out** | Closing stdin (the `close-stdin-during-mid-step` cell) does NOT make orch exit either; the `close-stdin` contract row is intentionally weak |

## Where the fix likely lives

Three plausible fix surfaces, ordered by least intrusive:

### Option A — Make `quit` intent cancel the workflow (smallest fix)

In `src/cli/commands/execute-with-attach.ts:104`, when `winner === FOREGROUND_SETTLED` AND the foreground settled via a `quit` intent (NOT via attach exit), treat it as cancellation: tear down the host and exit with `EXIT.SIGINT` instead of awaiting the workflow.

Today the code can't distinguish the two settlement reasons — `awaitForegroundShutdown` is a `void` race over `quitDeferred.promise` + `attachPromise`. To preserve the existing detach semantics for the "user closed their tmux client" case, the deferred needs to carry a discriminant:

```ts
// in tmux-host.ts — replace the void quitDeferred with a tagged version
const shutdownDeferred = createDeferred<'quit' | 'attach-exited'>()
// ...
if (intent.type === 'quit') shutdownDeferred.resolve('quit')
// ...
// settleAttach now does: () => shutdownDeferred.resolve('attach-exited')
```

Then in `execute-with-attach.ts`:

```ts
const reason = await host.awaitForegroundShutdown()
if (reason === 'quit' && !workflowSettled) {
  // User intent: kill the run. Don't wait for the workflow.
  await opts.host.teardown()
  process.exit(EXIT.SIGINT) // or a new EXIT.QUIT if you want a distinct exit code
}
```

This also fixes the right-pane controller's odd `quit → followLive()` at `right-pane-controller.ts:567` — that line should probably be `void stop()` or removed entirely.

### Option B — Wire Ctrl-C into the Ink input handler

`src/hosts/two-pane/steps-view/steps-view.tsx:92` — add a `key.ctrl && input === 'c'` branch that fires the same `onIntent({ type: 'quit' })`. Ink's `useInput` exposes `key.ctrl` for chord detection. This composes naturally with Option A — once `quit` works correctly, `Ctrl-C` just maps to the same intent.

Note: this only covers Ctrl-C delivered into the Ink-controlled pane. If the user presses Ctrl-C while attached to tmux but NOT focused on the left pane (e.g., focused on the right transcript pane), the keystroke goes to the transcript pane's child process — which is `tail -F` or similar. That child won't propagate to orch. If that case matters, the fix grows: either route via a tmux-level binding (`bind-key -n C-c run-shell 'tmux ... kill-server'` style) or document the focus requirement.

### Option C — `state.json` flush on signal teardown (separate but related)

The U7 docblock in `tests/integration/lifecycle/sigint-to-orch-during-mid-step.real.test.ts` notes that the SIGINT handler does NOT flush `state.json` status='cancelled' before exit:

> "the SIGINT handler does NOT persist `state.json` status='cancelled' (or 'crashed') before `process.exit(130)` — the handler is fire-and-forget around `host.teardown()`."

The §6.5 `pane-q-during-run` contract row currently asserts `hasStatus("cancelled")` — that row is satisfied for the §2.1 cells today because orch is still RUNNING (state stays at 'running'). But after Option A's fix, orch will tear down, exit cleanly, and `state.json` will be... what, exactly? If the fix routes through the SIGINT path, `state.json` won't be flushed — which means `hasStatus("cancelled")` STILL fails, the violation list stays non-empty, and the cells STILL pass (and never get deleted).

**This means the contract row will need updating in tandem with the fix** — either:
- Lift the SIGINT handler to flush `state.json` before exit (preferred — fixes the U7 finding too)
- Or drop `hasStatus("cancelled")` from the `pane-q-during-run` contract and rely on `cleanly() + doesNotExist()` alone (cheaper but loses the cancellation-was-persisted assertion)

If you go with the lift, the relevant code is in `src/cli/commands/execute-with-attach.ts:67`:

```ts
void opts.host.teardown().finally(() => process.exit(code))
```

`teardown()` doesn't currently flush state. You'd need to `await opts.stateStore.markCancelled(runId)` before teardown, or thread a cancellation hook through the host.

## Acceptance criteria

For the fix PR to land, all of these must hold (the harness enforces most automatically):

- [ ] `bun test tests/integration/lifecycle/q-during-fake-mid-step.real.test.ts` **PASSES** (this cell was inverted during the DSL rename pass — it uses `assertContractedOutcome` and goes green once orch tears down on `q`). Keep the cell as a permanent regression test.
- [ ] `bun test tests/integration/lifecycle/q-during-emitting-fake-mid-step.real.test.ts` **FAILS** with `assertContractViolatedThroughout("pane-q-during-run"): violation list is empty — orch reached the contracted clean state; the bug appears fixed. DELETE this cell, do not invert the assertion.`
- [ ] `bun test tests/integration/lifecycle/ctrl-c-{once,twice,thrice}-in-attached-during-mid-step.real.test.ts` ALL FAIL the same way (with `attach-tty-ctrl-c` scenario).
- [ ] The fix PR **DELETES** the four sentinel cells (q-during-emitting + the three ctrl-c cells). Do NOT invert their assertions or skip them. The committed snapshots under `tests/integration/lifecycle/__snapshots__/` for those scenarios should also be deleted — they're the bug ticket, and the bug is closed. The `q-during-fake-mid-step.real.test.ts` cell stays.
- [ ] The existing PASS cells stay green:
  - `sigint-to-orch-during-mid-step.real.test.ts` (single SIGINT)
  - `sigterm-to-orch-during-mid-step.real.test.ts`
  - `sighup-to-orch-during-mid-step.real.test.ts`
  - `double-sigint-to-orch-during-mid-step.real.test.ts`
  - `close-stdin-during-mid-step.real.test.ts` (weak contract)
  - `click-to-focus-across-divider-smoke.real.test.ts`
- [ ] `bun run check` is green.
- [ ] The §6.5 contract row in `tests/helpers/behavioral-dsl/internal/invariants.ts` (`pane-q-during-run` block, currently around line 89, matchers are `[exitedNormally(), tmuxIsTornDown(), hasStatus('cancelled')]`) — either updated to reflect the new persisted state, or its `hasStatus("cancelled")` is removed if the SIGINT-handler state flush is out of scope.
- [ ] Manual smoke test: `bunx orch run codex-riddle-solver` → press `q` while a step is running → orch exits, tmux session is gone, state file shows cancellation (or whatever the contract row settles on).
- [ ] Manual smoke test: `bunx orch run codex-riddle-solver` → attach foreground → press `Ctrl-C` while a step is running → orch exits cleanly.

## Don'ts

- **Don't invert `assertContractViolatedThroughout` to `assertContractedOutcome` in the four sentinel cells.** That defeats the whole Risk R-D defense. Delete those cells instead. (`q-during-fake-mid-step.real.test.ts` was already inverted intentionally — that one is exempt.)
- **Don't catch the fix with the four sentinel cells.** They PASS while the bug exists — they don't tell you the fix landed. The deletion-gate failure is the signal.
- **Don't widen the `awaitForegroundShutdown` race to silently include workflow cancellation** — that breaks the existing "user detached, run continues in background" semantics that the `sigterm/sighup` PASS cells implicitly rely on.
- **Don't refactor the tmux pane-map controller's `quit → followLive()` line** (`right-pane-controller.ts:567`) without checking that no other intent flow depends on it — that line looks wrong but may be load-bearing for the end-of-run summary path.

## Files touched, at a glance

Primary fix surface:

- `src/cli/commands/execute-with-attach.ts` — discriminate quit-intent vs attach-exit; route quit-intent to teardown+exit
- `src/hosts/two-pane/tmux-host.ts` — give `quitDeferred` a tagged settlement (`'quit' | 'attach-exited'`)
- `src/hosts/two-pane/steps-view/steps-view.tsx` — add `key.ctrl && input === 'c'` branch in `useInput`

Likely-touched in tandem:

- `src/hosts/two-pane/pane-map/right-pane-controller.ts:567` — `quit → followLive()` looks wrong; audit
- `src/cli/commands/execute-with-attach.ts:67` — optionally flush state.json before `process.exit(code)`
- `tests/helpers/behavioral-dsl/internal/invariants.ts:64-66` — update `pane-q-during-run` contract if state-flush is out of scope

## Why this campaign matters

This is the first deliverable of the Tier 5 lifecycle harness (plan `2026-05-20-001`). The harness was designed so that lifecycle bugs surface as committable evidence: a `.last.json` snapshot, a contract row, a one-line predicted-outcome comment in the cell. The §2.1 and Ctrl-C bugs are the inaugural use case. Future similar bugs (external pane kill, server kill, etc.) should follow the same shape — write a cell, capture the snapshot, hand off via a doc like this one.

See [`docs/findings/2026-05-20-lifecycle-campaign-findings.md`](../findings/2026-05-20-lifecycle-campaign-findings.md) for the full campaign report.
