---
status: active
type: refactor
title: "refactor: Phase 8 (parent U8) — lifecycle / outside-in migration into tests-new/"
created: 2026-06-06
parent: docs/plans/2026-06-05-001-refactor-testing-strategy-restructure-plan.md
origin: docs/brainstorms/2026-06-05-testing-strategy-restructure-spec.md
depth: deep
---

# refactor: Phase 8 (parent U8) — lifecycle / outside-in migration

> **This is a phase-detail plan.** It elaborates parent unit **U8** of
> [`docs/plans/2026-06-05-001-refactor-testing-strategy-restructure-plan.md`](2026-06-05-001-refactor-testing-strategy-restructure-plan.md)
> into concrete, ordered work. It inherits every decision (D1–D15), interface
> (§5), decision rule (§6), and worked example (§9) from the parent and the spec —
> it does not relitigate them. Phase-local work units are labelled `W1…W6` to
> avoid collision with the parent's `U`-IDs; the parent unit they implement is
> **U8** throughout.

---

## 1. Summary

Parent **U8** migrates the **lifecycle / outside-in** surface — the behaviours
whose risk is *process behaviour* (signals, stdin EOF, attached-TTY quit,
click-to-focus), *graceful-failure persistence*, and *real side effects*
(commit, worktree, ask non-interactive) — from `tests/integration/lifecycle/**`
into `tests-new/`. Per the decision rule (parent §6), most of this surface is the
`lifecycle` category (real `orch` subprocess under real tmux, via the
behavioral-dsl engine the U2 `lifecycle` driver wraps).

The migration is **by feature-area as a pruning re-derivation** (parent §10.2,
spec §11), not a mechanical 1:1 port. Research against the *actual* old tests and
the current `lifecycle` driver surfaced three decisions the parent's one-row
cluster description does not resolve, and they shape the whole phase:

1. **No `cancelled`-status assertion (reality, not aspiration).** The parent's
   §9.8 worked example asserts `system.persistedStatus('cancelled')`. On current
   `main` neither SIGINT nor a `q` quit-intent persists a `cancelled` status — the
   run is left `running`. This is **documented in the old test itself**
   (`sigint-to-orch-during-mid-step.real.test.ts`: *"the W3 cell therefore does
   NOT assert `hasStatus('cancelled')`; that gap is the campaign-cell finding…"*)
   and was confirmed by Phase 2 (the existing ctrl-c tracer carries the same
   honest deviation note). U8 asserts **only what `main` actually does** —
   `exitedNormally` + `tmuxTornDown` + terminal-balance + no-orphans — because the
   parent's non-goal is *"not changing what the orchestrator does, only how it is
   tested"* (parent §2). U8 **does not touch source**.

2. **Failure *rendering* is `model`/`screen`/`full-host`, not `lifecycle`.** Two
   of the four `failure.*` files assert pane content (failed ✗ glyph + error
   banner; right-pane failure summary). The `lifecycle` driver's pane reads are
   still `notImplemented` (deferred since U2), and per the decision rule a glyph /
   banner / summary is a *rendering* risk, not a *process* risk. U8 re-derives
   those as `model` (+ a `screen`/`full-host` twin) reusing the **existing**
   `outcome: 'failed'` DSL support (LaunchSpec, `assertGlyph('failed')`, error
   banner) that U5a/U5b already shipped — **not** by building lifecycle
   pane-reads. Only the two genuinely *persistence* failure cases stay
   `lifecycle`.

3. **Side-effect tests relocate as a non-`scenario()` category (U7 precedent).**
   `commit`, `worktree` (×2), `ask`, and the two failure-*persistence* cells drive
   a real subprocess with specific fixtures and assert **git / filesystem /
   persisted-state side effects with zero pane assertions**. They run at exactly
   one fidelity, have no multi-driver twin, and answer the triage rule *"would it
   still pass if the pane were empty?"* with **yes**. Forcing them through the
   pane-centric `scenario(app)` shape is the exact mismatch U7 hit with controller
   tests. They relocate into a plain `it()` category `tests-new/lifecycle/side-effects/`
   (the `tmux-argv` / `model/controller` precedent), importing behavioral-dsl from
   `_support`, with a README — **not** by extending shared DSL surfaces (which
   Phase 7 deliberately avoided to protect U4–U6).

The signals / stdin / q / click behaviours **do** fit the `lifecycle` `scenario()`
shape cleanly (launch held → one action → `system.*` outcomes) and read far better
through the typed app handle, so they are re-derived as `scenario()` lifecycle
tests — adding the small set of missing affordances test-first on the driver.

---

## 2. Problem frame & scope

**In scope — the 15 files named in the parent U8 cluster row**
(`tests/integration/lifecycle/`):

| Group | Old files | Target |
|---|---|---|
| **G1 — process signals / shutdown** | `sigint-to-orch-during-mid-step`, `sigterm-to-orch-during-mid-step`, `sighup-to-orch-during-mid-step`, `double-sigint-to-orch-during-mid-step`, `close-stdin-during-mid-step`, `q-during-fake-mid-step` | `lifecycle` `scenario()` |
| **G2 — click-to-focus** | `click-to-focus-across-divider-smoke` | `lifecycle` `scenario()` |
| **G3 — failure rendering** | `failure.failed-step-shows-x-glyph-and-error-banner`, `failure.right-pane-shows-failure-summary` | `model` (+ `screen`/`full-host` twin) |
| **G4 — side effects / persistence** | `failure.persisted-state-reflects-failed-status`, `failure.api-error-on-first-turn-keeps-run-failed-not-crashed`, `commit.step-creates-real-commit-on-branch`, `worktree.creates-real-git-worktree-and-switches-cwd`, `worktree.post-create-shell-command-creates-file`, `ask.noninteractive-uses-default-and-does-not-block` | `tests-new/lifecycle/side-effects/` (non-`scenario()`) |

**Close-out scope — lifecycle-dir hygiene (the 4 U5b rendering strays).**
`banner.error-banner-persists-until-escape`, `banner.info-banner-auto-clears-after-ttl`,
`end-of-run.right-pane-rests-on-final-step`, `end-of-run.summary-and-completion-count-visible`
physically live in `tests/integration/lifecycle/` but belong to U5's area
(parent U5 old-sources list names `lifecycle/banner.*` and `lifecycle/end-of-run.*`).
U5b built the model/screen replacements but never `.skip`ped these lifecycle
copies. U8 **closes them out** (W6) so the directory is not left with orphans —
verify the behaviour is already covered by the U5b/U6 twins, then `demote`+`.skip`
with a ledger reason; author a twin **only if** a genuine gap is found.

**Explicitly OUT of scope — stays LIVE for U10–U13** (parent U6 deferrals,
`demote→integration`; reconcile rule 3 forbids a `MIGRATED →` marker to a
not-yet-existing target):

- `command.output-streams-to-right-pane-and-exit-code-recorded` (disk streaming + `state.json` exitCode)
- `progression.per-step-artifacts-land-on-disk` (disk persistence)
- `resume.cached-steps-replay-with-cached-glyph` (resume orchestration)

**Definition-of-Done scope assertion:** after U8, the **only** LIVE (non-`.skip`)
files remaining in `tests/integration/lifecycle/` are those three U6-deferred
files. Everything else is `.skip` with a `// MIGRATED →` marker and every child
case ledgered at case granularity (D15).

**Out of scope (source & infra):**
- **No source changes.** U8 is test-only (parent §2 non-goal). The `cancelled`-
  status gap and the failed-vs-crashed bucket are *asserted as they are on main*,
  not fixed here.
- **Lifecycle fixtures are not moved.** `tests/fixtures/lifecycle/**` resolve as a
  **runtime path** (not an import) and keep working in place; Phase 2 deferred
  their relocation to a later `_support` close-out. U8 references existing
  fixtures only and adds no new ones.

---

## 3. Key decisions (phase-local; inherit and specialize the parent)

| # | Decision | Choice | Rationale |
|---|---|---|---|
| **KD1** | **Category split within U8** | G1+G2 → `lifecycle` `scenario()`; G3 → `model`(+twin); G4 → non-`scenario()` `tests-new/lifecycle/side-effects/`. | Decision rule (parent §6): signals/click are *process* behaviour and read well through the app handle; glyph/banner/summary are *rendering*; commit/worktree/ask/persisted-failure are *side effects* with no pane risk (triage = "passes if pane empty") and one fidelity — the `tmux-argv`/`model/controller` non-scenario precedent (U7) fits exactly. |
| **KD2** | **Assert `main`, not the §9.8 ideal** | Signals/q assert `exitedNormally`+`tmuxTornDown`+`terminalRestoredCleanly`+`noOrphanChildren` only. **No `persistedStatus('cancelled')`.** | Old tests + Phase 2 + the existing ctrl-c tracer already establish this; asserting `cancelled` would be a false claim and would go red. Non-goal: no source change. The absence is ledgered with a reason. |
| **KD3** | **Failure rendering re-derives via existing DSL** | Reuse `LaunchSpec.outcome: 'failed' \| 'crashed'`, `assertGlyph(step,'failed')`, error `banner` (all shipped U5a/U5b). No new lifecycle pane-reads. | Lifecycle pane reads are `notImplemented` by design; building them to host a rendering assertion violates the decision rule and adds fragile infra for zero benefit (Phase 7's "don't extend shared surfaces unnecessarily"). |
| **KD4** | **No new shared-DSL extension for side effects** | G4 imports behavioral-dsl helpers (`assertGit`/`commitExists`/`worktreeExists`/`assertFilesystem`/`fileExistsAt`/`assertPersistedState`/`hasRunStatus`/`hasStepFailed`/`hasStepCompleted`/`puppet`) from `@orch/test/behavioral-dsl` directly in plain `it()` tests. | These helpers already exist and are the right seam. Wrapping them in semantic `scenario()` app methods buys readability for *six single-fidelity tests* at the cost of a risky shared-surface extension touching every driver. U7 made the identical call. |
| **KD5** | **`api-error → failed-not-crashed` is asserted as-observed** | The phase implementer runs the old cell first on a tmux-capable box. Assert the **current** run status. If `main` still writes `crashed` (the old comment predicted RED), ledger the case `port` asserting current behaviour and record the desired-vs-actual gap as a note — do **not** chase the source fix here. | Non-goal: no source change, and the gate must stay green. Honesty over a green-theatre `failed` assertion the code does not produce. |
| **KD6** | **G1+G2 affordances ship test-first** | The new lifecycle actions/assertions (W1) land with driver-level regression tests **before** the scenarios consume them (parent R1, U2 pattern). | The real-tmux lifecycle boundary is where every historical flake lived; new affordances must carry their own no-orphans/teardown coverage. |

---

## 4. Where the work lands (output shape)

```
tests-new/
  lifecycle/
    sigint--exits-cleanly-and-tears-down.test.ts          # G1 (may reuse existing ctrl-c tracer for sigint)
    sigterm--exits-cleanly-and-tears-down.test.ts          # G1
    sighup--exits-cleanly-and-tears-down.test.ts           # G1
    double-sigint--still-reaches-clean-shutdown.test.ts    # G1
    close-stdin--terminal-stays-balanced.test.ts           # G1 (weak contract)
    q-intent--tears-down-cleanly.test.ts                   # G1
    click-to-focus--moves-focus-across-divider.test.ts     # G2
    failure--failed-step-shows-x-glyph-and-error-banner.test.ts   # G3 → model (+ screen twin)
    failure--right-pane-shows-failure-summary.test.ts             # G3 → full-host:fake-agent (or model)
    side-effects/                                          # G4 — non-scenario() category (U7 precedent)
      README.md                                            #   why plain it() not scenario()
      _support.ts                                          #   shared beforeEach/afterEach handle + helpers
      failure-persisted-state.test.ts
      failure-api-error-is-failed-not-crashed.test.ts
      commit-step-creates-real-commit.test.ts
      worktree-creates-and-switches-cwd.test.ts
      worktree-post-create-shell-command.test.ts
      ask-noninteractive-uses-default.test.ts
  screen/
    failure--x-glyph-and-error-banner-render.test.ts       # G3 screen byte twin (overlapGroup)
  dsl/
    app-surfaces.ts                                        # +closeStdin/quitIntent/click actions, +focus assertions (W1)
    panes/system-assertions.ts                             # +terminalRestoredCleanly/+noOrphanChildren (W1)
    panes/left-pane.ts | right-pane.ts                     # +assertFocused (W1)
    drivers/lifecycle-driver.ts                            # wire new affordances to behavioral-dsl (W1)
    drivers/__tests__/lifecycle-driver.test.ts             # +regression tests for new affordances (W1)
  _migration/ledger.md                                     # U8 sections, case-granular (all W)
```

> The exact scenario filenames are directional. The `screen` twin for G3 and the
> `full-host` vs `model` choice for `right-pane-shows-failure-summary` are
> confirmed at implementation time per the decision rule (see W4).

---

## 5. Implementation units

Land in order. Each leaves `bun run check` green (new tests + the still-running
old suite). G3/G4 (W4/W5) have no dependency on W1 and could be built in parallel,
but a single autonomous phase runs them linearly.

### W1. Lifecycle driver affordances for the G1/G2 scenarios (test-first)

**Goal.** Add the small set of process-behaviour actions and system assertions
the signal/stdin/q/click scenarios need, wiring each to an **existing**
behavioral-dsl helper, and ship driver-level regression tests for them before any
scenario consumes them.

**Requirements.** Parent §3.5 (`LifecycleApp`), §5.7, §12 (predictability rules
stay in the driver); D6, D14; KD6.

**Dependencies.** None (extends shipped U2 surfaces).

**Files (modify / create).**
- `tests-new/dsl/app-surfaces.ts` — extend `LifecycleApp`:
  `closeStdin(): Promise<void>`, `quitIntent(): Promise<void>`,
  `click(pane: 'left' | 'right'): Promise<void>`. (These are **lifecycle-only**
  surface members — keep them off `ModelApp`/`ScreenApp`/`FullHostApp` so the
  typed-DSL "unsupported action = type error" guarantee holds, D11.)
- `tests-new/dsl/panes/system-assertions.ts` — add to `SystemAssertionsBackend` +
  `SystemAssertions`: `terminalRestoredCleanly()`, `noOrphanChildren()` (throw
  `notImplemented` when no backend, matching the existing pattern).
- `tests-new/dsl/panes/left-pane.ts`, `right-pane.ts` — `assertFocused()` semantic
  method backed by a new `PaneDriver.assertFocused()` capability (lifecycle pane
  driver only; `notImplemented` elsewhere, mirroring the existing deferred reads).
- `tests-new/dsl/drivers/lifecycle-driver.ts` — implement the above against
  `closeOrchStdin()`, the `tui-intents.ndjson` quit-intent append (the path the
  `q-during` old test deliberately uses — see its comment on why a real
  `send-keys q` is unreliable in this harness), `clickOnPane()` + `isFocused()`
  via `assertLeftPane`/`assertRightPane`, `terminalRestoredCleanly()` +
  `noOrphanChildren()` via `assertTerminalEscapeStream`. All already exported from
  `@orch/test/behavioral-dsl`.
- `tests-new/dsl/drivers/__tests__/lifecycle-driver.test.ts` — regression tests
  for the new affordances (see Test scenarios).

**Approach.**
- The driver already owns the predictability rules (unique socket, server reaping,
  poll-and-resend, leaked-puppet sentinel). New affordances are thin maps onto
  behavioral-dsl `userAction(...)` / assertion matchers — **no** new lifecycle
  machinery, **no** new fixtures.
- `quitIntent()` appends `{"type":"quit"}\n` to `${handle.stateDir}/tui-intents.ndjson`
  and is asserted via the existing `exitedNormally`+`tmuxTornDown` (≈ the old
  `assertContractedOutcome('pane-q-during-run')`).
- `click(pane)` + `assertFocused()` round-trip the server-side click-to-focus
  binding; lifecycle is the only driver that models real focus.
- If a G1 scenario needs the **first** step held (the old signal tests hold
  `plan`, the driver's `planLaunch` holds the **last** step), note it: holding the
  last step still leaves orch mid-run, which is all a signal cell needs, so prefer
  the existing single-step (`steps:['work']`) held launch the ctrl-c tracer
  already uses. Only if a specific cell needs first-step-held does `planLaunch`
  gain a small option — flag it, don't pre-build it.

**Patterns to follow.** The existing `lifecycle-driver.ts` `system` backend and
`press`/`signal` wiring; `tests/integration/lifecycle/*.real.test.ts` for the
exact behavioral-dsl matchers each behaviour uses; the U2 driver regression tests
(`no-orphans`/`teardown`).

**Execution note.** Start each new affordance with its failing driver-level
regression test (the real-tmux lifecycle boundary is the historical flake source),
then wire it.

**Test scenarios (driver-level).**
- After a scenario that `closeStdin()`s a held run, `teardown()` reaps the server,
  removes the socket, and `assertNoLeakedEntries` passes — **zero** orphans /
  leaked scripted-fake entries. *(critical / integration)* — `REGRESSION:
  2026-05-26 real-tmux-suite-flakiness-leaked-puppets`
- `system.terminalRestoredCleanly()` passes when the terminal escape stream is
  balanced and **fails loudly** on an unbalanced stream (plant an unbalanced
  capture). *(error path)*
- `system.noOrphanChildren()` passes on a clean teardown and fails when an orphan
  child is present (planted). *(error path)*
- `quitIntent()` appends a single well-formed line to `tui-intents.ndjson` and the
  run exits + tmux is torn down. *(happy)*
- `click('right')` then `rightPane.assertFocused()` succeeds; `click('left')` then
  `leftPane.assertFocused()` succeeds; focus genuinely moved (assert the other
  pane is no longer focused). *(integration)*
- `terminalRestoredCleanly`/`noOrphanChildren`/`assertFocused` throw
  `notImplemented` on a non-lifecycle backend (defense-in-depth; the **type** error
  is the primary guard). *(edge)*

**Verification.** `bun run test:two-pane:lifecycle` green (serial, `--max-concurrency=1`);
`bun run typecheck` green (new lifecycle-only surface members do not leak onto
other app types — confirm by a deliberate local `model` scenario calling
`closeStdin()` going red). Old suite untouched.

---

### W2. G1 — process-signal & shutdown scenarios

**Goal.** Re-derive the six G1 behaviours as `lifecycle` `scenario()` tests
asserting the outcomes that hold on `main` (KD2), and `.skip` the old files once
every child case is ledgered.

**Requirements.** Parent §6 (decision rule), §9.8, §10.1–10.3; D2, D15; KD2.

**Dependencies.** W1.

**Files.**
- New: `tests-new/lifecycle/{sigterm,sighup,double-sigint,close-stdin,q-intent,sigint}--*.test.ts`
  (sigint may be satisfied by the **existing** ctrl-c tracer — see Approach).
- `.skip` + `// MIGRATED →` markers on the six old G1 files.
- Ledger rows (case-granular) in `tests-new/_migration/ledger.md`.

**Approach.**
- Each scenario: `await app.launch({ steps: ['work'], agent: holdsOpen(), stopAt: 'mid-step' })`
  → one action (`app.signal('SIGINT'|'SIGTERM'|'SIGHUP')`, `app.signal` twice for
  double-sigint, `app.closeStdin()`, `app.quitIntent()`) → `await app.system.exitedNormally()`
  + `await app.system.tmuxTornDown()` + (where the old cell asserted them)
  `terminalRestoredCleanly()` + `noOrphanChildren()`.
- **`close-stdin` is the weak contract** (old test asserts only
  `terminalRestoredCleanly()` after a settle, no teardown matcher — orch v1 has no
  stdin-EOF handler). Mirror exactly: assert the terminal stays balanced; do **not**
  assert exit/teardown. Carry the old test's documenting comment forward.
- **sigint:** the existing `tests-new/lifecycle/follow-live--ctrl-c-exits-and-tears-down.test.ts`
  tracer already re-derives `sigint-to-orch-during-mid-step` and carries the
  honest `cancelled` deviation note. Prefer ledgering the old sigint file as
  `port` → that tracer (a backfill row) over authoring a duplicate; optionally
  rename the tracer to a `sigint--*` filename for discoverability. Decide in the
  phase plan; do not ship two identical scenarios.
- **No `persistedStatus('cancelled')`** anywhere in G1 (KD2). The ledger row for
  each signal/q file records the dropped sub-assertion with reason: *"main does
  not persist `cancelled` on signal/quit; asserting it would be false (Phase 2
  finding, source unchanged per non-goal)."*

**Test scenarios.** One scenario per old file, each enumerated by its old cell's
actual assertions (above). Every old child case → a ledger row (`port` for the
shutdown invariants; an explicit `drop`-with-reason row for the never-asserted
`cancelled` sub-claim where the old comment flagged it).

**Verification.** `bun run test:two-pane:lifecycle` green; the six old G1 files
`.skip` *only* because every child case is ledgered (D15); overlap report stays
green (G1 lifecycle scenarios carry no `overlapGroup` — single-fidelity).

---

### W3. G2 — click-to-focus scenario

**Goal.** Re-derive the click-to-focus smoke as a `lifecycle` scenario using the
W1 `click`/`assertFocused` affordances; `.skip` + ledger the old file.

**Requirements.** Parent §6; D2, D15.

**Dependencies.** W1.

**Files.** `tests-new/lifecycle/click-to-focus--moves-focus-across-divider.test.ts`;
`.skip` `click-to-focus-across-divider-smoke.real.test.ts`; ledger row.

**Approach.** `launch` held → `app.click('right')` → `app.rightPane.assertFocused()`
→ `app.click('left')` → `app.leftPane.assertFocused()`. Faithful re-derivation of
the old round-trip (mouse-event builder + focus matcher).

**Test scenarios.** Covers the old cell's two clicks/asserts; ledger row `port`.
*(integration)*

**Verification.** Scenario green under `test:two-pane:lifecycle`; old file `.skip`;
ledger updated.

---

### W4. G3 — failure rendering re-derived as `model` (+ `screen`/`full-host` twin)

**Goal.** Re-derive the two failure-*rendering* cells through the rendering
categories using the existing `outcome: 'failed'` DSL, **not** lifecycle pane
reads (KD3); `.skip` + ledger the old files.

**Requirements.** Parent §6 (decision rule), §5.5 (`assertGlyph`, chrome
literals), §5.1; D10, D15; KD3. Reuses U5a/U5b DSL (`LaunchSpec.outcome`,
`LeftPane.assertGlyph('failed')`, error `banner`).

**Dependencies.** None new (DSL already shipped). Independent of W1–W3.

**Files.**
- `tests-new/lifecycle/failure--failed-step-shows-x-glyph-and-error-banner.test.ts`
  → **`model`** scenario (failed ✗ glyph + error banner projection).
  *Note: filename under `lifecycle/` is misleading for a `model` scenario — place
  it under `tests-new/model/` (e.g. `failure--failed-glyph-and-error-banner.test.ts`).*
- `tests-new/screen/failure--x-glyph-and-error-banner-render.test.ts` → the
  `screen` byte twin under a shared `overlapGroup: 'failure-glyph-banner'` (the
  blocking overlap report requires both halves).
- `failure.right-pane-shows-failure-summary` → confirm the surface at
  implementation time: if the summary is a **right-pane** artefact →
  `full-host:fake-agent` (agent fails, summary paints in the right pane); if it is
  a **projected** left-pane/summary decision → `model`. Apply the triage rule and
  record the choice in the ledger.
- `.skip` + `// MIGRATED →` on both old files; ledger rows.

**Approach.**
- Drive failure via `await app.launch({ steps: [...], outcome: 'failed' })` (and an
  error `banner` where the old cell asserted one). Assert with
  `leftPane.assertGlyph('<step>', 'failed')` and the co-located error-banner chrome
  (D10) — no production string imported.
- The `model`↔`screen` pair is the deliberate contract overlap (parent §5.5): the
  same semantic assertion runs on both; `model` proves the controller *selected*
  the failed glyph/banner, `screen` proves the bytes survive real tmux.
- Verify the existing `assertGlyph` supports the `'failed'` token and the error
  banner kind before authoring; both were shipped by U5a/U5b (parent §5.5 lists
  `'failed'`; `LaunchSpec.banner.kind` includes `'error'`). If a needed token is
  missing, that is a small, ledgered DSL addition — not a lifecycle pane-read.

**Test scenarios.**
- `model`: a failed step projects the ✗ glyph and the error banner; passes against
  real projector logic. *(happy / critical)* — `overlapGroup: failure-glyph-banner`.
- `screen`: the ✗ glyph + error-banner bytes render once at the expected position
  on real tmux (count-guarded against double-render). *(edge — bytes)*
- failure summary: the summary content reaches its surface (right pane or
  projection per the confirmed choice); test-authored content via the
  `assertShowsContent` escape hatch, chrome via a semantic method. *(integration)*

**Verification.** `bun run test:two-pane:fast` (model) + `:screen` (twin) green;
overlap report green for `failure-glyph-banner`; old files `.skip`; ledger rows
record the `demote→model/screen` (rendering, not process) dispositions with
reasons.

---

### W5. G4 — side-effect & failure-persistence relocation (non-`scenario()`)

**Goal.** Relocate the six side-effect / persistence cells faithfully into a plain
`it()` category `tests-new/lifecycle/side-effects/`, fixing import paths and
pruning, then `.skip` + ledger the old files.

**Requirements.** Parent §6 (triage rule), §10.2, R10 (import-path parity), D1,
D2, D15; KD1, KD4, KD5. Spec §11.

**Dependencies.** None new (behavioral-dsl already in `_support`). Independent of
W1–W4.

**Files.**
- `tests-new/lifecycle/side-effects/README.md` — why these are plain `it()` not
  `scenario()` (single fidelity, side-effect assertions, no pane risk; the
  `tmux-argv` / `model/controller` precedent).
- `tests-new/lifecycle/side-effects/_support.ts` — shared `beforeEach`/`afterEach`
  `OrchHandle` lifecycle (mirrors the old per-file `beforeEach`/`afterEach`).
- Six relocated tests:
  `failure-persisted-state.test.ts`, `failure-api-error-is-failed-not-crashed.test.ts`,
  `commit-step-creates-real-commit.test.ts`, `worktree-creates-and-switches-cwd.test.ts`,
  `worktree-post-create-shell-command.test.ts`, `ask-noninteractive-uses-default.test.ts`.
- `.skip` + `// MIGRATED →` on the six old files; ledger rows.

**Approach.**
- Import behavioral-dsl helpers from `@orch/test/behavioral-dsl` (now `_support`,
  D13) and `canRunRealTmux` from `@orch/test/real-tmux` — **not** the old
  `../../helpers/...` relative paths. This is the classic relocation
  misresolve-by-relative-depth risk (parent R10) — use the alias, and verify each
  relocated file imports the **same `src`/helper symbols** as its baseline original.
- These reference **existing** fixtures by name (`agent-then-commit`,
  `worktree-then-agent`, `worktree-with-post-create`, `ask-with-default`,
  `puppet-can-fail`, `single-agent-step`) at the runtime path
  `tests/fixtures/lifecycle/` — unchanged (fixtures are not moved in U8).
- **`port` parity**: a diff of old vs new should be import paths +
  describe/it-body identity (no semantic change), except the
  `describe.skipIf(!canRunRealTmux())` wrapper may be simplified and the shared
  handle plumbing factored into `_support.ts`.
- **KD5 — `api-error`:** run the old cell first on a tmux-capable box. Assert the
  **observed** run status. If `main` writes `crashed` (the old comment predicted
  RED against the desired `failed`), the relocated test asserts `crashed` and the
  ledger records the desired-vs-actual gap as a note (source unchanged). Do not
  let an aspirational `failed` assertion ship red.

**Test scenarios (relocation parity — same assertions, new path).**
- `failure-persisted-state`: drive `plan` complete + `execute` fail → persisted
  `status=failed`, `plan` completed, `execute` failed. *(persistence)*
- `failure-api-error`: `instant-fail` first turn → persisted status is the
  **observed** terminal bucket (KD5). *(persistence / error path)*
- `commit`: agent-then-commit run → `commitExists('feat/orch-d13', 'add note')`.
  *(git side effect)*
- `worktree-creates`: `worktreeExists` + the puppet-written file lands under the
  worktree path, not the repo root. *(git + fs side effect)*
- `worktree-post-create`: `postCreate` shell command creates `sentinel.txt` inside
  the worktree. *(fs side effect)*
- `ask-noninteractive`: `--noninteractive` resolves the ask to its default; the
  following step completes; persisted state shows both steps completed.
  *(non-blocking behaviour)*

**Verification.** `bun run test:two-pane:lifecycle` green (the `side-effects/`
dir is picked up by the `tests-new/lifecycle` glob); import-path parity confirmed;
no `tests-new → tests` imports; old files `.skip`; ledger rows `port`
(+ KD5 note). The category README explains the non-`scenario()` choice.

---

### W6. Lifecycle-dir hygiene, ledger close-out & reconcile-readiness

**Goal.** Close out the four U5b rendering strays, prove the lifecycle directory
is drained to exactly the three U6-deferred LIVE files, and leave the ledger +
overlap report in a U14-reconcilable state.

**Requirements.** Parent §10.2, §11.8, D12, D15; R13 (no vacuous reconcile).

**Dependencies.** W2–W5.

**Files.** `.skip` + `// MIGRATED →` (or `// COVERED BY →`) on the four stray
files where covered; ledger rows; (optional) a new twin only if a genuine gap is
found. `docs/plans/phase-summaries.md` — append the Phase 8 summary (post-impl).

**Approach.**
- For each of `banner.error-banner-persists-until-escape`,
  `banner.info-banner-auto-clears-after-ttl`,
  `end-of-run.summary-and-completion-count-visible`,
  `end-of-run.right-pane-rests-on-final-step`: verify the behaviour is already
  covered by an existing U5b `banner`/`end-of-run` model+screen twin (or a U6
  full-host scenario for the right-pane rest). If covered → `demote`+`.skip` with
  a ledger reason (*"rendering/projection, not process behaviour; covered by U5b
  `<overlapGroup>`"*). If a **real** gap is found (a behaviour no existing twin
  asserts), author the missing `model`/`screen`/`full-host` twin rather than a
  lifecycle pane-read (KD3).
- Run the lifecycle-dir drain assertion: the only files **without** a
  `// MIGRATED →`/`// COVERED BY →` marker (and not `skipIf`-only) are
  `command.output-streams`, `progression.per-step-artifacts`,
  `resume.cached-steps-replay`. Anything else un-skipped is a U8 miss.
- Confirm every U8 `MIGRATED →` target exists and each `lifecycle`/`model`/`screen`
  scenario back-references its old case via `oldTestRefs` (D15) so the U14
  reconcile scan can resolve ancestry.

**Test scenarios.** *Test expectation: none — this unit is ledger accounting,
`.skip` edits, and a directory-drain check; behaviour coverage lives in W2–W5.*
The drain check itself is a `grep`/AST assertion the phase runs, not a committed
test (U14's `reconcile.ts` is the committed gate).

**Verification.** `bun run check` green; the blocking overlap report green;
the lifecycle-dir drain assertion holds (only the 3 U6-deferred files LIVE);
ledger complete for every U8 old case at case granularity; Phase 8 summary
appended.

---

## 6. Worked shape (directional — not implementation spec)

> Illustrates the target shape for review. The implementing agent treats it as
> context, not code to reproduce.

**G1 — a signal scenario (lifecycle), asserting `main` (KD2):**

```ts
// tests-new/lifecycle/sigterm--exits-cleanly-and-tears-down.test.ts
import { holdsOpen, scenario } from '../dsl/index.ts'

scenario(
  {
    name: 'SIGTERM during a held step exits cleanly and tears tmux down',
    feature: 'shutdown',
    drivers: ['lifecycle'],
    risk: 'foreground-shutdown-race',
    oldTestRefs: ['tests/integration/lifecycle/sigterm-to-orch-during-mid-step.real.test.ts'],
  },
  async (app) => {
    // given — a held step so there is a window to act
    await app.launch({ steps: ['work'], agent: holdsOpen(), stopAt: 'mid-step' })

    // when
    await app.signal('SIGTERM')

    // then — only what main actually does (NO persistedStatus('cancelled'))
    await app.system.exitedNormally()
    await app.system.tmuxTornDown()
    await app.system.terminalRestoredCleanly()
    await app.system.noOrphanChildren()
  },
)
```

**G4 — a side-effect test (plain `it()`, non-`scenario()`, U7 precedent):**

```ts
// tests-new/lifecycle/side-effects/commit-step-creates-real-commit.test.ts
import { describe, it } from 'bun:test'
import { assertGit, awaitRunStatus, awaitStepStatus, commitExists, puppet, withinMs } from '@orch/test/behavioral-dsl/index.ts'
import { withOrchHandle } from './_support.ts'   // shared beforeEach/afterEach handle

describe.skipIf(/* canRunRealTmux gate via _support */ false)('commit step creates a real commit', () => {
  it('git log on the worktree branch shows the commit added by the commit step', async () => {
    const handle = await withOrchHandle('agent-then-commit', { script: { work: puppet() }, initGitRepo: true })

    await awaitStepStatus('worktree:feat-orch-d13', 'completed', { timeoutMs: 15_000 })
    await handle.agent('work').writeFile('note.txt', 'hello from puppet\n')
    await handle.agent('work').complete()
    await awaitRunStatus('completed', { timeoutMs: 15_000 })

    await assertGit(withinMs(5_000), commitExists('feat/orch-d13', 'add note'))
  })
})
```

---

## 7. Risks & mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| **R-A — `api-error` cell is RED on `main`** (old comment predicted `crashed`, not `failed`); a literal port goes red and fails the gate. | Medium | KD5: run the old cell first; assert the **observed** status; ledger the desired-vs-actual gap as a note. No source change. |
| **R-B — `cancelled`-status temptation** (the §9.8 example asserts it). | Medium | KD2: assert only the shutdown invariants `main` produces; the existing ctrl-c tracer already sets this precedent; ledger the dropped sub-claim with a reason. |
| **R-C — Over-extending shared DSL surfaces** to host G4 side effects, regressing U4–U7 drivers. | Medium | KD1/KD4: relocate G4 as plain `it()` category tests; W1 adds only narrow **lifecycle-only** affordances, each `notImplemented` elsewhere + type-fenced. |
| **R-D — Relocation misresolves imports** (parent R10): `tests/helpers/...` → `_support` depth change. | Medium | W5 uses the `@orch/test/*` alias (not relative `../../helpers`), and verifies same-symbol parity against the baseline original. |
| **R-E — Real-tmux flake from new lifecycle actions** (the historical flake surface). | High | KD6: W1 ships driver-level no-orphans/teardown regression tests first; new actions reuse the driver's existing socket/reaping/leak-sentinel; lifecycle runs serially (`--max-concurrency=1`, D6/D14). |
| **R-F — Driver holds the last step, old cells held the first.** | Low | W1 note: holding the last step still leaves orch mid-run (sufficient for a signal cell); add a `planLaunch` first-step option only if a specific cell needs it. |
| **R-G — Stray close-out (W6) silently demotes an uncovered behaviour** → green-but-incomplete. | Low | W6 verifies coverage against an existing twin **before** demote; authors a real twin if a gap is found; the blocking overlap report + U14 reconcile catch a dangling `MIGRATED →`. |
| **R-H — Lifecycle fixtures referenced by relocated tests are assumed present.** | Low | Fixtures stay in place at `tests/fixtures/lifecycle/` (runtime path, not import); W5 references existing fixture names only; no new fixtures. |

---

## 8. Verification (phase-level Definition of Done)

- All G1/G2 scenarios green under `bun run test:two-pane:lifecycle` (serial);
  G3 model green under `:fast`, G3 screen twin green under `:screen`, overlap
  report green for `failure-glyph-banner`; G4 side-effect tests green under
  `:lifecycle`.
- `bun run typecheck` green, including the lifecycle-only surface members not
  leaking onto other app types (deliberate-violation check).
- Every U8 old file (the 15 named + the 4 strays) is `.skip` with a
  `// MIGRATED →`/`// COVERED BY →` marker, and **every child case** is ledgered
  at case granularity (D15) with a disposition + reason; `cancelled`-status and
  any `drop` carry explicit reasons.
- **Lifecycle-dir drain assertion:** the only LIVE files left in
  `tests/integration/lifecycle/` are `command.output-streams-…`,
  `progression.per-step-artifacts-…`, and `resume.cached-steps-replay-…`
  (U6-deferred → U10–U13).
- No `tests-new → tests` imports introduced; G4 uses the `@orch/test/*` alias.
- `bun run check` green except the pre-existing, unrelated 5 `ENOENT` fixture
  failures under gitignored `.orch/` (documented since Phase 4 — not a U8
  regression; see [[orch-test-fixtures-under-gitignored-orch]]).
- `docs/plans/phase-summaries.md` gains a Phase 8 entry.

> **Note on the heavy real-tmux/lifecycle suite.** Like prior phases, the full
> legacy real-tmux integration suite is documented-flaky and need not be re-run
> end-to-end; U8 verifies the migrated old files `.skip` cleanly and the three
> U6-deferred files remain LIVE. The new `tests-new` lifecycle/side-effects/screen
> buckets are the gated proof.
