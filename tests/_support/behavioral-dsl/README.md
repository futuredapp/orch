# `tests/helpers/behavioral-dsl/` — the Tier 5 behavioral DSL

Reusable fixture for Tier 5 lifecycle tests. Boots `bun src/cli/main.ts run …` as a **real subprocess** against a real tmux server, exposes the orch process's stdin/stdout/stderr and the tmux socket for external probing, and provides a flat matcher/assertion DSL for asserting on lifecycle invariants.

Read [`docs/testing-strategy.md`](../../../docs/testing-strategy.md) first for the tier model and where Tier 5 fits next to Tiers 1–4. This README is the API surface.

## When to choose Tier 5 over Tier 1

| Use Tier 1 when … | Use Tier 5 when … |
| --- | --- |
| The bug class is reachable with an in-process `TmuxHost` mount | The bug class only fires under real CLI signal handlers, attached-TTY input, or external tmux verbs (`kill-pane`, `kill-session`, `kill-server`) |
| You can drive the gesture via `FakeRunner` events | You need the actual `src/cli/main.ts` entry point and `execute-with-attach.ts:64-78` signal handlers in the picture |
| The triage rule (visible-pane content) is the load-bearing assertion | The triage rule is irrelevant — the assertion is "did orch exit cleanly," "did tmux tear down," "is `state.json` consistent" |

Tier 5 is **additive**, not a replacement. Tier 1 keeps the in-process default; Tier 5 reaches the bug class Tier 1 cannot.

## Status (W1 / phased rollout)

The DSL surface lands incrementally across plan units U1–U10:

| Unit | What ships | Status |
| --- | --- | --- |
| **U1** | This scaffold + `docs/testing-strategy.md` Tier 5 section + `LifecycleSnapshot` type + typed stubs that throw | shipped in W1 |
| **U2** | `ProcessService.spawn` `rawStreams: true` extension | shipped in W1 |
| **U3** | `ScriptedFakeRunner` + `two-step-linear` fixture | W2 |
| **U4** | `launchOrchWorkflow` + `bringToState` + `release` / `holdUntilReleased` | W2 |
| **U5** | `ExternalTmuxProbe` + `TmuxService.hasSession` / `hasServer` + mouse-event builder | W3 |
| **U6** | `LifecycleSnapshot` capture + outcome matchers + invariant contract + `assertContractViolatedThroughout` | W3 |
| **U7** | `signalOrch` action + first SIGINT-to-orch cell | W3 |
| **U8** | Pane / workflow matchers + click-to-focus / press-key actions + smoke cell | W3 |
| **U9** | The §2.1 acceptance cells (fake + codex) | W4 |
| **U10** | Ctrl-C / SIGTERM / SIGHUP / `closeOrchStdin` cells | W4 |

Calling any stub before its owning unit lands throws `not yet implemented — lands in U<N>`.

## Quick start — Tier 5 cell (target shape)

```ts
import {
  assertLeftPane,
  assertOrchExits,
  assertPersistedState,
  assertTerminalEscapeStream,
  assertTmuxSession,
  clickOnPane,
  containsText,
  exitedNormally,
  hasStatus,
  holdUntilReleased,
  isFocused,
  isRunningStep,
  launchOrchWorkflow,
  noOrphanChildren,
  pressKeyInPane,
  terminalRestoredCleanly,
  tmuxIsTornDown,
  userAction,
  withinMs,
} from '../../helpers/behavioral-dsl/index.ts'
import { canRunRealTmux } from '../../helpers/real-tmux/index.ts'

describe.skipIf(!canRunRealTmux())('lifecycle — q during fake mid-step', () => {
  it('cancels the workflow and tears down everything', async () => {
    const orch = await launchOrchWorkflow('two-step-linear', {
      script: { plan: holdUntilReleased() },
      bringToState: { kind: 'mid-step', name: 'plan' },
      mode: 'two-pane',
    })

    await assertLeftPane(isFocused(), containsText('▶ live'))
    await assertPersistedState(isRunningStep('plan'))

    await userAction(clickOnPane('left'))
    await userAction(pressKeyInPane('left', 'q'))

    await assertOrchExits(withinMs(5_000), exitedNormally())
    await assertTmuxSession(tmuxIsTornDown())
    await assertPersistedState(hasStatus('cancelled'))
    await assertTerminalEscapeStream(terminalRestoredCleanly(), noOrphanChildren())
  }, 30_000)
})
```

The body uses ONLY the public DSL barrel. Tests MUST NOT import from `./internal/*`.

## DSL public surface

All symbols live on the barrel: `import { ... } from 'tests/helpers/behavioral-dsl'`.

### Launching
- `launchOrchWorkflow(fixtureName, opts?) → Promise<OrchHandle>`
- `holdUntilReleased() → HoldUntilReleasedScript`

### User actions — `userAction(action)`
- `signalOrch('SIGINT' | 'SIGTERM' | 'SIGHUP')`
- `clickOnPane('left' | 'right')`
- `pressKeyInPane(pane, key)` — server-side via `send-keys`
- `typeIntoOrchStdin(bytes)` — via orch's piped stdin (no controlling TTY)
- `wait(ms)` — explicit, bounded
- `release(stepName)` — touches the gate file for `holdUntilReleased`
- `closeOrchStdin()` — delivers stdin-EOF (NOT real SIGHUP — see U10)

### Pane matchers — `assertLeftPane(...)` / `assertRightPane(...)`
- `containsText(needle)` / `doesNotContain(needle)`
- `isFocused()`
- `showsInkState('live' | 'viewing' | 'end-of-run' | 'error-banner')`
- `hasFooterText(text)`
- `hasNoLiveOutput()`
- `isPaneDead()`

### Workflow matchers — `assertPersistedState(...)`
- `isRunningStep(name)` / `hasStepStatus(name, status)`
- `hasStatus(status)`
- `hasExitCode(code)` / `hasExitedBySignal(signal)`

### Outcome matchers — `assertOrchExits(...)` / `assertTmuxSession(...)` / `assertTerminalEscapeStream(...)`
- `withinMs(ms)` — bounds the polling window
- `exitedNormally()`, `tmuxIsTornDown()`, `terminalRestoredCleanly()`, `noOrphanChildren()`, `stepArtifactsIntact()`

### Bulk contract assertions
- `assertContractedOutcome(scenarioTag, ...)` — polls until the §6.5 row is fully satisfied
- `assertContractViolatedThroughout(scenarioTag, ...)` — **passes when the contract is violated** (used by §2.1 cells; see warning below)

## ⚠️ `assertContractViolatedThroughout` and `__snapshots__/`

Some cells under `tests/integration/lifecycle/` use `assertContractViolatedThroughout(scenarioTag, ...)`. These cells **PASS while orch is broken** and **FAIL when orch is fixed**. The committed `LifecycleSnapshot` artifacts under `tests/integration/lifecycle/__snapshots__/` are **bug evidence**, not regression baselines.

If a future contributor sees `assertContractViolatedThroughout` fail:

1. **Do not invert the assertion** (`assertContractedOutcome` is NOT a substitute).
2. **Do not mark the cell `it.skip`**.
3. **Delete the cell.** The committed snapshot under `__snapshots__/` stays as the historical bug ticket.

This is the programmatic R-D defense from the plan. See `docs/findings/2026-05-20-lifecycle-campaign-findings.md` (when it lands in U11) for the ledger of which cells are bug-evidence and which are regression-baselines.

## Internal layout — do not import from `./internal/*`

```
tests/helpers/behavioral-dsl/
├── index.ts                 ← the ONLY file tests import from
├── launch.ts                ← launchOrchWorkflow, holdUntilReleased
├── user-actions.ts          ← userAction + action constructors
├── pane-matchers.ts
├── workflow-matchers.ts
├── outcome-matchers.ts
├── assertions.ts
├── README.md                ← this file
└── internal/                ← harness engine. NEVER imported by tests.
    ├── lifecycle-handle.ts  ← OrchHandle + spawn options
    ├── subprocess.ts        ← orch spawn via BunProcessService
    ├── external-tmux-probe.ts
    ├── mouse-events.ts
    ├── snapshot.ts          ← LifecycleSnapshot capture
    ├── invariants.ts        ← runInvariantContract
    └── workflow-fixtures.ts
```

The DSL is responsible for **readability**; the harness is responsible for **mechanism**. If a cell needs new mechanism, file the gap as a `FAIL-DSL` triage finding (plan §9 / U11) and surface the matcher on the public barrel — do not reach into `./internal/*` from a test.

## Gating

- Tier 5 cells use `skipIf(!canRunRealTmux())` (from `tests/helpers/real-tmux/index.ts`) for the fake-variant cells.
- The Codex / Claude variants under U9 use `skipIf(!canRunRealTmuxE2E('codex' | 'claude'))` for the real-CLI gate.
- Tier 5 cells run via `bun test tests/integration/lifecycle/` — they are NOT part of `bun run check`. See plan Operational Notes.

## Gotchas (carried forward as units land)

Filled in as U3–U10 ship. Today's known constraints:

- **Tmux ≥3.0 required** for `send-keys -M` SGR mouse encoding (U5). The launcher will assert `meetsMinimumTmuxVersion('3.0')` at boot.
- **Two-pane only.** The launcher hard-defaults to `mode: 'two-pane'`. Plain-mode lifecycle is explicit non-goal (plan Scope Boundaries).
