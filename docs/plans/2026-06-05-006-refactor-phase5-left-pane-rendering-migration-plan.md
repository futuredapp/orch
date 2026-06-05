---
status: active
type: refactor
title: "refactor: Phase 5 (U5) — migrate the left-pane logic & rendering cluster into the scenario/driver DSL"
created: 2026-06-05
origin: docs/plans/2026-06-05-001-refactor-testing-strategy-restructure-plan.md
depth: deep
---

# refactor: Phase 5 (U5) — left-pane logic & rendering migration

> **This is a phase plan.** It elaborates **U5** of the parent plan
> ([`docs/plans/2026-06-05-001-refactor-testing-strategy-restructure-plan.md`](2026-06-05-001-refactor-testing-strategy-restructure-plan.md))
> into concrete, ordered steps. It does **not** relitigate the parent's locked
> decisions (§3 D1–D15), interfaces (§5), the decision rule (§6), the script
> ladder (§8), or the worked-example shapes (§9). Where this plan makes a U5-local
> choice the parent left open, it says so explicitly with rationale.
>
> **Phase = parent unit.** The established cadence is 1:1 (Phase 1 = U1 … Phase 4
> = U4, per [`docs/plans/phase-summaries.md`](phase-summaries.md)). **Phase 5 = U5.**

---

## 1. Summary

U5 is the **bulk** of the two-pane migration. It re-derives the **left-pane logic
& rendering** cluster — selection, preview cursor, scroll/viewport, step glyphs,
adaptive columns, the view-mode footer, banner TTL, and the end-of-run summary —
from ~16 still-live old files (~120 in-scope cases) into the new
`scenario`/`driver` DSL, as `model` projection scenarios (the bulk) plus their
`screen` byte twins (paint/resize). The parent flags this unit as the one that
**cannot be mechanically reshaped** (spec §3.2) and the one that **must be
pre-split** because it exceeds the ~40-case / ~15-file ceiling (parent §U5–U9
sizing note).

The parent mandates the split into **U5a** and **U5b**. This plan fixes the split
along **concern clusters** (each self-contained for the *blocking* overlap report)
rather than a literal model-then-screen cut, and orders each sub-phase as:
**(1) extend the DSL** (new co-located chrome literals + `LeftPane` semantic
methods + `PaneDriver` capabilities, model & screen, driver-level tests first) →
**(2) author `model` scenarios** → **(3) author `screen` byte twins** wiring the
`overlapGroup` contract → **(4) ledger every old case** at case granularity (D15)
→ **(5) `.skip` fully-ledgered old files** → **(6) verify the gate green**.

Each sub-phase (U5a, U5b) lands as its own commit behind `bun run check`, leaving
both the new tree and the still-live old suite green.

---

## 2. Problem frame & scope

**Problem.** The parent's migration machinery (DSL, six drivers, blocking overlap
report, frozen baseline, case-granular ledger) is fully in place after U1–U4, and
U4 proved the recipe on `launch` + `follow-live`. U5 is the first **bulk**
application of that recipe. Two things make it hard:

1. **Volume + heterogeneity.** ~120 in-scope cases across selection, scroll,
   glyphs, columns, footer, banner, and end-of-run — far past the parent's split
   ceiling. The DSL today (per U4) only carries affordances for selection
   (`selectStep`/`assertStepSelected`), snap-to-live (`followLive`), glyph *shape*
   (`assertGlyph`), and the live/replay footer hints. Scroll, preview cursor,
   adaptive columns, glyph/summary **colors**, banner TTL, and end-of-run summary
   are **not yet expressible** — so U5 is not pure scenario-authoring; each
   sub-phase opens with real, test-first DSL/driver extension.
2. **The blocking overlap report.** Since U4, `bun run overlap-report` is on the
   gate and exits non-zero when an `overlapGroup` has a `model` member but no
   `screen`/`full-host` twin. So a sub-phase that lands `model` scenarios with
   `overlapGroup`s whose `screen` twin lands in a *later* sub-phase would turn the
   gate **red at its own boundary**. This directly shapes the split (see D-P1).

**In scope (the U5 cluster).** Left-pane *logic* (what the controller decides to
select/scroll/show) and left-pane *rendering* (whether those bytes survive real
tmux): selection, preview cursor, scroll/viewport, step glyphs + colors, adaptive
columns, view-mode footer, banner (info/error + TTL), end-of-run summary + colors
+ completion count + terminal-state footer.

**Explicitly OUT of U5 scope** (stated here so the autonomous sub-phase plans do
not pull them in — Phase 3.7 anti-expansion):

| Old file(s) | Why out | Routes to |
|---|---|---|
| `steps-view/subworkflow-*` (`-boundary-projection`, `-boundary-selection`, `-collapse`, `-parallel-suppression`) and `steps-view/applySubworkflowEvent.test.ts` | Subworkflow boundary/collapse is the parent's **U7** cluster, not left-pane rendering | **U7** — keep live, do not ledger here |
| `steps-view/tail-ndjson.test.ts`, `steps-view/tail-state-json.test.ts` | State-tailing infra that *feeds* projection; not a left-pane render/logic behaviour. Plain class tests | **U10–U13** relocation (or `unit`/`model` later) — keep live, do not ledger here |
| `steps-view/view-mode-footer.test.tsx` | Already `.skip` + fully ledgered in **U4** (3 cases) | done — exclude |
| `lifecycle/end-of-run.right-pane-rests-on-final-step.behavioral.real.test.ts` | Asserts **right-pane** resting behaviour — two-pane *plumbing*, not left-pane | **U6** — keep live, do not ledger here |

**Non-goals.** No production (`src/`) behaviour change. No new old-test edits
beyond `describe.skip`/`it.skip` + a `// MIGRATED → <path>` marker (D2). No
re-derivation of `unit`/non-two-pane tests (that is U10–U13). No `reconcile.ts`
(that is U14). No `recorded`/`real`/`lifecycle`/`full-host` coverage except where
a left-pane behaviour genuinely crosses into a held lifecycle boot (see U5-local
decision D-P3).

---

## 3. Key technical decisions (U5-local)

These resolve points the parent left to the phase. They do **not** override any
parent decision; they apply them.

**D-P1 — The U5a/U5b split is by concern cluster, each self-contained for the
overlap report.** The parent's parentheticals ("U5a model (selection/scroll/
columns/glyphs projection)" and "U5b screen (paint/resize/banner/end-of-run
bytes)") are read as **concern clusters**, not a literal "all model, then all
screen" cut:
- **U5a = selection · preview-cursor · scroll · step glyphs · adaptive columns.**
  Model-dominant; `screen` byte twins land *in the same sub-phase* only where a
  genuine paint risk exists (glyph rendering survives tmux; column hides at narrow
  width).
- **U5b = view-mode footer · banner (info/error + TTL) · end-of-run summary/
  colors/count.** Rendering-dominant; each behaviour's `model` projection and its
  `screen` byte twin land **together**.

  *Rationale.* The overlap report is **blocking** (verified: `overlap-report.ts`
  header, `exitCodeForFindings`). A literal model-then-screen cut would land U5a
  `model` members whose `screen` twins arrive only in U5b, turning U5a's gate red.
  Co-landing each `overlapGroup`'s members inside one sub-phase keeps every phase
  boundary green. This is the same shape U4 already shipped (its `follow-live` and
  `launch` model+screen members co-landed under shared `overlapGroup`s).

**D-P2 — Banner TTL timing is a `model` concern proven on a virtual clock; the
`screen` twin proves only that the banner *paints*.** Auto-clear-after-TTL and
error-banner-persists are *decisions over time*; they belong in `model` and are
driven by a new `advanceTime(ms)` affordance over the model harness's existing
deterministic clock (`NOW = 5_000`). A `screen` test must **never** wait real
wall-clock for a TTL (that is exactly the flake history the parent's drivers
exist to kill) — the `screen` twin asserts the banner's *bytes render once at the
right place*, nothing temporal. (R-P2.)

**D-P3 — Left-pane end-of-run/launch behaviours do not, by themselves, justify a
`lifecycle` or `full-host` scenario.** The cluster is left-pane only. A lifecycle
*boot/teardown* concern keeps its own scenario (as U4 did for `launch`), but U5
adds none unless a migrated old case's left-pane assertion is unreachable without
one. End-of-run cases that assert **right-pane** behaviour are out of scope (→
U6, see §2). This keeps U5 on the fast `model`+`screen` levels.

**D-P4 — Glyph/summary colors are asserted as semantic states with co-located
expected tokens, never by importing `src/` color constants (D10).** `model`
asserts the projection *selected* the state (e.g. `done` → the success color
token); `screen` asserts the **ANSI bytes** for that token survive tmux. The
expected color→token mapping is a co-located constant on the Pane Object, an
independent spec — a production palette typo goes **red**, not laundered green
(parent R6).

**D-P5 — Multi-concern old files are ledgered across both sub-phases and `.skip`'d
only in U5b, when their *last* case is ledgered (D15).** Files whose cases span
U5a and U5b concerns (e.g. `steps-view-model.test.ts`: selection/glyph cases →
U5a, end-of-run-summary cases → U5b) stay **live** through U5a with their U5a
cases ledgered, and are wrapped `.skip` only after U5b ledgers the remainder. A
file with one ported case and three un-ledgered cases must **not** be skipped —
this is the green-but-incomplete trap the case-granular ledger exists to prevent
(D15). Per-file disposition is tracked in the ledger; the U5b verification gate
checks no in-scope file is skipped with un-ledgered children.

**D-P6 — Pure-constant / pure-policy cases are demoted out of the scenario DSL.**
A case that asserts only a *module constant or policy table* with no rendering or
controller decision (e.g. `adaptive-columns.test.ts` "exposes the documented
threshold constants") is not a left-pane render scenario. Ledger it `demote→unit`
(it relocates with U10–U13) or `drop` with reason if it is tautological — do not
force it through `scenario()`. (Triage rule, parent §6.)

---

## 4. Old-file → concern → category → sub-phase map

Indicative of *driver profile and ordering*, not a promise that each row is equal
effort. Case counts are the frozen-baseline estimate (D12) from the U5 inventory;
the sub-phase plan re-reads exact per-case identity from `baseline.json`. "Spans"
= multi-concern file handled per D-P5 (skipped in U5b).

### U5a — selection · preview-cursor · scroll · glyphs · adaptive columns

| Old file (`tests/unit/hosts/two-pane/steps-view/`) | ~cases | Concern | Target |
|---|---|---|---|
| `selection.test.tsx` | 4 | selection, scroll | model + screen(glyph/selection bytes) |
| `selection-tracks-view.test.tsx` | 4 | selection (+ footer → spans U5b) | model (+ U5b) |
| `preview-cursor.test.tsx` | 4 | preview cursor, scroll | model + screen |
| `key-intent-mapping.test.tsx` | 7 | selection/intent mapping (pure) | model |
| `applyLifecycleEvent.test.ts` | 8 | status→glyph projection (pure) | model |
| `header-rerender.test.tsx` | 1 | scroll/rerender | screen (paint) |
| `scroll-no-clear-flicker.test.tsx` | 4 | scroll, no-flicker repaint | screen (paint) / triage-drop |
| `steps-view-scroll.test.tsx` | 8 | scroll (+ footer → spans U5b) | model + screen (+ U5b) |
| `adaptive-columns.test.ts` | 2 | column breakpoints | model + screen; 1 → `demote→unit` (D-P6) |
| `steps-view-colors.test.tsx` | 9 | glyph/row colors | model + screen (D-P4) |
| `steps-view.test.tsx` | 10 | selection/scroll/glyphs/columns | model + screen |
| `empty-steps-state.test.tsx` | 2 | empty selection/footer (+ footer spans U5b) | model + screen (+ U5b) |
| `steps-view-model.test.ts` | 12 | selection/glyph (+ summary → spans U5b) | model (+ U5b) |
| `start-steps-view.test.ts` | 9 | selection (+ banner → spans U5b) | model (+ U5b) |

### U5b — view-mode footer · banner (info/error + TTL) · end-of-run summary/colors/count

| Old file | ~cases | Concern | Target |
|---|---|---|---|
| `steps-view/banner-rendering.test.tsx` | 3 | banner paint | model(decision) + screen(bytes) |
| `steps-view/steps-view-banner.test.tsx` | 13 | banner + footer | model + screen |
| `steps-view/tui-overlay.test.ts` | 11 | banner/footer overlay | model + screen |
| `steps-view/end-of-run-footer.test.tsx` | 4 | terminal-state footer | model + screen |
| `steps-view/end-of-run-summary.test.tsx` | 5 | summary text + count | model + screen |
| `steps-view/end-of-run-summary-colors.test.tsx` | 4 | summary colors | model(token) + screen(ANSI) |
| `integration/.../tier-1/banner-info-and-error-ttl.real.integration.test.ts` | 1 | banner TTL | model (TTL, D-P2) + screen(paint) |
| `integration/.../tier-1/end-of-run-summary-visible.real.integration.test.ts` | 1 | end-of-run summary visible | `demote→screen` |
| `integration/lifecycle/banner.info-banner-auto-clears-after-ttl.behavioral.real.test.ts` | 1 | banner auto-clear TTL | `demote→model` (D-P2/D-P3) |
| `integration/lifecycle/banner.error-banner-persists-until-escape.behavioral.real.test.ts` | 1 (`it.todo`) | error banner persist | `port→model` if reachable, else `drop`-with-reason (never executed) |
| `integration/lifecycle/end-of-run.summary-and-completion-count-visible.behavioral.real.test.ts` | 1 | left-pane summary + count | `demote→model`+`screen` |
| **+ spans-from-U5a:** `selection-tracks-view`, `steps-view-scroll`, `empty-steps-state`, `steps-view-model`, `start-steps-view` (footer/banner/summary cases) | — | per D-P5 | ledger remainder → `.skip` file |

---

## 5. High-level technical design (DSL extension surface)

> *Directional guidance for review — not implementation specification. The
> sub-phase plan refines names/shapes against `src/` reality. The DSL barrel
> (`tests-new/dsl/index.ts`) stays the only scenario import surface; new chrome
> literals are **co-located** on the Pane Object; `PaneDriver` stays unexported.*

The current `LeftPane` (9 methods) and `PaneDriver` (7 methods) are implemented on
both the `model` and real-tmux drivers (verified). U5 adds the following. Each new
`LeftPane` method delegates to a new `PaneDriver` method implemented **twice**
(model = projected view-model; real-tmux = captured bytes), shipped **test-first**
with a driver-level unit test (parent U2 DoD pattern).

```ts
// tests-new/dsl/panes/left-pane.ts  (directional additions)
class LeftPane {
  private static readonly TEXT = {
    quitHint: 'q quit', followHint: 'f live',         // existing
    // U5b — co-located footer/banner chrome (independent spec; never from src/)
    viewStepHint: '⏎ view step', helpHint: '? help', viewingPrefix: '⏸ viewing',
  } as const
  // U5b — expected color→state tokens (D-P4; independent spec)
  private static readonly COLOR = { done: 'success', failed: 'danger', running: 'accent' } as const

  // --- U5a ---
  assertPreviewCursorOn(step: string): Promise<void>      // browse cursor '›' vs committed '▌'
  browseTo(step: string): Promise<void>                    // move preview WITHOUT commit
  assertStepVisible(step: string): Promise<void>           // step row inside the viewport window
  assertStepOffscreen(step: string): Promise<void>         // scrolled out of the window
  assertGlyphColor(step: string, state: GlyphName): Promise<void>   // D-P4
  assertColumnVisible(col: 'elapsed' | 'cost' | 'tokens'): Promise<void>
  assertColumnHidden(col: 'elapsed' | 'cost' | 'tokens'): Promise<void>

  // --- U5b ---
  assertInfoBannerShows(text: string): Promise<void>       // content escape-hatch style
  assertErrorBannerShows(text: string): Promise<void>
  assertBannerCleared(): Promise<void>
  assertViewStepHintVisible(): Promise<void>               // co-located chrome
  assertHelpHintVisible(): Promise<void>
  assertEndOfRunSummaryShows(text: string): Promise<void>  // test-authored content
  assertCompletionCount(done: number, total: number): Promise<void>
  assertSummaryColor(state: GlyphName): Promise<void>      // D-P4
}
```

```ts
// tests-new/dsl/app-surfaces.ts  (directional additions)
interface LaunchSpec {
  readonly steps: readonly string[]
  readonly stopAt?: 'mid-step' | 'end-of-run'   // U5b — reach terminal state for summary/footer
  readonly viewportRows?: number                // U5a — bound the window for scroll tests (model)
}
interface ModelApp {
  advanceTime(ms: number): Promise<void>         // U5b/D-P2 — drive banner TTL on the virtual clock
  emitBanner(level: 'info' | 'error', text: string): Promise<void>  // U5b — inject a banner event
  // ...existing
}
interface ScreenApp {
  // existing resize() bounds the window for scroll/wrap/byte twins; no advanceTime (D-P2)
}
```

**Notes on driver realisation.**
- **`model` scroll** = project the windowed steps-view at `viewportRows`, assert
  which rows are in the frame (`ink-testing-library` `lastFrame()` already
  ANSI-stripped; reuse `highlightedStepName`/`previewCursorStepName` from
  `frame-text.ts`). **`screen` scroll** = small pane height via `resize`, real
  Up/Down keystrokes, capture the window.
- **`model` columns** = call the column policy projection at a width; **`screen`
  columns** = `resize` to the threshold widths (e.g. 69 vs 70) and assert column
  presence in captured bytes.
- **`model` banner TTL** = `emitBanner` then `advanceTime(ttl)` and assert
  cleared; error banner = `advanceTime` past TTL, assert still shown, then a
  dismiss action clears it. **`screen` banner** = assert the banner *paints* once
  at the right row; never `advanceTime` (D-P2).
- **`scroll-no-clear-flicker`** is a *repaint hygiene* concern. If it can be
  expressed as "no full-clear escape sequence between scrolls" on `screen`, port
  it there; if the only old assertion was vacuous against a fake tmux, `drop` with
  reason (triage rule). Decide per-case in the sub-phase plan.

---

## 6. Implementation units

Two sub-phases, landed in order, each its own commit behind `bun run check`.
Within each, steps are ordered: **DSL extension (tests first) → model scenarios →
screen twins → ledger → skip → verify.** U-IDs trace to the parent's U5.

### U5a. Selection, preview-cursor, scroll, glyphs & adaptive columns

**Goal.** Extend the DSL with preview-cursor, scroll/viewport, glyph-color, and
adaptive-column affordances (model + screen, driver-level tests first), then
re-derive the U5a cluster as `model` scenarios with `screen` byte twins for the
genuine paint risks, ledger every in-scope case, and `.skip` the wholly-in-U5a
files.

**Requirements.** Parent spec §3–§6, §10–§12; parent D2, D10, D12, D15; this plan
D-P1, D-P4, D-P5, D-P6.

**Dependencies.** Parent U4 (DSL, drivers, blocking overlap report, ledger,
baseline all in place).

**Files (create / modify).**
- `tests-new/dsl/panes/left-pane.ts` — add U5a methods + (D-P4) co-located `COLOR`
- `tests-new/dsl/panes/pane-driver.ts` — add U5a `PaneDriver` methods
- `tests-new/dsl/drivers/model-driver.ts`, `tests-new/dsl/drivers/real-tmux-pane-driver.ts` — implement them (model = projected view-model; screen = captured bytes)
- `tests-new/dsl/drivers/frame-text.ts` — add any window/column parsing helpers
- `tests-new/dsl/app-surfaces.ts` — add `viewportRows` to `LaunchSpec`
- `tests-new/dsl/drivers/__tests__/model-driver.test.ts`, `…/screen-driver.test.ts` — **driver-level tests first** for each new affordance
- `tests-new/dsl/panes/__tests__/left-pane.test.ts` — chrome/color-literal meta-tests (red on a wrong constant)
- New scenarios under `tests-new/model/` (bulk) and `tests-new/screen/` (twins), prefixed by feature (`selection--*`, `scroll--*`, `glyph--*`, `columns--*`)
- `.skip` + `// MIGRATED →` edits to wholly-in-U5a old files (see §4)
- `tests-new/_migration/ledger.md` — a per-case row for every touched old case (`port`/`merge`/`demote`/`drop` + reason), and U5a cases of spans-files (file stays live)

**Approach.** Follow U4's established pattern (`tests-new/model/*`,
`tests-new/screen/*`): `scenario({ name, feature, drivers, overlapGroup?,
oldTestRefs }, async (app) => { /* given/when/then await sections */ })`. Pure
selection/intent/glyph-projection cases (`key-intent-mapping`,
`applyLifecycleEvent`) are `model`-only (no paint twin → no `overlapGroup`).
Glyph-*rendering*, selection-*highlight bytes*, and column-*hiding at width* carry
a `screen` twin under a shared `overlapGroup`, co-landed (D-P1). `oldTestRefs`
must resolve in `baseline.json` (overlap report checks this).

**Execution note.** Start each new affordance with its failing driver-level test
(model and screen) before any scenario uses it — the parent's DoD for
driver/DSL work is test-first.

**Patterns to follow.** U4 scenarios (`tests-new/model/follow-live--*.test.ts`,
`tests-new/screen/launch--*.test.ts`); `frame-text.ts` cursor/glyph parsing;
old projection assertions in `tests/unit/hosts/two-pane/steps-view/*` for the
behaviours being re-derived (read for intent, not copied).

**Test scenarios (the new tests — feature-bearing by definition).**
- Driver-level (model + screen) for each new `PaneDriver` method: `assertPreviewCursorOn` distinguishes `›` browse from `▌` commit; `browseTo` moves preview without committing selection; `assertStepVisible`/`assertStepOffscreen` honour the window; `assertGlyphColor` reads the projected/ANSI color; `assertColumnVisible`/`assertColumnHidden` at threshold widths. *(critical / integration)*
- `assertGlyphColor` / column meta-test: changing the co-located `COLOR` constant or a chrome literal to a wrong value turns the test **red** (D10/D-P4). *(critical)*
- `selection--committed-vs-preview-cursor [model]` + `[screen]` twin under one `overlapGroup`: browsing moves `›` only; Enter commits `▌`. `Covers` the `preview-cursor` baseline cases. *(happy/edge)*
- `scroll--viewport-follows-selection [model]` (windowed projection at `viewportRows`) + `[screen]` twin (small pane, real keys): selecting a far step brings it on-screen; an out-of-window step is offscreen. *(happy/edge)*
- `glyph--state-and-color [model]` + `[screen]`: `running`/`done`/`failed` render the right glyph **and** color; ANSI survives tmux on `screen`. *(happy)*
- `columns--elapsed-hidden-below-threshold [model]` + `[screen]`: at width 69 `elapsed` is hidden, at 70 visible. *(edge)*
- `key-intent-mapping` / `applyLifecycleEvent` pure projections as `model`-only scenarios (no `overlapGroup`). *(happy/edge)*
- `scroll-no-clear-flicker`: ported to `screen` as no-full-clear-between-scrolls, **or** `drop` per-case with reason if vacuous (D-P6 triage). *(edge)*
- Ledger: every touched old *case* has a row; every `drop` carries a reason; spans-files keep only U5a cases ledgered and stay live (D-P5). *(critical)*

**Verification.** `bun run test:two-pane:fast` green (model + tmux-argv + DSL +
`_migration` unit tests) **and the blocking overlap report green** (every U5a
`overlapGroup` has both members; every `oldTestRefs` resolves). `bun run
test:two-pane:screen` green under the §D6/D14 concurrency ceiling. Driver-level
tests pass. Wholly-in-U5a old files are `.skip` **only** because every child case
is ledgered; spans-files remain live. `bun run check` green (old suite still
guards). Introduce a deliberate wrong `overlapGroup` locally and confirm the
report goes red, then revert.

---

### U5b. View-mode footer, banner TTL & end-of-run summary/colors

**Goal.** Extend the DSL with footer-chrome, banner-injection + virtual-clock TTL
(D-P2), and end-of-run summary/color/count affordances (model + screen, tests
first), re-derive the U5b cluster as co-landed `model`+`screen` pairs, ledger the
remaining cases (including the U5a spans-files), and `.skip` every now
fully-ledgered in-scope file.

**Requirements.** Parent spec §3–§6, §10–§12; parent D2, D10, D12, D15; this plan
D-P1, D-P2, D-P3, D-P4, D-P5.

**Dependencies.** U5a (DSL extension, spans-files partially ledgered).

**Files (create / modify).**
- `tests-new/dsl/panes/left-pane.ts` — add U5b methods + co-located footer/banner chrome literals
- `tests-new/dsl/panes/pane-driver.ts`, `…/drivers/model-driver.ts`, `…/drivers/real-tmux-pane-driver.ts` — implement banner/footer/summary capabilities; **`advanceTime`/`emitBanner` on the model driver only** (D-P2)
- `tests-new/dsl/app-surfaces.ts` — add `stopAt: 'end-of-run'`, `ModelApp.advanceTime`, `ModelApp.emitBanner`
- `tests-new/dsl/drivers/__tests__/{model,screen}-driver.test.ts` — driver-level tests first (incl. a model TTL test that asserts **no** real wall-clock wait)
- `tests-new/dsl/panes/__tests__/left-pane.test.ts` — footer/banner/summary chrome-literal meta-tests
- New scenarios under `tests-new/model/` + `tests-new/screen/`, prefixed `footer--*`, `banner--*`, `end-of-run--*`
- `.skip` + `// MIGRATED →` edits to all remaining in-scope old files **and** the U5a spans-files (now fully ledgered)
- `tests-new/_migration/ledger.md` — remaining per-case rows; close out spans-files

**Approach.** Each behaviour's `model` projection and `screen` byte twin land
together under one `overlapGroup` (D-P1). Banner TTL: `emitBanner` →
`advanceTime(ttl)` → `assertBannerCleared` on `model`; error banner →
`advanceTime` past TTL, still shown, then dismiss → cleared (or `drop` the
never-executed `it.todo` lifecycle case with reason). `screen` banner/footer/
summary twins assert **bytes paint once at the right place**, no temporal
assertions (D-P2). End-of-run: `stopAt: 'end-of-run'` then assert summary text,
`assertCompletionCount`, terminal footer, and `assertSummaryColor` (model token /
screen ANSI, D-P4).

**Execution note.** Driver-level TTL test first, and it must prove the virtual
clock is used (a real-time TTL would be a flake vector — R-P2).

**Patterns to follow.** U4 footer scenarios
(`tests-new/screen/follow-live--footer-flips-live-to-replay.test.ts`,
`…/follow-live--footer-renders-with-quit-hint.test.ts`) for footer chrome; the
old banner/end-of-run files (read for intent) — `steps-view-banner.test.tsx`,
`end-of-run-summary*.test.tsx`, `tui-overlay.test.ts`.

**Test scenarios.**
- Driver-level: `emitBanner`+`advanceTime` clears an info banner on the **virtual** clock (assert elapsed real time ≈ 0); error banner survives `advanceTime` then dismisses; `stopAt:'end-of-run'` reaches terminal; `assertCompletionCount` reads done/total; `assertSummaryColor` reads token/ANSI. *(critical / integration)*
- Footer/banner/summary chrome-literal meta-tests go red on a wrong constant (D10). *(critical)*
- `banner--info-auto-clears-after-ttl [model]` (+ `screen` paint twin): info banner shows then clears after TTL on the virtual clock. `Covers` the tier-1 + lifecycle banner-TTL baseline cases. *(happy/edge)*
- `banner--error-persists-until-dismiss [model]`: error banner does **not** auto-clear; dismiss clears it (or `drop` the `it.todo` case). *(edge/error)*
- `footer--view-mode-hints [model]` + `[screen]`: view-step / help / `⏸ viewing <step>` hints render per mode. *(happy)*
- `end-of-run--summary-and-count [model]` + `[screen]`: terminal state shows the summary text, completion count, and terminal-state footer. *(happy)*
- `end-of-run--summary-colors [model]`(token) + `[screen]`(ANSI): success/failure colors. *(edge)*
- Ledger close-out: every remaining in-scope case and every U5a spans-file case has a row; each spans-file is now `.skip` with `// MIGRATED →`; no in-scope file is skipped with un-ledgered children (D-P5/D15). *(critical)*

**Verification.** `bun run test:two-pane:fast` green **incl. blocking overlap
report**; `bun run test:two-pane:screen` green under the concurrency ceiling.
Driver-level tests pass; the model TTL test proves no real-time wait. **Every
in-scope U5 old file (U5a + U5b, incl. spans-files) is now `.skip` with a
`// MIGRATED →` marker and every child case ledgered**; the explicitly-out-of-scope
files (§2) remain live and un-ledgered. `bun run check` green. A spot grep
confirms no in-scope `steps-view/*` left-pane file (excluding `subworkflow-*`,
`tail-*`) is still live.

---

## 7. Sequencing & dependency graph

```
U4 (done) ──▶ U5a ──▶ U5b ──▶ (U6: two-pane plumbing — next phase)
              │         │
              │         └─ closes spans-files opened in U5a (D-P5)
              └─ DSL extension reused by U5b (preview/scroll/glyph/column seams)
```

- **U5a before U5b**: U5b reuses the model/screen seam extended in U5a and closes
  the spans-files U5a left live.
- **Within each sub-phase**: DSL extension (tests first) precedes scenarios;
  scenarios precede ledger; ledger precedes `.skip`; `.skip` precedes the final
  gate run. Never skip an old file before its cases are ledgered (D15).
- **Overlap report is blocking at every boundary** — no sub-phase may land a
  `model` member whose `screen` twin is deferred to a later sub-phase (D-P1).

---

## 8. Risks & mitigations (U5-local)

| Risk | Likelihood | Mitigation |
|---|---|---|
| **R-P1 — A `model` member lands without its `screen` twin, reddening the blocking gate at a sub-phase boundary.** | High | D-P1: co-land each `overlapGroup`'s members inside one sub-phase; pure-model cases carry no `overlapGroup`. Verification reds-then-greens the report deliberately. |
| **R-P2 — A banner-TTL `screen` test waits real wall-clock and reintroduces flake** (the exact history the drivers exist to kill). | High | D-P2: TTL is `model`-only on the virtual clock via `advanceTime`; the driver-level TTL test asserts ≈0 real elapsed; `screen` banner tests assert paint only, never time. |
| **R-P3 — A multi-concern file is `.skip`'d after U5a with un-ledgered U5b cases** (green-but-incomplete). | Medium | D-P5/D15: spans-files stay live through U5a; U5b verification fails if any in-scope file is skipped with un-ledgered children. |
| **R-P4 — Scope creep into subworkflow/tail/right-pane files.** | Medium | §2 out-of-scope table is explicit; those files stay live and un-ledgered here, routed to U6/U7/U10–U13. |
| **R-P5 — Chrome/color tautology** (importing a `src/` constant on both sides). | Medium | D10/D-P4: co-located literals + color tokens on the Pane Object; meta-tests go red on a wrong value; literals never inline in scenarios. |
| **R-P6 — Vacuous old assertions carried forward** (e.g. fake-tmux byte checks, never-executed `it.todo`s). | Medium | Triage rule (parent §6, D-P6): `drop` with reason; the `it.todo` lifecycle error-banner case is `drop`-or-`port` only if reachable. |
| **R-P7 — `model` scroll/window projection diverges from real-tmux rendering**, making the fast suite green while bytes are wrong. | Medium | The `screen` twin under a shared `overlapGroup` binds the projection to reality (parent goal 3 / R5); scroll/column paint risks always carry a `screen` member. |

---

## 9. Definition of Done (Phase 5 / U5)

- The DSL carries the U5 left-pane affordances (preview cursor, scroll/viewport,
  glyph color, adaptive columns, view-mode footer, banner + virtual-clock TTL,
  end-of-run summary/colors/count), each implemented on **both** `model` and
  real-tmux drivers, each with a driver-level test, each chrome/color literal
  **co-located** (never imported from `src/`).
- The U5 cluster is re-derived as `model` scenarios (the bulk) with `screen` byte
  twins for every genuine paint risk, each twin co-landed under a shared
  `overlapGroup`; pure-model behaviours carry none.
- **Every in-scope old file** (§4, U5a + U5b incl. spans-files) is `.skip` with a
  `// MIGRATED → <path>` marker, and **every child case** is ledgered at case
  granularity with a disposition + reason (D15). The explicitly out-of-scope files
  (§2) remain live and un-ledgered.
- The **blocking overlap report is green** for all U5 `overlapGroup`s and all
  `oldTestRefs` resolve in the frozen baseline.
- `bun run test:two-pane:fast`, `bun run test:two-pane:screen`, and `bun run
  check` are green; the old suite still guards (skipped files cost ≈0).
- A phase summary is appended to [`docs/plans/phase-summaries.md`](phase-summaries.md)
  recording: which files were skipped, which were deferred to U6/U7/U10–U13 and
  why, any `drop`ped cases with reasons, and any DSL affordance left
  `notImplemented` for a later phase (greppable, never silent green).

---

## 10. Notes for the implementing agent

- Load `phase-implementer` and re-read the parent plan + the spec before writing
  the detailed sub-phase plan. Honour parent §3 decisions and §9 worked-example
  shapes — do not redesign them.
- Re-read exact per-case identity from `tests-new/_migration/baseline.json` (D12)
  — the §4 counts are estimates. Ledger against the **frozen** baseline, never a
  live scan.
- If U5a's `model` surface still exceeds the parent's ~40-case ceiling after the
  out-of-scope exclusions, the sub-phase plan **may** split U5a further by concern
  (e.g. selection/preview/scroll vs. glyph/columns) — keep each split
  self-contained for the overlap report (D-P1). Do not split U5b's footer/banner/
  end-of-run pairs across the seam.
- Two-pane behavioural tests go under `tests-new/` in the scenario/driver shape
  (convention flipped at U3). Never edit an old test beyond `.skip` + the
  `// MIGRATED →` marker (D2).
