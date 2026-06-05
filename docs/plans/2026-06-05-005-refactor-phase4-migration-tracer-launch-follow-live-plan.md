---
status: active
type: refactor
title: "refactor: Phase 4 (U4) — migration tracer, launch + follow-live end-to-end"
created: 2026-06-05
parent: docs/plans/2026-06-05-001-refactor-testing-strategy-restructure-plan.md
origin: docs/plans/2026-06-05-001-refactor-testing-strategy-restructure-plan.md
depth: deep
---

> **Landed 2026-06-05.** Real-tmux `selectStep`/`followLive` navigation built in
> the shared pane driver (proven by the `screen` driver's keystroke tests; the
> single-pane fixture was made interactive — the **K2** path). Model/screen/
> full-host/lifecycle scenarios for `launch` + `follow-live` added and green; the
> overlap report is **blocking** and on the gate; the eight in-area old files are
> `.skip` + `// MIGRATED →` with case-granular ledger rows.
>
> **Deviation (honest):** the full-host *navigation* (`selectStep`/`followLive`)
> regression lives on the `screen` driver, not full-host. The navigation protocol
> is shared code (`real-tmux-pane-driver.ts`); the full-host live submode holds a
> **single** step handle, so a 2-step "navigate to a past step then return" run
> hangs at teardown (the undriven second puppet step never settles). Per the
> decision rule (§6) full-host's risk is two-pane *communication*, so its U4.5
> scenario proves the live mid-stream interleave (content reaching the visible
> right pane) instead — and `launch--first-step-shows-live-source` was **folded**
> into the existing `follow-live--right-pane-swaps-source` tracer rather than
> duplicated. Multi-step live navigation would need a driver extension (deferred).

# refactor: Phase 4 (U4) — migration tracer (`launch` + `follow-live`) end-to-end

> **This elaborates master unit U4** of
> [`docs/plans/2026-06-05-001-refactor-testing-strategy-restructure-plan.md`](2026-06-05-001-refactor-testing-strategy-restructure-plan.md).
> Phases 1–3 (U1–U3) are landed (see [`docs/plans/phase-summaries.md`](phase-summaries.md)).
> This plan fixes the **concrete, ordered steps** for U4 only. It does not
> relitigate any master decision (D1–D15) or interface (§5 of the parent) — it
> honours them. Sub-units below are numbered `U4.1`…`U4.7`; they are internal to
> this phase and do **not** consume new master U-IDs.

---

## 1. Summary

U4 is the **migration tracer**: it validates the *entire* strangler mechanic on
the first two real feature areas — `launch` and `follow-live` — by re-deriving
their behaviour across **every** driver (`model`, `screen`,
`full-host:fake-agent`, `lifecycle`), producing **case-granular ledger rows**
for every old file it fully migrates, **flipping the overlap report to
blocking**, and wrapping the migrated old files in `.skip` with a
`// MIGRATED → <path>` marker. It proves the recipe at the cost of ~two areas,
not the whole backlog (master §7, U4).

The work is **not** purely "write scenarios." Two driver affordances were
honestly deferred by U2 behind `notImplemented` and are the load-bearing
*implementation* this phase unblocks:

1. **Real-tmux navigation** — `selectStep()` / `followLive()` over the
   `screen` + `full-host` real-tmux pane driver
   (`tests-new/dsl/drivers/real-tmux-pane-driver.ts:52-59`). Today they throw
   `notImplemented`. `follow-live` cannot be re-derived above the `model` seam
   without them. **This is the highest-risk item in U4** (a keystroke-driven
   navigation protocol over real tmux, exactly the surface the parent flagged as
   net-new/highest-risk).
2. **Full-host live-driven interleave scenario** — the `liveDriven: true`
   submode *capability* exists (`full-host-fake-agent-driver.ts:67-163`,
   `app.agent.type/finish`), but the actual mid-stream-keypress scenario was
   deferred to "the first migration unit that needs it" (parent U4, phase-2
   summary). U4 writes it; it is the unblock of the deferred Tier-1 placeholder
   `follow-live-returns-to-running-step`.

Everything else U4 needs is already live: the `model` driver's `selectStep`/
`followLive` work (`model-driver.ts:144-161`), the `screen` footer-byte path
works, the `full-host:fake-agent` right-pane path works, the `lifecycle`
process-shutdown path works, and the overlap report already passes green
(13 scenarios, no missing twins, all `oldTestRefs` resolve).

**Triage is part of the mechanic, not a follow-up.** Some old "launch behavioral"
cases assert *rendering bytes* (header, glyph, footer) under the full real-tmux
host. Per the decision rule (parent §6), rendering bytes belong to `screen`, not
`lifecycle`; so those cases **demote** to `screen` (+ `model` for the
projection), and the `lifecycle` launch concern shrinks to *process boot/teardown*
— which the lifecycle driver already covers without the (still-deferred)
lifecycle pane-reads. This keeps U4 a true tracer and **avoids building lifecycle
subprocess-snapshot pane-reads**, which stay `notImplemented` for U8.

---

## 2. Scope boundary

### In scope (U4)
- Re-derive `launch` + `follow-live` across all four non-real-CLI drivers.
- Build the real-tmux navigation protocol (`selectStep`/`followLive`) once, in
  the shared real-tmux pane driver, used by `screen` + `full-host`.
- Write the full-host live-driven interleave `follow-live` scenario.
- Flip `overlap-report.ts` to **blocking** and wire it onto the gate.
- Ledger every case of the ~8 wholly-in-area old files at case granularity;
  `.skip` + `// MIGRATED →` each one (D2, D15).
- Backfill `oldTestRefs` on the three U2/U3 tracers that already point at real
  `launch`/`follow-live` baseline files, and record their ledger rows.

### Out of scope (deferred, with destination)
- **Lifecycle subprocess-snapshot pane-reads** (`deferredPaneDriver()`,
  `lifecycle-driver.ts:117-129`) — remain `notImplemented`; land in **U8** (the
  lifecycle cluster) when a scenario genuinely needs to read a pane over the
  subprocess. U4's lifecycle coverage uses `press`/`signal`/`system` only.
- **Bulk left-pane rendering** (selection, scroll, adaptive columns, banner ttl,
  end-of-run colours, step glyphs beyond the launch glyph) — **U5** (`### Deferred
  to Follow-Up Work`). The files `steps-view.test.tsx`, `steps-view-scroll.test.tsx`,
  `preview-cursor.test.tsx`, `key-intent-mapping.test.tsx`, `header-rerender.test.tsx`,
  `end-of-run-footer.test.tsx` are **not** skipped here (they span multiple areas;
  skipping before every case is ledgered is the green-but-incomplete trap D15 exists
  to prevent).
- **Pane-map / right-pane-controller** (`right-pane-on-intent.test.ts`,
  `right-pane-controller-interactive-dead-pane.test.ts`,
  `resume-launcher-mocked.integration.test.ts`) — **U7**.
- **`launch-smoke.real.test.ts`** (behavioral-dsl launcher smoke — infra
  self-test, 4 cases) — **U8** (lifecycle/behavioral-dsl), not an area behaviour.
- **`persistedStatus('cancelled')` on shutdown** — a pre-existing `main` gap
  (phase-2 deviation; the run stays `running`). U4 does **not** assert it; it is
  flagged for later product triage, not owned here.
- Reconciliation (`reconcile.ts`) — **U14**.

---

## 3. Inherited decisions in force (from the parent — do not relitigate)

D1 (whole-repo scope), **D2** (skip-as-migrated, keep forever, edits limited to
`describe.skip`/`it.skip` + `// MIGRATED →`), **D8** (selection by path),
**D10** (chrome literals co-located on Pane Objects, never inlined in scenarios),
**D11** (`tests-new/` typechecked — the navigation affordances are typed surfaces),
**D12** (accounting against the FROZEN `baseline.json`, never a live scan),
**D15** (case-granular ledger; a file is skipped only when **every** child case is
mapped). The decision rule (parent §6) is the triage law for every disposition.

---

## 4. Phase-local key decisions

| # | Decision | Choice | Rationale |
|---|---|---|---|
| K1 | **Where the real-tmux navigation protocol lives** | In the shared `real-tmux-pane-driver.ts`, behind a new `sendKey(key)` dep injected by each driver. Built **once**; `screen` and `full-host` both get it. | "Build once, clearer forever" (parent north star). The protocol is identical; only the keystroke transport differs per driver. |
| K2 | **Make the single-pane `screen` fixture interactive** | Wire the `single-pane-steps-entry` to update its `view` mode from `StepsView`'s `onIntent` (mirroring the `model` driver's `ModelHarness`, `model-driver.ts:64-81`), and expose a `sendKey` on `SinglePaneStepsFixture`. | Lets the `screen` follow-live twin prove the **live→replay footer flip via real navigation** (the third `view-mode-footer.test.tsx` case), not just static footer bytes. Same protocol as full-host. **Fallback (K2-alt):** if the interactive entry proves too costly within the phase, extend `SinglePaneStepsSpec` with an optional `viewMode` and assert each footer mode from a synthetic launch state; the navigation protocol then ships on `full-host` only and `screen` selectStep/followLive stay `notImplemented` until U5. Pick K2-alt only if K2 blows the phase budget; record the choice in the phase's ledger header. |
| K3 | **`selectStep` mechanics over real tmux** | Arrow-key navigation: from the current preview/committed row, send ↑/↓ to reach the target index, then Enter to commit; poll `assertSelected(step)` to a bounded deadline. `followLive()` presses `f` with **poll-and-resend** (idempotent, mirrors `model-driver.ts:152-161` and lifecycle `snapToLive()`). | Over real tmux the only input is keystrokes. Poll-and-resend on the idempotent `f` defeats the documented dropped-first-keypress race (REGRESSION 2026-05-29 nav.f-snaps). |
| K4 | **`lifecycle` launch coverage = process boot, not bytes** | The lifecycle launch scenario launches, lands mid-step, and asserts `system.exitedNormally()` + `system.tmuxTornDown()` after a clean shutdown — **no pane reads**. The rendering assertions of the old launch behavioral tests **demote** to `screen` + `model`. | Decision rule (parent §6): rendering bytes ≠ process behaviour. Keeps lifecycle pane-reads deferred to U8 and keeps U4 a tracer. |
| K5 | **Overlap report becomes blocking on the gate** | `overlap-report.ts` exits non-zero when findings exist; `bun run overlap-report` is added to the `check` gate (and `test:two-pane:fast` for the tight loop). | Parent §U3/§U4: U4 is the first phase whose Verification can fail on a red report. The report already passes green today, so the flip is safe. |
| K6 | **Right-pane "tracks live step" assertion uses the content escape hatch** | The live-interleave scenario asserts `rightPane.assertShowsContent(<text the live agent typed>)`, not a new `assertShowsLiveStep` chrome method. | The §9.5 parent sketch named `assertShowsLiveStep`, but `RightPane` (`right-pane.ts`) has no such method and inventing chrome semantics is out of scope for a tracer. The text is test-authored content → the existing escape hatch (D10-compliant). |

---

## 5. Implementation units (ordered)

> Driver wiring first (U4.1–U4.2), then scenarios (U4.3–U4.5), then the machinery
> flip + ledger/skip (U4.6–U4.7). Each unit leaves `bun run check` green.
> **Execution posture: test-first for the driver affordances** — they are
> feature-bearing infrastructure and the real-tmux lifecycle is where every
> historical flake lived; write the driver-level assertion before the protocol.

### U4.1 — Real-tmux key transport (fixture + harness plumbing)

**Goal.** Give the real-tmux pane driver a way to *send* a keystroke, without yet
adding navigation semantics.

**Requirements.** K1, K2; parent §5.4 (predictability rules stay inside drivers).

**Dependencies.** None (first unit).

**Files.**
- `tests-new/_support/real-tmux/single-pane-steps-fixture.ts` — add a
  `sendKey(input: NamedKey | string): Promise<void>` to `SinglePaneStepsFixture`,
  implemented via the existing `sendKeysToPane({ tmux, socket, target: paneId }, input)`
  (`keys.ts:62`). Make the `single-pane-steps-entry` interactive (K2): hold
  `view` in local state, update it from `StepsView`'s `onIntent`, mirroring
  `model-driver.ts:64-81`. *(If K2-alt: instead extend `SinglePaneStepsSpec`/
  `synthetic-steps-state.ts` with an optional `viewMode` and skip the interactive
  wiring.)*
- `tests-new/_support/real-tmux/single-pane-steps-entry.tsx` — the interactive
  wiring (or the `viewMode` honouring, under K2-alt).
- `tests-new/dsl/drivers/real-tmux-pane-driver.ts` — extend
  `RealTmuxPaneDriverDeps` with `sendKey(input): Promise<void>`; the two driver
  call sites supply it (`screen` → `fixture.sendKey`; `full-host` →
  `harness.sendKeysToPaneId(paneId, …)`).
- `tests-new/_support/real-tmux/index.ts` — re-export any new public type if the
  fixture's surface widened.

**Approach.** Pure transport in this unit: `sendKey` puts a keystroke on the
correct pane. No polling/commit logic yet (that is U4.2). The full-host harness
already exposes `sendKeysToPaneId`/`sendKeys` (`workflow-driver.ts:287-352`); the
screen single-pane fixture is the only one missing a send path.

**Patterns to follow.** `keys.ts` (`sendKeysToPane`, `NamedKey`); the model
harness intent→state wiring (`model-driver.ts:64-81`); `workflow-driver.ts`
key-send.

**Test scenarios** *(driver-level, under `tests-new/dsl/drivers/__tests__/`)*:
- `single-pane fixture: sendKey('Down') reaches the steps pane and the captured
  frame reflects a moved preview cursor` *(integration / real-tmux)*. Under K2-alt:
  `launch with viewMode:'replay' renders the replay footer bytes`.
- `full-host harness sendKey path targets the left pane id` — assert via a captured
  frame change after an arrow key *(integration)*.
- `sendKey is a no-op-safe before launch throws a clear error` *(error path)*.

**Verification.** `bun run test:two-pane:screen` and `:full:fake` green; the new
fixture method has a driver-level test; no behaviour scenarios touched yet.

---

### U4.2 — Navigation protocol: `selectStep` / `followLive` over real tmux

**Goal.** Replace the two `notImplemented` throws
(`real-tmux-pane-driver.ts:52-59`) with a real, race-safe keystroke navigation
protocol.

**Requirements.** K1, K3; REGRESSION 2026-05-29 nav.f-snaps; parent §5.4.

**Dependencies.** U4.1.

**Files.**
- `tests-new/dsl/drivers/real-tmux-pane-driver.ts` — implement `selectStep` and
  `followLive` using `deps.sendKey` + `deps.handle.waitFor`/`stepNames`.
- `tests-new/dsl/drivers/frame-text.ts` — add a `previewCursorStepName(frame, stepNames)`
  helper if the committed-vs-preview distinction is needed to compute arrow deltas
  (the committed highlight helper `highlightedStepName` already exists). *(Exact
  cursor glyph/column detection is execution-time detail — confirm against a real
  captured frame before finalizing the helper.)*
- `tests-new/dsl/drivers/__tests__/screen-driver.test.ts`,
  `…/full-host-fake-agent-driver.test.ts` — add navigation regression tests.

**Approach (directional — not implementation spec).**
```
selectStep(step):                          followLive():
  target = indexOf(step)                     // f is idempotent w.r.t. committed==live
  for bounded attempts:                      poll-and-resend:
    cur = previewCursorStepName(capture)       sendKey('f')
    if cur == step: sendKey('Enter'); break    if assertSelected(liveStep) within short window: done
    sendKey(cur < target ? 'Down' : 'Up')      else resend (bounded)
  waitFor(committed == step)               waitFor(committed == liveStep)
```
`followLive` mirrors the proven model/lifecycle poll-and-resend; `selectStep`
moves the preview cursor then commits with Enter, then polls the committed
selection. Both are bounded by `REAL_TMUX_ASSERT_TIMEOUT_MS` (already a dep).

**Execution note.** Start with the **failing** navigation regression test on
`screen` (`selectStep` then `assertSelected`) before wiring the protocol — this
boundary (keystroke race over real tmux) is where flakes live.

**Patterns to follow.** `model-driver.ts:144-161` (the intent/`f`-resend shape at
the projection seam — the real-tmux version must reproduce the same *observable*
contract); lifecycle `snapToLive()` poll-and-resend; `pane-handle.ts` `waitFor`.

**Test scenarios** *(driver-level)*:
- `screen: selectStep('plan') commits the highlight to 'plan'` over real tmux *(critical / integration)*.
- `screen: followLive() returns the committed highlight to the live step, resending f until it lands` *(critical)* — REGRESSION 2026-05-29 nav.f-snaps.
- `full-host: selectStep + followLive drive the real host's committed selection` *(critical)*.
- `selectStep to an out-of-range step name throws a clear error, not a hang` *(error path)*.

**Verification.** `bun run test:two-pane:tmux` green; the affordances no longer
throw `notImplemented` (grep confirms the two throws in `real-tmux-pane-driver.ts`
are gone); driver regression tests pass under the §D6 concurrency ceiling.

---

### U4.3 — `model` scenarios for `launch` + `follow-live`

**Goal.** Re-derive the projection-seam (controller-decision) coverage for both
areas on the `model` driver — the bulk, fast, no tmux.

**Requirements.** Parent §6 (decision rule), §9.2; D10, D15.

**Dependencies.** None (model affordances already live). Sequenced here so the
`overlapGroup`s exist before U4.6 flips the report to blocking.

**Files (create).** Under `tests-new/model/`:
- `launch--first-step-running-and-highlighted.test.ts` — running glyph on the
  first/live step (projection). `overlapGroup: 'launch-first-step'`.
- `launch--header-and-step-list-render.test.ts` — header + every step row + live
  footer selected (projection). `overlapGroup: 'launch-render'`.
- `follow-live--prefers-live-over-interactive-replay.test.ts` — after entering a
  past step, follow-live re-selects the live step over an interactive replay
  (the model-level intent the old Tier-2 mocked test asserted).
- *(existing)* `follow-live--returns-to-running-step.test.ts` already covers the
  core follow-live model case (`overlapGroup: 'follow-live-view-mode'`).

**Approach.** Use `app.launch({ steps, stopAt: 'mid-step' })`,
`app.leftPane.selectStep(...)`, `app.leftPane.followLive()`,
`assertStepSelected`, `assertGlyph('…','running')`, `assertQuitHintVisible`.
Chrome stays semantic (D10). Each scenario carries `oldTestRefs` to the exact
frozen-baseline path(s) it re-derives.

**Patterns to follow.** `tests-new/model/follow-live--returns-to-running-step.test.ts`
(existing model tracer); `model-driver.ts` affordances.

**Test scenarios.** (the scenarios *are* the tests — one `scenario()` each)
- `launch--first-step-running-and-highlighted [model]` asserts the running glyph
  on the live step. `Covers` the projection half of
  `launch.first-step-is-running-and-highlighted`.
- `launch--header-and-step-list-render [model]` asserts header + step rows + the
  live-mode footer hint.
- `follow-live--prefers-live-over-interactive-replay [model]` asserts follow-live
  re-selects the live step after a replay enter.

**Verification.** `bun run test:two-pane:model` green; all three new model
scenarios pass against real controller logic; no tmux booted.

---

### U4.4 — `screen` scenarios (byte twins) for `launch` + `follow-live`

**Goal.** Prove the *rendering bytes* survive real tmux for the launch render and
the follow-live footer flip — the `screen` contract twins of the U4.3 model
scenarios.

**Requirements.** Parent §6, §9.4; D4, D10; the `model↔screen` overlap (parent §5.5).

**Dependencies.** U4.2 (navigation, for the footer-flip twin under K2),
U4.3 (the model members of the shared `overlapGroup`s).

**Files (create).** Under `tests-new/screen/`:
- `launch--header-and-step-list-render.test.ts` — header + step row + live footer
  **bytes**. `overlapGroup: 'launch-render'` (twin of U4.3).
- `launch--first-step-running-and-highlighted.test.ts` — running glyph **bytes**.
  `overlapGroup: 'launch-first-step'`.
- `follow-live--footer-flips-live-to-replay.test.ts` — navigate into a step
  (`selectStep`), assert the **replay** footer bytes; `followLive()`, assert the
  **live** footer bytes return. `overlapGroup: 'follow-live-view-mode'`.
- *(existing)* `follow-live--footer-renders-with-quit-hint.test.ts` already
  covers the live-footer quit-hint bytes for that group.

**Approach.** `app.resize(80, 24)` then `app.launch(...)`; assert via co-located
chrome methods (`assertQuitHintVisible`, `assertGlyph`, a `followHint`/replay
footer assertion on `LeftPane`). The footer-flip twin exercises U4.2 navigation.
*(K2-alt path: launch at each `viewMode` and assert the footer bytes without
navigation; the scenario then drops `selectStep`/`followLive`.)*

**Patterns to follow.** `tests-new/screen/follow-live--footer-renders-with-quit-hint.test.ts`;
`screen-driver.ts`; `LeftPane` chrome constants (`left-pane.ts:20-23`) — extend
`TEXT` with the replay-footer literal if a new co-located chrome string is needed
(D10: mirror production wording, never import from `src/`).

**Test scenarios.**
- `launch--header-and-step-list-render [screen]` matches header/step/footer bytes.
- `launch--first-step-running-and-highlighted [screen]` matches the running glyph byte.
- `follow-live--footer-flips-live-to-replay [screen]` proves the replay↔live
  footer flip over real navigation (K2) — `Covers` the third
  `view-mode-footer.test.tsx` case.

**Verification.** `bun run test:two-pane:screen` green; every new screen scenario
shares an `overlapGroup` with a U4.3 model twin (so the report stays green when
blocking).

---

### U4.5 — `full-host:fake-agent` + `lifecycle` scenarios

**Goal.** Exercise the two remaining drivers in-area: the full-host live-interleave
(the deferred-placeholder unblock) and the lifecycle process-boot launch.

**Requirements.** Parent §4 (live-driven submode), §9.5, §9.8; K4, K6;
REGRESSION leaked-puppets.

**Dependencies.** U4.2 (full-host navigation for the interleave).

**Files (create).**
- `tests-new/full-host/fake-agent/follow-live--keypress-during-stream.test.ts` —
  `liveDriven: true`. Interleave: `app.agent.type('…')`, `app.leftPane.selectStep(…)`,
  `app.leftPane.followLive()`, `app.agent.finish()`, then
  `app.rightPane.assertShowsContent(<typed text>)` (K6). This is the scenario the
  old Tier-1 file was *deferred* on — the live submode closes the gap.
- `tests-new/full-host/fake-agent/launch--first-step-shows-live-source.test.ts` —
  the right-pane "live source" half of `launch.first-step-is-running-and-highlighted`
  (autonomous transcript reaches the visible right pane after step start).
  *(May fold into the existing `follow-live--right-pane-swaps-source.test.ts`
  coverage; keep separate only if it asserts a distinct launch behaviour.)*
- `tests-new/lifecycle/launch--boots-to-mid-step-and-tears-down.test.ts` — launch
  to mid-step, `system.exitedNormally()` + `system.tmuxTornDown()` after a clean
  shutdown (K4 — **no pane reads, no `persistedStatus('cancelled')`**).

**Approach.** Reuse the existing full-host live submode (`app.agent`,
`full-host-fake-agent-driver.ts:103-163`) and lifecycle `press`/`signal`/`system`
(`lifecycle-driver.ts:182-199`). The lifecycle scenario picks a fixture by step
list via `FIXTURE_BY_STEPS` (`lifecycle-driver.ts:66-70`) — use `['plan','execute']`
(→ `two-step-linear`) or `['work']` (→ `single-agent-step`).

**Patterns to follow.** `tests-new/full-host/fake-agent/follow-live--right-pane-swaps-source.test.ts`;
`tests-new/lifecycle/follow-live--ctrl-c-exits-and-tears-down.test.ts` (the honest
`persistedStatus` deviation note carries forward).

**Test scenarios.**
- `follow-live--keypress-during-stream [full-host:fake-agent]` — mid-stream
  navigation snaps the visible pane and the typed content shows *(integration / critical)*.
- `launch--first-step-shows-live-source [full-host:fake-agent]` — live source in
  the right pane after step start, no caret echo *(integration)*.
- `launch--boots-to-mid-step-and-tears-down [lifecycle]` — clean exit + teardown,
  zero leaked puppets *(critical)* — REGRESSION leaked-puppets.

**Verification.** `bun run test:two-pane:full:fake` and `bun run test:two-pane:lifecycle`
green under the concurrency ceiling; the live-interleave scenario reaches
`app.agent` only via `liveDriven: true`.

---

### U4.6 — Flip the overlap report to blocking + wire onto the gate

**Goal.** Make a red overlap report fail the phase (parent §U3/§U4).

**Requirements.** K5; parent §5.3, §5.5, §8; D12.

**Dependencies.** U4.3–U4.5 (so all real `overlapGroup`s and `oldTestRefs` exist
and the report is green *before* it becomes blocking).

**Files (modify).**
- `tests-new/_migration/overlap-report.ts` — `process.exit(findings.missingTwins.length
  + findings.unknownOldRefs.length > 0 ? 1 : 0)` (lines 224-230); update the
  banner string ("BLOCKING (U4+)" instead of "NON-BLOCKING in U3").
- `package.json` — add `overlap-report` to the `check` gate (e.g. after `test`),
  and to `test:two-pane:fast` or a dedicated `check` step so the tight loop sees
  it. Keep it path-pure (it AST-parses, registers zero Bun tests).
- `tests-new/_migration/__tests__/overlap-report.test.ts` — add a unit test that a
  **planted** missing-twin and a planted unknown-old-ref each make `analyze`
  report a finding and the runnable report exit non-zero (assert via the pure
  `analyze`/`renderFindings` core, not by importing scenario files).

**Approach.** The pure `analyze` already computes both finding classes
(`overlap-report.ts:136-169`); only the exit code + gate wiring change. Confirm
the report still **registers zero Bun tests** when run (it imports `typescript`
and reads source text only).

**Test scenarios.**
- `analyze flags a model overlapGroup with no real-tmux twin` *(critical)*.
- `analyze flags an oldTestRefs entry absent from the frozen baseline` *(critical)*.
- `the runnable report exits non-zero when findings exist, zero when clean` *(happy/error)*.

**Verification.** `bun run overlap-report` exits 0 today (green) and is now on the
`check` gate; introducing a deliberate missing-twin locally makes `bun run check`
go **red**, then revert.

---

### U4.7 — Ledger every migrated case + `.skip` the old files

**Goal.** Account for every child case of the ~8 wholly-in-area old files at case
granularity, then wrap each file `.skip` with a `// MIGRATED →` marker (D2, D15).

**Requirements.** D2, D12, D15; parent §7 (migration recipe), §9.10 (ledger row shape).

**Dependencies.** U4.3–U4.6 (the new scenarios must be green and the report
blocking-green before any old file is skipped).

**Files (modify).**
- `tests-new/_migration/ledger.md` — replace the illustrative rows with real
  per-case rows for the files below; record the K2-vs-K2-alt choice in the header.
- The old files (edits limited to `describe.skip`/`it.skip` + a one-line
  `// MIGRATED → <new path>` marker — **no other change**, D2):
  1. `tests/integration/hosts/two-pane/tier-1/follow-live-returns-to-running-step.real.integration.test.ts` — `port` → model + full-host interleave.
  2. `tests/integration/hosts/two-pane/tier-1/view-mode-footer-reflects-mode.real.integration.test.ts` — `port`/`demote→screen` → screen footer twins.
  3. `tests/integration/hosts/two-pane/tier-1/autonomous-live-pane-shows-content.real.integration.test.ts` — `port` → existing full-host fake tracer.
  4. `tests/unit/hosts/two-pane/steps-view/view-mode-footer.test.tsx` (3 cases) — `demote→screen`/`port→model`.
  5. `tests/integration/hosts/two-pane/follow-live-prefers-live-over-interactive-replay.integration.test.ts` — `port` → model.
  6. `tests/integration/lifecycle/launch.workflow-header-and-step-list-render.behavioral.real.test.ts` — `demote→screen` (+ model) for render; lifecycle boot covered by U4.5.
  7. `tests/integration/lifecycle/launch.first-step-is-running-and-highlighted.behavioral.real.test.ts` — `port` split across model (glyph) + screen (glyph bytes) + full-host (live source).
  8. `tests/integration/lifecycle/launch.interactive-badge-renders-on-interactive-step.behavioral.real.test.ts` (`it.todo`) — `drop` with reason (blocked todo, never executed; re-derive when an interactive fake runner exists — parent U9/recorded).

  Plus backfill ledger rows for the **already-skipped-nothing** U2/U3 tracers
  whose `oldTestRefs` point at files 1–3 above (the rows the templates marked
  "illustrative — landed by U4").

**Approach.** For each file, open the frozen baseline entry, enumerate its child
cases, map **every** case to `port`/`merge`/`demote`/`drop` + reason, and only
then skip the file. Apply the **triage rule** (parent §6): a case that "would still
pass if the pane were empty/wrong" → `demote` or `drop` with a recorded reason. Do
**not** skip any file outside the eight (the multi-area files stay live for U5–U7).

**Test scenarios.** *Test expectation: none — this unit is ledger bookkeeping +
`.skip` edits.* Its correctness is enforced by U4.6's blocking overlap report
(every `oldTestRefs` must resolve) and, later, U14's reconciliation (every skipped
case must be ledgered). Sanity check: after skipping, `bun test tests/unit tests/integration`
still collects (skipped, not failing) and `bun run check` is green.

**Verification.** The eight old files are `.skip` with `// MIGRATED →` markers;
`ledger.md` has a row for every child case with a disposition + reason; every
`drop` carries a reason; `bun run overlap-report` green and blocking;
`bun run check` green (old skipped suite + new green suite).

---

## 6. Dependency graph

```
U4.1 (key transport) ──▶ U4.2 (navigation protocol) ──▶ U4.4 (screen twins)
                                          │                       │
                                          └──▶ U4.5 (full-host live + lifecycle)
U4.3 (model scenarios) ─────────────────────────────────────────┤
                                                                 ▼
                                          U4.6 (flip report blocking) ──▶ U4.7 (ledger + .skip)
```

U4.3 has no code dependency and can run in parallel with U4.1/U4.2, but U4.6 and
U4.7 must come last (report goes blocking only once all groups/refs exist; files
are skipped only once their replacements are green).

---

## 7. Definition of Done (U4)

- `launch` + `follow-live` are re-derived across `model`, `screen`,
  `full-host:fake-agent`, and `lifecycle`; every new scenario is green at its level.
- `selectStep`/`followLive` over real tmux are implemented (no `notImplemented`
  throws remain in `real-tmux-pane-driver.ts`); driver regression tests cover them.
- The full-host live-driven interleave `follow-live` scenario exists and passes —
  the deferred Tier-1 placeholder is unblocked.
- The overlap report is **blocking** and green, wired onto `bun run check`.
- The eight in-area old files are `.skip` with `// MIGRATED →` markers; `ledger.md`
  accounts for **every** child case at case granularity with a disposition + reason.
- Lifecycle pane-reads and the bulk left-pane rendering files remain untouched and
  un-skipped (deferred to U8 / U5 respectively).
- `bun run check` green (old skipped tree + new tree); the concurrency ceiling
  (`tmux`=2, `lifecycle`=1 serial) holds with zero socket/puppet accumulation.

---

## 8. Risks & mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| **Real-tmux navigation is flaky** (keystroke race, preview-cursor detection). The highest-risk item. | High | Test-first driver regression (U4.2 execution note); poll-and-resend on idempotent `f` (K3, the proven model/lifecycle pattern); bounded by `REAL_TMUX_ASSERT_TIMEOUT_MS`; run under the §D6 ceiling. K2-alt fallback removes screen-side navigation entirely if needed. |
| **Interactive single-pane entry (K2) costs more than budgeted.** | Medium | K2-alt: drive the screen footer via a synthetic `viewMode` spec; ship navigation on full-host only; record the choice. |
| **`previewCursorStepName` helper guesses the cursor glyph/column wrong.** | Medium | Confirm against a real captured frame before finalizing (flagged as execution-time detail in U4.2); reuse the existing `highlightedStepName` machinery in `frame-text.ts`. |
| **Skipping a file before all its cases are ledgered** (green-but-incomplete, D15). | Medium | Only the eight wholly-in-area files are skipped; multi-area files explicitly stay live for U5–U7; U4.6's blocking report + U14 reconciliation are machine guards. |
| **Asserting `persistedStatus('cancelled')`** reintroduces the false claim from the main gap. | Low | K4: lifecycle launch scenario asserts only `exitedNormally`/`tmuxTornDown`; the deviation note carries forward from the U2 tracer. |
| **Overlap report flip breaks the gate on a pre-existing red.** | Low | The report already passes green today (verified: 13 scenarios, no findings); the flip is sequenced after U4.3–U4.5 so all new groups/refs resolve first. |
```

