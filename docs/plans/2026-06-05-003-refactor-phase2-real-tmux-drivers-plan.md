---
status: active
type: refactor
title: "refactor: Testing strategy restructure — Phase U2 (the three real-tmux drivers: screen [S2], full-host:fake-agent, lifecycle)"
created: 2026-06-05
parent: docs/plans/2026-06-05-001-refactor-testing-strategy-restructure-plan.md
origin: docs/brainstorms/2026-06-05-testing-strategy-restructure-spec.md
depth: deep
---

# refactor: Testing strategy restructure — **Phase U2** detailed execution plan

> **This is a phase-level plan.** It elaborates **only parent-plan phase `U2`**
> ([`docs/plans/2026-06-05-001-refactor-testing-strategy-restructure-plan.md`](2026-06-05-001-refactor-testing-strategy-restructure-plan.md) §7
> → `#### U2. The real-tmux drivers`). It does **not** redesign any interface or
> decision from the parent — it honours the parent's §3 decisions (D1–D15), §5
> interfaces, §6 decision rule, and §9 worked examples, and turns the parent's
> `U2` unit into concrete, ordered, implementation-ready work.
>
> **U-ID note.** The units below (`U2.1`–`U2.5`) are the *implementation units of
> parent-plan phase U2*. They carry their own stable plan-local IDs and are
> distinct from the parent's `U1..U14` phase IDs. "The parent's U2" means parent
> §7 → `#### U2. The real-tmux drivers (screen [S2], full-host:fake-agent, lifecycle)`.

---

## 1. Summary

Parent phase **U2** builds the three test drivers that boot **real tmux** —
`screen` (S2 single-pane steps-view fixture), `full-host:fake-agent` (the full
two-pane host driven by `FakeRunner`/`scriptedFake`), and `lifecycle` (outside-in
subprocess behaviour over the `behavioral-dsl` engine). It moves **all** hard-won
real-tmux predictability rules *into* the driver `build`/`teardown`, ships
**driver-level regression tests** (no-orphans/teardown, timeout/polling,
poll-and-resend) **before** any behaviour migrates onto the drivers, and proves
each driver with one tracer bullet. It is the single highest-regression phase of
the whole restructure (parent R1): the real-tmux rules were hardened through real
flakes, and relocating them is where every historical flake lived.

This phase plan breaks the parent's `U2` into **five dependency-ordered units**:

1. **U2.1 — Move shared real-tmux infra to `_support/`** (D13/R11). The
   `real-tmux/` harness and the `behavioral-dsl/` engine move under
   `tests-new/_support/`, each leaving a thin re-export shim at the old
   `tests/helpers/**` path so the still-green old suite keeps resolving. This is
   the prerequisite for D10's "`tests-new/` never imports from `tests/`" — without
   it the three drivers would import across the tree boundary.
2. **U2.2 — `full-host:fake-agent` driver** (wraps the moved `mountTmuxHost` +
   `FakeRunner`; static default, `scriptedFake` live-driven submode behind an
   explicit option).
3. **U2.3 — `lifecycle` driver** (wraps the moved `behavioral-dsl` subprocess
   engine behind the typed `LifecycleApp` surface).
4. **U2.4 — `screen` (S2) driver** — net-new single-pane steps-view fixture
   extraction; the highest-effort, highest-risk item (parent sizing note), kept in
   its own unit.
5. **U2.5 — Registry wiring, concurrency measurement (D6/D14), script ladder
   buckets, and the phase Definition of Done.**

The load-bearing risks this phase manages are: **R1** (predictability rules
regress when moved — mitigated by driver-level regression tests *first*), **R11**
(moving a helper breaks live old consumers — mitigated by re-export shims), and
**R5** (`screen`/`full-host` byte assertions must capture *real* tmux bytes, never
a fake).

---

## 2. Current state (verified 2026-06-05)

- **U1 has landed.** `tests-new/` exists with the DSL spine. `tsconfig.json`
  `include` is `["src","tests","tests-new","examples"]`; `@orch/test/*` already
  maps to `./tests-new/_support/*`. The frozen `baseline.json` (425 files, 2517
  cases) is committed under `tests-new/_migration/`.
- **The DSL seams the three drivers plug into already exist** (verified by reading
  `tests-new/dsl/`):
  - `Driver<App>` = `{ build(meta): Promise<App>; skip(): boolean; timeout: number }`
    (`tests-new/dsl/drivers/registry.ts`).
  - `DRIVERS` currently wires `model: modelDriver` and **stubs**
    `screen`, `full-host:fake-agent`, `lifecycle` (and the two U3 drivers) via
    `makeStubDriver(name, landsIn)` — `skip: () => true`, `build → notImplemented`.
    **U2 replaces exactly the three `parent U2` stubs.**
  - `PaneDriver` (`tests-new/dsl/panes/pane-driver.ts`) is the raw-capability seam:
    `assertBottomText(literal, {count})`, `assertContains(text)`,
    `assertSelected(step)`, `assertGlyph(step, glyph)`, `selectStep(step)`,
    `followLive()`. The `model` driver implements it against the projected
    view-model; the three real-tmux drivers implement it against **captured tmux
    bytes**.
  - App surfaces (`tests-new/dsl/app-surfaces.ts`): `ScreenApp` =
    `{ launch, leftPane, resize, teardown }`; `FullHostApp` =
    `{ launch, complete, leftPane, rightPane, teardown }`; `LifecycleApp` =
    `{ launch, press, signal, leftPane, rightPane, system, teardown }`.
  - `RightPane.assertNoCaretEcho()` and **all** `SystemAssertions` methods
    (`exitedNormally`, `tmuxTornDown`, `persistedStatus`) are currently
    `notImplemented(...)` placeholders — **U2 implements them** against the
    full-host and lifecycle drivers respectively.
  - `ScenarioMeta` already carries `liveDriven?: boolean` — the explicit channel
    for selecting the `scriptedFake` submode (parent §9.5). `Driver.build(meta)`
    receives the whole meta, so the driver reads `meta.liveDriven` to choose the
    submode.
- **The infra to be moved still lives under `tests/helpers/`** (NOT yet in
  `_support/`): `tests/helpers/real-tmux/**` (fixture, workflow-driver/`mountTmuxHost`,
  socket, pane-handle, agent-handle, keys, ansi, assert-no-leaks, tee-helpers) and
  `tests/helpers/behavioral-dsl/**` (launch, user-actions, matchers, assertions,
  awaits, `internal/`). `_support/` today holds only `ink-frame.ts`,
  `recording-process-service.ts`, `type-assertions.ts` (moved in U1).
- **The predictability constants** live in `tests/helpers/real-tmux/fixture.ts`:
  `REAL_TMUX_TEST_TIMEOUT_MS = 30_000`, `REAL_TMUX_ASSERT_TIMEOUT_MS = 15_000`,
  plus `canRunRealTmux()` / `canRunRealTmuxE2E()`.
- **`package.json` scripts**: U1 added `test:two-pane:{model,tmux-argv,fast}`.
  `check` is still the legacy `lint && typecheck && test` where
  `test = bun test tests/unit tests/integration`. **U2 adds the tmux buckets but
  does not yet fold them into `check`** — the full ladder + `check` repoint is U3
  (parent §8). U2 keeps the old `check` green throughout.

---

## 3. Scope & non-goals

**In scope (this phase = parent U2 only).**
- Move `real-tmux/` + `behavioral-dsl/` infra to `tests-new/_support/` with
  re-export shims at the old paths (D13, R11).
- The three real-tmux drivers, each owning its fixture lifecycle and **all**
  predictability rules (parent §5.4, §12).
- Driver-level regression tests (no-orphans/teardown, timeout/poll, poll-and-resend)
  shipped **before** the tracer in each driver unit (parent R1, execution note).
- Implement the `PaneDriver` capability seam for each driver against **real tmux
  bytes**; implement `RightPane.assertNoCaretEcho` and the three `SystemAssertions`.
- The agent-spec DSL helpers the parent's §9 worked examples assume but U1 did
  **not** ship: `emits(...)`, `live()`, `holdsOpen()` (the `recorded`/`real`
  helpers `fromCassette`/`claudeAgent` are U3). See U2.2 / U2.3 decisions.
- One tracer scenario per driver (parent U2 Files list):
  `screen/follow-live--footer-renders-with-quit-hint`,
  `full-host/fake-agent/follow-live--right-pane-swaps-source`,
  `lifecycle/follow-live--ctrl-c-persists-cancelled-status`.
- The `screen`/`full:fake`/`lifecycle`/`tmux` script buckets with encoded
  concurrency (D6/D14), and measuring the real contention ceiling (D6 explicitly
  defers the bound's tuning to "Phase 2 once drivers exist").

**Out of scope (deferred to later parent phases).**
- `full-host:recorded-agent`, `full-host:real-agent`, `record.ts`, cassettes,
  the overlap report, the bare-`bun test` guard, the docs/skill rewrite, and the
  full `check`/`test:project` repoint — **all U3**.
- Any **behaviour migration** of old tests (U4–U13). U2 writes only the three
  tracers and the driver regression tests; it marks **no** old test `.skip` and
  adds **no** ledger rows (the ledger template itself is U3).
- The live-interleave migration scenario (parent §9.5 second example,
  `press` mid-stream). U2 ships the *capability* (live-driven submode reachable
  via `meta.liveDriven`) and a minimal reachability proof; the full follow-live
  interleave belongs to the migration that unblocks the deferred Tier-1 placeholder
  (parent U4/U6). See U2.2 Decision D-P2.3.

**Non-goals (carried from parent §2).** Not changing what the orchestrator does;
not removing real-tmux testing (it becomes drivers); not redesigning the parent's
interfaces.

---

## 4. Decisions inherited & phase-local decisions

**Inherited (must not relitigate):** D2 (no old-test deletion — but U2 skips
*none*), D4 (`screen` = S2 single-pane fixture), D6 (real-tmux concurrency
ceiling), D8 (selection by path; `skip()` only prevents false failure), D10
(co-located chrome literals, never imported from `src/`), D13 (`_support/` neutral
home + shims), D14 (concurrency encoded as flags, not comments). Parent §5.4 (all
predictability rules live in the driver), §5.7 (adversarial byte catalogue), §12.

**Phase-local decisions** (resolving genuine gaps this plan surfaced; each is a
"how", inside the parent's "what"):

| # | Decision | Choice | Rationale |
|---|---|---|---|
| **D-P2.1** | **What moves to `_support/` in U2, and in what grain** | Move **both** `tests/helpers/real-tmux/**` → `tests-new/_support/real-tmux/**` and `tests/helpers/behavioral-dsl/**` → `tests-new/_support/behavioral-dsl/**`, preserving internal file structure. Leave a thin **barrel-only** re-export shim at each old `index.ts` (`tests/helpers/real-tmux/index.ts`, `tests/helpers/behavioral-dsl/index.ts`) re-exporting from the new location. Old consumers import only via those barrels (verified), so a barrel shim suffices. | D13 + R11. The drivers wrap these seams and D10 bans `tests-new → tests` imports, so the seams must live under `_support/`. Old `tests/integration/real-tmux/**` and `tests/integration/lifecycle/**` stay green via the shim until U8/U13 skip them. |
| **D-P2.2** | **Agent-spec DSL helpers (`emits`/`live`/`holdsOpen`)** | U2 adds them to the DSL barrel (`tests-new/dsl/index.ts`) as small typed factories returning an `AgentSpec` discriminated union the full-host/lifecycle drivers interpret. `emits(...texts)` → static `FakeRunner.script({events})`; `live()` → `scriptedFake` puppet; `holdsOpen()` → a held step (`holdUntilReleased`-style). `FullHostSpec`/`LifecycleSpec` gain an optional `agent?: AgentSpec` field. | Parent §9.5/§9.8 worked examples pass `agent: emits(...)` / `agent: live()` / `agent: holdsOpen()`, but U1's specs are bare `{steps, stopAt?}` and the barrel exports none of these. They are a real, ordered deliverable, not a freebie. |
| **D-P2.3** | **Live-driven full-host surface extension** | The `scriptedFake` live-driven submode needs `app.agent.type()/finish()` and `app.press()` (parent §9.5 second example) — absent from `FullHostApp`. U2 ships the **driver capability** (selected by `meta.liveDriven`) + a **minimal reachability tracer**, and extends `FullHostApp` with an **optional** `agent?` handle gated to live-driven builds. It does **not** add `press` to `FullHostApp` (that conflates full-host with lifecycle). The full mid-stream-`press` interleave scenario is deferred to the migration unit that unblocks the deferred Tier-1 follow-live placeholder (parent U4/U6). | Keeps the type surface honest (parent §5.2: unsupported action = type error) while satisfying the parent U2 scenario "live-driven submode is reachable only via explicit option." Avoids inventing a cross-cutting `press` on full-host before a migration actually needs it. |
| **D-P2.4** | **Concurrency bound (D6/D14)** | U2.5 **measures** the real contention ceiling on the dev box (run `screen` + `full:fake` at `--max-concurrency` 1/2/3/4, record wall-clock + any flake) and sets `test:two-pane:tmux` to the lowest bound that is both stable and not needlessly slow; `lifecycle` is hard-pinned `--max-concurrency=1` (serial). The chosen number + measurement is recorded in the DoD section of this plan and in a one-line `package.json` comment. | D6 explicitly says the ceiling is "revisited in Phase 2 once drivers exist and the real contention ceiling is measured." Parent ships `--max-concurrency=2` as the placeholder; U2 confirms or adjusts it with evidence. |
| **D-P2.5** | **Driver `skip()` predicate** | All three drivers' `skip()` returns `!canRunRealTmux()` (imported from `_support/real-tmux/`). `timeout` = `REAL_TMUX_TEST_TIMEOUT_MS` (30s). Internal poll/assert waits use `REAL_TMUX_ASSERT_TIMEOUT_MS` (15s). Both constants are honoured; neither is dropped (parent §12 names both). | D8 + parent §12. `skip()` only prevents false failure on an incapable box; it never causes a run. |

---

## 5. Directional design — how each driver plugs into the seam

> *Directional guidance for review — not implementation specification. The
> implementing agent refines names/shapes in its own work where reality demands,
> honouring the parent's §5 contract.*

All three drivers follow the **`model` driver's proven shape** (verified in
`tests-new/dsl/drivers/model-driver.ts`): a `createXApp()` closure factory holding
fixture state, returning a concrete app object whose methods drive/inspect that
state, with an inner `PaneDriver` injected into `new LeftPane(driver)` /
`new RightPane(driver)`. The difference is *what the `PaneDriver` inspects*: the
`model` driver inspects the projected view-model; the three U2 drivers **capture
real tmux bytes** (`capturePane({joinWrapped:true})` → `stripAnsi` → match the
co-located chrome literal), per parent §5.5 and R5.

```
  scenario(meta, body)                       [unchanged, U1]
        │  meta.drivers → DRIVERS[name].build(meta)
        ▼
  Driver.build(meta)  ── owns: createRealTmuxFixture() → unique socket,
        │                       REAL_TMUX_TEST_TIMEOUT/ASSERT_TIMEOUT,
        │                       hook-signal + liveness backstop, server reaping,
        │                       puppet parent-liveness self-reap, poll-and-resend
        ▼
  App surface (Screen/FullHost/Lifecycle)    [U1 interfaces, U2 implements]
        │  leftPane/rightPane → PaneDriver (real-tmux bytes)
        │  system → SystemAssertions (exit/teardown/persisted status)
        ▼
  moved _support/ infra  ── real-tmux harness  +  behavioral-dsl engine
        ▼
  src/hosts/two-pane/**  under real tmux
```

**`full-host:fake-agent`** wraps `mountTmuxHost(fixture, opts)` → `MountedHarness`
(`.left`/`.right` `PaneHandle`s, `runWorkflow`/`runPuppetWorkflow`, `agent(label)`).
`launch(spec)` maps `spec.steps` + `spec.agent` to `HarnessStep[]`; `complete(step)`
awaits that step (static) or drives `handle.agent(step).complete()` (live). The
`PaneDriver` reads `harness.right.capture()` / `.waitForText()`.

**`lifecycle`** wraps `launchOrchWorkflow(fixtureName, opts)` → `OrchHandle`
(real subprocess orch under real tmux, `.agent()` puppet control, `.teardown()`).
`press('left'|'right', key)` routes through the behavioral-dsl `pressKeyInPane`
(idempotent keys poll-and-resend per §12 rule 6); `signal(sig)` → `signalOrch(sig)`;
`system.exitedNormally/tmuxTornDown/persistedStatus` map to the existing
`exitedNormally()` / `tmuxIsTornDown()` outcome matchers + persisted-state read.

**`screen` (S2)** is **net-new**: extract a single-pane fixture that mounts
*only* the steps-view (`startStepsView` / `createStepsViewModel` + the `StepsView`
Ink component) on one tmux pane — no `right-pane-controller`, no pane-map, no full
host. The driver owns `width`/`height` + `resize(w,h)`. The `PaneDriver` captures
that one pane's bytes. `rightPane` access is rejected by type (U1) **and** runtime.

---

## 6. Implementation units

> **Ordering rationale.** U2.1 (infra move) is the hard prerequisite — the drivers
> cannot import the harness across the tree boundary until it lives under
> `_support/`. U2.2 (`full-host:fake-agent`) and U2.3 (`lifecycle`) are **wrapping**
> work that proves the `Driver → PaneDriver → real-tmux` seam on already-built
> infrastructure. U2.4 (`screen` S2) is **net-new** extraction; doing it after the
> two wrappers means the driver-seam pattern is already proven on easier ground.
> U2.5 wires the registry, measures concurrency, and closes the DoD. Each unit
> wires its driver into `DRIVERS` as it completes (replacing one stub), so the
> tree typechecks and the new bucket lights up incrementally; `bun run check` (old
> tree) stays green throughout.

---

### U2.1. Move `real-tmux/` + `behavioral-dsl/` infra to `_support/` with shims

**Goal.** Relocate the shared real-tmux harness and the behavioral-dsl engine to
`tests-new/_support/` so the three drivers can import them without crossing the
`tests-new → tests` boundary (D10/D13), leaving re-export shims so the still-green
old suite never breaks (R11).

**Requirements.** Parent D13, R11; §4 (the `_support/` move is "real, ordered
work — not a placement detail").

**Dependencies.** None (first unit of this phase).

**Files (move / create).**
- Move `tests/helpers/real-tmux/**` → `tests-new/_support/real-tmux/**` (fixture.ts,
  workflow-driver.ts, socket.ts, pane-handle.ts, agent-handle.ts, keys.ts, ansi.ts,
  assert-no-leaks.ts, tee-helpers.ts, index.ts, README.md).
- Move `tests/helpers/behavioral-dsl/**` → `tests-new/_support/behavioral-dsl/**`
  (launch.ts, user-actions.ts, the four `*-matchers.ts`, assertions.ts, awaits.ts,
  index.ts, README.md, and the whole `internal/` subtree).
- Create shim `tests/helpers/real-tmux/index.ts` → `export * from
  '../../../tests-new/_support/real-tmux/index.ts'` (barrel-only).
- Create shim `tests/helpers/behavioral-dsl/index.ts` → re-export the moved barrel.
- Update intra-module relative imports inside the moved files (they import each
  other by relative path; structure is preserved so most are unchanged — verify
  any `../../setup/**` or `../../../src/**` depth that changed).
- Fix any moved-file imports of helpers that did **not** move (e.g. references to
  `tests/setup/reap-test-sockets.ts`, `tests/fixtures/**`): either co-move the
  genuinely-shared ones or leave the moved file importing the old path **only if**
  that path is itself stable until its own phase. Prefer co-moving `setup/`
  reaping helpers the real-tmux fixture depends on; otherwise note the temporary
  cross-reference in the ledger-to-be (U3). *(Resolve at implementation time by
  reading the actual import graph — see Deferred notes.)*

**Approach.**
- This is a **pure relocation** — no behavioural change to the harness or engine.
  A diff of moved-vs-original should be import-path-only.
- Confirm the move grain against the real import graph first: `grep -rE
  "tests/helpers/(real-tmux|behavioral-dsl)" tests src` to enumerate **every** live
  consumer, then confirm each imports via the barrel `index.ts` (the shim target).
  Research confirms old consumers import the barrel; verify before relying on it.
- Keep `@orch/test/*` mapping untouched (already → `_support/*`).

**Patterns to follow.** U1's own `_support/` move of `ink-frame.ts` /
`type-assertions.ts` with shims (`tests-new/_support/` already demonstrates the
pattern); parent §4 shim description.

**Test scenarios.**
- **Old suite parity (the whole point):** `bun run check` (old tree:
  `tests/unit tests/integration` + typecheck) is **green** after the move — every
  old consumer resolves through the shim. *(critical / integration)* — this is the
  R11 guard.
- A moved helper imported via its **new** `_support/` path resolves and runs (smoke:
  import `createRealTmuxFixture` and `launchOrchWorkflow` from `_support/` in a
  trivial test). *(happy)*
- A moved helper imported via its **old** shim path resolves to the same symbol
  (identity smoke: `import { mountTmuxHost } from 'tests/helpers/real-tmux'`
  still works). *(happy)*
- `grep -rE "from '.*tests-new/_support" tests/` returns **zero** — the old tree
  imports only via the shim barrel, never reaches across into `_support/`
  directly. *(edge / consistency)*

**Verification.** `bun run check` green (old tree unbroken via shims);
`bun run typecheck` green (moved files compile under `tests-new` include);
both `_support/real-tmux` and `_support/behavioral-dsl` barrels export their full
public surface; the two shim barrels exist and re-export. No driver wired yet.

---

### U2.2. `full-host:fake-agent` driver (static default + live-driven submode)

**Goal.** Build the driver that boots the **full two-pane host** under real tmux
with a `FakeRunner` (static, default) or `scriptedFake` (live-driven, explicit)
in the agent slot, wrapping the moved `mountTmuxHost`. Ship its no-orphans/teardown
and timeout regression tests **first**, then the tracer. Implement
`RightPane.assertNoCaretEcho` against captured bytes. Add the `emits()`/`live()`
agent-spec helpers.

**Requirements.** Parent §3.4 (full-host), §4 (fake-agent mode + live-driven
decision), §5.4, §5.5, §6.1; D6, D8, D10, D14; this plan D-P2.2, D-P2.3, D-P2.5.

**Dependencies.** U2.1.

**Files (create / modify).**
- `tests-new/dsl/drivers/full-host-fake-agent-driver.ts` — the driver
  (`build`/`skip`/`timeout` + `createFullHostFakeAgentApp()` factory + inner
  real-tmux `PaneDriver`).
- `tests-new/dsl/drivers/__tests__/full-host-fake-agent-driver.test.ts` —
  **regression tests first** (no-orphans, teardown reaps server + socket, timeout
  budget, live-driven reachable only via `meta.liveDriven`).
- `tests-new/full-host/fake-agent/follow-live--right-pane-swaps-source.test.ts` — tracer.
- `tests-new/dsl/agent-spec.ts` (or fold into `index.ts`) — `emits(...)`, `live()`
  factories + the `AgentSpec` union (D-P2.2).
- `tests-new/dsl/app-surfaces.ts` — extend `FullHostSpec` with `agent?: AgentSpec`;
  add the optional `agent?` live handle to `FullHostApp` (D-P2.3).
- `tests-new/dsl/panes/right-pane.ts` — implement `assertNoCaretEcho()` (currently
  `notImplemented`) via the `PaneDriver` (a `count: 0` / "no caret glyph" byte assertion).
- `tests-new/dsl/index.ts` — export `emits`, `live`.
- `tests-new/dsl/drivers/registry.ts` — replace the `full-host:fake-agent` stub
  with the real driver.
- `package.json` — add `test:two-pane:full:fake` (bucket; concurrency set in U2.5).

**Approach.**
- `build(meta)`: `await createRealTmuxFixture()` → `mountTmuxHost(fixture, opts)`.
  Choose static vs live by `meta.liveDriven`: static uses `FakeRunner.script({events})`
  per step; live uses `runPuppetWorkflow` + `harness.agent(label)`.
- `launch(spec)`: map `spec.steps` + `spec.agent` (default `emits()` empty) to
  `HarnessStep[]`; kick the workflow. `complete(step)`: static → await the step's
  completion via the harness; live → `harness.agent(step).complete()`.
- `PaneDriver`: `leftPane`/`rightPane` `assertBottomText`/`assertContains` →
  `harness.left/right.waitFor(...)` over **captured tmux bytes** (`capture()` =
  `capturePane({joinWrapped})` → `stripAnsi`), matching co-located chrome literals
  (R5 — never a fake tmux). `assertNoCaretEcho` asserts the caret/echo glyph is
  absent in the right pane.
- All predictability rules are inside `build`/`teardown` already (the fixture owns
  the socket + reaping; `mountTmuxHost.teardown()` + `fixture.dispose()`); the
  driver must call both and additionally guard leaked scripted-fake puppets via
  `assertNoLeakedEntries(baseline)` in `teardown()` for the live submode.

**Execution note.** Start with the failing **no-orphans/teardown** regression test
(characterize the fragile real-tmux lifecycle) before the tracer — this boundary is
where every historical flake lived (parent execution note, R1).

**Patterns to follow.** `tests-new/dsl/drivers/model-driver.ts` (factory + inner
`PaneDriver` shape); moved `_support/real-tmux/workflow-driver.ts` (`mountTmuxHost`,
`runWorkflow`, `runPuppetWorkflow`, `agent`); moved `_support/real-tmux/assert-no-leaks.ts`;
old `tests/integration/hosts/two-pane/tier-1/*` for the assertion style being re-derived.

**Test scenarios.**
- `build()` allocates a **unique** socket; `teardown()` reaps the tmux server *and*
  removes the socket file; after teardown, **zero** orphan children and zero leaked
  scripted-fake entries above baseline. *(critical / integration)* —
  `REGRESSION: 2026-05-26 real-tmux-suite-flakiness-leaked-puppets`.
- The driver applies `REAL_TMUX_TEST_TIMEOUT_MS` as the test budget and
  `REAL_TMUX_ASSERT_TIMEOUT_MS` for poll/assert waits (assert both constants are
  used, not Bun's 5s default). *(error path)*
- **Static default:** scripted text (`emits('first thinking','second thinking')`)
  reaches the **right** pane after `complete(step)`, asserted on captured real-tmux
  bytes, with **no caret echo** (`assertNoCaretEcho`). *(integration / critical)*
- **Live-driven submode** is reachable **only** via `meta.liveDriven: true`, never
  inferred from the scenario body; a non-live scenario calling a live-only
  affordance is unreachable. *(edge)* — covers parent U2 "reachable only via explicit
  option" scenario.
- `full-host:fake-agent` refuses (runtime, in addition to type) a `resize` call
  (full-host has no `resize`). *(edge)*
- Tracer `follow-live--right-pane-swaps-source [full-host:fake-agent]` passes:
  autonomous transcript reaches the right pane on real tmux. *(happy)* `Covers F9.`

**Verification.** `bun run test:two-pane:full:fake` green; driver regression tests
pass; `assertNoCaretEcho` implemented and asserted on real bytes; `emits`/`live`
exported and typed; old `check` still green.

---

### U2.3. `lifecycle` driver (wraps the moved `behavioral-dsl` engine)

**Goal.** Build the outside-in `lifecycle` driver wrapping the moved
`behavioral-dsl` subprocess engine behind the typed `LifecycleApp` surface,
implement the three `SystemAssertions`, honour the poll-and-resend idempotent-key
rule, ship the no-orphans + poll-and-resend regression tests **first**, then the
tracer. Add the `holdsOpen()` agent-spec helper.

**Requirements.** Parent §3.5 (lifecycle), §5.4, §6.1, §12 (predictability rules,
esp. rule 5 server reaping + rule 6 poll-and-resend); D6 (serial), D8, D13, D14;
this plan D-P2.2, D-P2.3, D-P2.5.

**Dependencies.** U2.1. (Independent of U2.2 — may run in parallel, but registry
edits must not collide; sequence after U2.2 to keep `registry.ts` edits serial.)

**Files (create / modify).**
- `tests-new/dsl/drivers/lifecycle-driver.ts` — driver + `createLifecycleApp()`
  factory wrapping `launchOrchWorkflow` / `OrchHandle`.
- `tests-new/dsl/drivers/__tests__/lifecycle-driver.test.ts` — regression tests
  first (no-orphans/teardown/server-reap, poll-and-resend for `f`, timeout budget).
- `tests-new/lifecycle/follow-live--ctrl-c-persists-cancelled-status.test.ts` — tracer.
- `tests-new/dsl/panes/system-assertions.ts` — implement `exitedNormally()`,
  `tmuxTornDown()`, `persistedStatus(status)` (currently `notImplemented`) against
  the lifecycle driver's `OrchHandle` + outcome matchers.
- `tests-new/dsl/app-surfaces.ts` — `LifecycleSpec` gains `agent?: AgentSpec`.
- `tests-new/dsl/agent-spec.ts` / `index.ts` — add `holdsOpen()` (held step).
- `tests-new/dsl/drivers/registry.ts` — replace the `lifecycle` stub.
- `package.json` — add `test:two-pane:lifecycle` (`--max-concurrency=1`, serial).

**Approach.**
- `build(meta)`: launch the orch subprocess via `launchOrchWorkflow(fixtureName,
  { script, bringToState })`, deriving `fixtureName`/`script` from `meta` + the
  launch spec's `steps`/`agent`/`stopAt` (`stopAt: 'mid-step'` →
  `bringToState: { kind: 'mid-step', name }`).
- `press('left'|'right', key)`: route through the behavioral-dsl `pressKeyInPane`
  user-action. **Idempotent keys (`f`, boundary nav) poll-and-resend** until the
  observed state matches (parent §12 rule 6; template = `snapToLive()/selectStep()`
  in the moved `_support/behavioral-dsl/user-actions.ts`). Fire-and-forget only for
  keys with a unique observable transition the assertion already polls.
- `signal(sig)`: `signalOrch(sig)` via the engine.
- `system.*`: `exitedNormally()` → `exitedNormally()` outcome matcher;
  `tmuxTornDown()` → `tmuxIsTornDown()`; `persistedStatus(status)` → read
  `state.json` `stateStatus` (the engine's `awaitRunStatus` / snapshot path) and
  assert it equals `status` (`'cancelled'` etc.).
- `teardown()`: `handle.teardown()` (engine already reaps the **detached**
  `orch-<runId>` server + socket per §12 rule 5) **and** `assertNoLeakedEntries`.

**Execution note.** Start with the failing **no-orphans/server-reap** regression
test, then the **poll-and-resend** test (re-press `f` until observed), then the
tracer — this driver carries the two named historical flakes
(`2026-05-26` leaked puppets, `2026-05-29` `nav.f-snaps`).

**Patterns to follow.** Moved `_support/behavioral-dsl/{launch,user-actions,
outcome-matchers,assertions}.ts`; old `tests/integration/lifecycle/sigterm-*.real.test.ts`
and `q-during-fake-mid-step.real.test.ts` for the assertion style being wrapped;
`_support/real-tmux/assert-no-leaks.ts`.

**Test scenarios.**
- `build()`/`teardown()`: unique socket; teardown reaps the **detached** orch
  server + socket; zero orphan children, zero leaked scripted-fake entries above
  baseline. *(critical / integration)* — `REGRESSION: 2026-05-26 leaked-puppets`.
- Idempotent key `f` is poll-and-resent until observed, defeating the
  dropped-first-keypress race. *(critical)* — `REGRESSION: 2026-05-29 nav.f-snaps`.
- Both timeout constants honoured (test budget = `REAL_TMUX_TEST_TIMEOUT_MS`,
  poll waits = `REAL_TMUX_ASSERT_TIMEOUT_MS`); a missed `pane-died` hook resolves
  via the liveness backstop in ~1s, logged. *(error path)*
- `system.persistedStatus('cancelled')` reads `state.json` and fails if the status
  is anything else (plant a `completed` run → assertion goes red). *(critical)*
- `system.tmuxTornDown()` is true only after the server is actually gone (not just
  the process). *(integration)*
- Tracer `follow-live--ctrl-c-persists-cancelled-status [lifecycle]`: press `q`/
  Ctrl-C during a held step → `exitedNormally()` + `tmuxTornDown()` +
  `persistedStatus('cancelled')`. *(happy)* — mirrors parent §9.8 shape.

**Verification.** `bun run test:two-pane:lifecycle` green **serially**
(`--max-concurrency=1`); regression tests pass; the three `SystemAssertions`
implemented; old `check` green.

---

### U2.4. `screen` (S2) driver — net-new single-pane steps-view fixture

**Goal.** Extract a dedicated **single-pane** steps-view real-tmux fixture (S2,
D4) — mounting *only* the left/steps pane, never the full two-pane host — build the
`screen` driver on it (owning `width`/`height`/`resize`), ship the
no-orphans/teardown + resize regression tests and the **adversarial byte
catalogue** (§5.7) **before** the tracer. This is the highest-risk, highest-effort
unit (parent sizing note) and may be split into "extract fixture" then "driver +
tests" sub-steps during its own implementation.

**Requirements.** Parent §3.3 (+ S2 = D4), §4.1, §5.7 (adversarial byte catalogue),
§6.1, §12; D4, D6, D8, D10, D14; this plan D-P2.5.

**Dependencies.** U2.1, U2.2 (the driver-seam pattern proven on real tmux first).

**Files (create / modify).**
- `tests-new/_support/real-tmux/single-pane-steps-fixture.ts` — **net-new** S2
  fixture: boot a tmux server (reuse `createRealTmuxFixture` socket/reaping) and
  mount `startStepsView` / `createStepsViewModel` + the `StepsView` Ink component
  on **one** pane, no right-pane controller / pane-map. (Lives in `_support/`, not
  `dsl/`, because it is harness infrastructure the driver wraps.)
- `tests-new/dsl/drivers/screen-driver.ts` — driver + `createScreenApp()` factory
  (owns `width`/`height` + `resize(w,h)`) + inner real-tmux `PaneDriver` (left pane
  bytes only).
- `tests-new/dsl/drivers/__tests__/screen-driver.test.ts` — regression tests first
  (no-orphans/teardown, resize re-render, refuses `rightPane`) **and** the
  table-driven adversarial byte catalogue.
- `tests-new/screen/follow-live--footer-renders-with-quit-hint.test.ts` — tracer.
- `tests-new/dsl/drivers/registry.ts` — replace the `screen` stub.
- `package.json` — add `test:two-pane:screen` (concurrency set in U2.5).

**Approach.**
- **S2 extraction** is the load-bearing design work: identify the minimal seam in
  `src/hosts/two-pane/steps-view/**` to mount the steps-view alone. Candidates
  (verified to exist): `startStepsView(opts)` (returns `{ intent$ }`),
  `createStepsViewModel(opts)` (the state machine over `lifecycle.ndjson` +
  `state.json`), `projectStepsView(args)` (pure projector), and the `StepsView`
  Ink component. The fixture feeds the model a synthetic lifecycle/state for the
  spec's `steps`/`stopAt`, renders to one tmux pane, and exposes capture. **Resolve
  the exact mount seam by reading the steps-view barrel at implementation time** —
  prefer reusing `startStepsView` if it can target one pane without the host;
  otherwise compose `createStepsViewModel` + `StepsView` directly (see Deferred
  notes).
- `resize(w,h)`: re-render at the new tmux pane geometry; the `screen` risk class
  (wrapping, narrow/wide widths, SIGWINCH/header-duplication) lives **here**, not
  as one-offs.
- `PaneDriver`: capture **left-pane bytes only**; match co-located chrome literals
  with the `count` guard (catches a double-rendered footer/header). `rightPane`
  access throws at runtime (type already rejects it via `ScreenApp`).
- All predictability rules from the fixture (socket/reaping/timeouts) apply.

**Execution note.** Start with the failing no-orphans/teardown regression test on
the new single-pane fixture, then `resize`, then the adversarial byte catalogue
(byte hygiene can only be proven on real tmux — §5.1), then the tracer.

**Patterns to follow.** `src/hosts/two-pane/steps-view/index.ts` barrel and
`steps-view.tsx`/`steps-view-model.ts`/`project-steps-view.ts`; moved
`_support/real-tmux/{fixture,pane-handle}.ts` for socket + capture; the `model`
driver's chrome-literal assertion style (but over **real bytes** here).

**Test scenarios.**
- `build()`/`teardown()`: unique socket; teardown reaps server + removes socket;
  zero orphans. *(critical / integration)*
- `resize(w,h)` re-renders; a **narrow** width wraps the footer **without
  duplicating the header**; a **wide** width lays out without truncation.
  *(edge)* — left-pane bytes only.
- **Adversarial byte catalogue (§5.7), table-driven:** subprocess-controlled
  content with ANSI sequences, carriage returns, **NUL**, wide glyphs, long lines,
  and chunk-boundary fragments survives real tmux without corrupting the pane.
  *(adversarial / critical)* — on the real-tmux `screen` driver, since a fake tmux
  cannot prove byte hygiene. Start with a fixture table; defer any property-testing
  dependency.
- `screen` driver refuses (runtime, in addition to type) `rightPane` access.
  *(edge)*
- `LeftPane.assertGlyph(step, 'running'|'done'|'failed')` matches the rendered
  glyph bytes off real tmux. *(integration)*
- Tracer `follow-live--footer-renders-with-quit-hint [screen]`: the footer renders
  the quit hint **once** at the bottom of the steps pane (co-located literal,
  `count: 1` guards double-render). *(happy)* — the `overlapGroup:
  'follow-live-view-mode'` contract twin of the U1 `model` tracer (§5.5).

**Verification.** `bun run test:two-pane:screen` green; the single-pane fixture
boots only one pane (assert no right-pane controller mounted); adversarial catalogue
green on real tmux; resize regression green; old `check` green.

---

### U2.5. Registry finalization, concurrency measurement, script ladder, DoD

**Goal.** Confirm all three drivers are wired into `DRIVERS`, **measure** the real
real-tmux contention ceiling and set the encoded concurrency bound (D6/D14),
finalize the U2 script buckets, and close the phase Definition of Done.

**Requirements.** Parent D6, D14, §8 (the U2 subset of the ladder); this plan D-P2.4.

**Dependencies.** U2.2, U2.3, U2.4.

**Files (modify).**
- `tests-new/dsl/drivers/registry.ts` — confirm `screen`, `full-host:fake-agent`,
  `lifecycle` are real drivers; `full-host:recorded-agent` / `full-host:real-agent`
  remain stubs (U3).
- `package.json` — finalize the U2 buckets with encoded concurrency:
  - `test:two-pane:screen`, `test:two-pane:full:fake` (atomic).
  - `test:two-pane:tmux` = `bun test --max-concurrency=<N> tests-new/screen
    tests-new/full-host/fake-agent` (the measured bound; **note**: parent §8 folds
    `recorded` into this bucket at U3 — leave a comment marking that).
  - `test:two-pane:lifecycle` = `bun test --max-concurrency=1 tests-new/lifecycle`.
  - **Do not** repoint `check`/`test`/`test:project` — that is U3.

**Approach.**
- **Measure (D-P2.4):** run `test:two-pane:tmux` candidates at
  `--max-concurrency` ∈ {1,2,3,4}, record wall-clock and any flake/leak across a
  few repeats; pick the lowest stable bound that is not needlessly slow. Document
  the number + the measurement in this plan's DoD note and a one-line `package.json`
  comment. Hard-pin `lifecycle` to 1 regardless (serial, D6).
- Confirm the registry `satisfies Record<DriverName, Driver<AppBase>>` still holds
  with three real + two stub drivers.

**Test scenarios.**
- All three new buckets are runnable **by path** (D8) and green on a capable box;
  each auto-skips cleanly when `canRunRealTmux()` is false (no false failure).
  *(gating / happy)*
- Running `test:two-pane:tmux` at the chosen bound is stable across repeated runs
  (no leaked sockets/puppets accumulate — re-assert via `listScriptedFakeEntries`
  / socket count before-vs-after). *(critical)* — guards the U2 root-cause flake.

**Verification.** `bun run test:two-pane:tmux` and `bun run test:two-pane:lifecycle`
green under the encoded ceiling; the three driver regression suites pass; old
`check` green (untouched); the concurrency bound is recorded with evidence.

---

## 7. Definition of Done (phase U2)

- `tests-new/_support/real-tmux/**` and `tests-new/_support/behavioral-dsl/**`
  exist; re-export shims at the old `tests/helpers/**` barrels keep the old suite
  green (R11).
- `DRIVERS` wires real `screen`, `full-host:fake-agent`, `lifecycle` drivers;
  `full-host:recorded-agent` / `full-host:real-agent` remain stubs.
- **All** predictability rules (parent §12) live inside the driver
  `build`/`teardown`: unique socket per run, both `REAL_TMUX_TEST_TIMEOUT_MS` and
  `REAL_TMUX_ASSERT_TIMEOUT_MS`, hook-signal + liveness backstop, server reaping,
  puppet parent-liveness self-reap, poll-and-resend for idempotent keys.
- Each driver ships **driver-level regression tests** (no-orphans/teardown,
  timeout/poll, poll-and-resend where applicable) that pass **before** behaviour
  migrates (none migrates in U2).
- `RightPane.assertNoCaretEcho` and the three `SystemAssertions` are implemented
  (no longer `notImplemented`).
- The `emits()`/`live()`/`holdsOpen()` agent-spec helpers are exported and typed.
- Three tracers green:
  `screen/follow-live--footer-renders-with-quit-hint`,
  `full-host/fake-agent/follow-live--right-pane-swaps-source`,
  `lifecycle/follow-live--ctrl-c-persists-cancelled-status`.
- `test:two-pane:{screen,full:fake,lifecycle,tmux}` buckets exist with encoded
  concurrency (D6/D14); the bound is measured and recorded; `lifecycle` is serial.
- `bun run check` (old tree) stays **green** throughout — U2 skips **no** old test
  and adds **no** ledger rows.
- `bun run typecheck` green (the three drivers + extended surfaces compile under
  the `tests-new` include).

---

## 8. Deferred to implementation (execution-time unknowns)

These depend on reading real code / running real tmux and must **not** be
pretended-resolved here:
- The exact intra-module import-depth fixes inside the moved `_support/` files, and
  whether any `tests/setup/**` or `tests/fixtures/**` dependency of the real-tmux
  fixture should co-move now or stay behind a temporary reference until its own
  phase (U2.1 — resolve from the actual import graph).
- The exact **S2 mount seam**: whether `startStepsView` can target a single pane
  without the full host, or whether the fixture must compose
  `createStepsViewModel` + `StepsView` directly (U2.4 — resolve from the steps-view
  barrel).
- The precise **`assertNoCaretEcho`** byte signature on this terminal (which glyph/
  escape indicates a caret echo) — discover by capturing a real right pane (U2.2).
- The measured **concurrency bound** for `test:two-pane:tmux` (U2.5/D-P2.4).
- The exact `state.json` field path for `persistedStatus` (`stateStatus` per the
  snapshot type, but confirm against the live file) (U2.3).
- Whether the live-driven full-host `agent` handle is best exposed as `app.agent`
  or via a typed `LiveFullHostApp` sub-surface (U2.2/D-P2.3) — pick the shape that
  keeps "unsupported action = type error" honest with the least surface.

---

## 9. Risks & mitigations (phase-local view)

| Risk | Likelihood | Mitigation |
|---|---|---|
| **R1 (parent) — predictability rules regress when moved into drivers.** | High | Driver-level regression tests **first** in U2.2–U2.4 (no-orphans, teardown, timeout, poll-and-resend); both timeout constants honoured; concurrency ceiling encoded and **measured** (U2.5). |
| **R11 (parent) — moving `real-tmux`/`behavioral-dsl` breaks live old consumers.** | Medium | U2.1 leaves barrel re-export shims at both old paths; the DoD requires old `check` green; consumers verified to import via the barrel before relying on the shim. |
| **R5 (parent) — `screen`/`full-host` byte assertions go vacuous against a fake.** | Medium | Driver `PaneDriver`s capture **real tmux bytes** (`capturePane → stripAnsi`), never a fake tmux; the adversarial byte catalogue (§5.7) runs only on the real-tmux `screen` driver. |
| **P2-A — S2 single-pane extraction is net-new and under-scoped.** | Medium | U2.4 is its own unit, ordered after the two wrappers prove the seam; may split into "extract fixture" + "driver/tests"; the mount seam is an explicit deferred decision, not assumed. |
| **P2-B — worked examples (§9) assume surfaces/helpers U1 didn't ship** (`emits`/`live`/`holdsOpen`, live-driven `app.agent`/`press`). | Medium | D-P2.2/D-P2.3 make these explicit, ordered deliverables with minimal honest type surfaces; the full mid-stream-`press` interleave is deferred to the migration unit that needs it (U4/U6), not invented in U2. |
| **P2-C — registry `satisfies Record<DriverName, Driver<AppBase>>` breaks mid-phase** as stubs are replaced one at a time. | Low | Each unit wires its driver into `DRIVERS` only when it satisfies the interface; the other entries stay valid stubs; `typecheck` is part of each unit's verification. |

---

## 10. Requirements traceability

| Parent requirement | Where addressed |
|---|---|
| §3.3 + D4 (`screen` = S2 single-pane) | U2.4 |
| §3.4 (full-host) + §4 (fake-agent mode, live-driven decision) | U2.2 |
| §3.5 (lifecycle, outside-in) | U2.3 |
| §5.4 (all predictability rules in the driver) | U2.2–U2.4 (build/teardown), §7 DoD |
| §5.5 / D10 (co-located chrome literals over real bytes; overlapGroup contract twin) | U2.4 tracer (`follow-live-view-mode`), all `PaneDriver`s |
| §5.7 (adversarial byte catalogue) | U2.4 |
| §12 (predictability rules; both timeout constants; rule 5 server reaping; rule 6 poll-and-resend) | U2.2–U2.4 regression tests |
| D6 / D14 (concurrency encoded + measured; lifecycle serial) | U2.5 / D-P2.4 |
| D8 (selection by path; `skip()` only prevents false failure) | U2.5 buckets, D-P2.5 |
| D13 / R11 (`_support/` home + shims) | U2.1 |
| Parent U2 "driver-level regression tests before behaviour migrates" | U2.2–U2.4 execution notes |
| Parent U2 "three tracers pass" | U2.2–U2.4 tracers |
| Parent U2 Files: `test:two-pane:{screen,full:fake,lifecycle,tmux}` | U2.2/U2.3/U2.5 |
| Parent U2 **non-goal**: no old-test skip, no ledger rows (that's U3+) | §3 Out of scope, §7 DoD |

---

## 11. Concurrency measurement result (D-P2.4) — landed 2026-06-05

Measured the `test:two-pane:tmux` bucket (`screen` + `full-host:fake-agent`
driver tests + tracers, 20 tests) at `--max-concurrency` ∈ {1, 2, 4} on the dev
box (macOS, tmux 3.x). All three settings were **stable**: 0 failures, and the
reserved `orch-test-*` socket count + scripted-fake puppet count returned to
baseline after every run across 3 repeats at N=2 (no leak accumulation — the
drivers reap their server + socket cleanly). Bun runs test *files* sequentially,
so wall-clock was effectively flat across N (~5–6s); the flag is the encoded D6
ceiling, not a perf lever here.

**Chosen bound:** `test:two-pane:tmux` → `--max-concurrency=2` (the parent §8
value, now evidence-backed). `test:two-pane:lifecycle` → `--max-concurrency=1`
(serial, D6 — the behavioral-dsl "current handle" is process-global). Note: the
shared tmux socket dir still holds ~133 leaked `orch-*` sockets from the legacy
real-tmux suite (pre-existing, U1-documented); the U2 drivers add none.

## 12. Notable deviations from the directional plan (recorded honestly)

- **D-P2.1 grain — per-file shims, not barrel-only.** The plan assumed old
  consumers import only via the barrel. A full import-graph scan found ~33 deep
  imports of `real-tmux/fixture.ts`, plus `socket.ts`/`agent-handle.ts`/`keys.ts`
  and several `behavioral-dsl` internals. So the move (`scripts/move-test-infra-to-support.sh`)
  leaves a re-export shim at **every** deep-imported old path, not just the barrel.
  Both helper trees sit exactly 3 dirs deep before and after the move, so all
  `../../../src/...` and cross-helper relative imports are preserved unchanged.
- **lifecycle tracer asserts shutdown, not `persistedStatus('cancelled')`.** On
  current `main` neither SIGINT nor a `q` quit-intent persists a `cancelled` run
  status (the run stays `running` — verified empirically; pre-existing gap
  documented in `sigint-to-orch-during-mid-step.real.test.ts`). The tracer
  (`follow-live--ctrl-c-exits-and-tears-down.test.ts`) therefore asserts the
  shutdown outcomes that hold (`exitedNormally` + `tmuxTornDown`); the
  `persistedStatus` assertion itself is implemented and covered against a planted
  (completed) state in the lifecycle driver regression test.
- **Buckets include the driver `__tests__` files explicitly** (path-based, D8) so
  the driver-level regression tests actually run in their driver's bucket — the
  parent §8 category-dir-only form would have skipped them.
