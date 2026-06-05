---
status: active
type: refactor
title: "refactor: Testing strategy restructure — Phase U1 (DSL foundation + model & tmux-argv drivers + migration foundations)"
created: 2026-06-05
parent: docs/plans/2026-06-05-001-refactor-testing-strategy-restructure-plan.md
origin: docs/brainstorms/2026-06-05-testing-strategy-restructure-spec.md
depth: deep
---

# refactor: Testing strategy restructure — **Phase U1** detailed execution plan

> **This is a phase-level plan.** It elaborates **only `U1`** of the parent plan
> ([`docs/plans/2026-06-05-001-refactor-testing-strategy-restructure-plan.md`](2026-06-05-001-refactor-testing-strategy-restructure-plan.md) §7).
> It does **not** redesign any interface or decision from the parent — it honours
> the parent's §3 decisions (D1–D15), §5 interfaces, §6 decision rule, and §9
> worked examples, and turns the parent's `U1` unit into concrete, ordered,
> implementation-ready work.
>
> **U-ID note.** The units below (`U1.1`–`U1.8`) are the *implementation units of
> parent-plan phase U1*. They carry their own stable plan-local IDs. They are
> distinct from the parent's `U1..U14` phase IDs. When this doc says "the parent's
> U1" it means parent §7 → `#### U1. DSL foundation + the two no-tmux drivers`.

---

## 1. Summary

Parent phase **U1** stands up `tests-new/` and the shared DSL spine — the
`scenario()` runner, the typed app surfaces, the Pane Objects with co-located
chrome literals, the driver registry, and the two drivers that boot **no tmux**
(`model` projection-seam, and the `tmux-argv` category) — proven by two tracer
bullets. It *also* lays the migration's three foundations, which the parent marks
as non-optional: put `tests-new/` under the typecheck gate (**D11**), capture the
**frozen baseline manifest** (**D12**), and stand up the `_support/` infra home
(**D13**).

This phase plan breaks that into eight dependency-ordered units. The
load-bearing edits are: **`tsconfig.json` `include` += `tests-new`** (without it
every typed-DSL guarantee ships green and inert — R9), and the **frozen
`baseline.json`** (without it nothing downstream can prove completeness — R13).

**Current state (verified 2026-06-05).** `tests-new/` does **not** exist — U1 is
greenfield. `tsconfig.json` `include` is `["src", "tests", "examples"]`; the
`@orch/test/*` alias → `./tests/helpers/*` is referenced by **zero** files
(`grep -rE "@orch/test/" src tests` → 0), so repointing it is risk-free.
`package.json` scripts are the legacy set (`test` → `bun test tests/unit
tests/integration`); `check` = `lint && typecheck && test`. `bunfig.toml`
preloads `tests/setup/cleanup-stale-tmux.ts`. The 6 existing `.test-d.ts` files
already typecheck because `tests` is in `include` — confirming the D11 mechanism
works the moment `tests-new` joins `include`.

---

## 2. Scope & non-goals

**In scope (this phase = parent U1 only).**
- `tests-new/` directory skeleton + tsconfig wiring (D11, D13).
- The DSL spine: `scenario()`, typed app surfaces, driver registry, barrel.
- Pane Objects + co-located chrome literals + the `PaneDriver` capability seam (D10).
- The `model` driver (no tmux) + its driver-level unit tests.
- The `tmux-argv` category tracer (plain unit test, no `scenario()`).
- The two tracer scenarios that prove the design on real behaviour.
- The frozen baseline manifest + snapshot script + its determinism test (D12).
- The `_support/` infra home seeded with the helpers U1 needs, each with a
  back-compat shim at the old path (D13).
- New `package.json` buckets: `test:two-pane:model`, `test:two-pane:tmux-argv`,
  `test:two-pane:fast`.

**Out of scope (later parent phases — do not start here).**
- Real-tmux drivers `screen`/`full-host`/`lifecycle` (parent U2).
- `recorded-agent`/`real-agent`, the full script ladder, the bare-`bun test`
  guard, the overlap report, docs/skill rewrites, convention flip (parent U3).
- Any *migration* of old tests to `.skip` (parent U4+). U1 touches **no** old
  test's pass/skip state; it only *moves* two shared helpers (with shims) and
  *adds* the new tree.
- Repointing `test`/`check` onto `tests-new/` (parent U14). U1 adds the new
  buckets but leaves the default gate on the old tree. The **typecheck** step of
  `check` does begin covering `tests-new/` immediately (that is the whole point
  of D11) — see §5 Decision K1.
- Splitting the `model` category into `model/projector|view|controller` — the
  parent explicitly says U1 needs only the shared seam + the tracer.

---

## 3. Reality checks — parent §9 examples are directional, and three diverge

The parent §5/§9 sketches are framed as *directional guidance, not implementation
specification*. Local research found three places where following the sketch
verbatim would not compile or run. The implementer must use the real seam:

| Parent sketch | Reality (verified) | What U1 does |
|---|---|---|
| §9.3 `fps.lastSpawn().argv` | `FakeProcessService` exposes **no** `lastSpawn()`/`spawns`. It is response-oriented: `when(argv).respondWith(res)`; `spawn()` **throws** on an unmatched argv (`fake-process-service.ts:75`). The repo's tmux argv tests assert via `when([...exact argv]).respondWith(...)` (e.g. `tests/unit/services/tmux/tmux-service.test.ts:514`). `FakeTmuxService` separately has a `recordedCalls[]` array. | tmux-argv tracer (U1.6) uses the **established `when().respondWith()` matcher** against `RealTmuxService` → `FakeProcessService`. Argv correctness is enforced by exact-match (mismatch throws). For a readable positive `toContain('-l')` assertion, U1.6 adds a **test-side** `RecordingProcessService` wrapper that records spawned argv — a helper under `tests-new/_support/`, **not** a `src/services` change. |
| §9.3 `new RealTmuxService({ process, socket })` | Constructor is `new RealTmuxService({ processService })`; the socket is **per-call** in `sendKeys({ socket, target, keys, enter })`. `sendKeys` argv = `['tmux','-L',socket,'send-keys','-t',target,'-l',...keys]` (`real-tmux-service.ts`). | U1.6 constructs with `{ processService }` and passes `socket`/`target` per call; asserts the `-l` literal-mode flag + verbatim payload. |
| §9.2 `model` driver "inspects the controller's projected view-model" | The seam is two-layered: `projectStepsView(args) → StepsViewState` (pure, no I/O) and the **steps-view Ink component** rendered via `ink-testing-library` + `stripAnsi` (today's Tier-2). The `RightPaneController` exposes `onIntent`/`followLive`/`setViewMode` but **does not** publicly expose `isFollowingLive`/`currentView` getters. Selection (cursor position) lives in the steps-view component, driven by `StepsIntent`. | U1.4 builds the `model` driver on the **Tier-2 Ink-render seam** (render the steps-view component, drive input, poll `lastFrame()` via `waitForFrame` with `stripAnsi`), asserting the **projected/rendered view-model** — never a fake tmux (R5). It allocates **no** socket. |

These are captured as Key Decisions K2–K3 below so the implementer does not
re-discover them mid-build.

---

## 4. Output structure (what U1 creates)

```
tests-new/
  dsl/
    index.ts                         # U1.2 — single public barrel (scenario, types, pane objects)
    app-surfaces.ts                  # U1.2 — DriverName union + Model/Screen/FullHost/Lifecycle App ifaces
    scenario.ts                      # U1.2 — scenario(meta, body); AppFor + SharedApp non-distributive types
    drivers/
      registry.ts                    # U1.2 — Driver<App> iface + DRIVERS record (satisfies Record<DriverName,…>)
      model-driver.ts                # U1.4 — no-tmux projection-seam driver
      __tests__/model-driver.test.ts # U1.4 — driver-level unit tests (no socket, idempotent teardown)
    panes/
      left-pane.ts                   # U1.3 — LeftPane + co-located chrome literals (D10)
      right-pane.ts                  # U1.3 — RightPane Pane Object
      system-assertions.ts           # U1.3 — SystemAssertions (declared; bodies land with lifecycle driver in U2)
      pane-driver.ts                 # U1.3 — PaneDriver capability interface (driver-facing seam)
      __tests__/left-pane.test.ts    # U1.3 — chrome-literal meta-test (goes red on wrong literal)
    __tests__/
      scenario.test.ts               # U1.2 — runtime: one it() per listed driver
      scenario.test-d.ts             # U1.2 — NEGATIVE type tests (@ts-expect-error) — gated by typecheck (D11)
  _support/                          # U1.1 — shared infra home (D13); @orch/test/* repoints here
    type-assertions.ts               #   moved from tests/helpers/ (+ shim left behind)
    ink-frame.ts                     #   moved from tests/helpers/ (+ shim left behind)
    recording-process-service.ts     # U1.6 — test-side argv-recording ProcessService wrapper
  _migration/
    snapshot.ts                      # U1.7 — committed generator: walks tests/**, classifies, per-case identity
    baseline.json                    # U1.7 — FROZEN snapshot (D12)
    baseline.md                      # U1.7 — human-readable view
    __tests__/snapshot.test.ts       # U1.7 — determinism + counts-match-fixture
  model/
    follow-live--returns-to-running-step.test.ts   # U1.5 — tracer (Covers parent F9)
  tmux-argv/
    send-keys--escapes-metacharacters.test.ts      # U1.6 — tracer
  screen/  full-host/  lifecycle/  unit/  integration/  e2e/   # U1.1 — empty dirs w/ .gitkeep (downstream homes)

tests/helpers/type-assertions.ts     # U1.1 — becomes a re-export shim → ../../tests-new/_support/type-assertions.ts
tests/helpers/ink-frame.ts           # U1.1 — becomes a re-export shim → ../../tests-new/_support/ink-frame.ts
tsconfig.json                        # U1.1 — include += "tests-new"; @orch/test/* → tests-new/_support/*
package.json                         # U1.8 — + test:two-pane:model | :tmux-argv | :fast
```

The per-unit **Files** sections below are authoritative. The tree is the scope shape.

---

## 5. Key technical decisions (phase-local)

These inherit the parent's D1–D15 and resolve the phase-local choices the parent
left to "each phase's own plan."

- **K1 — D11 gating arrives via `typecheck`, not via a new runtime bucket.**
  `check` already runs `tsc --noEmit`. The moment `tests-new` is in tsconfig
  `include` (U1.1), the negative type tests (`scenario.test-d.ts`) and every typed
  surface are enforced by `bun run check` — *even though* the `model`/`tmux-argv`
  runtime buckets are not yet in `check`'s test step (they join the gate in later
  parent phases / U14). Verification U1.1 introduces a deliberate type violation
  and confirms `typecheck` goes red, then reverts it.

- **K2 — `model` driver = Ink-render projection seam, never a fake tmux (R5).**
  Build on `ink-testing-library` render of the steps-view component + `stripAnsi`
  (today's Tier-2), polled with `waitForFrame` from `_support/ink-frame.ts`. The
  driver's `PaneDriver.assertBottomText` inspects the **rendered/projected**
  view-model. It allocates no socket and boots no tmux (asserted in U1.4). A
  `FakeTmuxService` must **not** appear in the `model` driver.

- **K3 — tmux-argv tracer uses the real `RealTmuxService`/`FakeProcessService`
  contract** (§3 row 1–2), with an optional `_support/recording-process-service.ts`
  wrapper for readable positive argv assertions. No `src/` change.

- **K4 — Repoint `@orch/test/*` → `tests-new/_support/*` now (safe).** Zero files
  reference the alias today, so the glob repoint cannot break a current import.
  Moved helpers (`type-assertions`, `ink-frame`) keep a thin re-export shim at the
  old `tests/helpers/<name>.ts` path because old tests import them via **relative**
  paths (`../../helpers/ink-frame.ts`); the shim keeps those resolving until those
  files are skipped/relocated in a later phase, then the shim is deleted (D13/R11).
  New-tree code imports shared infra via `@orch/test/*` (now → `_support`) or
  relative within `tests-new/` — it never imports from `tests/`.

- **K5 — `scenario()` registers tests at import time; keep registration in one
  helper.** Per parent §5.3 import-time-purity note, `scenario()` calls `it()` on
  module eval. U1 confines that call to a single function so the future overlap
  report (parent U3) has a stable AST parse target, and so nothing else in the DSL
  runs on import (CLAUDE.md rule 8). The baseline snapshot (U1.7) must therefore
  **AST/source-scan** `tests/**`, never `import` it.

- **K6 — `SharedApp` is a non-distributive mapped type over `keyof AppFor<D[number]>`**
  (parent §5.3), **not** `UnionToIntersection`. A `['model','screen']` scenario must
  type to only the common `leftPane` surface; `resize` must not compile on it. The
  `<const D extends readonly DriverName[]>` capture at the call site is mandatory —
  without it the body type collapses to the full union and the guarantees evaporate.
  U1.2's `scenario.test-d.ts` proves each acceptance/rejection.

- **K7 — `system-assertions.ts` is declared but thin in U1.** `SystemAssertions`
  (exit/teardown/persisted status) is only meaningful on the `lifecycle` driver
  (parent U2). U1 declares the interface/class shape so `LifecycleApp` in
  `app-surfaces.ts` typechecks, but its methods may throw `notImplemented()` until
  U2 wires the lifecycle driver. No `model`/`tmux-argv` path depends on it.

---

## 6. Implementation units

> Dependency order is strict where noted. **U1.6** (tmux-argv) and **U1.7**
> (baseline) depend only on **U1.1** and may proceed in parallel with the DSL
> spine (U1.2→U1.5). **Write tests first** for every feature-bearing unit (the
> DSL, the drivers, the snapshot script). Leave `bun run check` green after each.

### Dependency graph

```
U1.1 (scaffold + tsconfig + _support move)
 ├─► U1.2 (scenario spine + negative type tests)
 │     └─► U1.3 (pane objects + PaneDriver seam)
 │           └─► U1.4 (model driver)
 │                 └─► U1.5 (model tracer)        ──┐
 ├─► U1.6 (tmux-argv tracer)                       ─┤
 └─► U1.7 (frozen baseline manifest)               ─┤
                                                    └─► U1.8 (package.json buckets + DoD)
```

---

### U1.1. Scaffold `tests-new/`, put it under the typecheck gate, seed `_support/`

**Goal.** Create the `tests-new/` skeleton, wire it into `tsconfig` so `tsc
--noEmit` typechecks it (D11), repoint the `@orch/test/*` alias to `_support`
(D13/K4), and move the two helpers U1 needs into `_support/` with back-compat
shims — all without disturbing the old suite.

**Requirements.** Parent D11, D13; parent U1 Files (`tsconfig.json`, `_support/`).

**Dependencies.** None.

**Files (create / modify).**
- Create the directory skeleton with `.gitkeep` in each downstream-only dir:
  `tests-new/{dsl,dsl/drivers,dsl/drivers/__tests__,dsl/panes,dsl/panes/__tests__,dsl/__tests__,_support,_migration,_migration/__tests__,model,tmux-argv,screen,full-host,lifecycle,unit,integration,e2e}/`.
- Move `tests/helpers/type-assertions.ts` → `tests-new/_support/type-assertions.ts`;
  replace the old path with a shim: `export * from '../../tests-new/_support/type-assertions.ts'`.
- Move `tests/helpers/ink-frame.ts` → `tests-new/_support/ink-frame.ts`; shim the old path likewise.
- `tsconfig.json` — add `"tests-new"` to `include`; change the `@orch/test/*`
  mapping target from `./tests/helpers/*` to `./tests-new/_support/*`.

**Approach.**
- Verify the shim direction works for the 6 existing `.test-d.ts` files (they
  import `type-assertions` via relative path `../../helpers/type-assertions.ts`) —
  the shim keeps them green; `tsc` follows the re-export to `_support`.
- Because the `@orch/test/*` alias has zero current consumers (verified), the
  repoint is inert for old code and ready for new-tree use.
- Do **not** move `real-tmux`, `behavioral-dsl`, `fixtures`, or `setup` — those
  move in parent U2/U10–U13 with their own shims.

**Patterns to follow.** Existing `tsconfig.json` `paths` block; the re-export
barrel idiom already used across `src/*/index.ts`.

**Test scenarios.**
- `bun run typecheck` compiles `tests-new/` (assert the tree is now in the
  program — introduce a deliberate `const x: number = 'y'` in a temp
  `tests-new/_support/__typecheck_probe.ts`, confirm `typecheck` goes **red**,
  then delete the probe). *(critical — proves D11 is live, R9)*
- Old suite still green: `bun run check` passes; the 6 `.test-d.ts` files still
  typecheck through the shim. *(happy / integration)*
- A new-tree file importing `@orch/test/ink-frame` resolves to
  `tests-new/_support/ink-frame.ts`. *(integration)* — proven incidentally by U1.4.
- `Test expectation:` mostly config/scaffolding; the load-bearing assertion is the
  deliberate-type-violation red, captured above. No behavioural unit beyond that.

**Verification.** `bun run check` green (old suite untouched, shims resolve);
`tsc --noEmit` now includes `tests-new/`; the deliberate violation flips
`typecheck` red and reverts clean.

---

### U1.2. The scenario runner, typed app surfaces, driver registry (DSL spine)

**Goal.** Ship `scenario(meta, body)`, the `DriverName` union and four typed app
surfaces, the `Driver<App>` registry, and the public barrel — with the negative
type tests that make the typed-DSL guarantee real (D11/K6).

**Requirements.** Parent §5.2, §5.3, §5.4, D11; spec §6, §6.1.

**Dependencies.** U1.1.

**Files (create).**
- `tests-new/dsl/app-surfaces.ts` — `DriverName` union (`'model' | 'screen' |
  'full-host:fake-agent' | 'full-host:recorded-agent' | 'full-host:real-agent' |
  'lifecycle'`); `ModelApp` / `ScreenApp` / `FullHostApp` / `LifecycleApp`
  interfaces exactly per parent §5.2 (Model has `leftPane` only; Screen adds
  `resize`; FullHost adds `rightPane` + `complete`; Lifecycle adds `press` /
  `signal` / `system`).
- `tests-new/dsl/scenario.ts` — `ScenarioMeta<D>` (with **required** `oldTestRefs`
  per D15, optional `risk`/`overlapGroup`/`regressionRef`/`liveDriven`); the
  non-distributive `AppFor<D>` conditional lookup; the non-distributive
  `SharedApp<D>` mapped type (K6); `scenario<const D>(meta, body)` expanding to one
  `it.skipIf(driver.skip())` per listed driver with per-driver timeout + try/finally
  teardown. Keep the `it()` registration in a single helper (K5).
- `tests-new/dsl/drivers/registry.ts` — `Driver<App>` interface (`build`, `skip`,
  `timeout`) + `DRIVERS` record `satisfies Record<DriverName, Driver<unknown>>`.
  In U1 only the `model` entry is wired live; the other five are declared with a
  `notImplemented` stub driver so the `satisfies` constraint holds and the union is
  complete (later phases replace each stub).
- `tests-new/dsl/index.ts` — barrel re-exporting `scenario`, the app-surface types,
  the Pane Objects (added in U1.3), and the content/agent helper factories
  referenced by scenarios (`emits`, `live`, `fromCassette`, `claudeAgent`,
  `holdsOpen` may be declared as typed stubs here in U1 and implemented by the
  phase that needs them — U1 only needs `model`-relevant exports live).
- `tests-new/dsl/__tests__/scenario.test.ts` — runtime behaviour.
- `tests-new/dsl/__tests__/scenario.test-d.ts` — negative type tests, reusing
  `Expect`/`Equal` from `_support/type-assertions.ts`.

**Approach.**
- The `<const D>` capture and `SharedApp` mapped type are the crux (parent §5.3,
  K6). Do not use `UnionToIntersection`. Prove the distinction by compilation in
  `scenario.test-d.ts`.
- The stub drivers for non-`model` names keep `build()` rejecting with a clear
  "driver lands in parent phase Ux" error and `skip()` → `true`, so a stray
  scenario listing them is skipped at runtime rather than crashing the suite.

**Technical design (directional, not spec).**
```ts
// scenario.ts — shape only; names/details refined in implementation
type AppFor<D extends DriverName> =
  D extends 'model' ? ModelApp :
  D extends 'screen' ? ScreenApp :
  D extends `full-host:${string}` ? FullHostApp :
  D extends 'lifecycle' ? LifecycleApp : never
type SharedApp<D extends readonly DriverName[]> = { [K in keyof AppFor<D[number]>]: AppFor<D[number]>[K] }
function scenario<const D extends readonly DriverName[]>(meta: ScenarioMeta<D>, body: (app: SharedApp<D>) => Promise<void>): void
```

**Patterns to follow.** Existing `.test-d.ts` idiom
(`tests/unit/core/ask-types.test-d.ts`): `type _X = Expect<Equal<…>>` plus
`@ts-expect-error` lines; the `satisfies` pattern used in `src/` registries.

**Test scenarios.**
- `scenario()` expands to exactly one `it()` per listed driver, each labelled
  `name [driver]`; a two-driver scenario yields two `it()`s. *(happy)*
- A `['model']` scenario body referencing `app.rightPane` or `app.press` is a
  **type error**; `['model','screen']` referencing `app.resize` is a type error;
  `['screen']` `app.resize` and `['lifecycle']` `app.press`/`app.signal` **compile**.
  All via `@ts-expect-error` in `scenario.test-d.ts`, caught only because
  `tests-new` is in `include` (D11/K1). *(critical / edge)*
- `SharedApp<['model','screen']>` resolves to the common `leftPane`-only surface
  (`Expect<Equal<keyof SharedApp<['model','screen']>, 'launch'|'leftPane'|'teardown'>>`
  or the accurate common-key set). *(critical)*
- A driver whose `skip()` returns `true` produces a skipped `it()`, not a failure.
  *(edge)*
- Importing `tests-new/dsl/index.ts` runs no side effect beyond test registration
  inside `scenario()` calls (no top-level work). *(edge — CLAUDE.md rule 8)*

**Verification.** `bun run typecheck` green with the positive type tests and red
on each `@ts-expect-error` removed; `bun test tests-new/dsl/__tests__/scenario.test.ts`
green; no import-time side effects.

---

### U1.3. Pane Objects, co-located chrome literals, the `PaneDriver` seam (D10)

**Goal.** Ship `LeftPane`/`RightPane`/`SystemAssertions` as **semantic** Pane
Objects whose expected chrome lives in co-located constants (never imported from
`src/`), backed by a driver-facing `PaneDriver` capability interface.

**Requirements.** Parent §5.5, D10; spec §6.2.

**Dependencies.** U1.2 (uses the app-surface types).

**Files (create).**
- `tests-new/dsl/panes/pane-driver.ts` — `PaneDriver` interface:
  `assertBottomText(literal: string, opts: { count: number }): Promise<void>`,
  `assertContains(text: string): Promise<void>`, `assertSelected(step: string):
  Promise<void>`, `assertGlyph(step: string, glyph: 'running'|'done'|'failed'):
  Promise<void>` (the raw capabilities a driver implements; refine in impl).
- `tests-new/dsl/panes/left-pane.ts` — `LeftPane` with `private static readonly
  TEXT = { quitHint: 'q quit', followHint: 'f follow' } as const`; semantic methods
  `assertQuitHintVisible`, `assertStepSelected`, `assertGlyph`, plus the
  `assertShowsContent(text)` escape hatch and the `selectStep`/`followLive`
  affordances the `model` tracer uses (these forward to driver capabilities).
- `tests-new/dsl/panes/right-pane.ts` — `RightPane` (`assertShowsContent`,
  `assertNoCaretEcho`, …) — declared; only the methods the U1 tracers need are
  exercised. (Full-host scenarios land in parent U2/U4.)
- `tests-new/dsl/panes/system-assertions.ts` — `SystemAssertions` shape per K7
  (declared; bodies may `notImplemented()` until parent U2).
- `tests-new/dsl/panes/__tests__/left-pane.test.ts` — chrome-literal meta-test.

**Approach.**
- The Pane Object is **driver-independent**: it asks its `PaneDriver` for raw
  capabilities; the driver decides what "bottom text" means at its fidelity. In
  U1 only the `model` driver backs it.
- Add the chrome-literal guardrail note to a `tests-new/dsl/README.md` (D10): chrome
  literals live only on Pane Objects; a scenario needing an inline chrome literal
  must carry `// CHROME-LITERAL-EXCEPTION: <reason>`.

**Patterns to follow.** Parent §9.9 `LeftPane` sketch; co-located `as const`
constant tables already used in `src/hosts/two-pane/**`.

**Test scenarios.**
- `LeftPane.assertQuitHintVisible()` reads its literal from `LeftPane.TEXT`, not
  from `src/`: with a fake `PaneDriver` capturing the asserted literal, the meta-
  test asserts the captured value equals `'q quit'`, and **fails red** if `TEXT.quitHint`
  is changed to a wrong value. *(happy / critical — guards D10 tautology, R6)*
- `assertShowsContent('x')` forwards verbatim to `PaneDriver.assertContains('x')`
  (the only free-string path). *(happy)*
- A semantic chrome method never passes a scenario-supplied string to the driver
  (type: chrome methods take an enum/step, not free text). *(edge)*

**Verification.** `bun test tests-new/dsl/panes/__tests__/left-pane.test.ts`
green; `bun run typecheck` green; the meta-test flips red when the chrome constant
is corrupted.

---

### U1.4. The `model` driver (no tmux, projection seam)

**Goal.** Implement the `model` driver: `build(meta) → ModelApp` over the Tier-2
Ink-render projection seam (K2), backed by a `PaneDriver` that inspects the
rendered/projected view-model. It boots no tmux, allocates no socket, and tears
down idempotently — proven by driver-level unit tests **before** the tracer.

**Requirements.** Parent §5.1, §5.2 (`ModelApp`), D8, R5; spec §3.1–3.2.

**Dependencies.** U1.2, U1.3.

**Files (create).**
- `tests-new/dsl/drivers/model-driver.ts` — the live `DRIVERS.model` entry: a
  `ModelApp` whose `launch(spec)` renders the steps-view component via
  `ink-testing-library`, drives input, and exposes a `LeftPane` over a
  `PaneDriver` that polls `lastFrame()` through `_support/ink-frame.ts`
  (`waitForFrame`, `stripAnsi` transform). `skip()` → `false`;
  `timeout` → the default (no real-tmux budget). `teardown()` unmounts the Ink
  tree and is idempotent.
- `tests-new/dsl/drivers/__tests__/model-driver.test.ts`.

**Approach.**
- Wrap the existing seams: `projectStepsView` (`src/hosts/two-pane/steps-view/
  project-steps-view.ts`) and/or the steps-view Ink component used by today's
  Tier-2 tests under `tests/unit/hosts/two-pane/steps-view/`. The driver maps
  semantic Pane Object calls to: `assertBottomText` → poll the stripped last frame
  for the literal `count` times; `assertSelected` → assert the cursor/selection
  marker in the projected view; `followLive`/`selectStep` → drive the component's
  input (or feed the projector a `view`/intent) and re-render.
- **No `FakeTmuxService`** anywhere in this driver (R5). The `model` `ModelApp`
  has no `resize`/`rightPane`/`press` — those are compile errors by construction
  (proven in U1.2).
- Use `_support/ink-frame.ts` `waitForFrame`/`pressUntilFrame`/`waitForIntents`
  for deterministic polling (the helper documents which keys are idempotent-safe).

**Execution note.** Start with the no-socket / idempotent-teardown driver tests
(characterize the lifecycle), then wire enough surface for the tracer.

**Patterns to follow.** `tests/unit/hosts/two-pane/steps-view/*.test.ts*`
(projection + `renderToString`/`stripAnsi`); `_support/ink-frame.ts` polling
discipline; the `RightPaneController` intent surface (`onIntent`/`followLive`/
`setViewMode`) where a controller-level decision is asserted.

**Test scenarios.**
- `model` driver `assertBottomText(literal, { count: 1 })` asserts the **selected**
  hint for a given state and **boots no tmux** — assert zero sockets allocated
  (no `orch-test-*` socket created; the driver never touches `RealTmuxService`).
  *(integration / critical — R5)*
- `build()` → `launch(spec)` renders a known steps spec; `assertStepSelected`
  reflects the projected selection. *(happy)*
- `teardown()` is idempotent (callable twice, second is a no-op) and leaves no
  fixture residue / no mounted Ink tree. *(edge)*
- A wrong expected literal makes `assertBottomText` reject with a legible diff
  (uses the `waitForFrame` budget-expiry diagnostic). *(error path)*

**Verification.** `bun test tests-new/dsl/drivers/__tests__/model-driver.test.ts`
green and millisecond-level; no socket allocated during the run.

---

### U1.5. Tracer — `model/follow-live--returns-to-running-step`

**Goal.** Prove the whole `model` path end-to-end on real controller logic with
the parent §9.2 scenario.

**Requirements.** Parent §9.2; spec §6. Covers parent **F9**.

**Dependencies.** U1.4.

**Files (create).**
- `tests-new/model/follow-live--returns-to-running-step.test.ts` — the §9.2
  scenario verbatim in shape: `drivers: ['model']`, `overlapGroup:
  'follow-live-view-mode'`, required `oldTestRefs` pointing at the real old file
  (`tests/integration/hosts/two-pane/tier-1/follow-live-returns-to-running-step.real.integration.test.ts`
  — confirm exact path during impl from the baseline).

**Approach.**
- `app.launch({ steps: ['plan','execute'], stopAt: 'mid-step' })` →
  `app.leftPane.selectStep('plan')` → `app.leftPane.followLive()` →
  `app.leftPane.assertStepSelected('execute')`. On `model`, `followLive()` records
  the intent through the controller/projection seam (no keypress, no tmux — the
  `?.` optional-chaining idiom is banned per parent §9.2).
- This is a **migration tracer in miniature**: it does **not** skip the old file
  (that is parent U4) — U1 only proves the new scenario runs green.

**Test scenarios.**
- The scenario passes against real controller logic; selection returns to the
  live `execute` step after a navigate-away. *(happy)* — `Covers F9.`
- The scenario boots no tmux (inherits U1.4's guarantee). *(integration)*

**Verification.** `bun test tests-new/model` green; the tracer asserts a real
behaviour, not a stub.

---

### U1.6. Tracer — `tmux-argv/send-keys--escapes-metacharacters`

**Goal.** Prove the `tmux-argv` category runs at unit speed with no tmux, using
the **real** `RealTmuxService`/`FakeProcessService` contract (§3, K3).

**Requirements.** Parent §5.2 (tmux-argv is not a `scenario()`), D5, D8; spec §5.4 note.

**Dependencies.** U1.1.

**Files (create).**
- `tests-new/_support/recording-process-service.ts` — a thin `ProcessService`
  wrapper that delegates to a `FakeProcessService` and records each spawned
  `argv` for readable positive assertions (test-side only; no `src/` change).
- `tests-new/tmux-argv/send-keys--escapes-metacharacters.test.ts` — plain
  `it(...)` (no `scenario()`), constructing `new RealTmuxService({ processService
  })` and asserting `sendKeys` argv carries `-l` (literal mode) and the verbatim
  metacharacter payload.

**Approach.**
- Pre-script the fake with `when([...expected argv]).respondWith({ exitCode: 0 })`
  (the established repo pattern — mismatch throws), **or** route through the
  recording wrapper and assert `recorded.argv` `toContain('-l')` and
  `toContain('$(rm -rf /)')`. Prefer the recording wrapper for the readable,
  intent-revealing assertion the parent §9.3 wanted; keep the `when()` matcher as
  the correctness backstop.
- Real argv (verified): `['tmux','-L',socket,'send-keys','-t',target,'-l',...keys]`.

**Patterns to follow.** `tests/unit/services/tmux/tmux-service.test.ts`
(`when([...]).respondWith(...)`, `recordedCalls`); `FakeProcessService`
`when`/`spawn` semantics.

**Test scenarios.**
- `send-keys` passes a metacharacter payload (`$(rm -rf /)`) literally via `-l` —
  the argv contains `-l` and the payload verbatim, no shell interpretation.
  *(happy / critical)*
- Runs at unit speed with **no** socket allocated and no tmux process. *(edge)*
- An unmatched argv (wrong flag) surfaces as a clear failure (fake throws / record
  mismatch). *(error path)*

**Verification.** `bun test tests-new/tmux-argv` green, millisecond-level, no tmux.

---

### U1.7. Frozen baseline manifest + snapshot script (D12)

**Goal.** Generate the checked-in `tests-new/_migration/baseline.json` (+ `.md`):
a snapshot of **every** `tests/**` path, each classified, and for every `test`
file each `it()`/`test()`/`it.each` case with a stable identity. Frozen after U1.

**Requirements.** Parent D12, D15; parent §4 output structure.

**Dependencies.** U1.1.

**Files (create).**
- `tests-new/_migration/snapshot.ts` — committed generator. Walks `tests/**`,
  classifies each path (`test | type-test | helper | fixture | setup | asset`),
  and for `test` files records each case `{ file, name, line, hash }`. Writes
  `baseline.json` (machine) + `baseline.md` (human). Deterministic ordering +
  formatting.
- `tests-new/_migration/baseline.json`, `tests-new/_migration/baseline.md` — the
  generated, frozen outputs.
- `tests-new/_migration/__tests__/snapshot.test.ts` — determinism + counts test.

**Approach.**
- **Must not `import` test files** (that registers/executes Bun tests — K5/parent
  §5.3). Parse source instead. Recommended: the **TypeScript compiler API**
  (`typescript` is transitively available; if not present, add as a devDependency —
  a tooling dep, ledgered) to find `CallExpression`s named `it`/`test`/`it.each`
  and their first string-literal arg + line. A regex fallback is brittle for
  `it.each` and template names — prefer the AST. This is the **highest-effort,
  highest-risk unit of U1**; budget accordingly and treat the parser choice as the
  first implementation decision.
- Classification by path + extension + content sniff: `*.test-d.ts` → `type-test`;
  `*.test.ts(x)` → `test`; `tests/helpers/**` → `helper`; `tests/fixtures/**` →
  `fixture`; `tests/setup/**` → `setup`; everything else → `asset`. Record the rule
  used per entry so reconciliation (parent U14) is auditable.
- `hash` = stable hash of the case's normalized source span (so a moved case with
  identical body is recognizable). Define the normalization precisely in impl.

**Test scenarios.**
- The snapshot is **deterministic**: running it twice on an unchanged tree yields
  byte-identical `baseline.json`. *(critical)* — `Covers D12.`
- Counts match a known-good fixture: total files, per-classification counts, and a
  spot-checked file's case list (names + count) equal a committed expectation.
  *(critical)*
- A `.test-d.ts` file is classified `type-test`, a `tests/helpers/*` file `helper`,
  a `tests/fixtures/*` file `fixture`. *(edge)*
- `it.each([...])('name %s', …)` is captured as a case (not missed). *(edge)*
- The generator registers **zero** Bun tests when run (it parses, never imports) —
  assert no `it()` fires during generation. *(critical — K5)*

**Verification.** `bun run tests-new/_migration/snapshot.ts` writes a stable
`baseline.json`/`baseline.md`; `bun test tests-new/_migration/__tests__/snapshot.test.ts`
green; the JSON round-trips and is committed (frozen).

---

### U1.8. `package.json` buckets + Definition-of-Done wiring

**Goal.** Add the three U1 script buckets so the new fast level is runnable and
boots no tmux, while leaving the default gate on the old tree (parent U14 repoints
it).

**Requirements.** Parent §8 (the model/tmux-argv/fast rows), D8.

**Dependencies.** U1.5, U1.6 (so the buckets have green content).

**Files (modify).**
- `package.json` scripts — add:
  - `"test:two-pane:model": "bun test tests-new/model"`
  - `"test:two-pane:tmux-argv": "bun test tests-new/tmux-argv"`
  - `"test:two-pane:fast": "bun test tests-new/model tests-new/tmux-argv"`

**Approach.**
- Do **not** add these to `check`'s test step yet (that is later parent phases /
  U14). The D11 typecheck gate already covers `tests-new/` via `tsc --noEmit`
  inside `check` (K1) — that is the U1 gate contribution. Keep `test`/`check`
  pointing at the old tree so the suite stays whole during migration.
- `Test expectation: none` for the script rows themselves (config); coverage is the
  two tracers run by these buckets.

**Verification.** `bun run test:two-pane:fast` is green and millisecond-level
(boots no tmux — assert no `orch-test-*` socket appears during the run);
`bun run check` (old tree + typecheck-over-`tests-new`) green.

---

## 7. Phase Definition of Done (U1)

- `tests-new/` exists with the DSL spine, Pane Objects, `model` + `tmux-argv`, the
  two tracers, `_support/` (with shims at old paths), and the frozen `_migration/`
  baseline.
- `bun run typecheck` compiles `tests-new/`; the `scenario.test-d.ts` negative
  assertions are enforced (a deliberate violation flips `typecheck` red). **D11 is
  live.**
- `bun run test:two-pane:fast` green, no tmux, millisecond-level. Both tracers
  assert real behaviour.
- `baseline.json` is generated, deterministic, committed, and **frozen** (D12).
- `@orch/test/*` → `tests-new/_support/*`; moved helpers resolve through shims;
  `tests-new/` imports nothing from `tests/`.
- `bun run check` green — the old suite is **untouched** (no old test skipped) and
  still guards.

---

## 8. Risks & mitigations (phase-local)

| Risk | Likelihood | Mitigation |
|---|---|---|
| **PR-R1 — Typed-DSL guarantee inert** (`tests-new` not actually typechecked). | High | U1.1 verification introduces a deliberate type violation and confirms `typecheck` goes red before proceeding (parent R9/D11). |
| **PR-R2 — `model` driver smuggles in a fake tmux**, making byte assertions vacuous. | Medium | K2 + U1.4 test asserts **no socket allocated**; the `model` `ModelApp` type has no byte-level surface; `FakeTmuxService` import banned in the driver (parent R5). |
| **PR-R3 — Baseline snapshot imports test files** and registers/executes Bun tests, or misses `it.each`. | Medium | U1.7 parses source via the TS AST (not import, not regex); a test asserts zero `it()` fires during generation and that `it.each` is captured (K5/parent §5.3). |
| **PR-R4 — Following §9.3 verbatim** (`fps.lastSpawn`, `{process,socket}` ctor) — won't compile. | Medium | §3 reality-check table + K3; U1.6 uses the verified `{ processService }` ctor and `when().respondWith()` / recording-wrapper pattern. |
| **PR-R5 — `@orch/test/*` repoint breaks an import.** | Low | Verified zero current consumers; moved helpers keep relative-path shims for old tests (K4/parent R11). |
| **PR-R6 — `SharedApp` built with `UnionToIntersection`**, silently allowing `resize` on `['model','screen']`. | Medium | K6 + a `scenario.test-d.ts` assertion proving the common-key surface; the `<const D>` capture is mandatory and type-tested. |

---

## 9. Notes for the next phase (parent U2)

- The five non-`model` `DRIVERS` entries are `notImplemented` stubs after U1 —
  parent U2 replaces `screen`/`full-host:fake-agent`/`lifecycle`; parent U3 the
  recorded/real ones.
- `SystemAssertions` bodies are declared-but-thin (K7) — wire them with the
  `lifecycle` driver in U2.
- The `behavioral-dsl`, `real-tmux`, `fixtures`, `setup` infra moves to `_support/`
  (with shims) happen in parent U2/U10–U13 — **not** U1.
- The frozen `baseline.json` is the single source of truth for parent U4–U14
  completeness accounting — do not regenerate it against the mutating tree (D12).
```
