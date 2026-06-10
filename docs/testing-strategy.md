# Testing strategy — orch

This is the canonical reference for **where a test belongs** and **how to write it**. It covers the two-pane host (`src/hosts/two-pane/**`) via the scenario/driver DSL, and everything else via the unchanged three-layer model.

> **Historical note.** This supersedes the former **five-tier** model. The tiers imposed a 1-D number on a 2-D space, sanctioned copy-paste (the old "Tier 1 ↔ Tier 4" mocked+real pair), and required a hand audit to answer "which screen-tested behaviours were never proven against a real CLI?". The replacement writes each behaviour **once** as a scenario and runs it against swappable **drivers** at different fidelities. See [`docs/plans/2026-06-05-001-refactor-testing-strategy-restructure-plan.md`](plans/2026-06-05-001-refactor-testing-strategy-restructure-plan.md) for the full rationale and the migration.

## The model — four layers

```
  Scenario      a plain async (app) => { ... }; Given/When/Then are await statements
     │          lists which drivers it runs on; carries metadata (feature/risk/overlapGroup/oldTestRefs)
     ▼
  Pane Object   LeftPane / RightPane / SystemAssertions — SEMANTIC methods backed by
     │          co-located chrome constants; driver-INDEPENDENT (same object at every fidelity)
     ▼
  Driver        one per fidelity; OWNS gating, timeouts, teardown, socket reaping,
     │          predictability rules. Scenarios never see these.
     ▼
  System        src/hosts/two-pane/** under test, at the chosen fidelity
```

A scenario calls only **semantic** Pane Object methods (plus the `assertShowsContent` content escape hatch). The Pane Object asks its **driver** for a raw capability; the driver decides what that means at its fidelity — on `model` it inspects the controller's projected view-model, on `screen`/`full-host` it captures **actual bytes off real tmux**.

## The categories and the decision rule

This replaces "when to write at which tier." The single question:

> **Is the risk in *what the controller decides to show*, or in *whether those bytes reach the real screen*, or in *process behaviour*?**

| The risk is… | Category | Boots tmux? | Example |
| --- | --- | --- | --- |
| what the controller *decides* | `model` (the bulk) | No | footer contains quit; failed step shows ✗; selection moves on ↑↓ |
| left/steps-pane **bytes** survive real tmux | `screen` (single steps pane) | Yes | footer placement, glyph rendering, wrapping, narrow/wide widths, escapes |
| two-pane **plumbing / communication** | `full-host` (full host) | Yes | right pane not empty after `step:start`; transcript paints; source swap |
| **process** behaviour (signals, teardown) | `lifecycle` (outside-in) | Yes | SIGINT/SIGTERM/SIGHUP; attached-TTY `q`; external `tmux kill-*`; persisted status |
| adapter **argv / escaping** | `tmux-argv` (unit-speed) | No | tmux flags, escape rules, env passthrough |
| isolated class logic, fakes at `*Service` | `unit` | No | everything non-two-pane; pure projector/model logic |

Full-host **mode** is then chosen by: independent of agent content → `fake-agent`; needs *realistic* event streams → `recorded-agent`; needs the *actual binary* → `real-agent` (2–3 smokes, gated).

The **triage rule** is the north star and the migration pruning filter:

> **Would this test still pass if the visible pane were empty / wrong / unformatted? If yes, demote or delete.**

## Writing a scenario

`scenario(meta, body)` expands to **one `it()` per listed driver**, each gated/timed/torn-down by that driver. The scenario file never mentions `canRunRealTmux`, timeouts, or `afterEach`. The DSL barrel (`tests/dsl/index.ts`) is the **only** import surface — scenarios never name a driver or touch tmux.

```ts
// tests/model/follow-live--returns-to-running-step.test.ts
import { scenario } from '../dsl/index.ts'

scenario({
  name: 'pressing follow-live returns the view to the running step',
  feature: 'follow-live',
  drivers: ['model'],
  overlapGroup: 'follow-live-view-mode',     // ties this to its screen contract twin
  oldTestRefs: ['tests/integration/hosts/two-pane/tier-1/follow-live-returns-to-running-step.real.integration.test.ts'],
}, async (app) => {
  // given — a run paused with one step done and the next live
  await app.launch({ steps: ['plan', 'execute'], stopAt: 'mid-step' })

  // when — the user navigated away, then asked to follow the live step
  await app.leftPane.selectStep('plan')
  await app.leftPane.followLive()           // semantic affordance; on model it records intent, no tmux

  // then — the controller re-selects the live step (decision, not bytes)
  await app.leftPane.assertStepSelected('execute')
})
```

The typed `app` surface is **driver-specific**: a `['model']` scenario cannot call `app.rightPane`; a `['screen']` scenario *can* call `app.resize`; a `['lifecycle']` scenario *can* call `app.press`/`app.signal`; a `['model','screen']` scenario is typed to only the **shared** `leftPane` surface. Unsupported actions are a **compile error** — `tests/` is in the `tsconfig` `include`, so `bun run typecheck` enforces it. The `?.` idiom is therefore **banned in scenarios**: reaching for a key absent on the chosen driver signals the wrong category.

The full-host **agent slot** is declared with a fidelity-independent spec: `emits(...texts)` (static), `live()`/`holdsOpen()` (the scriptedFake live submode, requires `liveDriven: true`), `fromCassette(file)` (recorded replay), `claudeAgent(prompt)`/`codexAgent(prompt)` (the real binary).

```ts
// tests/full-host/recorded-agent/claude-plan-then-work.test.ts
import { fromCassette, scenario } from '../../dsl/index.ts'

scenario({
  name: 'a recorded Claude plan→work run paints its transcript in the right pane',
  feature: 'transcript-rendering',
  drivers: ['full-host:recorded-agent'],
  oldTestRefs: [],
}, async (app) => {
  await app.launch({ steps: ['plan'], agent: fromCassette('claude-plan-then-work.json') })
  await app.complete('plan')
  await app.rightPane.assertShowsContent('plan recorded')   // content the cassette authored → escape hatch
})
```

`tmux-argv` is **not** a `scenario()` — it is a plain unit test of `RealTmuxService` argv against `FakeProcessService`, living in the taxonomy as a category that runs at unit speed:

```ts
// tests/tmux-argv/send-keys--escapes-metacharacters.test.ts
import { expect, it } from 'bun:test'
import { FakeProcessService } from '../../src/services/process/fake-process-service.ts'
import { RealTmuxService } from '../../src/services/tmux/index.ts'

it('send-keys passes a metacharacter payload literally via -l', async () => {
  const fps = new FakeProcessService()
  const tmux = new RealTmuxService({ processService: fps })
  await tmux.sendKeys(paneId, '$(rm -rf /)')
  expect(fps.lastSpawn().argv).toContain('-l')   // literal mode — no shell interpretation
})
```

## Drivers and the registry (no central switch)

A driver implements `{ build(meta), skip(), timeout }` and is added with a new file + one line in `tests/dsl/drivers/registry.ts`. The full set is live: `model`, `screen`, `full-host:fake-agent`, `full-host:recorded-agent`, `full-host:real-agent`, `lifecycle`. **All hard-won real-tmux predictability rules live inside the driver's `build`/`teardown`** (unique socket per run, the timeout constants, hook-signal + liveness backstop, server reaping, puppet self-reap, poll-and-resend) — they are requirements on driver implementations, never on scenario authors. The drivers that own them ship with driver-level regression tests (teardown/no-orphans, timeout/polling) under `tests/dsl/drivers/__tests__/`.

The recorded and real full-host drivers **reuse** the same static full-host engine (`createStaticFullHostApp`); only the agent slot's `Runner` differs (a cassette-fed `FakeRunner`, or the real `ClaudeRunner`/`CodexRunner`). The swap *is* the promotion — there is no copy-paste.

## Pane Objects and the chrome/content rule

Expected chrome (footer hints, glyphs, labels) lives as a **co-located constant on the Pane Object**, asserted via a semantic method — **never** inline in a scenario, **never** imported from `src/`.

```ts
// tests/dsl/panes/left-pane.ts
export class LeftPane {
  private static readonly TEXT = { quitHint: 'q quit', followHint: 'f live' } as const
  constructor(private readonly driver: PaneDriver) {}

  assertQuitHintVisible() { return this.driver.assertBottomText(LeftPane.TEXT.quitHint, { count: 1 }) }
  assertStepSelected(step: string) { return this.driver.assertSelected(step) }
  // the ONLY free-string method — for content the test itself authored
  assertShowsContent(text: string) { return this.driver.assertContains(text) }
}
```

An imported production symbol on both sides of an assertion is tautological — a co-located literal is an independent specification that goes red on a production wording typo. On `screen`/`full-host` `assertBottomText` captures actual bytes off real tmux; on `model` it asserts the controller *selected* that hint.

## The two fakes: `FakeRunner` vs `scriptedFake`

Two agent doubles stand in for real Claude/Codex. They are **not** interchangeable — pick by whether the test drives the agent from *inside* or *outside* the orch process.

| | `FakeRunner` | `scriptedFake` / `ScriptedFakeRunner` |
| --- | --- | --- |
| Lives in | `src/runners/fake/` — public barrel `src/runners/index.ts` | `src/runners/scripted-fake/` — dev-only deep import, deliberately *not* in the public barrel |
| Process boundary | In-process; shares the test's JS context | Subprocess; orch spawns it as a child |
| Script binding | `new FakeRunner(fps).script({ events, structuredOutput, failWith, sessionId })` | JSON file at `ORCH_LIFECYCLE_SCRIPT`, indexed per step |
| External driving | None — the whole script is fixed at construction | Yes — a driver appends NDJSON commands, gating on `.ready` + per-command `.ack` |
| Used by | `model`, the static `full-host:fake-agent` default, `recorded-agent` replay, unit + mocked-integration | the `full-host:fake-agent` **live** submode, the `lifecycle` driver, and the `orch-qa-engineer` skill |

**`FakeRunner` is the default.** Reach for `scriptedFake` (the `live()`/`holdsOpen()` specs, `liveDriven: true`) **only when something outside the orch process must drive a live run step-by-step** — e.g. interleaving agent output with a keypress mid-stream. It is **not** a flakiness remedy: for a script known at write time `FakeRunner` is already fully deterministic and faster.

## Recorded-agent cassettes

A cassette captures the Runner's **normalised `RunnerEvent` stream** (via the existing `onEvent` tap), never raw CLI stdout — so it never re-tests the runner parser and never drifts with CLI output formatting (raw parser fixtures stay at the runner layer). The stream is split into `events: InfoEvent[]` + a single `terminal: TerminalEvent`, because `FakeRunner.script()` synthesizes its own terminal from `structuredOutput`/`failWith`. The replay shim maps the split back into a `FakeScript`; replay is the `fake-agent` engine with a different event source.

Re-record when a cassette drifts (runs a real run once through the `onEvent` tap, then `--verify` replays it CLI-free):

```sh
bun run tests/full-host/recorded-agent/record.ts --scenario claude-plan-then-work --runner claude --prompt '…'
bun run tests/full-host/recorded-agent/record.ts --scenario claude-plan-then-work --verify
```

## Predictability rules for real-tmux drivers

The tmux-booting drivers (`screen`, `full-host`, `lifecycle`) round-trip a `pane-died` hook, so they are the only place flakiness can enter. These rules live **inside the drivers** now; they were hardened after the two-pane-sequential-runs flake (2026-05-26) and the `nav.f-snaps` flake (2026-05-29):

1. **Unique socket per run** via `createRealTmuxFixture` (`tests/_support/real-tmux/`) — allocates `orch-<runId>`, wires the SIGINT/SIGTERM stale-socket reaper, asserts you are not nested inside tmux, removes the socket on `dispose()`.
2. **Use the real-tmux budgets, not Bun's 5s default** — `REAL_TMUX_TEST_TIMEOUT_MS` for the test, `REAL_TMUX_ASSERT_TIMEOUT_MS` for poll/assert waits. Both are distinct knobs; neither may be dropped.
3. **No real CLI except in `full-host:real-agent`** — the agent slot is a `FakeRunner` everywhere else.
4. **Interactive completion is hook-signal + liveness backstop**, not a bare wait — a missed `pane-died` hook resolves in ~1s via the poll, logged as `interactive-wait-hook-missed`.
5. **Reap the tmux server, not just the process** — a subprocess-spawned run boots a detached server; teardown must `kill-server` and remove the socket, or servers accumulate to the per-uid limit.
6. **Idempotent probe-driven keys poll-and-resend, not fire-and-forget** — a single `send-keys` for an idempotent key (`f` for snap-to-live, boundary nav) can be lost under contention or arrive before `useInput` subscribes. Capture the pane between keystrokes and re-press until the observed state matches.
7. **`canRunRealTmux()` is the *single* skip predicate for every real-tmux surface** — the `screen` / `full-host` / `lifecycle` drivers' `skip()` and the legacy `tests/integration/real-tmux/` describes all route through it. Gate any new tmux-booting test through `canRunRealTmux()`, **never** a raw `Bun.which('tmux')` — a raw predicate silently bypasses the PR-CI gate and fails headless (this is how `steps-view-runner` slipped the first gate, 2026-06-10). The runner needs **tmux ≥ 3.5**: `ubuntu-24.04` ships 3.4, whose `split-window` on a *detached* session fails with `size missing` ([tmux/tmux#3060](https://github.com/tmux/tmux/issues/3060)), so `pr.yml` builds a checksum-pinned 3.6b. See [`docs/issues/2026-06-10-pr-ci-real-tmux-and-env-gaps.md`](issues/2026-06-10-pr-ci-real-tmux-and-env-gaps.md).

Ink projection tests (`model` and the `<StepsView>` unit tests) drive Ink via `ink-testing-library`; never read `lastFrame()` after a fixed `setTimeout` — use the polling helpers in `tests/_support/ink-frame.ts` (`waitForFrame`, `pressUntilFrame`, `waitForIntents`) and `tests/_support/` `manual-timer` for component timers.

## Running & gating — the script ladder

Selection is **by path only**: the filesystem is the manifest. Cost levels are named by nature, never by number. **Never run bare `bun test`** — it ignores the concurrency ceiling and runs both trees unbounded (a Bun preload prints a warning).

| Moment | Command | Runs |
| --- | --- | --- |
| Tight two-pane dev loop | `bun run test:two-pane:fast` | model + tmux-argv + DSL unit tests (ms, no tmux) |
| Touched rendering / panes | `bun run test:two-pane:screen` / `:full:fake` / `:full:recorded` / `:tmux` | that bucket (seconds) |
| Touched process lifecycle | `bun run test:two-pane:lifecycle` | lifecycle (serial, `--max-concurrency=1`) |
| Pre-commit / the gate (local) | `bun run check` | everything **except** real-agent; includes `check:migration` (overlap-report + import-parity) |
| Pre-merge (PR CI) | `bun run check` with `ORCH_DISABLE_REAL_TMUX=1` | same, **minus the entire real-tmux surface** (see below) |
| Touched binary launch / re-entry | `bun run test:binary-smoke` | builds `dist/orch`, asserts boot + internal-subcommand dispatch headlessly (see "Binary smoke" below) |
| Release | `bun run check:release` | **everything** — includes `test:binary-smoke` (`preflight:release` checks `which claude codex` first) |

**PR CI deliberately runs no real tmux (AE3).** `.github/workflows/pr.yml` exports `ORCH_DISABLE_REAL_TMUX=1`, which `canRunRealTmux()` honors — so the `screen` / `full-host` / `lifecycle` drivers **and** the `tests/integration/real-tmux/` level all skip on pull requests. The fast surface (`model`, `tmux-argv`, `unit`) and the low-level tmux *ops* tests that use their own `Bun.which('tmux')` predicate (service-level `RealTmuxService`, `windows`, fixture lifecycle) still run on PR CI. Full real-tmux coverage lives on **release CI and local `bun run check`** (flag unset). Rationale and history: [`docs/issues/2026-06-10-pr-ci-real-tmux-and-env-gaps.md`](issues/2026-06-10-pr-ci-real-tmux-and-env-gaps.md).

Concurrency is **encoded as flags**, not a comment: `--max-concurrency=2` bounds the tmux pane levels; `--max-concurrency=1` makes `lifecycle` serial. `real-agent` is unreachable except by naming `test:two-pane:full:real` (gated on `tmux` + the CLI + `RUN_REAL_TMUX_E2E=1`).

## Binary smoke — testing the compiled artifact

Every category above runs under the `bun` interpreter. That means an entire
class of bugs is **structurally invisible** to them: anything that only differs
in a `bun build --compile` standalone binary, where `process.execPath` is the
`orch` binary itself (not a generic interpreter) and embedded modules resolve
under Bun's virtual FS (`/$bunfs/...`). The Homebrew left-pane crash
(`Unknown command: /$bunfs/root/steps-view-runner.tsx` → dead pane) passed the
entire green suite for exactly this reason — see
[`docs/solutions/compiled-binary-tui-launch-contract.md`](solutions/compiled-binary-tui-launch-contract.md).

`tests/binary-smoke/` closes that gap. It is **not** a `scenario()` and **not**
a two-pane category — it is a plain `bun test` that builds the real artifact and
asserts, headlessly (no tmux, no agent), only the things that can break in the
binary:

1. The runner modules do **not** self-execute at import and hijack startup
   (`--help` prints usage, not a runner's missing-args error).
2. The internal re-entry subcommands route to their runners instead of falling
   through to "Unknown command" (`__steps-view`, `__ask`).

It lives in its own directory so the path-based selection never pulls it into
the fast loop (the build adds seconds), and is gated via `bun run
test:binary-smoke` inside `check:release` — **never** on `bun run check`. To
faithfully exercise the same launch contract at unit speed, inject the binary's
two strings (`bunExecPath`, an `/$bunfs/...` `runnerScript`) through the
launchers' existing override seams and assert `argv[1]` is a command the
dispatcher recognizes (the round-trip) — not a literal argv snapshot.

For manual exercise, `scripts/orch-binary.ts` (`bun run orch:binary`) builds the
binary and execs it with whatever argv you pass (stdio inherited, so a real
terminal gives it a TTY and two-pane attaches like an installed user's); with no
args it just builds and prints the path. The smoke proves the *launch contract*,
not that the pane visually renders — that last mile needs a TTY and lives in the
real-tmux harness / the `orch-qa-engineer` skill. Methodology and rationale:
[`docs/solutions/binary-smoke-testing.md`](solutions/binary-smoke-testing.md).

## Migration tooling (`tests/_migration/`)

The `tests/_migration/` directory holds lightweight auditing tools that keep the suite honest during (and after) the old-tier migration. They run as part of `bun run check` via `check:migration`.

| Tool | What it checks |
| --- | --- |
| `overlap-report.ts` | Every scenario with an `overlapGroup` has at least one `model` AND one `screen` case in that group (the contract-overlap rule). Flags missing halves so deadline pressure can't silently skip them. |
| `import-parity.ts` | Every symbol in the DSL public barrel (`tests/dsl/index.ts`) is exported and importable — catches barrel drift when new DSL features are added. |
| `snapshot.ts` / `reconcile.ts` | Track old-tier test counts and per-scenario ledger entries; keep migration accounting visible so the "delete old tests in the same PR" rule stays enforceable. |

These tools are **not** scenario tests — they are plain scripts run via `bun run <tool>`. Their own unit tests live under `tests/_migration/__tests__/`. After the migration is complete the snapshot/reconcile tools may be retired, but overlap-report and import-parity are permanently part of the gate.

## Screen-level manual QA — the `orch-qa-engineer` skill

This is **not a driver** and **not** on `bun run check`. It drives a real two-pane tmux run against `scriptedFake` (deterministic, zero-token, no API calls), screenshots the left/right panes, advances steps, simulates a human, and writes a PASS/FAIL verdict report. Use it **only when explicitly asked** to QA / manually verify / smoke-test / reproduce two-pane TUI behaviour — a green QA session is screen-level evidence, not a regression guard. It complements the categories; it does not replace them. See [`.claude/skills/orch-qa-engineer/SKILL.md`](../.claude/skills/orch-qa-engineer/SKILL.md).

## Per-feature recipe (for all future work)

When you add or change a feature:

1. **Default everything to `model`/`unit`.** Fast, no tmux. Most of any feature.
2. **Add one `screen` test only if you changed *what paints*** (Ink rendering, layout, colours, escapes; narrow/wide widths, resize).
3. **Add one `full-host` test only if you changed *two-pane plumbing*** (agent→right pane, source swap, split). Pick the mode: independent of agent → `fake`; needs realism → `recorded`; needs the binary → `real`.
4. **Add `lifecycle` only when the real CLI boundary matters** (signals, attached TTY, external tmux verbs, teardown/orphan risk).
5. **Add fault injection** when the feature touches runner/output failure paths.
6. **Vary width/resize** in `screen` when the feature touches layout/repainting.

A typical feature PR: ~5 `model`/`unit`, 0–1 `screen`, 0–1 `full-host:fake-agent`; `recorded`/`real`/`lifecycle` only when the feature reaches those surfaces.
