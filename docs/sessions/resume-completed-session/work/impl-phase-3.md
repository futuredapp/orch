# Phase 2 — Interactive `failed` view + retry core — implementation summary (round 3)

**Phase:** 2 of 3 (`plan.md` → "Interactive `failed` view + retry core + status-aware fallback")
**Status:** in-progress. This round landed **U5b** (the host→CLI action channel),
completing **U5** (U5a landed in round 2). **U6** and **U7** remain for a
following round.
**Gate:** `bun run check` green end-to-end — lint, typecheck, `bun run test`
(1796 pass), two-pane fast/screen/full-host/lifecycle (266 + 63 + 26), and the
migration overlap/import-parity/`_migration` checks all pass. No schema
migration; no public-API barrel change (the new `ForegroundAction` type is an
internal hosts barrel export).

## What this round ships — U5b: the host→CLI action channel

The net-new plumbing that carries a user retry action from the Ink failure view
up through the host to the point the CLI can consume it. Per the plan's U5 file
list and the prior round's hand-off note. Everything is **inert in all current
product paths** (gated behind an `actionsEnabled` / `enableFailureActions` flag
that no live `run`/`resume` sets), so there is **no behavior change and no dead
branch** — the consumer (the CLI open loop) is U6.

### View edge — new intents + gated keybindings + footer affordances

- **`src/hosts/two-pane/steps-view/steps-view.tsx`** — extended `StepsViewIntent`
  with `{type:'retry'}` and `{type:'retry-continue'}`; added an `actionsEnabled`
  prop. `[r]`/`[c]` are bound in `useInput` **only** when
  `actionsEnabled && state.status === 'failed'` (`failureActions`). A live run's
  failure frame leaves `actionsEnabled` off, so the actions never surface there
  — that is the sibling feature, out of scope (brainstorm Non-goals).
- **`src/hosts/two-pane/steps-view/end-of-run-summary.tsx`** — the `EndOfRunFooter`
  takes a `showFailureActions` prop; the `failed` footer adds
  `· r to retry · c to retry & continue` (the affordances a read-only/completed
  view intentionally lacks — AT-3). `completed`/`crashed` and the
  actions-disabled `failed` footer are unchanged.

### IPC + daemon — schema + child threading

- **`src/hosts/two-pane/steps-view/start-steps-view.ts`** — `StepsIntentSchema`
  now parses `retry` / `retry-continue`; added an `enableFailureActions` daemon
  option threaded into the child's base64 `--opts`.
- **`src/hosts/two-pane/steps-view/steps-view-runner.tsx`** — `OptsSchema` accepts
  `enableFailureActions`; passes it to `<StepsView actionsEnabled>`. `onIntent`
  now treats `retry`/`retry-continue` like `quit` (the child unmounts so the
  parent observes the pane exit) — the lifecycle U6's open loop will reopen on.

### Host contract — widened reason + tmux-host resolution

- **`src/hosts/host.ts`** — added `ForegroundAction = 'retry' | 'retry-continue'`
  and widened `ForegroundShutdownReason` to
  `'quit' | 'attach-exited' | { type: 'action'; action: ForegroundAction }`.
  `executeWithAttach`'s existing `winner.reason === 'quit'` check is unaffected
  (string vs object).
- **`src/hosts/index.ts`** — export `ForegroundAction`.
- **`src/hosts/two-pane/tmux-host.ts`** — `composedIntent` resolves the shutdown
  deferred with `{type:'action', action}` for the retry intents (mirroring the
  existing `'quit'` resolution); added the `enableFailureActions` host option,
  threaded into `startStepsView`.
- **`src/hosts/host-registry.ts`** — `HostFactoryInputs.enableFailureActions`
  threaded into the two-pane `createTmuxHost` call so the CLI re-entry `failed`
  open (U6) can request the action channel per invocation.

### Tests (U5b is plumbing — proven at the view/host edges, not end-to-end)

- **`tests/model/failure-actions--retry-keymap.test.tsx`** *(new)* — `model`
  category (ink-testing-library, no tmux): `[r]`/`[c]` emit the matching intents
  in the interactive `failed` view; emit **nothing** in a completed view or in a
  failed view with actions disabled; the failed footer adds the retry/continue
  affordances (AT-3) that the completed footer lacks, and omits them when actions
  are disabled.
- **`tests/unit/hosts/await-foreground-shutdown.test.ts`** — added the
  shutdown-outcome cases: a `retry` / `retry-continue` intent settles
  `awaitForegroundShutdown()` with `{type:'action', action}` (the host-wrapper
  unit the plan names for U5).
- **`tests/unit/hosts/two-pane/steps-view/start-steps-view.test.ts`** — schema
  parses the two new intents.

## Design notes / decisions made

- **Gated by `actionsEnabled`, not by `status === 'failed'` alone.** A live run
  that just failed renders the same `'failed'` `StepsViewState`. Binding `[r]`/`[c]`
  on status alone would expose half-built actions in the live failure frame — the
  sibling feature's surface, explicitly out of scope here. The extra flag keeps
  the channel inert everywhere except the CLI re-entry `failed` open (U6).
- **`execute-with-attach.ts` deliberately left unchanged this round.** The plan
  lists it under U5 ("handle the third outcome — drive execution instead of
  tearing down"), but *driving execution* is U6's open loop. Surfacing an
  unconsumed callback now would be exactly the dead branch the round-2 hand-off
  warned against. The host wrapper already *surfaces* the action via
  `awaitForegroundShutdown` (tested); the CLI consumption lands with U6.
- **No `acceptance-tests.md` status flips.** AT-3 (footer affordances) and the
  retry ATs are written against a real `orch resume` + rendered TUI driving
  surface, which needs U6's open loop. The footer/keymap are landed and
  model-covered, but marking AT-3 ✅ now would over-claim the real-resume path —
  left `⬜ todo`.

## What remains in Phase 2 (next round)

- **U6 — interactive `failed` open wired end-to-end.** Flip `orch resume
  <failed-id>` (TTY) to **park** at the interactive failure view (no silent
  re-run); no-TTY `failed` → refuse (AT-20 failed half). The CLI open loop
  consumes the U5b action channel:
  - `[r]` ⇒ `executor.retryStep` (landed round 2) under a real host; re-open the
    viewer on the now-updated state (KTD-8 parked: status stays `failed`, step
    shown ok, `[c]` still offered).
  - `[c]` ⇒ retry-and-continue ≈ the existing real `resume()` re-run (KTD-5) with
    the U4 `instructionResolver` injected — which naturally fires `run:ended` +
    the cmux pill `failed→completed` on completion (AT-R11) because it reuses the
    real resume host construction.
  - Per-step transcript **tee invalidation** on retry (KTD-6) for both Claude and
    Codex, so a later `⏎`/`orch resume` doesn't replay stale pre-retry bytes.
  - Expose a **host-free `retryAndContinue(runId, instructionSource)`** core so
    U8's headless `orch retry` branch (Phase 3) can call it without a TUI.
  - Wiring seam reachable today: pass `enableFailureActions: true` on the
    `HostFactoryInputs` for the `failed` open, and consume the
    `{type:'action'}` reason from `awaitForegroundShutdown` (surfaced this round)
    in `execute-with-attach`/`open-finished`. The `failed` branch in
    `resume.ts:186`-area currently still falls through to the silent real-resume
    path — that is the line U6 flips.
- **U7 — status-aware bare-resume fallback.** Wire the existing `ConfirmService`
  (already on `CliDeps.confirmService`, KTD-3) into the bare-`resume` path; offer
  the newest finished run with status-distinguishing copy; open the matching view
  on `y` (completed → U1 read-only; failed → U6 interactive), "nothing to resume"
  on `N`.

## Surprises / notes for reviewers

- **Scope reality (unchanged from round 2).** Phase 2 is multi-PR-sized net-new
  infra. This round took the **U5b plumbing** as a clean, fully-green, no-dead-
  branch boundary rather than land an intricate, real-tmux-dependent open loop
  half-tested. The action channel is now end-to-end *as a channel* (view →
  daemon IPC → host reason) and unit/model-proven; the CLI *behavior* flip is
  U6.
- **`enableFailureActions` threading touched five layers** (view prop → child
  opts → daemon option → tmux-host option → host-registry input). Each defaults
  off; the only setter will be U6's `failed` open. Verified no live path enables
  it (grep: the only `enableFailureActions: true` sites are the new test and the
  conditional plumbing).
- **No schema change.** `RunState.schemaVersion` stays `5`.

## Blockers

None. No blocker file written. The brainstorm's assumptions held: the host→CLI
action channel was buildable on the existing `shutdownDeferred` / `composedIntent`
seam by widening the tagged reason, with the actions gated so the live-run
failure frame (sibling territory) is untouched.
