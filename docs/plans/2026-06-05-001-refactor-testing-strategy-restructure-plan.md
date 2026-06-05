---
status: active
type: refactor
title: "refactor: Testing strategy restructure — scenario/driver DSL + whole-repo migration into tests-new/"
created: 2026-06-05
origin: docs/brainstorms/2026-06-05-testing-strategy-restructure-spec.md
depth: deep
---

# refactor: Testing strategy restructure — scenario/driver DSL + whole-repo migration into `tests-new/`

> **This is the parent plan.** It is the last document a human reviews before the
> work runs autonomously, phase by phase. Each phase below is picked up by an
> agent that (1) writes a *detailed* phase-level plan from the unit specified
> here, then (2) implements it behind the gate, then returns. The next phase is
> launched the same way. Therefore this document fixes **core concepts, core
> interfaces, the directory shape, the migration mechanic, and the phase
> sequence** precisely enough that independent agents produce a coherent whole —
> while deliberately leaving file-by-file detail to each phase's own plan.
>
> **North star: readability and maintainability over everything.** No shortcuts,
> no hacks, no "sanctioned copy-paste." Tests must read like sentences; the
> infrastructure (drivers, Pane Objects, scenario runner) must have clean, typed
> interfaces that make the *right* test easy to write and the *wrong* test hard
> to write. When a phase faces a tradeoff between "less work now" and "clearer
> forever," it chooses clearer.

---

## 1. Summary

Today the two-pane host (`src/hosts/two-pane/**`) is tested through a **five-tier
model** ([`docs/testing-strategy.md`](../testing-strategy.md)). The spec
([`docs/brainstorms/2026-06-05-testing-strategy-restructure-spec.md`](../brainstorms/2026-06-05-testing-strategy-restructure-spec.md))
diagnoses the structural faults — a 1-D number imposed on a 2-D space, Tier 4 as
a flag not a tier, location ≠ tier, sanctioned copy-paste, hand-audited
coverage — and chooses a replacement: **one imperative behavioural DSL, written
once per scenario, run against swappable drivers at different fidelities** (the
four-layer pattern from *Growing Object-Oriented Software*: scenario → DSL →
driver → system).

This plan turns that target state into a phased build, and — per the reviewer's
decision — extends it from "two-pane surface only" to a **whole-repo migration
into a fresh `tests-new/` tree** with top-level category directories. The two
distinct kinds of work:

1. **The two-pane behavioral surface** (old Tiers 1–5) is *re-derived* through
   the new scenario/driver DSL into the categories `model`, `screen`,
   `full-host/{fake,recorded,real}-agent`, `lifecycle`, and `tmux-argv`.
2. **Every other test in the repo** (core, runners, services, state, validators,
   workflows, cli, codegen, config, observability) is *relocated* into
   `tests-new/{unit,integration,e2e}/` mirroring the `src/` layout, following the
   **unchanged** three-layer model from [`CLAUDE.md`](../../CLAUDE.md). These are
   already "plain class tests with fakes at the `*Service` seam" — the spec's
   `unit` category is exactly today's unit concept, so this is a relocation +
   import-path fix, not a redesign.

Old tests are **marked `.skip` as their replacement lands and kept on disk
permanently** (reviewer decision — see §3). There is no delete phase. A final
**reconciliation** phase proves every old file is fully skipped, every area is
accounted for in the migration ledger, the overlap report is green, and the gate
runs the `tests-new/` tree.

---

## 2. Problem frame & goals

**Problem.** The five-tier taxonomy is hard to teach, hard to navigate, and hard
to keep honest. Its worst property is that it *sanctions* writing one idea twice
(Tier 1 ↔ Tier 4) and *requires a human audit* to answer "which screen-tested
scenarios were never proven against a real CLI?". The structure elevates
*fidelity knobs* (tmux? real CLI? subprocess?) to *categories*, when the only
genuine category boundary is **"what the controller decides to show" vs "whether
those bytes reach the real screen" vs "process behaviour."**

**Goals (in priority order).**
1. **Readability** — a test is a plain async function of an `app` handle;
   Given/When/Then are sequential `await`s (comment-marked), assertions read like
   sentences (`await app.leftPane.assertQuitHintVisible()`), no builder chains,
   no `.expect(...)` ceremony, no harness boilerplate in scenario files.
2. **Maintainability** — write a behaviour once; run it at multiple fidelities by
   *listing drivers*, not by copy-pasting files. Expected chrome strings live in
   exactly one place (a Pane Object constant). Coverage gaps and migration
   progress become **queryable data**, not a hand audit.
3. **Honesty** — `model` (fast, no tmux) asserts above tmux at the projection
   seam; real-tmux drivers are the only place byte-level assertions mean
   anything; a small, deliberate `model`↔`screen` **contract overlap** keeps the
   fast suite from drifting into all-green theatre.
4. **Safety during migration** — the old suite guards the whole time (it is only
   skipped *after* its replacement is green), so we never lose the net while
   rewriting.

**Non-goals** (carried from spec §13, plus reviewer scope note):
- Not changing what the orchestrator *does* — only how it is tested.
- Not removing real-tmux testing — it becomes one driver among several, with most
  tests below it.
- Not replacing runner *parser* contract tests with recorded-agent cassettes —
  raw CLI parser fixtures remain at the runner layer (§5.4 of the spec).
- Not *redesigning* non-two-pane tests — they relocate into `tests-new/unit|
  integration|e2e` essentially as-is (path + import fixes). The spec's §13
  non-goal "we are not moving non-two-pane tests into this taxonomy" is
  **explicitly superseded** by the reviewer's whole-repo decision, but only as a
  *relocation*, not a re-derivation.

---

## 3. Key decisions (locked by this plan)

These were the open/ambiguous points. They are **fixed here** so downstream
phases cohere. Each phase plan inherits them and must not relitigate them.

| # | Decision | Choice | Rationale |
|---|---|---|---|
| D1 | **Scope** | **Whole repo.** Two-pane surface → new scenario/driver DSL; everything else → relocation into `tests-new/{unit,integration,e2e}`. | Reviewer decision. The `unit` category == today's unit concept, so non-two-pane work is low-risk relocation. |
| D2 | **Old-test disposition** | **Skip-as-migrated, keep skipped forever.** Old file changes are limited to wrapping in `describe.skip` / `it.skip` (+ a one-line `// MIGRATED → <new path>` marker). No deletion. | Reviewer decision. Preserves a historical record and a grep-able "what's left" signal; skipped tests cost ~0 to run. |
| D3 | **New tree location & shape** | **`tests-new/`** with **top-level category dirs**: `dsl/ unit/ integration/ e2e/ model/ tmux-argv/ screen/ full-host/ lifecycle/`. | Reviewer decision. Cleanly separable from the old `tests/` tree; categories are first-class paths (path = category, see D8). |
| D4 | **`screen` driver v1** | **S2 — a dedicated single-pane steps-view real-tmux fixture.** | Reviewer decision. Cleaner isolation: a `screen` test exercises *only* the left/steps pane, never the full two-pane host. Fits the "no shortcuts" bar. |
| D5 | **`tmux-argv` home** | **`tests-new/tmux-argv/`** (top-level category, **unit-speed**, boots no tmux). | Spec-preferred; keeps it visible as a category while running in the fast level. |
| D6 | **Real-tmux concurrency** | The tmux-booting levels run with a **real-tmux concurrency ceiling**: `lifecycle` runs **serially**; `screen` + `full-host` run with a small bounded concurrency. Encoded in the script ladder (§8) and revisited in Phase 2 once drivers exist. | Documented flake history (leaked-puppet pileup; peak-parallelism timing ceiling). Concurrency is a design input, not a later optimisation (spec §8.4). |
| D7 | **Bare `bun test`** | **Guidance + lightweight guard.** CLAUDE.md names the default (`bun run test:two-pane:fast`) and bans bare `bun test`; Phase 3 ships a Bun preload that prints a warning when `bun test` is invoked with no path. | Spec §8.4. Cheap, honest, non-blocking. |
| D8 | **Selection by path, never env var** | Selection is expressed **only** by the directory a test lives in, via the script that targets it. `skipIf(!canRunRealTmux())`-style predicates remain but only *prevent false failure* on an incapable box; they never *cause* a run. | Spec §8.1. "The filesystem is the manifest." |
| D9 | **Cassette boundary** | `recorded-agent` cassettes capture the **Runner's normalised `RunnerEvent` stream**, never raw CLI stdout. A `record.ts` re-record entrypoint is required and lives beside the recorded-agent tests. | Spec §5.4. Avoids re-testing the runner parser and decouples from CLI output drift. |
| D10 | **Pane Object chrome literals** | Expected chrome (footer hints, glyphs, labels) lives as a **co-located constant on the Pane Object**, asserted via a semantic method. **Never inline in a scenario; never imported from `src/`.** Test-authored *content* uses the `assertShowsContent(text)` escape hatch. | Spec §6.2. An imported production symbol on both sides of an assertion is tautological — a co-located literal is an independent specification that goes red on a production typo. |
| D11 | **`tests-new/` is typechecked by the gate** | U1 adds `tests-new` to `tsconfig.json` `include`. The whole typed-DSL contract (§5.2/§5.3) is *only* real if `tsc --noEmit` sees the tree — `bun test` transpiles per-file and never typechecks. Negative "must-not-compile" tests use `.test-d.ts` + `@ts-expect-error` + the existing `tests/helpers/type-assertions.ts` (`Expect`/`Equal`), the repo's established mechanism (6 such files already exist). | Without this, every type guarantee ships green and the primary safety mechanism is inert. The plan cannot rely on `bun test` to catch type errors. |
| D12 | **Frozen baseline manifest precedes migration** | U1 generates a checked-in `tests-new/_migration/baseline.json` (+ a human-readable `.md`) snapshot of **every** `tests/**` path, each classified `test \| type-test \| helper \| fixture \| setup \| asset`, and for `test` files every `it()`/`test()`/`it.each` case with a stable identity (file, name, line, hash). All migration accounting and the U14 reconciliation run against this **frozen** manifest, never a live scan of a tree the migration is mutating. | Reviewer + Codex consensus: prose phase groupings miss `hosts/**` non-two-pane, `fixtures/`, `setup/`, `unit/helpers/`, `.test-d.ts`, and top-level e2e. A frozen manifest makes "is everything accounted for?" a query, and makes U14 falsifiable. |
| D13 | **Shared test infrastructure has a neutral home** | Helpers/fixtures/setup are **moved** to `tests-new/_support/` and the `@orch/test/*` tsconfig alias is repointed there — `tests-new/` never imports from `tests/`. A helper that still has **live** old consumers moves with a thin re-export shim left at the old path until those consumers are skipped, so the move is non-breaking. | Resolves the contradiction Codex flagged: drivers reuse `tests/helpers/**` while U10–U13 ban `tests-new → tests` imports. The current alias is `@orch/test/* → ./tests/helpers/*` (`tsconfig.json:28`). |
| D14 | **Concurrency is encoded, not described** | The §D6 ceiling is real flags, not a comment: `lifecycle` runs `--max-concurrency=1` (serial); `screen` + `full-host` run a small explicit bound. Encoded in the script ladder (§8). | Codex consensus: D6 promised a ceiling the script ladder did not impose. The repo pins no bun concurrency anywhere today, so the default applies unless set. |
| D15 | **Ledger is test-case-granular** | A file is wrapped `.skip` **only once every child `it()`/`test()`/`it.each` row** is mapped to `port \| merge \| demote \| drop`. `oldTestRefs` (and a disposition) is **required** per case, not optional. The repo's dominant skip idiom is `skipIf` (99 uses) not literal `.skip` (5) — the migration uses unconditional `.skip`/`describe.skip` for migrated code and the reconciliation scanner must distinguish the two. | Codex consensus: a single old file holds many cases; file-level skipping after porting one scenario yields green-but-incomplete coverage. |

---

## 4. Output structure

The target `tests-new/` tree (the per-unit `**Files:**` sections remain
authoritative for what each phase creates; this is the scope shape):

```
tests-new/
  dsl/                              # the shared DSL — built in Phases 1–3, never feature-specific
    index.ts                       #   single barrel: scenario, driver registry types, pane objects
    scenario.ts                    #   scenario(meta, body) → one it() per listed driver
    app-surfaces.ts                #   ModelApp / ScreenApp / FullHostApp / LifecycleApp interfaces
    drivers/
      registry.ts                  #   DRIVERS record + DriverName union; add a driver w/o a central switch
      model-driver.ts              #   no tmux; projection-seam app
      screen-driver.ts             #   S2 single-pane real-tmux fixture
      full-host-fake-agent-driver.ts
      full-host-recorded-agent-driver.ts
      full-host-real-agent-driver.ts
      lifecycle-driver.ts          #   wraps today's behavioral-dsl subprocess handle
    panes/
      left-pane.ts                 #   LeftPane Pane Object + co-located chrome literals
      right-pane.ts                #   RightPane Pane Object
      system-assertions.ts         #   SystemAssertions (exit/teardown/persisted status)
  _support/                        # shared test infra (D13): @orch/test/* repoints here, never tests/
    real-tmux/  behavioral-dsl/    #   moved from tests/helpers/** (shim left behind for live old consumers)
    fixtures/  setup/              #   moved from tests/fixtures + tests/setup (the bunfig preload lives here)
    ink-frame.ts  manual-timer.ts  temp-git-repo.ts  type-assertions.ts  ...
  unit/                            # plain class tests, fakes at *Service seams; mirrors src/ layout
    core/  runners/  services/  state/  validators/  workflows/  cli/  observability/  codegen/  config/
    hosts/                         #   NON-two-pane host tests (plain-host, tmux-host, host-registry, …) — see U12/U13
  integration/                     # mocked-edge integration (non-two-pane), mirrors src/ layout
    hosts/                         #   NON-two-pane host integration (plain-mode, *-command-line, …)
  e2e/                             # real-CLI entrypoint/workflow tests (non-two-pane), env-gated
                                   #   incl. relocated tests/e2e/{resume-real-claude,steps-tui-e2e,workflows,cli}
  model/                           # TWO-PANE: controller decisions / projection, NO tmux — the bulk
    projector/  view/  controller/
    follow-live--returns-to-running-step.test.ts
  tmux-argv/                       # TWO-PANE-adjacent: tmux adapter argv contract, unit-speed
  screen/                          # TWO-PANE: real tmux, single steps pane, rendering bytes
    follow-live--footer-renders-with-quit-hint.test.ts
  full-host/                       # TWO-PANE: full two-pane host
    fake-agent/                    #   FakeRunner static by default; scriptedFake live-driven for interleaving
    recorded-agent/                #   standalone — carries its own asset + workflow
      cassettes/                   #     recorded normalised-event streams beside the tests
      record.ts                    #     the re-record entrypoint
    real-agent/                    #   ClaudeRunner/CodexRunner, gated, ~2–3 smoke
  lifecycle/                       # TWO-PANE: outside-in CLI behaviour (signals, attached TTY, tmux kill-*)
  _migration/                      # the auditable record of the strangler migration
    baseline.json                  #   FROZEN U1 snapshot: every tests/** path classified + per-case identity (D12)
    baseline.md                    #   human-readable view of the same snapshot
    ledger.md                      #   per-CASE old→new accounting (port/merge/demote/drop + reason) — D15
    overlap-report.ts              #   AST-parses scenario meta; flags missing overlap groups & ledger gaps; runnable
    reconcile.ts                   #   U14 check: ledger vs FROZEN baseline (not a live scan), all-skip proof
```

The old `tests/` tree stays on disk, progressively all-`.skip`. Shared test
infrastructure under `tests/helpers/**`, `tests/fixtures/**`, and `tests/setup/**`
(the `real-tmux` harness, `behavioral-dsl`, `ink-frame`, `manual-timer`,
`temp-git-repo`, `type-assertions`, the `cleanup-stale-tmux` preload, fakes) is
**moved into `tests-new/_support/`** (D13), and the `@orch/test/*` alias is
repointed there — the new drivers *wrap* these seams rather than reimplementing
them, but they do not import across the tree boundary. Because some of these
helpers still have **live** consumers in the old `tests/` tree until those files
are skipped, each move leaves a **thin re-export shim** at the old path (e.g.
`tests/helpers/behavioral-dsl/index.ts` re-exports from `tests-new/_support/...`)
so the still-green old suite never breaks. The shim is deleted when the last old
consumer is skipped. **This is a real, ordered piece of work — not a deferred
placement detail** (see U2 execution note and R11).

---

## 5. High-level technical design

> *Directional guidance for review — not implementation specification. The
> implementing phase treats these interfaces as the contract to honour, refining
> names/shapes in its own plan where reality demands.*

### 5.1 The four layers

```
  Scenario        a plain async (app) => { ... } ; Given/When/Then are await statements
     │            lists which drivers it runs on; carries metadata (id/feature/risk/overlapGroup)
     ▼
  Pane Object     LeftPane / RightPane / SystemAssertions — SEMANTIC methods backed by
     │            co-located chrome constants; driver-INDEPENDENT (same object over every fidelity)
     ▼
  Driver          one per fidelity; builds a typed app surface; OWNS gating, timeouts,
     │            teardown, socket reaping, predictability rules. Scenarios never see these.
     ▼
  System          src/hosts/two-pane/** under test, at the chosen fidelity
```

The scenario calls only **semantic** Pane Object methods (plus the
`assertShowsContent` content escape hatch). The Pane Object asks its **driver**
for a raw capability (`assertBottomText(literal, {count})`, `capture()`,
view-model access). The **driver** decides what "assert bottom text" *means* at
its fidelity: on `model` it inspects the controller's projected view-model; on
`screen`/`full-host` it captures **actual bytes off real tmux**.

### 5.2 Typed app surfaces (caught by types, not just runtime)

Not every action/assertion is meaningful on every driver, so the surfaces differ
by driver family. Unsupported actions are a **type error**, with runtime guards
as defense-in-depth only.

```ts
// tests-new/dsl/app-surfaces.ts  (directional)
type DriverName =
  | 'model'
  | 'screen'
  | 'full-host:fake-agent'
  | 'full-host:recorded-agent'
  | 'full-host:real-agent'
  | 'lifecycle'

interface ModelApp {
  launch(spec: ModelSpec): Promise<void>
  leftPane: LeftPane           // projection-seam assertions only
  teardown(): Promise<void>
}
interface ScreenApp {
  launch(spec: ScreenSpec): Promise<void>
  leftPane: LeftPane           // real-tmux single-pane byte assertions
  resize(width: number, height: number): Promise<void>
  teardown(): Promise<void>
}
interface FullHostApp {
  launch(spec: FullHostSpec): Promise<void>
  complete(step: string): Promise<void>
  leftPane: LeftPane
  rightPane: RightPane         // transcript / two-pane communication
  teardown(): Promise<void>
}
interface LifecycleApp {
  launch(spec: LifecycleSpec): Promise<void>
  press(pane: 'left' | 'right', key: string): Promise<void>
  signal(sig: Signal): Promise<void>
  leftPane: LeftPane
  rightPane: RightPane
  system: SystemAssertions     // exit / teardown / persisted status
  teardown(): Promise<void>
}
```

`tmux-argv` is **not** an `app` scenario — it is a plain unit test of
`RealTmuxService` argv against `FakeProcessService`. It lives in the taxonomy as
a category (and runs at unit speed) but does not use `scenario()`.

### 5.3 The scenario runner

`scenario(meta, body)` is a thin wrapper over `test.each(drivers)`: it expands to
**one real test per driver**, each gated/timed/torn-down by that driver. The
scenario file never mentions `canRunRealTmux`, `REAL_TMUX_TEST_TIMEOUT_MS`, or
`afterEach`. Metadata powers the overlap report.

```ts
// tests-new/dsl/scenario.ts  (directional)
interface ScenarioMeta<D extends readonly DriverName[]> {
  name: string
  drivers: D                         // the literal tuple is captured (see `const` below)
  feature: string                    // stable prefix, e.g. 'follow-live'
  risk?: string                      // e.g. 'projection-to-screen-binding'
  overlapGroup?: string              // ties a model test to its screen contract test
  oldTestRefs: readonly string[]     // migration accounting — REQUIRED (D15), not optional
  regressionRef?: string             // e.g. '2026-05-26 real-tmux-suite-flakiness-leaked-puppets'
}

// AppFor MUST be a non-distributive conditional lookup — one member at a time.
type AppFor<D extends DriverName> =
  D extends 'model' ? ModelApp :
  D extends 'screen' ? ScreenApp :
  D extends `full-host:${string}` ? FullHostApp :
  D extends 'lifecycle' ? LifecycleApp : never

// SharedApp = the capabilities common to EVERY listed driver. `keyof` over the
// union of app surfaces yields only the COMMON keys; this non-distributive
// mapped type is the whole trick. (Do NOT use UnionToIntersection — that yields
// ModelApp & ScreenApp, whose member set is the *union*, so `resize` wrongly
// compiles on a `['model','screen']` scenario. Proven by compilation.)
type SharedApp<D extends readonly DriverName[]> = {
  [K in keyof AppFor<D[number]>]: AppFor<D[number]>[K]
}

function scenario<const D extends readonly DriverName[]>(
  meta: ScenarioMeta<D>,
  body: (app: SharedApp<D>) => Promise<void>,
) {
  for (const d of meta.drivers) {
    const driver = DRIVERS[d]
    it.skipIf(driver.skip())(`${meta.name} [${d}]`, async () => {
      const app = await driver.build(meta)
      try { await body(app as SharedApp<D>) } finally { await app.teardown() }
    }, driver.timeout)
  }
}
```

The `<const D extends readonly DriverName[]>` type parameter captures the literal
tuple at the call site (a bare `drivers: readonly DriverName[]` destroys that
inference — then `typeof meta.drivers[number]` collapses to the full `DriverName`
union and the body type ignores the driver list entirely, which is the bug in
earlier drafts: a `['lifecycle']` scenario could not call `press()`/`signal()`).
With the capture, a scenario listing `['model']` cannot call `app.rightPane`
(compile error), one listing `['screen']` *can* call `app.resize` (§9.4), one
listing `['lifecycle']` *can* call `app.press`/`app.signal` (§9.8), and one
listing `['model','screen']` is typed to **only the shared `leftPane` surface** —
which is exactly what makes a `model`↔`screen` contract scenario safe to write
once. U1 ships `@ts-expect-error` negative tests (D11) proving each rejection.

> **Import-time purity (CLAUDE.md rule 8).** As written, `scenario()` calls
> `it()` at module-eval time, so a file *registers tests on import*. That means
> the overlap report (§5.5) must **not** import scenario files to read metadata —
> it would register/execute Bun tests. The report **AST-parses** the literal
> `scenario({...})` first argument instead (all fields — `drivers`,
> `overlapGroup`, `oldTestRefs` — are static object literals at every call site).
> U1 also keeps the registration confined to a single helper so the parse target
> is stable.

### 5.4 The driver registry (no central switch)

```ts
// tests-new/dsl/drivers/registry.ts  (directional)
interface Driver<App> {
  build(meta: ScenarioMeta): Promise<App>   // owns fixture lifecycle
  skip(): boolean                           // capability predicate (D8)
  timeout: number                           // driver-appropriate budget
}
const DRIVERS = {
  model: modelDriver,
  screen: screenDriver,
  'full-host:fake-agent': fullHostFakeAgentDriver,
  'full-host:recorded-agent': fullHostRecordedAgentDriver,
  'full-host:real-agent': fullHostRealAgentDriver,
  lifecycle: lifecycleDriver,
} satisfies Record<DriverName, Driver<unknown>>
```

A new driver is a new file + one line here. **All hard-won real-tmux
predictability rules live inside the driver `build`/`teardown`** (unique socket
per run, `REAL_TMUX_TEST_TIMEOUT_MS`, hook-signal + liveness backstop, server
reaping, puppet parent-liveness self-reap, poll-and-resend for idempotent keys).
They are *requirements on driver implementations*, not on scenario authors — and
because they were hardened through real flakes, **the drivers that own them ship
with driver-level regression tests** (teardown/no-orphans, timeout/polling)
*before* any behaviour coverage migrates onto them (Phase 2 DoD).

### 5.5 Pane Objects & the chrome/content rule (D10)

```ts
// tests-new/dsl/panes/left-pane.ts  (directional)
class LeftPane {
  // expected chrome — co-located, an INDEPENDENT spec of what the user should see.
  // NOT imported from src/ (an imported symbol on both sides launders typos).
  private static readonly TEXT = { quitHint: 'q quit', followHint: 'f follow' } as const

  constructor(private readonly driver: PaneDriver) {}

  // semantic chrome assertions — no literal reaches the scenario
  assertQuitHintVisible() { return this.driver.assertBottomText(LeftPane.TEXT.quitHint, { count: 1 }) }
  assertStepSelected(step: string) { /* ... */ }
  assertGlyph(step: string, glyph: 'running' | 'done' | 'failed') { /* ... */ }

  // escape hatch — ONLY for literals the test itself authored
  assertShowsContent(text: string) { return this.driver.assertContains(text) }
}
```

On `screen`/`full-host` drivers `assertBottomText` captures *actual bytes off
real tmux* and matches the co-located literal — the full Ink→tmux→capture path is
exercised and a production wording typo goes **red**. On `model` it asserts the
controller *selected* that hint for the current state. A lint/review rule keeps
chrome literals out of scenario files; a one-off layout test may inline a chrome
literal only with `// CHROME-LITERAL-EXCEPTION: <reason>`.

### 5.6 The recorded-agent cassette (D9)

```ts
interface RecordedAgentCassette {
  schemaVersion: 1
  runner: 'claude' | 'codex'
  runnerVersion?: string
  recordedAt: string
  sourceCommand: readonly string[]
  workflowName: string
  scenarioId: string
  prompt: string
  eventSchema: 'RunnerEvent'
  // The cassette splits the stream the way FakeRunner.script() consumes it:
  events: readonly InfoEvent[]       // streamed InfoEvents (kind: 'info'), captured via the onEvent tap
  terminal: TerminalEvent            // the single terminal outcome (kind: 'terminal'), captured separately
}
// from src/runners/types.ts:
//   InfoEvent     = { kind: 'info'; type: string; payload?: Record<string, unknown> }
//   TerminalEvent = { kind: 'terminal'; type: 'turn-complete'; data? }
//                 | { kind: 'terminal'; type: 'error'; message: string; data? }
```

> **Interface reality check (verified against `src/runners/`).** The normalised
> `onEvent` tap is real (`runRunner(..., { onEvent })` in `src/runners/execute.ts`).
> But `FakeRunner.script()` takes `events: readonly InfoEvent[]` (**not** the full
> `RunnerEvent[]`) and **synthesizes its own terminal** event from separate
> `structuredOutput`/`failWith` fields. So a cassette cannot be a flat
> `readonly RunnerEvent[]` with an embedded terminal — that would type-error on
> the terminal element and double up the terminal on replay. Hence the split
> above: `record.ts` captures `InfoEvent`s into `events` and the final terminal
> into `terminal`, and the replay shim maps `terminal` → `FakeRunner.script`'s
> `structuredOutput`/`failWith`. (If a future phase prefers a flat
> `RunnerEvent[]`, that requires an explicit `FakeRunner.script` overload — a real
> runner change, ledgered as such, not a freebie.)

`record.ts` runs a `real-agent` scenario once with the existing `onEvent` tap,
dumps the normalised events + terminal to `cassettes/<scenario>.json`, validates
the schema, formats deterministically, and supports a **verification mode** that
replays the cassette through `FakeRunner.script(...)` via the shim. Replay =
`fake-agent` engine, different event source (cassette vs authored inline).

---

## 6. The decision rule (which category a behaviour belongs to)

This replaces "when to write at which tier." It is the single most important
thing a migrating phase internalises.

> **Is the risk in *what the controller decides to show*, or in *whether those
> bytes reach the real screen*, or in *process behaviour*?**

| The risk is… | Category | Example |
|---|---|---|
| what the controller *decides* | `model` (no tmux, fast, the bulk) | footer contains quit; failed step shows ✗; selection moves on ↑↓ |
| left/steps-pane **bytes** survive real tmux | `screen` (real tmux, single pane) | footer placement, glyph rendering, wrapping, narrow/wide widths, escape handling |
| two-pane **plumbing / communication** | `full-host` (full host, real tmux) | right pane not empty after `step:start`; transcript paints; source swap works |
| **process** behaviour (signals, teardown) | `lifecycle` (outside-in, full boot) | SIGINT/SIGTERM/SIGHUP; attached-TTY `q`; external `tmux kill-*`; persisted status |
| adapter **argv/escaping** | `tmux-argv` (unit-speed, no tmux) | tmux flags, escape rules, env passthrough |
| isolated class logic, fakes at `*Service` | `unit` | everything non-two-pane; pure projector/model logic |

Full-host **mode** is then chosen by: independent of agent content → `fake-agent`;
needs *realistic* event streams → `recorded-agent`; needs the *actual binary* →
`real-agent` (2–3 smokes, gated).

The **triage rule** stays the north star and is also the migration pruning
filter: *"Would this test still pass if the visible pane were empty / wrong /
unformatted? If yes, demote or delete."*

**Manual screen QA stays *outside* the automated taxonomy (spec §12, unchanged).**
The `orch-qa-engineer` / `scriptedFake` screenshot workflow is **not** a driver and
**not** on `check`; it remains useful exploratory evidence before writing or
debugging an automated `screen`/`full-host` scenario. The migration neither
absorbs nor removes it — U3 only de-tiers its skill doc (R12), it is not ledgered.

---

## 7. Implementation units (the phases)

Phases land in order. Each is picked up autonomously: **plan the unit in detail
→ implement behind the gate → return.** Every phase must leave `bun run check`
green (its own new tests + the still-running old suite). A phase is **not done**
until its Definition of Done holds and its Verification command passes.

> **Autonomous execution protocol (applies to every unit below).**
> 1. Load the `phase-implementer` skill and read this parent plan + the spec.
> 2. Write a detailed phase plan under `docs/plans/` (`...-NNN-<type>-<phase>-plan.md`)
>    that honours every interface and decision in §3–§6 — do not redesign them.
> 3. Write tests first where the unit is feature-bearing (the DSL itself, the
>    drivers, `record.ts`, the overlap report). For *migration* units, the "test"
>    is the re-derived scenario; "implementation" is the driver wiring it needs.
> 4. Land behind the appropriate script (§8). Update the migration ledger
>    (`tests-new/_migration/ledger.md`) for any old test touched.
> 5. Never delete an old test; only wrap it in `.skip` with a `// MIGRATED → <path>`
>    marker once its replacement is green (D2).

### Phase group A — Build the structure (U1–U3)

#### U1. DSL foundation + the two no-tmux drivers (`model`, `tmux-argv`)

**Goal.** Stand up `tests-new/` and the shared DSL spine: the `scenario()`
runner, the typed app surfaces, the Pane Objects with co-located chrome literals,
the driver registry, and the two drivers that boot **no tmux** — `model`
(projection seam) and the `tmux-argv` category. Prove the design on real
behaviour with two tracer bullets. **Also lay the migration's foundations: put
`tests-new/` under the typecheck gate (D11), capture the frozen baseline manifest
(D12), and stand up the `_support/` infra home (D13).** These foundations are not
optional polish — without D11 the typed-DSL guarantee is inert, and without D12
nothing downstream can prove completeness.

**Requirements.** Spec §2, §3.1–3.2, §3.6, §5.1, §5.2, §6, §6.1, §6.2; D1, D3,
D5, D8, D10, **D11, D12, D13**.

**Dependencies.** None.

**Files (create / modify).**
- `tests-new/dsl/scenario.ts`, `tests-new/dsl/app-surfaces.ts`, `tests-new/dsl/index.ts`
- `tests-new/dsl/panes/left-pane.ts`, `right-pane.ts`, `system-assertions.ts`
- `tests-new/dsl/drivers/registry.ts`, `model-driver.ts`
- `tests-new/dsl/drivers/__tests__/model-driver.test.ts` (driver-level unit tests)
- `tests-new/dsl/__tests__/scenario.test.ts`, `panes/__tests__/left-pane.test.ts`
- `tests-new/dsl/__tests__/scenario.test-d.ts` — **negative type tests** (`@ts-expect-error`)
  proving each unsupported-action rejection; reuses `tests/helpers/type-assertions.ts`
  (`Expect`/`Equal`) — moved to `_support/` here (D11, D13).
- `tests-new/model/follow-live--returns-to-running-step.test.ts` (tracer)
- `tests-new/tmux-argv/<one-argv-case>.test.ts` (tracer; wraps `RealTmuxService` + `FakeProcessService`)
- **`tsconfig.json`** — add `"tests-new"` to `include` so `tsc --noEmit` typechecks the new tree;
  add a `@orch/test/*` → `tests-new/_support/*` mapping (D11, D13). *(This is the single
  most load-bearing edit in U1 — the entire type-safety promise depends on it.)*
- **`tests-new/_migration/baseline.json` + `baseline.md`** — generated by a small
  committed script (`tests-new/_migration/snapshot.ts`) that walks `tests/**`, classifies
  each path (`test|type-test|helper|fixture|setup|asset`), and records per-`it()`/`test()`/
  `it.each` case identity (file, name, line, hash). **Frozen after U1** (D12).
- **`tests-new/_support/`** — begin the infra move (D13): at minimum the helpers U1 needs
  (`type-assertions.ts`, `ink-frame.ts`), each with a re-export shim left at the old path.
- `package.json` — add `test:two-pane:model`, `test:two-pane:tmux-argv`, `test:two-pane:fast` (model + tmux-argv) — see §8

**Approach.**
- `model` driver wraps the existing projector/view/controller seams
  (`src/hosts/two-pane/steps-view/{project-steps-view,steps-view-model}.ts`,
  `pane-map/right-pane-controller.ts`) and exposes a `LeftPane` whose
  `assertBottomText`/`assertContains` inspect the **projected view-model**
  (today's Tier-2 `renderToString`/`stripAnsi` approach), never a fake tmux (§5.1).
- The `model` category may split internally into `model/projector`, `model/view`,
  `model/controller` (spec §3.2 implementation note) — do **not** force all 199
  legacy Tier-2 cases through one `launch(spec) → PaneObject` shape on day one.
  U1 only needs the shared driver seam + enough surface for the tracer.
- `tmux-argv` tracer is a plain unit test (no `scenario()`), proving the category
  runs in the fast level.
- Pane Object chrome literals are co-located constants (D10); add the
  lint/review guardrail note to the DSL README.

**Patterns to follow.** `tests/helpers/ink-frame.ts` polling discipline;
`tests/unit/hosts/two-pane/steps-view/*.test.tsx` projection assertions;
`tests/unit/services/tmux/*` for argv shape.

**Test scenarios.**
- `scenario()` expands to exactly one `it()` per listed driver, each labelled
  `name [driver]`. *(happy)*
- `scenario()` with an unsupported action for a driver fails to **type-check** —
  a `model`-only scenario calling `rightPane`/`press`, a `['model','screen']`
  scenario calling `resize`, all rejected; a `screen`-only `resize` and a
  `lifecycle`-only `press`/`signal` accepted. Lives in `scenario.test-d.ts` via
  `@ts-expect-error`, **caught by `bun run typecheck` only because `tests-new` is
  now in `tsconfig` include** (D11). *(edge / critical)*
- The baseline manifest (`baseline.json`) lists every current `tests/**` file and
  per-case identity; a unit test asserts the snapshot script is deterministic and
  the counts match a known-good fixture. *(critical)* — `Covers D12.`
- `LeftPane.assertQuitHintVisible` reads its literal from the co-located constant,
  not from `src/`. *(happy)* — assert the test fails red if the constant is changed
  to a wrong value (a small meta-test).
- `model` driver `assertBottomText` asserts the **selected** hint for a state and
  does **not** boot tmux (assert no socket allocated). *(integration / critical)*
- `model` driver `teardown()` is idempotent and leaves no fixture residue. *(edge)*
- tracer `follow-live--returns-to-running-step [model]` passes against real
  controller logic. *(happy)* `Covers F9.`
- tmux-argv tracer: one action → expected argv via `FakeProcessService`. *(happy)*

**Verification.** `bun run test:two-pane:fast` is green and boots no tmux
(millisecond-level). The two tracers pass. **`bun run typecheck` now compiles
`tests-new/` and the `scenario.test-d.ts` negative assertions pass** (introduce a
deliberate violation locally and confirm `typecheck` goes red — the guarantee is
only real if the gate enforces it). The frozen `baseline.json` exists and round-
trips. Old suite untouched and still green under `bun run check` (the `_support/`
shims keep old imports resolving).

---

#### U2. The real-tmux drivers (`screen` [S2], `full-host:fake-agent`, `lifecycle`)

**Goal.** Build the three drivers that boot real tmux, moving **all**
predictability rules into them, and ship **driver-level regression tests** for
teardown/no-orphans and timeout/polling *before* behaviour migrates onto them.
Prove each with one tracer bullet.

**Requirements.** Spec §3.3 (+ S2 = D4), §3.4, §3.5, §4 (fake-agent mode), §5.7,
§6.1, §12 (predictability rules move into drivers); D4, D6, D8, **D13, D14**.

> **Sizing note.** These three drivers are *not* equal effort. `full-host:fake-agent`
> wraps the existing `mountTmuxHost` (✅ exists, spec §4) and `lifecycle` wraps the
> existing `behavioral-dsl` engine — both are *wrapping* work. **`screen` (S2) is
> net-new/extracted infrastructure** (spec §3.3, §4.1) and is the highest-risk,
> highest-effort item of the three; the phase plan should budget for it accordingly
> and may split it into its own sub-phase. Do not treat all three as already-solved
> wrappers.

**Dependencies.** U1.

**Files (create).**
- `tests-new/dsl/drivers/screen-driver.ts` (S2 single-pane steps-view fixture; owns width/height/resize)
- `tests-new/dsl/drivers/full-host-fake-agent-driver.ts` (wraps `mountTmuxHost` + `FakeRunner`; live-driven `scriptedFake` submode behind an explicit option)
- `tests-new/dsl/drivers/lifecycle-driver.ts` (wraps the `behavioral-dsl` subprocess handle behind the `LifecycleApp` surface)
- `tests-new/dsl/drivers/__tests__/{screen,full-host-fake-agent,lifecycle}-driver.test.ts` — **no-orphans / teardown / timeout / poll-and-resend** regression tests
- Tracers: `tests-new/screen/follow-live--footer-renders-with-quit-hint.test.ts`,
  `tests-new/full-host/fake-agent/follow-live--right-pane-swaps-source.test.ts`,
  `tests-new/lifecycle/follow-live--ctrl-c-persists-cancelled-status.test.ts`
- `package.json` — add `test:two-pane:screen`, `test:two-pane:full:fake`, `test:two-pane:lifecycle`, `test:two-pane:tmux` (§8), with the §D6 concurrency ceiling

**Approach.**
- **S2 (D4):** extract a dedicated single-pane steps-view runner fixture (not the
  full two-pane host) so a `screen` test exercises *only* the left pane. The
  driver **owns width/height + `resize()`**; wrapping, narrow/wide widths, and
  SIGWINCH/header-duplication are part of the `screen` risk class, not one-offs.
- **fake-agent:** static `FakeRunner.script({ events })` is the **default**; the
  live-driven `scriptedFake` subprocess flavour (`agent.type()`/`agent.finish()`)
  is a heavier submode selected **explicitly** in driver options, only when a
  scenario must *interleave* agent output with user actions (spec §4 decision).
- **lifecycle:** wrap the existing `behavioral-dsl` engine behind the typed
  `LifecycleApp` surface (do not flatten it into the `model` substrate — it is
  intrinsically subprocess + real-tmux + control-file bound). **The `behavioral-dsl`
  engine moves to `tests-new/_support/behavioral-dsl/` (D13), leaving a re-export
  shim at `tests/helpers/behavioral-dsl/` so the still-live old lifecycle suite
  (skipped only in U8) keeps resolving.** This move is an explicit, ordered step
  with a back-compat shim — *not* a "placement detail" (R11). The public DSL barrel
  stays the only scenario import surface.
- Predictability rules (spec §12, `docs/testing-strategy.md` "Predictability
  rules") move *into* `build`/`teardown`: unique socket per run, **both timeout
  constants `REAL_TMUX_TEST_TIMEOUT_MS` and `REAL_TMUX_ASSERT_TIMEOUT_MS`** (spec
  §12 names both — neither may be dropped), hook-signal + liveness backstop, server
  reaping, puppet parent-liveness self-reap, poll-and-resend for idempotent keys.

**Execution note.** Start each driver with its failing no-orphans/teardown
regression test (characterization of the fragile real-tmux lifecycle) before the
tracer behaviour — this boundary is where every historical flake lived.

**Patterns to follow.** `tests/helpers/real-tmux/{fixture,workflow-driver,socket}.ts`;
`tests/helpers/behavioral-dsl/**`; the predictability rules and the leaked-puppet
fix referenced in auto-memory ([[real-tmux-suite-flakiness-root-cause]]).

**Test scenarios.**
- Each driver: `build()` allocates a **unique** socket; `teardown()` reaps the
  tmux server *and* removes the socket file; after teardown, **zero** orphan
  children and zero leaked scripted-fake entries. *(critical / integration)* —
  `REGRESSION: 2026-05-26 real-tmux-suite-flakiness-leaked-puppets`
- Each real-tmux driver applies `REAL_TMUX_TEST_TIMEOUT_MS` (not Bun's 5s
  default) for the test budget **and `REAL_TMUX_ASSERT_TIMEOUT_MS` for poll/assert
  waits** (both, per spec §12); a missed `pane-died` hook resolves via the liveness
  backstop in ~1s, logged. *(error path)*
- `screen` driver `resize(w,h)` re-renders; a narrow width wraps the footer
  without duplicating the header. *(edge)* — left-pane bytes only.
- **Adversarial byte catalogue (spec §5.7), table-driven** (start with a fixture
  table; defer any property-testing dependency): subprocess-controlled content with
  ANSI sequences, carriage returns, **NUL**, wide glyphs, long lines, and
  chunk-boundary fragments survives real tmux without corrupting the pane — on a
  real-tmux driver, since a fake tmux cannot prove byte hygiene (§5.1). *(adversarial / critical)*
- `screen` driver refuses (type + runtime) `rightPane` access. *(edge)*
- `full-host:fake-agent` static mode: scripted text reaches the **right** pane
  after `complete(step)`, with no caret echo on real tmux. *(integration)*
- `full-host:fake-agent` live-driven submode is reachable only via explicit
  option, not inferred from the scenario body. *(edge)*
- `lifecycle` driver: idempotent key (`f`) is poll-and-resent until observed,
  defeating the dropped-first-keypress race. *(critical)* —
  `REGRESSION: 2026-05-29 nav.f-snaps`
- Three tracers pass. *(happy)*

**Verification.** `bun run test:two-pane:tmux` (screen + full:fake) and
`bun run test:two-pane:lifecycle` green under the §D6 concurrency ceiling.
Driver regression tests pass. Old suite still green.

---

#### U3. `recorded-agent` + `real-agent` + convention flip (script ladder, docs, overlap report)

**Goal.** Complete the driver set (cassette-backed `recorded-agent`; gated
`real-agent`), define the cassette format + `record.ts`, ship the full script
ladder and the bare-`bun test` guard, build the overlap report + ledger
template, and **flip the convention** so that from here on every new two-pane
behavioural test is written in the new shape.

**Requirements.** Spec §4 (recorded/real modes), §4.1, §5.3, §5.4, §5.5, §5.6,
§7, §8, §10.4 (PR2–PR3); D6, D7, D9.

**Dependencies.** U2.

**Files (create/modify).**
- `tests-new/dsl/drivers/full-host-recorded-agent-driver.ts`, `full-host-real-agent-driver.ts`
- `tests-new/full-host/recorded-agent/record.ts`, `cassettes/.gitkeep`, one tracer `*.test.ts`
- `tests-new/full-host/real-agent/<one-smoke>.test.ts` (tracer; the swap-agent-slot proof)
- `tests-new/dsl/drivers/__tests__/recorded-agent-driver.test.ts` (cassette schema validation + replay verification)
- `tests-new/_migration/overlap-report.ts`, `tests-new/_migration/ledger.md` (template + first rows)
- `package.json` — the full ladder (§8): atomic buckets, cumulative levels,
  `test:legacy` (incl. old `tests/e2e`), `test:new-e2e`, `test:project`, `check`,
  `check:release`, with the §D6/D14 **concurrency flags** (`--max-concurrency`)
  on every tmux bucket
- `tests-new/dsl/preload-warn-bare-bun-test.ts` (D7 guard) + wire as a Bun preload
- **Docs (rewrite BEFORE any migration phase consumes them — see sequencing note):**
  rewrite `docs/testing-strategy.md` as the canonical new reference (supersede the
  five tiers); update `CLAUDE.md` "How to write tests" + "How to write a two-pane
  test" + run guidance + bare-`bun test` ban; update `README` script references;
  reconcile **every** skill doc that hard-codes the five tiers or old `tests/`
  paths — confirmed: `testing-strategy`, `orch-qa-engineer`, `runner-author`,
  `phase-implementer`, **`orch-acceptance-tests`** (currently in-flight/uncommitted,
  enumerates Tier 1–5), and **`orch-workflow-author`** (in-flight/modified). Missing
  any of these leaves a skill teaching the old model to the very agents that run
  U4–U13 (R12).

**Approach.**
- `recorded-agent` replay is `FakeRunner.script({ events })` fed from a cassette;
  `real-agent` is the same full-host body with `ClaudeRunner`/`CodexRunner` in
  the agent slot (the swap *is* the promotion — no copy-paste).
- `record.ts` records at the **Runner boundary** via the existing `onEvent` tap
  (spec §5.4), validates `RecordedAgentCassette`, formats deterministically,
  verifies by replay. Raw parser fixtures stay at the runner layer (§5.6, D9).
- **Overlap report (§5.5):** **AST-parses** the literal `scenario({...})` first
  argument across `tests-new/**` (it must NOT import scenario files — importing
  registers/executes Bun tests, see §5.3 import-time note). Flags missing
  `overlapGroup` pairs (a `model` test with no `screen` contract twin) and ledger
  gaps against the **frozen baseline** (D12). It becomes **blocking at U4** (the
  first migration phase) — "underway" = the first ledger row exists; U3 wires it
  non-blocking, U4's plan flips it to blocking and U4 is the first phase whose
  Verification can fail on a red report. No phase after U4 may run it non-blocking.
- **Script ladder & gating:** path-based selection only (D8); the §D6/D14
  concurrency *flags* on tmux levels; `test:legacy` keeps the **old** suite —
  **including old `tests/e2e`** — on the gate until the final phase; `test:new-e2e`
  joins `test:project` so new e2e is gated too; `test`/`check` run both old and new.
- **During-migration routing rule (the convention flip is a moving target):**
  after U3, *new* two-pane behavioural tests are written under `tests-new/` in the
  new shape. *New non-two-pane* tests are written in their **old** `tests/{unit,
  integration,e2e}` home (so U10–U13 relocate them with everything else) **unless**
  that module has already been relocated, in which case they go straight to
  `tests-new/` with a same-PR ledger row marking them `new` (no old twin). A test
  born in `tests-new/` with no baseline entry is expected and must be tagged `new`
  in the ledger so U14 does not flag it as an unaccounted relocation.

**Test scenarios.**
- `record.ts` rejects a cassette missing required fields; accepts a valid one;
  replay verification round-trips events through `FakeRunner`. *(error + happy)*
- `recorded-agent` tracer replays a cassette deterministically (no CLI, no flake).
  *(integration)* — uses a checked-in fixture cassette, not a live record.
- `real-agent` tracer is **unreachable** except by naming its path
  (`test:two-pane:full:real`); it auto-skips without `claude`/`codex` + tmux. *(gating)*
- Overlap report flags a deliberately-missing overlap group and a deliberately
  unaccounted old test; passes when both are satisfied. Run via AST parse, it
  registers **zero** Bun tests (assert no `it()` fired during collection). *(critical)*
- Bare `bun test` (no path) prints the guard warning. *(edge)*
- `bun run check` runs old + new and is green; `bun run check:release` additionally
  requires `which claude codex`. *(happy)*

> **Sequencing (load-bearing).** The docs/skill rewrite must complete **within
> U3, before U4 starts**, because every migration phase (U4–U13) loads
> `phase-implementer` (and runner work loads `runner-author`) per CLAUDE.md, and a
> stale tier-coded skill will make an autonomous agent write old-shape tests
> mid-migration (R12). U3 is not done until a grep for "Tier 1".."Tier 5" /
> "five-tier" across `.claude/skills/**` and `CLAUDE.md` returns only intentional
> historical references.

**Verification.** All seven atomic buckets runnable by path; `check` green;
`docs/testing-strategy.md` no longer documents tiers; CLAUDE.md names the default
and bans bare `bun test`; the skill/`CLAUDE.md` tier-grep is clean. **Convention
is now flipped** — subsequent feature work writes only new-shape tests, routed per
the during-migration rule above.

---

### Phase group B — Migrate the two-pane surface (U4–U9)

> Migration is **by feature-area, never by tier** (spec §10.2): a feature's
> `model` + `screen` + `full-host` tests are re-derived **together**, through the
> triage rule, as a **pruning** opportunity (some old tests die → `drop`, some
> merge, some demote a level). A mechanical 1:1 port would carry today's bloat
> forward. For each area: write new scenarios → run green → add a ledger row **per
> old `it()`/`test()`/`it.each` case** (`port`/`merge`/`demote`/`drop` + reason),
> keyed to the frozen baseline (D12) → **only once every case in an old file is
> ledgered**, wrap that file `.skip` with a `// MIGRATED → <path>` marker (D15) →
> update the old-tier count trend. A file with one ported case and three
> un-ledgered cases must **not** be skipped — that is the green-but-incomplete
> trap the case-granular ledger exists to prevent.

#### U4. Migration tracer — first full feature-area (`launch` + `follow-live`) end-to-end

**Goal.** Validate the *entire migration mechanic* on one or two real areas:
re-derive across `model` + `screen` + `full-host:fake-agent` + `lifecycle`,
produce ledger rows for every old file touched, exercise the overlap report on a
real `overlapGroup`, and mark the corresponding old tests `.skip`. This proves
the recipe at the cost of ~one area, not the whole backlog.

**Requirements.** Spec §10.1–10.3, §11; D2, D10.

**Dependencies.** U3.

**Files.** New scenarios under `tests-new/{model,screen,full-host/fake-agent,lifecycle}/`
prefixed `launch--*` and `follow-live--*`; `.skip` edits to the matching old
files (`tests/integration/lifecycle/launch.*.behavioral.real.test.ts`,
`tests/integration/hosts/two-pane/tier-1/follow-live-*`,
`tests/unit/hosts/two-pane/steps-view/*` for the launch/selection projections);
ledger rows in `tests-new/_migration/ledger.md`.

**Approach.** Pick areas that touch *every* driver so the tracer exercises the
full surface: `launch` (first step running/highlighted, header+step-list render,
interactive badge) spans `model` + `screen` + `lifecycle`; `follow-live` spans
`model` (intent flip) + `full-host:fake-agent` (right-pane swap) + `screen`
(footer). Note the existing `follow-live` Tier-1 file is a **deferred
placeholder** — the new `full-host:fake-agent` live-driven submode (interleave a
keypress mid-run) is exactly what unblocks it; capture that as the tracer's proof
that the new design closes a gap the old harness could not.

**Test scenarios.** Re-derived `launch--*` and `follow-live--*` scenarios (see
§9 Worked Examples for the exact target shapes). Each old *case* (not just each
file) gets a ledger row keyed to the baseline; every `drop` carries a reason; the
overlap report passes for the `follow-live-view-mode` group. **U4 also flips the
overlap report to blocking** (the first ledger row now exists — "migration is
underway", §U3) — from here a red report fails the phase.

**Verification.** `bun run test:two-pane` green; overlap report green **and
blocking** for the migrated groups; old `launch`/`follow-live` files all `.skip`
*only* because every child case is ledgered (D15); ledger updated. This phase is
also the proof that the case-granular ledger + AST overlap report + frozen
baseline machinery works end-to-end before the bulk migration leans on it.

---

#### U5–U9. Two-pane feature-area migrations (one coherent cluster per phase)

Each unit is one autonomous phase using the U4 recipe. Grouped so a phase's tests
share a driver profile and can be re-derived together. **Each phase plan must
inventory its area's old files *from the frozen baseline* (D12), apply the triage
rule, and ledger every disposition at case granularity.**

> **Phase sizing is NOT uniform — pre-split before the run.** These clusters are
> wildly unequal: **U5 absorbs the bulk of the ~199 Tier-2 cases** (spec §1.1) and
> is the one the spec explicitly warns cannot be mechanically reshaped (§3.2),
> while U9 is ~4 tests. "Split if large" cannot be decided *during* the run if the
> executor fixes the phase count up front — so the **split must be expressed in
> this plan**: treat any cluster exceeding **~40 old cases or ~15 files** as
> multiple phases, and pre-split U5 into `U5a model` (selection/scroll/columns/
> glyphs projection) and `U5b screen` (paint/resize/banner/end-of-run bytes) up
> front. The grouping below is indicative of *driver profile*, not a promise that
> each row is one phase's worth of work.

| U | Area cluster | Old sources (indicative) | Target categories |
|---|---|---|---|
| **U5** | Left-pane logic & rendering: `selection`, `scroll`, `view-mode-footer`, `adaptive-columns`, `end-of-run` summary/colors, `banner` ttl, step glyphs | `tests/unit/hosts/two-pane/steps-view/*` (selection, scroll, columns, banner, end-of-run, colors); `tier-1/banner-*`, `tier-1/end-of-run-*`; `lifecycle/banner.*`, `lifecycle/end-of-run.*` | `model` (bulk) + `screen` (paint/resize) |
| **U6** | Two-pane plumbing: `nav` (enter-swap, up-down, help-overlay, f-snaps), `replay` (revisit-reuses-pane, same-transcript), `progression` (live-focus, glyph-flips, per-step-artifacts), `multi-source`/`many-sources`, `command` output→pane | `tier-1/*` (replay, multi-step, many-sources, auto-stop, interactive-pane); `lifecycle/nav.*`, `lifecycle/progression.*`, `lifecycle/resume.*`, `lifecycle/command.*` | `model` + `full-host:fake-agent` (+ `recorded-agent` where realism matters) |
| **U7** | Right-pane controller / pane-map & subworkflow: `right-pane-controller*` (banner, failure-recovery, dead-pane, session-lost), `source-session`, `resume-refusal`, `subworkflow` (boundary, collapse, parallel-suppression) | `tests/unit/hosts/two-pane/pane-map/*`; `tests/unit/hosts/two-pane/steps-view/subworkflow-*` | `model/controller` (+ `full-host:fake-agent` where it crosses panes) |
| **U8** | Lifecycle / outside-in: signals (`sigint`/`sigterm`/`sighup`/`double-sigint`), `close-stdin`, `q-during`, `click-to-focus`, `failure` status/summary, `ask` noninteractive, `commit`, `worktree` | `tests/integration/lifecycle/*` (the remaining process-behaviour + failure + commit/worktree/ask cells) | `lifecycle` (subtypes: `process-lifecycle`, `attached-cli-ui`, `external-tmux`) |
| **U9** | Real-CLI smokes + recorded realism: the 2 Tier-4 e2e + 1–2 recorded cassettes for event-stream-shape-dependent behaviour | `tests/e2e/tier-4/*`; new `recorded-agent` cassettes | `full-host:real-agent` (2–3) + `full-host:recorded-agent` |

**Requirements (all of U5–U9).** Spec §3–§6, §10, §11, §12; the per-feature
recipe (§11 of the spec). **Test expectation:** each phase re-derives behaviour
coverage; feature-bearing by definition — the scenarios *are* the tests.

**Verification (each).** The area's new scenarios green at their driver levels;
overlap report green for the area's groups; every old file in the area `.skip`
with `// MIGRATED →`; ledger rows complete with reasons for every `drop`;
old-tier count trend updated. `bun run check` green.

---

### Phase group C — Migrate the rest of the repo (U10–U13)

> These are **relocations, not re-derivations** (D1). Non-two-pane tests are
> already plain class/integration tests with fakes at `*Service` seams. Move the
> file into `tests-new/{unit,integration,e2e}/<mirror of src path>`, fix import
> paths, mark the old file `.skip`, ledger it. **No behavioural rewrite.** Group
> by `src/` module so each phase is coherent and reviewable.

| U | Module cluster | Old → New |
|---|---|---|
| **U10** | `core/**` (step, workflow, run, parallel, schema, commit, command, prompt-file, validation) | `tests/{unit,integration}/core/**` → `tests-new/{unit,integration}/core/**` |
| **U11** | `runners/**` (claude, codex, fake, scripted-fake) + `runners` execute/runner | `tests/{unit,integration}/runners/**` → `tests-new/{unit,integration}/runners/**`; real runner tests → `tests-new/e2e` or kept gated under integration per existing convention |
| **U12** | `services/**` (process, fs, git, clock, prompt) — **excluding** `services/tmux` argv which is already `tmux-argv` (U-handled) — plus `state/**`, `validators/**`, `workflows/**`, `config/**`, `codegen/**`, and the **non-two-pane `hosts/**`** (plain-host, tmux-host, host-registry, pane-queue, parallel-rollup, terminal-reset, await-foreground-shutdown — confirmed 13 unit + 4 integration files NOT under `two-pane/`) | mirror into `tests-new/{unit,integration}/**` incl. `tests-new/{unit,integration}/hosts/**` |
| **U13** | `cli/**` + `observability/**` + remaining `e2e/**` (the relocated `resume-real-claude`, `steps-tui-e2e`, `workflows/`, `cli/` files) + classify the adjacent real-tmux adapter/harness tests (`tests/integration/real-tmux/**`, `tests/integration/services/tmux/**`) into `tmux-argv` vs `integration` explicitly (spec §7 note, §14) + relocate the **`.test-d.ts`** type-tests and account for `tests/unit/helpers/**` | mirror into `tests-new/{unit,integration,e2e}/**`; tmux adapter/harness contract tests classified, not dropped; `.test-d.ts` files land where `tsconfig` typechecks them |

> **Coverage of the WHOLE tree (D12).** U10–U13 must drain the frozen baseline to
> zero unassigned `test`/`type-test` entries. `helper`/`fixture`/`setup`/`asset`
> entries are accounted for by the D13 `_support/` move (with shims), not relocated
> as tests. Every baseline entry ends in exactly one of: relocated, `_support`-moved,
> or explicitly `drop`ped-with-reason. Nothing is allowed to be silently left behind
> in `tests/` un-ledgered.

**Requirements.** D1, D2, D3, **D12, D13**; CLAUDE.md three-layer model unchanged.

**Verification (each).** New location green; old location `.skip`; **import-path
parity guard** — a check (codemod + assertion) confirms each `port` file imports
the *same `src/` symbols* as its baseline original and resolves them (relative-depth
changes from `tests/…`→`tests-new/…` silently misresolve otherwise; "diff-identical
except paths" is the contract but a wrong `../` count is the classic failure); no
cross-tree imports from `tests-new/` into `tests/`; ledger rows at case granularity;
`bun run check` green. **Test expectation:** relocation parity — same assertions,
new path. A diff of old vs new should be import paths + `describe`/`it` body
identity (no semantic change) for `port` rows.

---

### Phase group D — Finish (U14)

#### U14. Reconciliation — "we are finished"

**Goal.** Prove the migration is complete and flip the repo's default gate onto
`tests-new/`.

**Requirements.** Spec §10 (no long-lived dual suite), §11.8; D2.

**Dependencies.** U4–U13.

**Files (modify).** `package.json` (point `test`/`check` at `tests-new/`; keep
`test:legacy-archive` running the all-`.skip` old tree as a cheap record);
`tests-new/_migration/ledger.md` (final accounting); `docs/testing-strategy.md`,
`CLAUDE.md`, `README`, skill docs (final reconcile); `docs/plans/implementation-phases.md`
(record the restructure as landed).

**Approach.** A reconciliation check (`tests-new/_migration/reconcile.ts`,
extending the overlap report) asserts, **always against the FROZEN U1 baseline
(D12), never a live scan of a tree the migration mutated**:
1. **Every** `test` entry in the baseline is either fully `.skip` in `tests/` or
   `drop`ped-with-reason in the ledger — using an **AST scan** that resolves
   skipped *ancestry* (`describe.skip` wrapping, nesting) and does not confuse
   `skipIf` (capability) with unconditional `.skip` (migrated); a regex for
   `it(`/`test(` is insufficient and is explicitly rejected.
2. **Every** baseline entry (at case granularity) appears in the ledger with a
   disposition; **zero** unaccounted cases. Because the expected-set is the frozen
   baseline, a file that was *deleted* rather than skipped still fails the check —
   reconciliation cannot pass vacuously over a shrunken/renamed tree.
3. Every `MIGRATED → <path>` target actually exists and its scenario back-
   references the old case via `oldTestRefs` (D15).
4. The overlap report is green (no missing overlap groups) for the whole suite.
5. `tests-new/` runs green at every level (`check` and `check:release` on a
   capable box).
6. Docs **and** `.claude/skills/**` contain **no** references to the five tiers or
   numbered tiers (the U3 grep, re-run repo-wide).

**Test scenarios.**
- Reconciliation scan: planting a single non-skipped old case makes it fail; a
  `describe.skip`-wrapped case is correctly seen as skipped, a `skipIf` case is
  **not** mistaken for migrated. *(critical)*
- Ledger completeness: a baseline case absent from the ledger fails the check;
  a `MIGRATED →` target that doesn't exist fails the check. *(critical)*
- `bun run check` runs only `tests-new/` (+ the all-skip archive) and is green. *(happy)*

**Verification.** `bun run check` and `bun run check:release` green pointing at
`tests-new/`; reconciliation check green; ledger complete; docs tier-free. The
old `tests/` tree remains on disk, fully skipped, kept forever (D2).

---

## 8. Running & gating — the script ladder

Selection is **by path only** (D8). Cost levels are named by nature, never by
number. During migration, `test:legacy` keeps the old suite on the gate; U14
repoints the default.

```jsonc
// two-pane atomic buckets (run exactly one)
"test:two-pane:model":         "bun test tests-new/model",
"test:two-pane:tmux-argv":     "bun test tests-new/tmux-argv",
"test:two-pane:screen":        "bun test tests-new/screen",
"test:two-pane:full:fake":     "bun test tests-new/full-host/fake-agent",
"test:two-pane:full:recorded": "bun test tests-new/full-host/recorded-agent",
"test:two-pane:full:real":     "bun test tests-new/full-host/real-agent",
"test:two-pane:lifecycle":     "bun test tests-new/lifecycle",

// two-pane cumulative levels (nest: fast ⊂ two-pane ⊂ all)
// D14: concurrency is ENCODED via --max-concurrency, not just commented.
"test:two-pane:fast": "bun test tests-new/model tests-new/tmux-argv",                         // ms, no tmux
"test:two-pane:tmux": "bun test --max-concurrency=2 tests-new/screen tests-new/full-host/fake-agent tests-new/full-host/recorded-agent",  // bounded (D6/D14)
"test:two-pane":      "bun run test:two-pane:fast && bun run test:two-pane:tmux",             // fail-fast: ms before tmux
"test:two-pane:lifecycle": "bun test --max-concurrency=1 tests-new/lifecycle",               // SERIAL (D6/D14)
"test:two-pane:all":  "bun run test:two-pane && bun run test:two-pane:lifecycle && bun run test:two-pane:full:real",

// the rest of the repo, in the new tree
"test:new-unit":  "bun test tests-new/unit",
"test:new-int":   "bun test tests-new/integration",
"test:new-e2e":   "bun test tests-new/e2e",                // env-gated like old e2e; was MISSING — Codex consensus

// project-level compatibility / transition (U14 repoints `test`)
// test:legacy includes OLD e2e so it is not silently dropped from the gate during migration.
"test:legacy:e2e": "RUN_REAL_E2E=1 bun test tests/e2e",
"test:legacy":  "bun test tests/unit tests/integration && bun run test:legacy:e2e",   // OLD tree — on the gate until U14
"test:project": "bun run test:legacy && bun run test:new-unit && bun run test:new-int && bun run test:new-e2e && bun run test:two-pane",
"test":         "bun run test:project",

// the gate
"check":         "bun run lint && bun run typecheck && bun run test && bun run test:two-pane:lifecycle",
"check:release": "bun run lint && bun run typecheck && bun run test:project && bun run test:two-pane:lifecycle && bun run test:two-pane:full:real"
```

> **Concurrency is real, not a comment (D14).** `--max-concurrency=1` makes
> `lifecycle` serial; `--max-concurrency=2` bounds the tmux pane levels. The repo
> pins no concurrency today, so without these flags the runner default applies and
> the D6 ceiling is fiction. The exact bounds are revisited in Phase 2 once the
> drivers exist and the real contention ceiling is measured. (Note `typecheck` =
> `tsc --noEmit` now also compiles `tests-new/` per D11.)

Properties: nested levels = "all two-pane tests up to this cost"; `real-agent` is
unreachable except by naming it; `lifecycle` runs **serially** (D6/D14); the
bounded ceiling caps `screen`/`full-host` concurrency. Non-two-pane tests stay on
the gate throughout — `test:legacy` (incl. old e2e) until U14, then
`test:new-unit`/`test:new-int`/`test:new-e2e`.

| Moment | Command | Runs |
|---|---|---|
| Tight two-pane dev loop | `bun run test:two-pane:fast` | model + tmux-argv (ms) |
| Touched rendering / panes | `bun run test:two-pane:screen` / `:full:fake` / `:tmux` | that bucket (seconds) |
| Touched process lifecycle | `bun run test:two-pane:lifecycle` | lifecycle (serial) |
| Pre-commit / the gate | `bun run check` | everything **except** real-agent |
| Release | `bun run check:release` | **everything** (`which claude codex` first) |

---

## 9. Worked examples — the target shape of every test kind

> **This section is the reviewer's main checkpoint.** It shows exactly what each
> kind of test looks like at the end. Names/signatures are directional; the
> *shape, readability, and layering* are the contract. Given/When/Then are plain
> comment-marked `await` sections — no builder chains, no `.expect(...)`.

### 9.1 `unit` — plain class test, fakes at the `*Service` seam (non-two-pane)

```ts
// tests-new/unit/runners/claude/build-command.test.ts
import { describe, expect, it } from 'bun:test'
import { claude } from '../../../../src/runners/index.ts'

describe('ClaudeRunner.buildCommand', () => {
  it('emits the bare autonomous argv with the prompt last', () => {
    const cmd = claude().buildCommand({ cwd: cwdPath, env: {}, prompt: 'do the thing' })

    expect(cmd.argv).toEqual([
      'claude', '--bare', '-p', 'do the thing',
      '--output-format', 'stream-json', '--verbose', '--no-session-persistence',
    ])
  })
})
```

*Unchanged concept from today — relocated under `tests-new/unit/`, mirroring
`src/`. Fakes (here none needed; for I/O, `FakeProcessService`) live only at
`*Service` ports.*

### 9.2 `model` — controller decision / projection seam, no tmux (the bulk)

```ts
// tests-new/model/follow-live--returns-to-running-step.test.ts
import { scenario } from '../dsl/index.ts'

scenario({
  name: 'pressing follow-live returns the view to the running step',
  feature: 'follow-live',
  drivers: ['model'],
  risk: 'projection-to-screen-binding',
  overlapGroup: 'follow-live-view-mode',
  oldTestRefs: ['tests/integration/hosts/two-pane/tier-1/follow-live-returns-to-running-step.real.integration.test.ts'],
}, async (app) => {
  // given — a run paused with one step done and the next live
  await app.launch({ steps: ['plan', 'execute'], stopAt: 'mid-step' })

  // when — the user navigated away, then asked to follow the live step
  await app.leftPane.selectStep('plan')
  await app.leftPane.followLive()           // ModelApp affordance; records the intent, no tmux

  // then — the controller re-selects the live step (decision, not bytes)
  await app.leftPane.assertStepSelected('execute')
})
```

> **Why a `leftPane.followLive()` method and not `app.press('f')`?** `ModelApp`
> has no `press` (only `ScreenApp`/`LifecycleApp` model real keystrokes). Calling
> `app.press?.('left','f')` is **not** a graceful no-op — optional chaining does
> not excuse a property absent from the type; it is a hard compile error once
> `tests-new/` is typechecked (D11). The `?.` idiom is therefore **banned in
> scenarios**: a key that doesn't exist on the chosen driver's surface signals
> the author reached for a capability the driver doesn't have. On `model`,
> intent is expressed through a semantic Pane Object method (`followLive()`); the
> same method over a `screen`/`lifecycle` driver maps to a real keypress.

### 9.3 `tmux-argv` — adapter argv contract, unit-speed, no tmux

```ts
// tests-new/tmux-argv/send-keys--escapes-metacharacters.test.ts
import { expect, it } from 'bun:test'
import { FakeProcessService } from '../../src/services/process/fake-process-service.ts'
import { RealTmuxService } from '../../src/services/tmux/index.ts'

it('send-keys passes a metacharacter payload literally via -l', async () => {
  const fps = new FakeProcessService()
  const tmux = new RealTmuxService({ process: fps, socket: socketName })

  await tmux.sendKeys(paneId, '$(rm -rf /)')

  expect(fps.lastSpawn().argv).toContain('-l')                 // literal mode — no shell interpretation
  expect(fps.lastSpawn().argv).toContain('$(rm -rf /)')
})
```

### 9.4 `screen` — left/steps-pane bytes on one real tmux pane (S2 fixture)

```ts
// tests-new/screen/follow-live--footer-renders-with-quit-hint.test.ts
import { scenario } from '../dsl/index.ts'

scenario({
  name: 'the footer renders the quit hint once at the bottom of the steps pane',
  feature: 'follow-live',
  drivers: ['screen'],
  risk: 'footer-placement',
  overlapGroup: 'follow-live-view-mode',     // the contract twin of the §9.2 model test
}, async (app) => {
  // given — a run paused mid-step at a known width
  await app.resize(80, 24)
  await app.launch({ steps: ['plan'], stopAt: 'mid-step' })

  // then — actual bytes off real tmux; co-located chrome literal, count guards double-render
  await app.leftPane.assertQuitHintVisible()
})
```

*Because §9.2 (`model`) and §9.4 (`screen`) share `overlapGroup:
'follow-live-view-mode'`, the overlap report treats them as the deliberate
`model`↔`screen` contract (§5.5). The same `LeftPane.assertQuitHintVisible()` runs
over both drivers — on `model` it asserts the controller selected the hint; on
`screen` it matches captured real-tmux bytes against the co-located literal.*

### 9.5 `full-host:fake-agent` — full two-pane host, right-pane communication (static default)

```ts
// tests-new/full-host/fake-agent/follow-live--right-pane-swaps-source.test.ts
import { emits, scenario } from '../../dsl/index.ts'

scenario({
  name: 'autonomous transcript reaches the right pane with no caret echo',
  feature: 'follow-live',
  drivers: ['full-host:fake-agent'],
  risk: 'two-pane-communication',
}, async (app) => {
  // given — a fake agent scripted to emit known text (static = default)
  await app.launch({ steps: ['plan'], agent: emits('first thinking', 'second thinking') })

  // when
  await app.complete('plan')

  // then
  await app.rightPane.assertShowsContent('first thinking')   // test-authored CONTENT → escape hatch
  await app.rightPane.assertNoCaretEcho()                    // chrome/hygiene → semantic method
})
```

**Live-driven submode (only when interleaving is required):**

```ts
// tests-new/full-host/fake-agent/follow-live--keypress-during-stream.test.ts
scenario({
  name: 'pressing follow-live mid-stream snaps the right pane back to the live step',
  feature: 'follow-live',
  drivers: ['full-host:fake-agent'],
  liveDriven: true,                          // EXPLICIT opt-in to the scriptedFake subprocess submode
}, async (app) => {
  await app.launch({ steps: ['plan', 'execute'], agent: live() })

  // interleave user action with agent output — the gap the old Tier-1 file was deferred on
  await app.agent.type('working on plan...')
  await app.leftPane.selectStep('plan')
  await app.press('left', 'f')
  await app.agent.finish()

  await app.rightPane.assertShowsLiveStep('execute')
})
```

### 9.6 `full-host:recorded-agent` — replay a normalised-event cassette

```ts
// tests-new/full-host/recorded-agent/claude-plan-then-work.test.ts
import { fromCassette, scenario } from '../../dsl/index.ts'

scenario({
  name: 'a recorded Claude plan→work run paints structured events in the right pane',
  feature: 'transcript-rendering',
  drivers: ['full-host:recorded-agent'],
  risk: 'event-stream-shape',
}, async (app) => {
  // given — realistic events, captured once from a real run, replayed deterministically
  await app.launch({ steps: ['plan'], agent: fromCassette('claude-plan-then-work.json') })

  // when
  await app.complete('plan')

  // then — chrome (how we render a tool-use event) via semantic method; no raw CLI bytes here
  await app.rightPane.assertRenderedToolUse('Write')
})
```

```jsonc
// tests-new/full-host/recorded-agent/cassettes/claude-plan-then-work.json (excerpt — OUR normalised type)
{
  "schemaVersion": 1, "runner": "claude", "recordedAt": "2026-06-05T12:00:00Z",
  "workflowName": "plan-then-work", "scenarioId": "claude-plan-then-work",
  "eventSchema": "RunnerEvent",
  "events": [
    { "kind": "info", "type": "tool_use", "payload": { "name": "Write", "path": "plan.md" } }
  ],
  "terminal": { "kind": "terminal", "type": "turn-complete", "data": "done" }
}
```

```sh
# re-record when the cassette drifts (runs a real-agent run once through the onEvent tap):
bun run tests-new/full-host/recorded-agent/record.ts --scenario claude-plan-then-work
```

### 9.7 `full-host:real-agent` — the actual binary, gated, ~2–3 smokes

```ts
// tests-new/full-host/real-agent/autonomous-multi-step.test.ts
import { claudeAgent, scenario } from '../../dsl/index.ts'

scenario({
  name: 'a real Claude step produces output that paints in the right pane',
  feature: 'real-cli-smoke',
  drivers: ['full-host:real-agent'],
}, async (app) => {
  // given — the real ClaudeRunner in the agent slot (the ONLY difference from §9.5)
  await app.launch({ steps: ['plan'], agent: claudeAgent('Reply with exactly: OK') })

  // when
  await app.complete('plan')

  // then — prove the binary integrates INSIDE the two-pane system (not the runner in isolation, §5.6)
  await app.rightPane.assertShowsContent('OK')
})
```

*Auto-skips unless `tmux` + `claude` are on PATH; reachable only via
`test:two-pane:full:real` (D8). It does **not** duplicate the runner's own
mocked+real integration test — it asserts pane integration.*

### 9.8 `lifecycle` — process behaviour, outside-in

```ts
// tests-new/lifecycle/q-during--persists-cancelled-status.test.ts
import { holdsOpen, scenario } from '../dsl/index.ts'

scenario({
  name: 'pressing q in the attached pane during a step exits cleanly',
  feature: 'shutdown',
  drivers: ['lifecycle'],
  regressionRef: '2026-05-26 real-tmux-suite-flakiness-leaked-puppets',
}, async (app) => {
  // given — a held step so there is a window to act
  await app.launch({ steps: ['plan'], agent: holdsOpen(), stopAt: 'mid-step' })

  // when
  await app.press('left', 'q')

  // then — process-level outcomes via SystemAssertions
  await app.system.exitedNormally()
  await app.system.tmuxTornDown()
  await app.system.persistedStatus('cancelled')
})
```

### 9.9 The Pane Object (DSL layer — driver-independent)

```ts
// tests-new/dsl/panes/left-pane.ts
export class LeftPane {
  private static readonly TEXT = {
    quitHint: 'q quit',
    followHint: 'f follow',
  } as const

  constructor(private readonly driver: PaneDriver) {}

  assertQuitHintVisible() {
    return this.driver.assertBottomText(LeftPane.TEXT.quitHint, { count: 1 })
  }
  assertStepSelected(step: string) { return this.driver.assertSelected(step) }
  assertGlyph(step: string, glyph: 'running' | 'done' | 'failed') {
    return this.driver.assertGlyph(step, glyph)
  }
  // the ONLY free-string method — for content the test itself authored
  assertShowsContent(text: string) { return this.driver.assertContains(text) }
}
```

### 9.10 A migration ledger row (per area, in `tests-new/_migration/ledger.md`)

```md
## follow-live

| Old file | Old scenario | New scenario (path) | Disposition | Reason |
|---|---|---|---|---|
| tier-1/follow-live-returns-to-running-step.real.integration.test.ts | press F swaps back to live | model/follow-live--returns-to-running-step + full-host/fake-agent/follow-live--keypress-during-stream | port | was a DEFERRED placeholder; live-driven submode unblocks it |
| steps-view/view-mode-footer.test.tsx | footer reflects mode | screen/follow-live--footer-renders-with-quit-hint | demote→screen | rendering byte risk, not full-host |
| tier-1/...some vacuous fake-tmux byte assertion | not(contains '^[') on fake tmux | — | drop | fake tmux never emits '^[' — assertion could never catch the bug |
```

---

## 10. Risks & mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| **R1 — Predictability rules regress when moved into drivers.** The real-tmux rules were hardened through real flakes; relocating them is the single highest-regression move. | High | U2 ships **driver-level regression tests** (no-orphans, teardown, timeout, poll-and-resend) *before* any behaviour migrates. The §D6 concurrency ceiling caps contention. Tracer bullets validate each driver on real behaviour. |
| **R2 — Scope blow-up (whole repo).** ~300 non-two-pane tests added to the migration. | High | Treated as **relocation, not re-derivation** (D1): mechanical move + import fix + `.skip`, grouped by `src/` module (U10–U13). `port` rows must be diff-identical except paths. |
| **R3 — "Almost no change to old tests" drifts into real edits.** | Medium | D2 constrains old-file edits to `describe.skip`/`it.skip` + a `// MIGRATED →` marker. U14's reconciliation scan fails on any surviving non-skipped old test and any ledger gap. |
| **R4 — Autonomous phases diverge** (no human review until the end). | Medium | This parent plan fixes interfaces (§5), decisions (§3), the decision rule (§6), and worked examples (§9). Each phase plan must honour them, not redesign. The overlap report + ledger + reconciliation check are machine guards against drift. |
| **R5 — `model` byte assertions go vacuous** if someone builds a `FakeTmuxService` and asserts "pane content" against it. | Medium | §5.1 rule baked into the `model` driver: it asserts the **projected view-model**, never a fake tmux. Real-tmux drivers are the only place byte assertions live; the `model`↔`screen` overlap (§5.5) binds the fast suite to reality. |
| **R6 — Chrome-literal tautology** (importing the production symbol on both sides). | Medium | D10: literals are **co-located** on Pane Objects, never imported from `src/`; the overlap/lint guard keeps chrome literals out of scenario files. |
| **R7 — Cassette drift** silently re-tests stale CLI behaviour. | Low | D9: cassettes capture *our* normalised `RunnerEvent` (changes rarely); `record.ts` re-record + replay-verification; raw parser fixtures stay at the runner layer as the real drift guard. |
| **R8 — Dual-suite CI cost during transition.** | Low | Old tests are `.skip` the moment their replacement is green (D2) — skipped tests cost ~0. The gate runs both trees but only live tests execute. |
| **R9 — Typed-DSL guarantee is inert because `tests-new/` isn't typechecked.** The whole "unsupported action = type error" safety mechanism does nothing if `tsc --noEmit` never sees the tree; `bun test` transpiles and won't catch it. | High | D11: U1 adds `tests-new` to `tsconfig` `include` as a Definition-of-Done item; U1 Verification introduces a deliberate type violation and confirms `typecheck` goes red. `.test-d.ts` negative tests ride the same gate. |
| **R10 — Relocation silently misresolves imports.** Moving ~300 files changes relative depth (`../../../../src` → `…`); a wrong `../` count resolves to nothing or the wrong module while "looking" diff-identical. | Medium | U10–U13 import-path parity guard (codemod + same-`src`-symbols assertion against the baseline original), not just "`bun run check` green". |
| **R11 — Moving a helper breaks still-live old consumers.** `behavioral-dsl`/fixtures move to `_support/` (D13) while old `tests/` files still import them via `@orch/test/*` until skipped. | Medium | D13: every move leaves a thin re-export shim at the old path until the last old consumer is skipped, then the shim is deleted. U2 treats the `behavioral-dsl` move as ordered work, not a placement detail. |
| **R12 — Stale tier-coded skills make autonomous phases write old-shape tests.** Every phase loads `phase-implementer` (and runner work loads `runner-author`); these + `orch-qa-engineer`, `orch-acceptance-tests`, `orch-workflow-author`, `CLAUDE.md` still encode the five tiers. | Medium | U3 rewrites **all** of them (incl. the two in-flight skills) **before U4 starts**, gated by a repo-wide tier-grep; U14 re-runs the grep across `.claude/skills/**`. |
| **R13 — Reconciliation passes vacuously.** A file deleted/renamed rather than skipped vanishes from a live scan, so completeness "passes" over a shrunken tree. | Medium | D12: U14 reconciles against the **frozen U1 baseline**, not a live scan; AST scan resolves skipped ancestry and distinguishes `skipIf` from migrated `.skip`; every `MIGRATED →` target must exist. |

---

## 11. Per-feature recipe (for all future work, post-U3)

Replaces "when to write at which tier." When you add or change a feature:
1. **Default everything to `model`/`unit`.** Fast, no tmux. Most of any feature.
2. **Add one `screen` test only if you changed *what paints*** (Ink rendering,
   layout, colours, escapes; narrow/wide widths, resize). Triage check: *would it
   still pass if the pane were empty/wrong?*
3. **Add one `full-host` test only if you changed *two-pane plumbing*** (agent→
   right pane, source swap, split). Pick the mode: independent of agent → `fake`;
   needs realism → `recorded`; needs the binary → `real`.
4. **Add `lifecycle` only when the real CLI boundary matters** (signals, attached
   TTY, external tmux verbs, teardown/orphan risk).
5. **Add fault injection** when the feature touches runner/output failure paths.
6. **Vary width/resize** in `screen` when the feature touches layout/repainting.

A typical feature PR: ~5 `model`/`unit`, 0–1 `screen`, 0–1 `full-host:fake-agent`;
`recorded`/`real`/`lifecycle` only when the feature reaches those surfaces.

---

## 12. Definition of Done (whole effort)

- `tests-new/` holds the full DSL (`dsl/`), the two-pane taxonomy (`model`,
  `tmux-argv`, `screen`, `full-host/{fake,recorded,real}-agent`, `lifecycle`),
  and the relocated repo (`unit`, `integration`, `e2e`).
- Every behaviour is written **once** as a scenario and run at the fidelities it
  lists; the Tier-1↔Tier-4 copy-paste is **structurally impossible**.
- Chrome literals live only on Pane Objects (co-located, never imported from
  `src/`); scenarios call only semantic methods (+ the content escape hatch).
- The overlap report is green; the migration ledger accounts for **every** old
  file with a disposition + reason.
- Every old test file is `.skip` and kept on disk (D2). `bun run check` /
  `check:release` run `tests-new/` green; the reconciliation check passes.
- `docs/testing-strategy.md`, `CLAUDE.md`, `README`, and skill docs contain **no**
  references to the five tiers. CLAUDE.md names `bun run test:two-pane:fast` as
  the default and bans bare `bun test`.
- `docs/plans/implementation-phases.md` records the restructure as landed.
