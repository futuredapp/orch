---
title: Handover — Pane-Map Implementation (after U1 + U3 + U4)
type: handover
date: 2026-05-11
plan: docs/plans/2026-05-11-001-feat-decouple-live-runner-unified-pane-map-plan.md
supersedes: docs/plans/2026-05-11-001-feat-decouple-live-runner-unified-pane-map-handover.md
status: superseded
superseded_by: docs/plans/2026-05-11-003-feat-decouple-live-runner-unified-pane-map-handover-mid-u5.md
---

# Pane-map plan — handover after U1 + U3 + U4

This document hands the pane-map plan off to the next agent. **Three units
are shipped on `main`; seven remain.** Read the plan
([`docs/plans/2026-05-11-001-feat-decouple-live-runner-unified-pane-map-plan.md`](2026-05-11-001-feat-decouple-live-runner-unified-pane-map-plan.md))
end to end before starting — this handover only summarizes what changed,
deviations the implementer made vs. the plan text, and what to do next.

The prior handover
([`docs/plans/2026-05-11-001-feat-decouple-live-runner-unified-pane-map-handover.md`](2026-05-11-001-feat-decouple-live-runner-unified-pane-map-handover.md))
captured the state after U1 + U3. This document supersedes it; the
deviations it called out are summarized below alongside the new U4-specific
ones.

## Current state of `main`

Commits landed on `main`:

```
1f0280e feat(two-pane): banner + view-mode plumbing                   (U4)
9ce66bf docs(pane-map): handover after U1 + U3
9f83526 feat(two-pane): pane-map module + per-run scratch session lifecycle (U3)
b6cc8b4 feat(tmux): add swapPane and argv-form splitPane with env/cwd     (U1)
```

`bun run check` is green at HEAD. **1460 tests pass, 9 skipped, 0 failing.**
37 new tests landed across U4 (1423 → 1460); 17 prior new tests are
documented in the previous handover for U1 + U3.

## What U4 shipped

**TL;DR:** U4 is the **pure plumbing layer** for banner + view-mode UI
affordances. No caller emits any banners yet. U5/U6/U7/U8 each flip their
own surfaces to use the new methods inline with their test migrations.

### New types

[`src/hosts/two-pane/steps-view/step-types.ts`](../../src/hosts/two-pane/steps-view/step-types.ts):

- `ViewMode = {mode:'live'} | {mode:'replay', stepName: string}` — the
  persistent footer indicator.
- `Banner = {kind:'info'|'error', text, ttlMs?, seq: number}` — single-slot,
  last-write-wins transient feedback. `seq` is the monotonic counter the
  controller assigns at emit time.
- Every `StepsViewState` variant now carries `view: ViewMode` (required)
  and `banner?: Banner` (optional).

### New IPC channel: `<stateDir>/tui-overlay.ndjson`

[`src/hosts/two-pane/steps-view/tui-overlay.ts`](../../src/hosts/two-pane/steps-view/tui-overlay.ts) (new):

- `parseTuiOverlayLine(line)` / `serializeTuiOverlayLine(overlay)` — wire
  format. One JSON snapshot per line.
- `banner: null` is the **explicit "clear banner"** sentinel on the wire;
  the parser maps it to an `undefined` field on the in-memory shape so
  downstream uses `banner === undefined` as the absent test.
- Parent controller writes snapshots; child renderer (in
  [`steps-view-model.ts`](../../src/hosts/two-pane/steps-view/steps-view-model.ts))
  tails the file via `tailNdjson` and re-projects on every update.

### Renderer ([`steps-view.tsx`](../../src/hosts/two-pane/steps-view/steps-view.tsx))

- Footer derives from `state.view.mode`:
  - `live` → `▶ live · ⏎ view step · q quit · ? help` (no `f` token — it
    would be a no-op against the most-recent live source; the parallel-
    switcher pass will re-introduce it with cycle-between-branches
    semantics).
  - `replay` → `⏸ viewing ${stepName} · f live · ⏎ view another · q quit · ? help`.
  - `stepName` is truncated to 30 chars with `…` when longer.
- Banner renders as a **single line above the steps grid**: info is
  cyan/dim, error is red and appends `· Esc dismiss`.
- `Esc` precedence (in `useInput`): help-overlay-close → dismiss-error-
  banner → no-op. Info banners are NOT manually dismissable; they
  auto-clear.
- Auto-dismiss: `useEffect` keyed on the `banner` object reference. The
  controller emits a NEW banner object per `seq`, so identical-text
  successive emits reliably restart the `ttlMs ?? 4000` timer. Error
  banners do not auto-dismiss regardless of `ttlMs`.
- Help overlay (`?`) lists `f`, `Esc`, and the view-mode indicator.

### Intent ([`start-steps-view.ts`](../../src/hosts/two-pane/steps-view/start-steps-view.ts))

- `StepsIntentSchema` gains `{type:'dismiss-banner'}`.
- `StepsViewIntent` in `steps-view.tsx` extended to match.

### Controller ([`pane-map/right-pane-controller.ts`](../../src/hosts/two-pane/pane-map/right-pane-controller.ts))

Three new methods on the `RightPaneController` interface, plus a new
optional `tuiOverlayPath: Path` on `RightPaneControllerOptions`:

- `emitBanner({kind, text, ttlMs?})` — bumps monotonic `bannerSeq`, sets
  `currentBanner`, writes a snapshot to `tuiOverlayPath`. Caller passes
  everything except `seq`; the controller assigns it.
- `setViewMode(view)` — sets `currentView`, writes a snapshot. Independent
  of `banner` (both can change in the same projection cycle without
  one clobbering the other).
- `onIntent({type:'dismiss-banner'})` — clears `currentBanner`, writes a
  snapshot with `banner: null`. No-op when no banner is set.

When `tuiOverlayPath` is omitted (pre-U5 tests that don't exercise the
surface), the methods are in-memory no-ops past the state update — the
file write is silently skipped. The runtime guard is in
`writeTuiOverlay()`.

### Host wiring ([`tmux-host.ts`](../../src/hosts/two-pane/tmux-host.ts))

- Controller construction now passes
  `tuiOverlayPath: toPath(`${stateDir}/tui-overlay.ndjson`)`.

### Test surface added by U4

- [`tests/unit/hosts/two-pane/steps-view/tui-overlay.test.ts`](../../tests/unit/hosts/two-pane/steps-view/tui-overlay.test.ts) —
  10 tests covering parse/serialize round-trips, `banner: null`
  semantics, schema rejection (negative seq, unknown kinds, missing
  view).
- [`tests/unit/hosts/two-pane/steps-view/steps-view-banner.test.tsx`](../../tests/unit/hosts/two-pane/steps-view/steps-view-banner.test.tsx) —
  12 tests covering footer text per `view.mode`, 30-char stepName
  truncation, banner kind/style, Esc precedence (help-close > dismiss-
  banner > no-op), info-only auto-dismiss, seq-keyed timer restart, help
  overlay copy.
- [`tests/unit/hosts/two-pane/pane-map/right-pane-controller-banner.test.ts`](../../tests/unit/hosts/two-pane/pane-map/right-pane-controller-banner.test.ts) —
  6 tests covering `emitBanner` monotonic seq, `setViewMode` snapshot,
  no-op behavior without `tuiOverlayPath`, `onIntent('dismiss-banner')`
  clearing.
- Augmented [`steps-view-model.test.ts`](../../tests/unit/hosts/two-pane/steps-view/steps-view-model.test.ts) —
  4 tests for projector view/banner propagation defaults and through to
  terminal-status states.
- Augmented [`start-steps-view.test.ts`](../../tests/unit/hosts/two-pane/steps-view/start-steps-view.test.ts) —
  3 tests for `StepsIntentSchema` parsing including the new
  `dismiss-banner` variant.

### Tests touched (not added) in U4

- [`tests/unit/hosts/two-pane/steps-view/steps-view.test.tsx`](../../tests/unit/hosts/two-pane/steps-view/steps-view.test.tsx) —
  state fixtures gain `view: {mode:'live'}`; the static `↑/↓ ⏎ f ? q`
  keymap assertion is replaced by the view-mode-derived footer text
  contract (`▶ live · ⏎ view step · q quit · ? help`).
- [`tests/unit/hosts/two-pane/steps-view/end-of-run-summary.test.tsx`](../../tests/unit/hosts/two-pane/steps-view/end-of-run-summary.test.tsx) —
  state fixture gains `view: {mode:'live'}`.
- [`tests/unit/hosts/await-foreground-shutdown.test.ts`](../../tests/unit/hosts/await-foreground-shutdown.test.ts) —
  the local `IntentLike` shim adds `'dismiss-banner'` to the union so the
  composed handler typechecks.

## Deviations from the plan (U4)

The plan's U4 scope was honored end-to-end with one minor implementation
detail worth flagging:

1. **`useEffect` dep array uses the whole `banner` object, not just
   `banner.seq`.** The plan's pseudo-text says "keyed on `banner.seq`."
   The implementation keys on `banner` itself. This is functionally
   equivalent because the controller emits a NEW banner OBJECT for every
   snapshot (the seq monotonic counter guarantees a fresh reference), and
   it satisfies Biome's `useExhaustiveDependencies` rule without the
   `bannerSeq + banner + bannerTtl + bannerKind` over-specification it
   flagged. The seq-keyed timer-restart test in
   `steps-view-banner.test.tsx` still passes — it directly drives the
   "two banners with bumped seq" scenario and asserts the timer re-arms.

No other deviations.

## Deviations carried forward (from prior handover — still standing)

These remain unresolved and will land in the unit the prior handover
scheduled. Brief recap; the prior handover has the full reasoning.

1. **`onIntent` still uses the legacy `respawnPane`-based dispatch.**
   `onIntent('enter')` does NOT yet call `registerSource(replayKey)` +
   `showSource(replayKey)`. **U8 flips this** alongside the
   `right-pane-replay.integration.test.ts` migrations.
2. **Placeholder source is NOT auto-registered at controller boot, NOT
   swapped in at boot.** **U5 registers it** when it switches autonomous
   live to `file-tail`.
3. **`isRightPaneBusy` option preserved on the controller** because the
   legacy `respawnPane` path is still load-bearing. **U5 drops it** along
   with the `inFlight: Set<StepName>` in `tmux-host.ts`.
4. **`scratchSession` is OPTIONAL on `RightPaneControllerOptions`.** May
   be flipped to required in U5+ as part of test migrations, or left
   optional indefinitely; the runtime guard catches misuse.
5. **The old `src/hosts/two-pane/right-pane-controller.ts` is still a
   thin re-export shim** rather than deleted. **U10 deletes it** and
   updates the ~8 test files that import from the old path.

## What's next — U5 through U10

The plan's ordering is preserved. Dependencies form a DAG:

- **U5** — wire autonomous + command-step live to `file-tail` sources.
  Depends on U3 + U4. **This is where the U3 deferrals #2, #3, #4 from
  the prior handover resolve.** U5 is the first behavior-changing unit
  to consume U4's `emitBanner` / `setViewMode` — every `step:start`
  emits a "step N running — press f to follow" info banner when the
  user is on a replay; every `step:complete` flips `viewMode` to
  `{mode:'replay', stepName}` and emits a "step N complete" info
  banner; every `step:failed` emits an error banner unconditionally.
  Migrates `right-pane-live-output.test.ts`,
  `right-pane-live-doubling.real.integration.test.ts` (ungate the
  `ORCH_REPRO_BUG` skip), and `two-pane-mocked.test.ts`.
- **U6** — interactive runners → `pty` archetype. Depends on U3 + U4.
  Also consumes `emitBanner({kind:'error', …})` for resume-failure (the
  refusal text that the legacy controller writes via `respawnCatInline`
  becomes a banner). Migrates `two-pane-interactive.test.ts`,
  `two-pane-sequential-runs.test.ts`,
  `resume-launcher-mocked.integration.test.ts`,
  `resume-failure-mocked.integration.test.ts`.
- **U7** — rollup gets its own hidden pane + parallel-block lifecycle
  events. Depends on U3 + U4 + U5. Touches `src/core/workflow.ts` (new
  `step:parallel-start` / `step:parallel-complete` events).
- **U8** — past-step replay warm-cache + edge-case wiring. Depends on
  U3–U7. **Flips `onIntent('enter')` to the new swap-based path
  (resolves prior-handover deferral #1)**, calls
  `setViewMode({mode:'replay', stepName})` on each enter, and migrates
  `right-pane-replay`, `right-pane-busy-gate`, `kind-details` tests.
- **U9** — right-pane-source invariant guard test. Cross-cutting
  regression guard. Depends on U3–U8.
- **U10** — cleanup, docs, prior-doc archival. **Deletes the shim
  (prior-handover deferral #5)**, updates `docs/getting-started.md`,
  `docs/logging.md`, `docs/solutions/*`, marks prior brainstorms /
  plans as `status: superseded`.

The plan's "Each behavior-changing unit migrates its own previously-passing
tests in the same commit so `bun run check` stays green at every commit" rule
is non-negotiable. Migrate tests inline with the behavior change.

## How to consume the U4 surface (cheat sheet for U5+)

The new methods on the controller are:

```ts
// Caller passes everything but seq; the controller bumps + assigns it.
await controller.emitBanner({ kind: 'info', text: 'step X complete', ttlMs: 4000 })
await controller.emitBanner({ kind: 'error', text: 'resume failed' })

// Persistent footer indicator. Independent of banner — both can change in
// the same projection cycle without one clobbering the other.
await controller.setViewMode({ mode: 'replay', stepName: 'plan' })
await controller.setViewMode({ mode: 'live' })

// Dismiss-banner intent comes from the renderer's Esc handler. The
// controller's onIntent already dispatches; U5+ doesn't need to wire it
// again — just don't override `onIntent` without forwarding the new
// variant.
```

**Banner UX rules baked into U4** (so U5+ doesn't have to re-derive them):

- Single-slot, last-write-wins. Three errors in quick succession show
  only the third; the steps-view grid is the durable signal.
- Info banners auto-clear after `ttlMs ?? 4000`. Error banners persist
  until replaced or `Esc`-dismissed (when help overlay is closed).
- `seq` is monotonic per controller lifetime — the renderer's timer
  re-arms whenever a fresh banner object arrives (which the bumped `seq`
  guarantees).
- Cached steps: banner only, no `viewMode` change, no `registerSource`
  call. The plan's U5 spec covers the wiring.
- "step running — press f to follow" info banner fires when
  `registerSource` is called and `viewMode === {mode:'replay'}` (U5
  derives this — the controller doesn't auto-emit it from
  `registerSource`).

## Branch + commit policy

- Working directly on `main`. The user explicitly opted into this at the
  start of the work. Continue on `main` unless the user asks otherwise.
- Commits use Conventional Commits prefixed with `feat(scope)`,
  `refactor(scope)`, etc. No attribution footer for incremental commits.
- `bun run check` must be green before each commit. Lint baseline = 10
  warnings (all pre-existing complexity warnings in code outside this
  plan's scope; one warning was added by U4 — the `tui-overlay.ts`
  module-level surface is fine). Do not introduce new errors;
  `lint:fix` handles `organizeImports` and React-deps simplifications.

## Project rules to keep in mind

These are codified in [`CLAUDE.md`](../../CLAUDE.md) and worth re-reading:

1. **Subprocess isolation** — all subprocess calls go through `ProcessService`.
   `tail` runs INSIDE a tmux pane (via `splitPane(... argv: ['tail', ...])`),
   not via a `Bun.spawn` call. This stays true under the pane-map plan.
2. **Mock only at the edge** — unit tests mock `*Service` ports only. The
   pane-map unit tests use `FakeTmuxService` directly. Don't mock
   `RightPaneController` itself — exercise it via its real methods. The
   U4 tests follow this — `right-pane-controller-banner.test.ts` writes
   real files into a tempdir and reads them back rather than mocking
   `appendFile`.
3. **TypeScript strict** — no `any`, no `!`. The discriminated unions in
   `pane-spec.ts` and the new `Banner` / `ViewMode` / `TuiOverlay` are
   `readonly`-by-default; preserve that.
4. **File size ≤ 300 LOC** is a warning. `pane-map/right-pane-controller.ts`
   is currently around 580 lines because it ports the legacy onIntent
   path verbatim and now also carries the U4 emit/setViewMode/dismiss
   methods. U5/U6/U8 should bring it down to ≤ 300 as the legacy
   helpers (`dispatchByKind`, `respawnCatInline`, `respawnCatPath`,
   `dispatchAgentInteractive`) get replaced by the new methods. The
   plan's U10 accepts that `tmux-host.ts` stays above the warning cap.
5. **`bun run check` is the gate.** Green at every commit, including
   `bun run typecheck` (which the project's `check` runs).

## Quick orientation commands

```sh
# Re-read the plan
less docs/plans/2026-05-11-001-feat-decouple-live-runner-unified-pane-map-plan.md

# See what changed since main
git log --oneline -5

# Run the gate
bun run check

# Run only the pane-map / banner tests
bun test tests/unit/hosts/two-pane/pane-map/
bun test tests/unit/hosts/two-pane/steps-view/steps-view-banner.test.tsx
bun test tests/unit/hosts/two-pane/steps-view/tui-overlay.test.ts
bun test tests/integration/hosts/two-pane/pane-map-scratch-session.real.integration.test.ts

# See the pane-map module
ls src/hosts/two-pane/pane-map/
ls src/hosts/two-pane/steps-view/
```

## When stuck

- The plan is authoritative. If this handover conflicts with the plan,
  the plan wins.
- The user is reachable. Ask for direction on plan deviations rather
  than guessing.
- Don't try to "fix" the prior-handover or U4 deferrals listed above by
  changing already-committed code — handle them in the unit they're
  scheduled for (U5, U8, U10).
- If a test feels wrong, check what unit it belongs to (the plan lists
  test migrations per unit). Don't migrate a test in U-N if U-M+1 owns
  it — that bloats the diff and breaks the per-commit `bun run check`
  gate.
- The new banner/view-mode surface is **plumbing only** in U4. If a
  question arises about who emits which banner (e.g. cached-step,
  failure, "running — press f to follow"), the plan's per-unit Files
  + Approach sections are authoritative. The controller does NOT
  auto-emit banners from `registerSource` / `unregisterSource` — U5+
  emits them explicitly.
