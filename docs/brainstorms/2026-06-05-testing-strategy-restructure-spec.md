# Testing strategy restructure — specification

- **Date:** 2026-06-05
- **Status:** Specification — decisions made, ready for an implementation plan. Not yet built.
- **Audience:** The agent (or person) who will turn this into a phased implementation plan, plus anyone who wants to understand *what* we are building and *why* we chose it.
- **Scope:** The behavioral test suite for the two-pane host (`src/hosts/two-pane/**`) and the surrounding two-pane test taxonomy. It supersedes the five-tier model in [`docs/testing-strategy.md`](../testing-strategy.md) for this surface only; repo-wide `tests/unit`, `tests/integration`, and existing top-level `tests/e2e` suites remain part of the project gate and must be explicitly preserved in the script transition.

> **Read this first.** This document describes a target state and the reasoning that led to it. It is deliberately descriptive about *how we were thinking*, because the decisions only make sense alongside the alternatives we rejected. The next agent should produce a phased plan from §10 (Migration) and §11 (Handoff); everything before that is the rationale and the design those phases must honour.

---

## 1. Why we are doing this

Today the two-pane tests are organised into a **five-tier model** (`docs/testing-strategy.md`). It works, but the structure has accumulated problems that make it hard to teach, hard to navigate, and hard to keep honest.

### 1.1 Current state (measured 2026-06-05)

| Tier | Lives in | Bug class | Files | Test cases |
| --- | --- | --- | --- | --- |
| Tier 1 | `tests/integration/hosts/two-pane/tier-1/` | visible pane content / view state (real tmux + FakeRunner) | 12 | 16 |
| Tier 2 | `tests/unit/hosts/two-pane/steps-view/` | Ink projection (state→view, key→intent) | 28 | 199 |
| Tier 3 | `tests/unit/services/tmux/` | `RealTmuxService` argv contract | 5 | 78 |
| Tier 4 | `tests/e2e/tier-4/` | real-CLI end-to-end on real tmux | 3 | 3 (1 skipped → **2 active**) |
| Tier 5 | `tests/integration/lifecycle/` | CLI signals / attached-TTY / external `tmux kill-*` | 32 | 30 (2 files currently 0 cases) |
| | | **Total** | **80** | **~326** |

> Counts are static `grep` of `it(`/`test(`; runtime-generated cases (`it.each`) may be undercounted, and the two 0-count lifecycle files suggest a non-standard structure in a couple of places. Treat ~326 as ±a handful.

Distribution is actually healthy: ~85% of cases never boot tmux (Tier 2 + Tier 3 = 277/326). The problem is not the balance — it is the **taxonomy**.

### 1.2 What is wrong with the five-tier model

1. **It is a 1-D number imposed on a multi-dimensional space.** The "tiers" pretend to be a linear cheap→expensive scale, but they actually encode **two independent axes** — *environment fidelity* (no tmux / real tmux / real-CLI entrypoint) and *agent fidelity* (in-process fake / subprocess fake / real CLI) — plus a *bug-class label*. A linear number cannot represent two axes, so the doc keeps having to explain that "Tier 5 is additive, not a replacement" — i.e. the number lies about the ordering.

2. **Tier 4 is a flag, not a tier.** It is *literally Tier 1's body* with the agent slot swapped from `FakeRunner` to `claude()` and the gate flipped. It carries 2 active tests. A top-level concept that is a parameter-flip of another concept and holds 2 tests is not earning its place.

3. **Location ≠ tier.** Tier 1 and Tier 5 both live under `tests/integration/`; Tier 2 and Tier 3 both under `tests/unit/`. The tier number tells you the bug class but not where the file is.

4. **It sanctions copy-paste.** The doc calls the Tier-1↔Tier-4 pair "the only sanctioned duplication." That is one idea written twice, differing by ~4 lines wrapped in ~40 lines of identical ceremony. We should make the duplication impossible, not bless it.

5. **Coverage gaps are audited by hand.** "Which screen-tested scenarios were never proven against a real CLI?" was answered by a human reading the whole tree (the `2026-05-12 two-pane audit`). That should be a query, not an audit.

6. **The doc does five jobs at once** — taxonomy + how-to skeletons + flakiness postmortems + fakes comparison + assertion-shape lifecycle. The postmortems (the 2026-05-26 / 2026-05-29 flakes) are append-only history bloating the canonical reference.

The underlying fault line worth keeping is **"screen content" vs "process lifecycle"** — those are genuinely different *kinds* of assertion. Everything else (tmux? real CLI? subprocess?) is a **fidelity knob**, not a category. The five-tier scheme elevates knobs to categories, which is why it needs so much prose to stay straight.

### 1.3 Alternatives we considered before choosing the target model

We discussed three restructures before landing on the final shape. This matters because the chosen model is not just a rename — it is the result of rejecting simpler partial fixes.

| Option | Shape | Why it was not enough |
| --- | --- | --- |
| **A — two axes, named cells** | Drop tier numbers and name cells by environment/agent fidelity (`render`, `tmux-argv`, `screen`, `lifecycle`, `real-cli`). | Better than numbers, but still mostly a taxonomy rewrite. It would not remove the Tier-1↔Tier-4 copy-paste or make coverage gaps queryable. |
| **B — taxonomy by question** | Lead with what the developer is asserting (`view`, `tmux-contract`, `screen`, `lifecycle`) and derive infra from that. | Good framing for the documentation, but still leaves each fidelity as separate tests instead of making shared scenarios first-class. |
| **C — one scenario, many fidelities** | Write a scenario once against an abstract app handle; list the drivers/fidelities it should run on. | Chosen. It removes sanctioned duplication, makes promotion a driver choice, and lets coverage gaps become data instead of a hand audit. |

The final strategy combines **B's decision rule** (choose by the risk/bug class) with **C's implementation shape** (one scenario, swappable drivers).

**Growth premise for choosing C.** The shared scenario/driver architecture is justified only because we expect the two-pane behavioral suite to grow along the multi-fidelity axis: the same feature-level behaviours will need to be proven at `model`, `screen`, full-host fake-agent, recorded-agent, and real-agent fidelities. If this were only a taxonomy cleanup plus two duplicated Tier-1/Tier-4 files, Option B plus a small helper would be enough. The implementation plan should keep this premise visible and should validate it with tracer bullets that exercise genuinely multi-driver scenarios.

### 1.4 The concrete duplication we want to eliminate

The clearest example is the old Tier-1/Tier-4 pair:

- `tests/integration/hosts/two-pane/tier-1/autonomous-live-pane-shows-content.real.integration.test.ts`
- `tests/e2e/tier-4/autonomous-multi-step.real.e2e.test.ts`

They are the same idea — run an autonomous step and prove the right pane receives output — wrapped in almost the same harness ceremony. The meaningful differences are only:

| Concern | Tier 1 | Tier 4 |
| --- | --- | --- |
| Gate | `canRunRealTmux()` | `canRunRealTmuxE2E('claude')` |
| Agent slot | `FakeRunner` scripted to emit known text | `claude()` prompted to produce output |
| Timeout | short real-tmux timeout | long real-agent timeout |
| Assertion | exact scripted text appears | real CLI output/progress appears |

Everything else — fixture creation, `mountTmuxHost`, workflow execution, teardown bookkeeping, pane capture/wait helpers — is repeated. The new structure should make this pair a **single scenario** with different drivers/modes, not two copy-pasted files.

---

## 2. The core idea

**One imperative behavioural DSL, written once per scenario, run against swappable drivers at different fidelities.**

A test is a **scenario**: a plain async function that drives an abstract `app` handle and asserts against its panes / process state. The *fidelity* at which it runs (no tmux, real tmux, real CLI, subprocess) is chosen by a **driver** that supplies the `app`. The old notion of "which tier" becomes "which drivers this scenario lists," derived from a simple decision rule (§5.2).

Two hard constraints from the discussion that shaped this:

- **No builder pattern.** We explicitly rejected `scenario().given().when().then().runOn()` fluent chains — they hide control flow. Given/When/Then are **plain sequential `await` statements** (comment-marked sections), which is the shape the existing Tier-5 `behavioral-dsl` already uses.
- **The assertion vocabulary is the surface.** High-level helpers assert over **the left pane, the right pane, or the whole system**, and read like sentences (e.g. "the footer contains `q quit`").

This is the four-layer test pattern (abstract scenario → DSL → driver → system) from *Growing Object-Oriented Software*. We are not inventing it. We are borrowing the readability shape of the Tier-5 DSL, but not pretending the existing Tier-5 handle can simply be reused everywhere: today's lifecycle handle is subprocess + real-tmux + control-file bound, while `model` is no-tmux and `screen` is a real-tmux rendering fixture. The implementation is a shared scenario vocabulary over typed driver capabilities, not one lowest-common-denominator object forced across incompatible substrates.

---

## 3. The categories

Two groups: a **fidelity ladder** (simplicity → complexity, the spine of the suite) and two **standalone categories** that sit off the ladder because they assert a different kind of thing.

```
  THE LADDER (fidelity → cost)
  unit ──▶ model ──▶ screen ──▶ full-host ┬─ fake-agent      authored / live-driven synthetic agent
   │        │          │                  ├─ recorded-agent  recorded real-agent events, replayed
   │        │          │                  └─ real-agent      the actual CLI binary (gated, ~2–3)
  one     no tmux   1 real tmux   full two-pane host
  class   fake proc pane, fake    (fake process; real CLI only in real-agent mode)
          (proj.)   process

  STANDALONE CATEGORIES (off the ladder)
  lifecycle   — outside-in CLI behaviour (process signals, attached CLI UI, tmux kill-*), full boot
  tmux-argv   — tmux adapter argv contract, no system booted (UNIT-SPEED, not tmux-speed)
```

### 3.1 `unit` — plain class tests
Classic isolated unit tests: construct a class with **fakes at the `*Service` seams** (`FakeProcessService`, etc.), call a method, assert return/internal state. Per CLAUDE.md "mock only at the edge" — fakes live at Service ports; if you want to fake anything else, the seam is wrong. Unchanged by this restructure except where module-level steps-view tests move to `model` (§9).

### 3.2 `model` — the system's *decisions*, no tmux (the bulk)
Drive the system with actions; assert the controller's **decision / projection** — the view-model `StepsView` consumes, or the content/command the controller *intends* to push to a pane source. **No tmux is booted.** Fast (milliseconds), fake process. This is most of the suite (absorbs today's 199 Tier-2 tests).

> **Critical rule (§5.1): `model` asserts at the projection seam, never against a fake tmux.** The moment you assert *rendered bytes*, you are in `screen`.

Implementation note: the `model` category is not all one harness shape. Current Tier-2 coverage includes pure projector tests, Ink component/render tests, key→intent tests, and controller-adjacent tests. The public category stays `model`, but the implementation may split internally into `model/projector`, `model/view`, and `model/controller`. Do not assume all 199 cases can be mechanically rewritten as `launch(spec) → complete(step) → PaneObject` scenarios on day one; the shared model driver is real infrastructure.

### 3.3 `screen` — bytes actually reach the screen (real tmux, single pane)
Drive the system; assert the **rendered bytes on a real tmux pane** (the left/steps pane). Risk class: *does our Ink view survive real tmux* — wrapping, colours, escape handling, footer/header placement, glyph rendering, and terminal byte quirks. One real tmux pane, fake process, slower than `model` (seconds). Narrower than today's Tier 1 — it is **left-pane rendering only**, no agent/right-pane communication.

Implementation note: `screen` is also net-new or extracted infrastructure. The existing reusable `mountTmuxHost` path is full two-pane, while the single-pane steps-view real-tmux tests hand-roll their fixture. Planning must choose v1 explicitly:
- **Option S1:** `screen` means "left pane inside the full two-pane host" for less harness work.
- **Option S2:** extract a dedicated single-pane steps-view runner fixture for cleaner isolation.

Either way, the driver must own width/height and resize knobs. Wrapping, narrow widths, wide widths, and SIGWINCH/header-duplication regressions are part of the `screen` risk class, not special one-off tests.

### 3.4 `full-host` — the full two-pane host
Drive the system; assert that **both panes and the communication between them** behave (split, stream agent output to the right pane, swap sources, left reflects progress). Full two-pane host on real tmux, several seconds. This is where right-pane transcript assertions live, including "right pane is not empty after `step:start`" and "agent output actually paints." Few tests. **Three agent modes** (§4) differing only by where the agent's event stream comes from.

Naming decision: use `full-host` / `two-pane` language for this family and reserve top-level `e2e` for real entrypoint/external-binary tests elsewhere in the repo. `e2e:fake-agent` is too easy to misread because it is not "real everything" and this repo already has broader `tests/e2e/**` suites.

### 3.5 `lifecycle` — process behaviour, outside-in (standalone)
Look at the system **from outside the process**: signal handling (SIGINT/SIGTERM/SIGHUP), attached-TTY keypresses, external `tmux kill-*`, clean teardown, persisted status, and attached CLI UI behaviours that only appear through the real CLI entrypoint. Full boot, slowest, fewest. This is today's Tier 5; it already uses the desired readable DSL style, but its handle is intrinsically subprocess + real-tmux + puppet-control-file based.

Subtypes the planner should keep visible:
- `process-lifecycle` — process exit, signals, teardown, orphan prevention, persisted status.
- `attached-cli-ui` — keypresses and visible left/right pane assertions that require the attached CLI path.
- `external-tmux` — kill-pane/session/server and tmux-side disruption.

### 3.6 `tmux-argv` — adapter contract (standalone, unit-speed)
Assert the **argv/escaping the tmux adapter emits** for a given action, via `FakeProcessService` capturing the spawn. **No tmux is booted**, so despite being a "standalone category" it runs at **unit speed** and belongs in the *fast* run level (§8). This is today's Tier 3, unchanged in substance.

---

## 4. The three full-host agent modes

Within `full-host` (full two-pane host), the agent is a double whose **event stream has one of three provenances**. They form a fidelity gradient: *synthetic → recorded-real → live-real*.

| Mode | What it is | Existing machinery | Build status |
| --- | --- | --- | --- |
| `fake-agent` | Author any agent behaviour, including edge cases real CLIs won't reliably produce. Default = a **static authored** event script. Reach for the **live-driven** subprocess flavour (`agent.type()` / `agent.finish()`) only when the test must **interleave** agent output with user actions. | `FakeRunner.script({ events })` (static, in-process) and `scriptedFake` (live-driven subprocess; the `type_and_send`/`finish` NDJSON grammar) | ✅ exists |
| `recorded-agent` | "Predictable real Claude/Codex." A **recorded normalised event stream**, captured from a real run, replayed deterministically. Realistic data without cost or flake. | `runRunner(..., { onEvent })` already exposes the normalised event tap; replay is `FakeRunner.script({ events })` fed from a cassette file | 🔨 cassette schema + re-record workflow are net-new; the event tap and replay engine already exist |
| `real-agent` | Proof the actual binary integrates inside the two-pane system: launches, makes a file, returns a structured response, finishes. Few (~2–3), gated, slow (~a minute/round). | `ClaudeRunner` / `CodexRunner` in the agent slot (today's 2 Tier-4 tests) | ✅ exists |

**Key realisation:** `fake-agent` (static) and `recorded-agent` are the **same replay engine, different event source** (authored inline vs loaded from a cassette). You build one engine and fill it two ways. Only the live-driven flavour of `fake-agent` (the subprocess) is heavier, and it is needed only for interleaving.

**Decision: `full-host:fake-agent` defaults to static authored events.** The `agent.type()` / `agent.finish()` style is not the default; it is the heavier live-driven submode for cases where the test must interleave user actions with agent output. Most fake-agent full-host tests should be static scripts because they are cheaper and easier to debug. Scenario authors must choose the submode explicitly in the driver options when interleaving is required; it should not be inferred from the scenario body.

### 4.1 Build-status correction

The hard parts are not distributed the way the first draft implied:
- `model` driver: **net-new shared driver seam** over several existing test shapes (`projector`, Ink render, key intent, controller-adjacent).
- `screen` driver: **net-new or extracted real-tmux rendering fixture**, depending on whether v1 uses the full two-pane host or a dedicated single-pane steps-view runner.
- `recorded-agent`: cassette format, validation, and re-record command are net-new, but the normalised event tap already exists at the Runner boundary and replay is `FakeRunner.script({ events })`.

The implementation plan should phase around that reality: prove the awkward `model` and `screen` boundaries early instead of treating them as already-solved wrappers.

---

## 5. Design rules (the load-bearing details)

### 5.1 `model` asserts above tmux, never against a fake tmux
If you build a `FakeTmuxService` that stores "pane content" and assert against it, byte-level assertions go **vacuous**. Example from the current Tier-1 suite: `expect(visible).not.toContain('^[')` catches the legacy pty/tmux escape-doubling bug — but a fake tmux *never* emits `^[`, so the assertion passes trivially and proves nothing. Therefore: `model` asserts the **controller's projected view-model** (what Tier 2 does today with `renderToString`). Real tmux (`screen`/`full-host`) is the *only* place byte assertions are meaningful.

### 5.2 The decision rule (which category a behaviour belongs to)
> Is the risk in **what the controller decides to show**, or in **whether those bytes reach the real screen**?
- "what it decides" → `model` (footer contains quit, failed step shows ✗, selection moves on ↑↓)
- "left/steps-pane bytes survive real tmux" → `screen` (footer placement, glyph rendering, wrapping, terminal byte quirks)
- "two-pane plumbing / communication" → `full-host` (right pane not empty after `step:start`, transcript paints, source swap works)
- "process behaviour" (signals, teardown) → `lifecycle`
- "adapter argv/escaping" → `tmux-argv`

### 5.3 The three-way full-host choice
> What does the behaviour depend on?
- independent of agent content → `fake-agent` (and you're done)
- needs *realistic* event streams (parsing/displaying specific event types) → `recorded-agent`
- needs the *actual binary* → `real-agent`

### 5.4 Cassette rule: record at the Runner boundary, not raw stdout
`recorded-agent` cassettes must capture the **Runner's normalised event stream** (`{ kind, type, payload }` — our own type), **not** raw Claude/Codex stdout. Because:
- Raw stdout → replaying it re-tests *the Runner's parser*, which already has its own real integration test (the runner-author mocked+real pair). Duplication, and it breaks every time a CLI tweaks its output format.
- Normalised events → the cassette is in *our* schema, which changes rarely. Replay is trivially `FakeRunner.script({ events })`. The seam is clean.

Record step: run a `real-agent` scenario once with the existing Runner `onEvent` tap, dump normalised events to `cassettes/<scenario>.json`. **A `re-record` entrypoint is required** (cassettes drift); cassetting our event type instead of raw bytes makes the drift slow and obvious. Cassettes live **beside** their tests (`tests/two-pane/recorded-agent/cassettes/`), not in a global fixtures dir.

Minimum cassette shape:

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
  events: readonly RunnerEvent[]
}
```

`record.ts` must validate this schema, produce deterministic formatting, and support a verification mode that replays the cassette through `FakeRunner.script({ events })`. Raw-output parser fixtures still belong at the runner level; normalised cassettes must not become the only protection against CLI parser drift.

### 5.5 The contract-overlap rule (keeps the fast suite honest)
When you fake a boundary, you **owe a small set of the *same* scenarios run against the real boundary** as a binding proof. A `model` test is only trustworthy if a thin, deliberate `screen` test proves the projection→tmux binding is real. Without that, the fake silently drifts and the fast suite becomes all-green theatre. The `model`↔`screen` overlap is **intentional and small** — it is the contract, not redundancy.

This cannot be only an exhortation. Each shared scenario should carry lightweight metadata:

```ts
scenario({
  id: 'follow-live--returns-to-running-step',
  feature: 'follow-live',
  risk: 'projection-to-screen-binding',
  drivers: ['model', 'screen'],
  overlapGroup: 'follow-live-view-mode',
  oldTestRefs: ['tests/integration/hosts/two-pane/tier-1/follow-live-returns-to-running-step.real.integration.test.ts'],
}, async (app) => { /* ... */ })
```

A simple report should flag missing expected overlap groups and old-test accounting gaps. It does not need to prove semantic parity across 326 tests, but it should make the contract visible enough that deadline pressure cannot silently skip it.

### 5.6 `real-agent` must not duplicate the Runner's own integration test
The runner-author skill already requires each runner to ship a mocked + real integration test. `real-agent` scenarios test the runner **inside the two-pane system** (does the pane show output, does the workflow complete), *not* the runner in isolation. Keep to 2–3 smoke scenarios.

### 5.7 Regression and adversarial-output rules

Past bugs are part of the risk model. Tests that pin a known bug should carry a visible marker:

```ts
// REGRESSION: 2026-05-26 real-tmux-suite-flakiness-leaked-puppets
```

or equivalent scenario metadata (`regressionRef`). Byte-hygiene regressions such as caret echo / escape doubling must run on a real tmux driver (`screen` or `full-host`); a fake tmux cannot prove them.

The suite should also include small adversarial byte/output cases for subprocess-controlled content: ANSI sequences, carriage returns, NUL, wide glyphs, long lines, and chunk-boundary-like fragments. Start with table-driven fixtures before adding a property-testing dependency. Fault-injection cases for runner crash, nonzero exit, partial output, and malformed-but-normalised events belong in `model`/`full-host:fake-agent` depending on the surface under test.

---

## 6. The DSL shape (illustrative — not final API)

A scenario is a function of `app`; drivers supply `app`. Assertion helpers assert+poll and throw on failure, so each line reads like a sentence with no `.expect(...)` ceremony.

```ts
// The scenario helper is generic over the selected driver. Each driver builds
// a typed app surface; not every driver exposes every action/assertion.
scenario('name', ['model', 'screen'], async (app) => {
  await app.launch({ steps: ['plan'], stopAt: 'mid-step' })
  await app.leftPane.assertQuitHintVisible()
})
```

Examples per category (Given/When/Then are plain comment-marked sections):

```ts
// model — logic, no tmux
scenario('the footer tells you how to quit during a run', ['model'], async (app) => {
  // given
  await app.launch({ steps: ['plan'], stopAt: 'mid-step' })
  // then — chrome assertion: no production literal in the scenario (see §6.2)
  await app.leftPane.assertQuitHintVisible()
})

// screen — left/steps pane bytes, one real tmux pane
scenario('footer quit hint renders once at the bottom of the steps pane', ['screen'], async (app) => {
  // given
  await app.launch({ steps: ['plan'], stopAt: 'mid-step' })
  // then
  await app.leftPane.assertQuitHintVisible()
})

// full-host — full two-pane host; right-pane transcript / communication
scenario('autonomous transcript reaches the right pane with no caret echo',
  ['full-host:fake-agent'], async (app) => {
    // given
    await app.launch({ steps: ['plan'], agent: emits('first thinking', 'second thinking') })
    // when
    await app.complete('plan')
    // then
    await app.rightPane.assertShowsContent('first thinking')  // test-owned literal — escape hatch, see §6.2
    await app.rightPane.assertNoCaretEcho()
  })

// lifecycle — process behaviour, outside-in
scenario('pressing q in the attached pane during a step exits cleanly',
  ['lifecycle'], async (app) => {
    // given
    await app.launch({ steps: ['plan'], agent: holdsOpen(), stopAt: 'mid-step' })
    // when
    await app.press('left', 'q')
    // then
    await app.system.exitedNormally()
    await app.system.tmuxTornDown()
    await app.system.persistedStatus('cancelled')
  })
```

`scenario(name, drivers, body)` is a thin wrapper over `test.each(drivers)`: it expands to one real test per driver, each gated/timed by that driver. **All gating, timeouts, fixture lifecycle, socket reaping, and the real-tmux predictability rules move *into* the drivers**, written once — the test file never mentions `canRunRealTmux`, `REAL_TMUX_TEST_TIMEOUT_MS`, or `afterEach` again.

```ts
function scenario(name, drivers, body) {
  for (const d of drivers) {
    const { build, skip, timeout } = DRIVERS[d]
    it.skipIf(skip())(`${name} [${d}]`, async () => {
      const app = await build()
      try { await body(app) } finally { await app.teardown() }
    }, timeout)
  }
}
```

The driver registry is where today's hard-won predictability rules (unique socket per run, `REAL_TMUX_TEST_TIMEOUT_MS`, hook-signal + liveness backstop, server reaping, parent-liveness self-reap for puppet runners, poll-and-resend for idempotent keys) get encapsulated. They are *requirements on the driver implementations*, not on scenario authors. This is a high-regression-risk move because those rules were hardened through real flakes; PR 1 must include driver-level regression tests for teardown/no-orphans and timeout/polling behaviour before migrating behaviour coverage onto the new abstraction.

### 6.1 Driver capability boundaries

The `app` handle is intentionally consistent at the scenario vocabulary level, but not every assertion surface is meaningful on every driver. These boundaries must be explicit in types first. Runtime errors are acceptable as defense-in-depth, but they are not the primary mechanism.

Suggested shape:

```ts
type DriverName =
  | 'model'
  | 'screen'
  | 'full-host:fake-agent'
  | 'full-host:recorded-agent'
  | 'full-host:real-agent'
  | 'lifecycle'

interface ModelApp { leftPane: ModelLeftPane; launch(spec: ModelSpec): Promise<void>; teardown(): Promise<void> }
interface ScreenApp { leftPane: ScreenLeftPane; launch(spec: ScreenSpec): Promise<void>; resize(width: number, height: number): Promise<void>; teardown(): Promise<void> }
interface FullHostApp { leftPane: ScreenLeftPane; rightPane: RightPane; launch(spec: FullHostSpec): Promise<void>; complete(step: string): Promise<void>; teardown(): Promise<void> }
interface LifecycleApp { leftPane: ScreenLeftPane; rightPane: RightPane; system: SystemAssertions; launch(spec: LifecycleSpec): Promise<void>; press(pane: 'left' | 'right', key: string): Promise<void>; signal(sig: Signal): Promise<void>; teardown(): Promise<void> }
```

The public scenario helper can still feel uniform, but the implementation should not force in-process Ink render, in-process real-tmux mount, and out-of-process lifecycle subprocesses into one lowest-common-denominator object.

| Driver | Meaningful assertions | Not for |
| --- | --- | --- |
| `model` | Controller decisions / projection seam; semantic left-pane affordances selected for the current state | Real terminal bytes, right-pane transcript painting |
| `screen` | Left/steps-pane bytes captured from one real tmux pane; layout/chrome/glyph/terminal rendering checks | Full two-pane communication, agent streaming |
| `full-host:*` | Full two-pane host; left/right panes, source swaps, agent output reaching the right pane, workflow completion | Process signal/TTY teardown contracts |
| `lifecycle` | Process behavior from outside: signals, attached-TTY keys, external `tmux kill-*`, teardown, persisted status | Rendering assertions unless the lifecycle case explicitly requires them |
| `tmux-argv` | Adapter argv/escaping only | Behavioural `app` scenarios |

### 6.2 Pane Objects: assert affordances, never raw chrome literals

`leftPane` / `rightPane` / `system` are **Pane Objects** (the Page Object pattern, applied to panes), not thin assertion bags. A scenario names *affordances* (`assertQuitHintVisible`, `assertStepSelected`, `assertEmpty`), never the bytes that implement them. The expected text lives in exactly one place — the Pane Object — so a wording change is a single localized edit, and a reader sees precisely what each pane expects without leaving the test layer.

**The rule is about chrome, not all literals.** There are two kinds of string in a test, and only one belongs behind a Pane Object:

| Kind | Owner | Example | Where it lives |
| --- | --- | --- | --- |
| **Chrome** | production renders it | `q quit` footer hint, `✓`/`✗` glyph, empty-state placeholder, status label | **A constant on the Pane Object, asserted via a semantic method. Never inline in a scenario.** |
| **Content** | the test injected it | the fake agent's scripted `'first thinking'`, a prompt the test sent | **Inline via the `assertShowsContent(text)` escape hatch** — centralizing it would only hurt locality; it's defined a few lines up in the same file. |

**Co-locate the literal in the Pane Object; do NOT import it from `src/`.** It is tempting to import the same constant production renders from, so a rename "can't drift." That is the wrong trade for chrome: if production renders `FOOTER_HINTS.quit` and the test asserts the captured bytes contain `FOOTER_HINTS.quit`, the same symbol is on both sides — a production *typo* (`q qiut`) flows straight through and the test still passes. The assertion is tautological even on real bytes.

A co-located literal is an **independent specification** of what the user should see. When production renames the hint, the `screen`/`full-host` driver captures the real bytes, fails to find the literal, and goes **red** — the correct signal: confirm the new wording is intended, then update the one constant. The literal stated plainly in the Pane Object is also simply easier to read than an import chased into `src/`.

```ts
// tests/dsl/panes/left-pane.ts  — Pane Object (DSL layer, driver-independent)
class LeftPane {
  // expected chrome — co-located, independent of production's own constants
  private static readonly TEXT = {
    quitHint: 'q quit',
    followHint: 'f follow',
  } as const

  constructor(private readonly driver: PaneDriver) {}

  // semantic chrome assertions — no literal reaches the scenario
  assertQuitHintVisible() {
    return this.driver.assertBottomText(LeftPane.TEXT.quitHint, { count: 1 })  // count guards double-render
  }
  assertStepSelected(step: string) { /* ... */ }
  assertGlyph(step: string, glyph: 'running' | 'done' | 'failed') { /* ... */ }

  // escape hatch — ONLY for literals the test itself authored
  assertShowsContent(text: string) {
    return this.driver.assertContains(text)
  }
}
```

On the `screen` / `full-host` drivers `assertBottomText` captures *actual bytes off real tmux* and matches them against the co-located literal — the full Ink→tmux→capture render path is exercised, and because the expected string is specified independently, a production wording typo is caught, not laundered. On the `model` driver it asserts the controller *selected* that hint for this state.

**Three layers, cleanly separated:**
- **Driver** — raw capability: `assertBottomText(literal, {count})`, `capture()`, view-model access. One per fidelity.
- **Pane Object** — semantic, constant-backed methods over a driver. *Driver-independent: the same Pane Object runs over every fidelity.*
- **Scenario** — calls only semantic methods (plus the content escape hatch).

**Guardrail:** `assertShowsContent` is the one method allowed to take a free string. A lint/review rule should keep chrome literals out of scenarios — if a literal that production renders appears in a `tests/` *scenario* file, it belongs as a co-located constant on a Pane Object method instead. The literals live only in the Pane Objects, never in scenarios and never imported from `src/`.

Pragmatic exception: a one-off layout/rendering test may inline a production chrome literal only with an explicit review tag, e.g. `// CHROME-LITERAL-EXCEPTION: one-off layout regression`. The default remains Pane Object ownership; the exception exists to avoid ceremony when centralising a literal would not create reuse or clarity.

---

## 7. Directory layout

Primary split by **driver/cost** (CI gating and speed demand it); the **feature** is carried by the sentence-style filename (`follow-live-returns-to-running-step`). You get cost-class isolation for CI *and* feature-grep readability, without choosing one over the other.

```
tests/
  dsl/                      # the shared DSL: typed app surfaces, scenario(), DRIVERS registry
    panes/                  #   Pane Objects (LeftPane/RightPane), with co-located chrome literals (§6.2)
    drivers/                #   one driver per fidelity; predictability rules encapsulated here
  unit/                     # plain class tests, grouped by module
  two-pane/                 # new taxonomy applies to src/hosts/two-pane/** only
    model/                  # fast, no tmux — the bulk
      projector/
      view/
      controller/
      follow-live--returns-to-running-step.test.ts
      failed-step--shows-x-glyph.test.ts
    tmux-argv/              # standalone category, UNIT-SPEED (no tmux booted)
    screen/                 # real tmux, left/steps pane rendering bytes
      footer--quit-hint-renders-at-bottom.test.ts
    full-host/              # full two-pane host
      fake-agent/           # FakeRunner static by default; scriptedFake live-driven when interleaving is required
      recorded-agent/       # standalone subdir — carries its own asset + workflow
        cassettes/          #   recorded normalised-event streams live beside the tests
        record.ts           #   the re-record entrypoint
        claude-plan-then-work.test.ts
      real-agent/           # ClaudeRunner/CodexRunner, gated, ~2–3 smoke
    lifecycle/              # outside-in CLI behaviour
  integration/              # existing non-two-pane integration suites stay accounted for
  e2e/                      # existing repo-wide entrypoint/workflow e2e suites stay accounted for
```

Notes:
- `two-pane/tmux-argv` is visible as a two-pane-adjacent category even though by nature it is a unit test of `RealTmuxService`. It runs in the *fast* level because it boots no tmux. If planning chooses to keep a repo-level `tests/tmux-argv/` instead, the script transition must still preserve all non-two-pane service/integration tests.
- `recorded-agent` is **its own directory** because it carries an asset (`cassettes/`) and a workflow (`record.ts`) the others don't. Do not scatter cassettes into a global fixtures dir.
- `tests/integration/services/tmux/**` and `tests/integration/real-tmux/**` are adjacent real-tmux adapter/harness contract tests. They are not replaced by `two-pane/tmux-argv`; classify them explicitly in the project script ladder or mark them out of scope in the canonical doc.

### 7.1 Feature naming convention

Because directories are split by driver/cost, the filename must carry the feature area. Use a stable feature prefix plus a sentence-style behaviour name:

```
tests/two-pane/model/follow-live--returns-to-running-step.test.ts
tests/two-pane/screen/follow-live--footer-renders-with-quit-hint.test.ts
tests/two-pane/full-host/fake-agent/follow-live--right-pane-swaps-source.test.ts
tests/two-pane/lifecycle/follow-live--ctrl-c-persists-cancelled-status.test.ts
```

This keeps feature-area migrations grep-able (`rg follow-live tests/`) while preserving path-based run selection.

---

## 8. Running & gating

### 8.1 Principle: selection by path, never by env var
The thing to kill is `RUN_REAL_TMUX_E2E=1 bun test` as a **selector**. It conflates two concerns:
- **Selection** (*what do I want to run?*) → expressed **only** by the directory the test lives in, via the script that targets it. There is no flag.
- **Capability skip** (*can this machine run it?*) → keep the `skipIf(!canRunRealTmux())` predicate. This never *causes* a test to run; it only prevents a false failure on a box without tmux/the CLI.

The payoff is the property we want: **the command names the path, and the path is the category.** `bun run test:two-pane:fast` *cannot* run a real-agent test because those files aren't under its paths. A human or agent is always certain what is running — no hidden env var, no marker comment, no `describe`-name parsing. The filesystem is the manifest.

### 8.2 The script ladder
Two layers — **two-pane atomic/cumulative buckets** and **project-level gates** that preserve the rest of the repo. Cost levels are named by nature, **not** by number (do not reintroduce numbered tiers).

```jsonc
// two-pane atomic buckets (run exactly one)
"test:two-pane:model":          "bun test tests/two-pane/model",
"test:two-pane:tmux-argv":      "bun test tests/two-pane/tmux-argv",
"test:two-pane:screen":         "bun test tests/two-pane/screen",
"test:two-pane:full:fake":      "bun test tests/two-pane/full-host/fake-agent",
"test:two-pane:full:recorded":  "bun test tests/two-pane/full-host/recorded-agent",
"test:two-pane:full:real":      "bun test tests/two-pane/full-host/real-agent",
"test:two-pane:lifecycle":      "bun test tests/two-pane/lifecycle",

// two-pane cumulative levels
"test:two-pane:fast": "bun test tests/two-pane/model tests/two-pane/tmux-argv",                         // ms, no tmux
"test:two-pane:tmux": "bun test tests/two-pane/screen tests/two-pane/full-host/fake-agent tests/two-pane/full-host/recorded-agent",
"test:two-pane":      "bun run test:two-pane:fast && bun run test:two-pane:tmux",
"test:two-pane:all":  "bun run test:two-pane && bun run test:two-pane:lifecycle && bun run test:two-pane:full:real",

// project-level compatibility / transition
"test:legacy":  "bun test tests/unit tests/integration",      // current default paths until migrated/accounted for
"test:project": "bun run test:legacy && bun run test:two-pane",
"test":         "bun run test:project",

// the gate
"check":         "bun run lint && bun run typecheck && bun run test && bun run test:two-pane:lifecycle",
"check:release": "bun run lint && bun run typecheck && bun run test:project && bun run test:two-pane:lifecycle && bun run test:two-pane:full:real",
```

Properties:
- Two-pane cost levels nest: `test:two-pane:fast` ⊂ `test:two-pane` ⊂ `test:two-pane:all` — this is "all two-pane tests up to this level."
- `test:two-pane` chains fast before tmux, so a millisecond-level failure aborts **before** tmux boots (fail-fast dev loop).
- `real-agent` is unreachable except by naming it (`test:two-pane:full:real` or release `test:two-pane:all`).
- `lifecycle` is **not** part of the default two-pane command despite booting tmux, because it is outside-in process behaviour and can be slower/noisier than pane tests. Whether local `check` includes it is a deliberate ergonomics decision; if it stays in `check`, run it serially or with a documented real-tmux concurrency ceiling.
- Non-two-pane integration and e2e tests must remain in project-level scripts until explicitly migrated or declared out of scope. Do not redefine `test` to only run the new two-pane folders.

### 8.3 Which command for which moment

| Moment | Command | Cost | Runs |
| --- | --- | --- | --- |
| Tight two-pane dev loop | `bun run test:two-pane:fast` (or a single `test:two-pane:model`) | ms | model + tmux-argv |
| Touched rendering / panes | `bun run test:two-pane:screen`, `bun run test:two-pane:full:fake`, or `bun run test:two-pane:tmux` | seconds | just that bucket, or all pane/full-host tmux behaviour |
| Touched process lifecycle | `bun run test:two-pane:lifecycle` | slower seconds | outside-in lifecycle bucket |
| Pre-commit / the gate | `bun run check` | seconds | everything **except** real-agent |
| Release | `bun run check:release` | ~minutes | **everything** |

### 8.4 Guardrails
- **CLAUDE.md must name the default and ban the bare command.** Add: *"During two-pane development run `bun run test:two-pane:fast`. The gate is `bun run check`. Never run `bun test` bare — it has no cost ceiling and an agent will crawl every tmux/full-host file."* If this is intended to be more than guidance, add a Bun preload warning/guard for bare `bun test`; otherwise document it honestly as workflow guidance, not enforcement.
- **`real-agent`: skip-quietly in CI, fail-loud on release.** Keep `skipIf` so a runner without `claude`/`codex` doesn't hard-fail a normal pipeline. But the **release** job must `which claude codex || exit 1` *before* `check:release`, so `real-agent` cannot silently skip on the one run where it matters.
- **Real-tmux concurrency is a design input, not a later optimisation.** The known residual flake history means planning must decide before PR 1 whether `test:two-pane:tmux` runs serially, uses bounded concurrency, or splits into `test:two-pane:tmux:serial`.

---

## 9. Mapping from the old tiers

| Old | New | Notes |
| --- | --- | --- |
| Tier 2 (render, 199) | `two-pane/model` | The bulk, but not one mechanical shape. Split internally as needed (`projector`, `view`, `controller`) instead of forcing every case through one scenario surface immediately. |
| Tier 1 (screen, 16) | split: `two-pane/screen` + `two-pane/full-host/fake-agent` | Keep on `screen` only the left/steps-pane rendering-byte scenarios; pure-logic ones demote to `model`. Right-pane transcript / two-pane communication ones become `full-host/fake-agent`. Prune via the triage rule — do **not** 1:1 port. |
| Tier 4 (real-CLI, 2) | `two-pane/full-host/real-agent` | Stops being a tier; becomes the `real-agent` mode. |
| Tier 5 (lifecycle, 30) | `two-pane/lifecycle` | Keep the outside-in CLI harness shape; expose it through typed lifecycle app capabilities rather than pretending it is the same substrate as `model`. |
| Tier 3 (tmux-argv, 78) | `two-pane/tmux-argv` or a repo-level `tests/tmux-argv/` | Unchanged in substance; unit-speed because it boots no tmux. Planning must also classify adjacent real-tmux adapter/harness tests. |
| — (net-new) | `two-pane/full-host/recorded-agent` | Cassette schema + re-record workflow are net-new; normalised event capture and replay machinery already exist. |

---

## 10. Migration strategy (harness-first strangler)

We evaluated three approaches:

- **A — in-place rewrite, one direction.** Rejected: loses the safety net *while* rewriting; the old and new tests fight over the same behaviour; hard to prove equivalence.
- **B — greenfield parallel, delete old once "covered."** Rejected as the primary plan: its specific failure mode is that **the deletion never happens** — "we'll remove the old suite once migrated" becomes a permanent dual suite (twice the CI cost and flake surface), and "are all tests covered?" is not mechanically answerable, so nobody pulls the trigger.
- **C — harness-first strangler, migrate by feature-area, delete in the same PR.** **Chosen.**

### 10.1 The chosen approach
1. **Build typed app surfaces + the drivers first.** Some pieces wrap seams that already exist (`createRealTmuxFixture`, `FakeRunner`, `FakeProcessService`, `scripted-fake`, the Tier-5 `behavioral-dsl`), but `model` and `screen` are real driver infrastructure. Do not describe PR 1 as a small wrapper-only change. All gating/timeout/teardown/predictability rules move *into* the drivers, with driver-level regression tests for the fragile real-tmux lifecycle rules.
2. **Tracer bullet the awkward boundaries first:** port exactly one representative case per driver family:
   - one `model/projector` or `model/view` case,
   - one true left-pane `screen` case with width/resize control,
   - one `full-host/fake-agent` right-pane communication case,
   - one `lifecycle` subprocess case.
   If the typed app surfaces express those comfortably, the design holds — validated at the cost of ~4 tests, not 326. If it can't, we learn the gap early.
3. **Add the recorded-agent tracer separately:** define the cassette schema, `record.ts`, validation, and re-record workflow; then port one `full-host/recorded-agent` scenario. The normalised event tap already exists, but cassette durability is infrastructure and should not be treated as a throwaway detail.
4. **Flip the new-test convention after the tracer bullets, not before.** From that point, all new two-pane behavioral tests are written in the new shape. The bleeding stops early; the old tiers can only shrink.
5. **Migrate the backlog by feature-area, never by tier**, and **delete the old tests in the same PR** that adds the new ones only after the migration ledger accounts for each old scenario. Duplication is short-lived (one PR), but deletion must be auditable.

### 10.2 Why by feature-area, not by tier
A feature's tests (`model` + `screen` + `full-host`) must be re-derived **together**, and migration is a **pruning** opportunity: the 2026-05-12 audit already found Tier-1 tests that should demote to `model`. Re-derive each area through the triage rule — some old tests die, some merge, some move down a level. A mechanical 1:1 port would carry today's bloat forward.

### 10.3 Coverage parity is per-area and ledgered
There is no tool that proves semantic parity across 326 tests; don't build a solver. But do not leave parity as an unstructured human judgement either. When migrating area X, commit a migration ledger in the PR description or a checked-in markdown note:

| Old file | Old scenario | New scenario ID/path | Disposition | Reason |
| --- | --- | --- | --- | --- |
| `tests/integration/hosts/two-pane/tier-1/foo.real.integration.test.ts` | `shows foo` | `tests/two-pane/screen/foo--shows-foo.test.ts` | `port` | same risk, new driver |
| `...` | `old duplicated case` | `foo--main-behaviour` | `merge` | covered by broader scenario |
| `...` | `vacuous fake-tmux byte assertion` | — | `drop` | assertion could never catch the bug |

Allowed dispositions: `port`, `merge`, `demote`, `drop`. Every `drop` must carry a reason. Every feature-area PR should also update an old-tier count trend or checklist so the remaining migration is visible.

### 10.4 Suggested sequencing
```
PR 1: typed app surfaces + base drivers + tracer bullets (model, screen, full-host/fake-agent, lifecycle). Old suite untouched.
PR 2: cassette format + full-host/recorded-agent tracer bullet.
PR 3: flip convention — update docs (this spec → the canonical testing-strategy.md) + CLAUDE.md run guidance + project script transition.
PR 4: first real feature-area migration immediately after the convention flip, with ledger + delete-in-same-PR.
PR 5..N: one feature-area each — port + delete in the same PR, with ledger. Do not "stop whenever"
         without leaving an explicit remaining-area checklist and owner.
```
This gives B's safety (old tests guard the whole time) without B's trap (no long-lived dual suite, no "delete later" debt).

---

## 11. The per-feature recipe (the replacement for "when to write at which tier")

When you add or change a feature:
1. **Default everything to `model`/`unit`.** Logic, decisions, state transitions. Fast, no tmux. Most of any feature.
2. **Add one `screen` test only if you changed *what paints*** — Ink rendering, layout, colours, escapes. Triage check: *would it still pass if the pane were empty/wrong?* If your change is rendering and the answer is "no," you need it.
3. **Add one `full-host` test only if you changed the *two-pane plumbing*** — content flowing agent→right pane, source swap, split. Then pick the mode by §5.3 (independent of agent → `fake`; needs realism → `recorded`; needs the binary → `real`).
4. **Add lifecycle only when the real CLI boundary matters** — process signals, attached TTY, external tmux verbs, or subprocess teardown/orphan risks.
5. **Add fault injection when the feature touches runner/output failure paths** — nonzero exit, crash mid-stream, malformed-but-normalised event, partial output, or long/adversarial output.
6. **Vary width/resize when the feature touches layout or terminal repainting** — narrow widths, wide widths, and resize sequences belong in `screen`.

A typical feature PR: ~5 `model`/`unit`, 0–1 `screen`, 0–1 `full-host/fake-agent`; `recorded`/`real`/`lifecycle` only when the feature specifically reaches those surfaces.

---

## 12. What carries over unchanged

- **The triage rule** stays the north star: *"Would this test still pass if the visible pane were empty / wrong / unformatted? If yes, demote or delete."* It is now also the migration pruning filter.
- **The real-tmux predictability rules** (unique socket per run, `REAL_TMUX_TEST_TIMEOUT_MS`, `REAL_TMUX_ASSERT_TIMEOUT_MS`, hook-signal + liveness backstop, server reaping, puppet parent-liveness self-reap, poll-and-resend for idempotent keys) survive — but they **move into the driver implementations** instead of being recited in every test file and the doc. This move must be tested directly because it is a known flake boundary.
- **The two fakes** (`FakeRunner`, `scriptedFake`) and their guidance survive: `FakeRunner` is the in-process default; `scriptedFake` is the subprocess, live-driven fake for interleaving and lifecycle. `recorded-agent` is a new *use* of `FakeRunner` (cassette source), not a new fake.
- **`tmux-argv` substance** is untouched.
- **Manual screen QA** remains outside the automated taxonomy. The QA/screenshot workflow is not part of `check`, but it remains useful exploratory evidence before writing or debugging automated `screen`/`full-host` scenarios.

## 13. Non-goals

- We are **not** changing what the orchestrator *does* — only how it is tested.
- We are **not** removing real-tmux testing — `screen`/`full-host`/`lifecycle` keep it; it just becomes one driver among several with most tests below it.
- We are **not** rewriting the `tmux-argv` assertions — only relocating/renaming the category.
- We are **not** replacing runner parser contract tests with recorded-agent cassettes. Raw CLI parser fixtures remain at the runner layer.
- We are **not** moving non-two-pane project tests into this taxonomy unless a later project-wide testing strategy explicitly does that.

---

## 14. Open / deferred items for the planning agent

- **Real-CLI home — decided:** `tests/two-pane/full-host/real-agent`, run only by `test:two-pane:full:real` or release `check:release`. (We considered folding it into `lifecycle`; rejected — different assertion target.)
- **Full-host naming — decided:** use `full-host`/`two-pane` naming for the two-pane family and reserve top-level `e2e` for repo-wide real entrypoint/workflow tests.
- **`tmux-argv` placement:** preferred home is `tests/two-pane/tmux-argv/` for the two-pane taxonomy, but planning may choose a repo-level `tests/tmux-argv/` if it better fits service ownership. Either way, explicitly account for `tests/integration/services/tmux/**` and `tests/integration/real-tmux/**`.
- **Known residual flakiness:** the doc notes a peak-parallelism timing ceiling and the shipped leaked-puppet fix. The new per-level run scheme may relieve real-tmux contention, but planning must decide before PR 1 whether `test:two-pane:tmux` is serial, bounded-concurrency, or split into `test:two-pane:tmux:serial`.
- **Cassette format + `record.ts`:** define the on-disk shape of a normalised-event cassette, validation, deterministic formatting, re-record, and replay verification (§5.4).
- **Driver registry location/shape:** where `DRIVERS` lives, how typed app surfaces are selected, and whether a runner/driver author can add a driver without editing a large central switch.
- **Bare `bun test` enforcement:** decide whether to add a test-setup warning/guard or to document the ban as workflow guidance only.
- **Contract-overlap report:** define the minimal metadata and report that flags missing overlap groups and migration-ledger gaps.

---

## 15. Handoff — what the next agent should produce

A **phased implementation plan** (per `docs/plans/implementation-phases.md` conventions and the `phase-implementer` discipline) that:
1. Specifies the typed app surfaces (`ModelApp`, `ScreenApp`, `FullHostApp`, `LifecycleApp`) and the `LeftPane` / `RightPane` / `SystemAssertions` Pane Objects in full (§6.1, §6.2), and validates how the existing ~326 tests map onto those surfaces (flag any that don't fit — that reveals a missing capability, a unit test that should stay outside the DSL, or a driver gap).
2. Specifies the Pane Object layer in concrete terms: identify production chrome literals, define one co-located expected literal per semantic Pane Object assertion, and allow free strings only for test-authored content (`assertShowsContent(text)`). Do not scatter literals in scenarios, and do not share the same production symbol on both sides of a chrome assertion.
3. Specifies each driver (`model/projector`, `model/view`, `model/controller` as needed; `screen`; `full-host/fake-agent`; `full-host/recorded-agent`; `full-host/real-agent`; `lifecycle`) — what it wraps, which assertion surfaces it supports, how it gates/times/tears down, where the predictability rules live, and how width/resize is controlled.
4. Designs the `recorded-agent` cassette format + `record.ts` (record at the Runner boundary through the existing normalised `onEvent` tap, §5.4), while preserving raw parser contract tests at the runner layer.
5. Lays out the directory move and the `package.json` script ladder (§7, §8), including project-level compatibility so non-two-pane tests remain in `test`/`check`.
6. Sequences the migration as PRs (§10.4), starting with the typed app/driver tracer, then the cassette tracer, then feature-area migrations with ledger + delete-in-same-PR.
7. Specifies the scenario metadata + overlap report and the feature-area migration ledger.
8. Updates `docs/testing-strategy.md` (canonical), CLAUDE.md (run guidance + bare-`bun test` guidance or enforcement), README script references, and reconciles any skill docs that reference the five tiers.

### Session-equivalence checklist

If this brainstorm is accurate, a reader should come away with the same decisions as the original discussion:

- Current five-tier counts and why the distribution is not the problem.
- The problems with numbered tiers: 1-D number on a 2-D space, Tier 4 as a flag, location mismatch, sanctioned copy-paste, hand-audited coverage, overloaded doc.
- Rejected taxonomy alternatives A/B/C and why the final model combines B's decision rule with C's scenario/driver shape.
- Growth premise: the full scenario/driver system is justified because future two-pane behaviours are expected to run across multiple fidelities.
- Final ladder: `unit → model → screen → full-host`, with `full-host` split into `fake-agent`, `recorded-agent`, `real-agent`.
- Standalone categories: `lifecycle` and `tmux-argv`.
- The no-fake-tmux rule: `model` asserts at the projection seam; real tmux is required for byte assertions.
- Imperative scenario DSL, no builder pattern, with typed app surfaces rather than one lowest-common-denominator `OrchApp`.
- Pane Objects / Page Object-like layer: assert affordances, do not inline production chrome literals in scenarios.
- Path-based two-pane run scripts, no environment variables for selection, no bare `bun test` in agent workflows, and project-level scripts that preserve non-two-pane tests.
- Harness-first strangler migration, by feature area, with ledgered old-test accounting and old tests deleted in the same PR as their replacement.
- Per-feature recipe: mostly `model`/`unit`, add `screen` only for paint/resize changes, add `full-host` only for two-pane plumbing, choose fake/recorded/real by agent-dependence, add lifecycle/fault-injection only when those boundaries matter.

### Glossary
- **scenario** — a behavioural test written once as a function of `app`, run against one or more drivers.
- **driver** — supplies a typed app surface at a given fidelity (`model`/`screen`/`full-host:*`/`lifecycle`); owns gating, timeouts, teardown, predictability rules.
- **typed app surface** — the handle a scenario drives and asserts against; differs by driver family (`ModelApp`, `ScreenApp`, `FullHostApp`, `LifecycleApp`) so unsupported actions are caught by types.
- **Pane Object** — a semantic assertion surface for one pane (Page Object pattern). Owns chrome assertions backed by co-located expected literals; exposes `assertShowsContent` as the only free-string escape hatch (§6.2).
- **chrome vs content** — *chrome* is text production renders (footer hints, glyphs, labels) → Pane Object method; *content* is text the test injected (fake agent output) → inline escape hatch.
- **projection seam** — the view-model the controller emits before tmux renders it; where `model` asserts.
- **cassette** — a recorded normalised-event stream replayed by `recorded-agent`.
- **contract overlap** — the deliberate, small set of scenarios run on both a fake and the real boundary to prove the fake hasn't drifted.
- **migration ledger** — per-feature accounting table that maps old tests to new scenarios and records `port`/`merge`/`demote`/`drop` decisions.
