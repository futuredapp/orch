# Testing strategy — orch

This is the canonical reference for **where a test belongs** and **how to write it** for the two-pane host (`src/hosts/two-pane/**`). Outside this surface, follow the three-layer model in [CLAUDE.md](../CLAUDE.md#how-to-write-tests) plus the [`testing-strategy` skill](../.claude/skills/testing-strategy/SKILL.md).

## The five tiers

| Tier | Bug class it catches | Where the test lives | Boots tmux? | Boots real CLI? |
| --- | --- | --- | --- | --- |
| **Tier 1** | Visible right-pane / left-pane content and view state (right pane empty after `step:start`, transcript missing on replay, follow-live drops to the wrong source, banner doesn't appear). | `tests/integration/hosts/two-pane/tier-1/*.real.integration.test.ts` | Yes | No (FakeRunner) |
| **Tier 2** | Ink projection — state→view, key→intent, footer indicators, banner rendering. | `tests/unit/hosts/two-pane/steps-view/*.test.tsx` | No | No |
| **Tier 3** | `RealTmuxService` argv contract — tmux flags, escape rules, env passthrough. | `tests/unit/services/tmux/*.test.ts` (out of two-pane audit scope) | No (`FakeProcessService`) | No |
| **Tier 4** | Real-CLI end-to-end on real tmux — exactly Tier 1's body with a real `ClaudeRunner` / `CodexRunner` in the agent slot. | `tests/e2e/tier-4/*.real.e2e.test.ts` | Yes | Yes (env-gated) |
| **Tier 5** | CLI signal handlers (`SIGINT` / `SIGTERM` / `SIGHUP` to the orch process), attached-TTY input (Ctrl-C / `q` typed inside tmux), external tmux verbs (`kill-pane`, `kill-session`, `kill-server`), stdin-EOF — bug classes Tier 1 cannot reach because the in-process `TmuxHost` mount never goes through `src/cli/main.ts`. | `tests/integration/lifecycle/*.real.test.ts` | Yes | No (`ScriptedFakeRunner` drives every first-batch cell). Real-CLI Tier 5 variants are deferred follow-up — the `canRunRealTmuxE2E('codex')` predicate is kept available but unused in this plan. |

Each tier has a unique responsibility. The "mocked + real" pair across Tier 1 and Tier 4 is the **only** sanctioned duplication: Tier 1 catches the bug class deterministically with a FakeRunner; Tier 4 proves the same body still works against the real CLI. Tier 5 is additive — Tier 1 stays the in-process default, and Tier 5 is reserved for the bug class Tier 1's harness mechanically cannot reach.

## The triage rule

> **Would this test still pass if the visible pane were empty / wrong / unformatted? If yes, demote or delete.**

This is the question to ask before writing a new test, and the question the audit doc (`docs/plans/2026-05-12-002-feat-tiered-testing-strategy-two-pane-audit.md`) answered for every existing two-pane test.

## When to write at which tier

- **Add a new pane-map behavior (right-pane source registers, swaps, kills)** → Tier 1.
- **Add a new keymap entry or change the footer copy** → Tier 2.
- **Add new flags to a tmux argv** → Tier 3.
- **Validate a new Claude/Codex CLI scenario end-to-end** → Tier 4.
- **Reproduce a lifecycle bug that requires real CLI signal handlers, attached-TTY input, or external `tmux kill-*` verbs** → Tier 5.
- **Refactor a Service port** → unit test on the port itself; no host tier change.

## Writing a Tier 1 test — 5-line skeleton

```ts
import { canRunRealTmux, createRealTmuxFixture, mountTmuxHost } from '../../../../helpers/real-tmux/index.ts'
import { FakeRunner } from '../../../../../src/runners/index.ts'
import { FakeProcessService } from '../../../../../src/services/process/fake-process-service.ts'

describe.skipIf(!canRunRealTmux())('Tier 1 — <bug class>', () => {
  it('<the user-visible outcome the test pins>', async () => {
    const fixture = await createRealTmuxFixture({ env: {} })
    try {
      const fps = new FakeProcessService()
      const harness = await mountTmuxHost(fixture, { disableStepsView: true, agentProcessService: fps })
      try {
        const agent = new FakeRunner(fps).script({ events: [...], structuredOutput: 'done' })
        await harness.runWorkflow([{ name: 'plan', agent }])
        await harness.right.waitForText('<expected user-visible content>')
      } finally {
        await harness.teardown()
      }
    } finally {
      await fixture.dispose()
    }
  }, 15_000)
})
```

The harness is the same shape Tier 4 uses — promotion is just swapping the agent slot and adjusting the env-gate predicate.

## Writing a Tier 2 test — 5-line skeleton

```ts
import { renderToString } from 'ink'
import { stripAnsi } from '../../../../../src/observability/index.ts'
import { StepsView } from '../../../../../src/hosts/two-pane/steps-view/index.ts'

it('renders <visible thing> for state <X>', () => {
  const frame = stripAnsi(renderToString(<StepsView state={X} onIntent={() => {}} now={() => 0} />, { columns: 110 }))
  expect(frame).toContain('<expected text>')
})
```

For keypress-driven assertions, use `ink-testing-library`'s `render()` + `stdin.write(...)` (see `tests/unit/hosts/two-pane/steps-view/key-intent-mapping.test.tsx`).

## Writing a Tier 5 test — 5-line skeleton

```ts
import {
  assertOrchExits, exitedNormally, holdUntilReleased, launchOrchWorkflow,
  pressKeyInPane, userAction, withinMs,
} from '../../helpers/behavioral-dsl/index.ts'
import { canRunRealTmux } from '../../helpers/real-tmux/fixture.ts'

describe.skipIf(!canRunRealTmux())('Tier 5 — <bug class>', () => {
  it('<the lifecycle invariant the test pins>', async () => {
    await launchOrchWorkflow('two-step-linear', {
      script: { plan: holdUntilReleased() },
      bringToState: { kind: 'mid-step', name: 'plan' },
    })
    await userAction(pressKeyInPane('left', 'q'))
    await assertOrchExits(withinMs(5_000), exitedNormally())
  }, 30_000)
})
```

The DSL barrel (`tests/helpers/behavioral-dsl/index.ts`) is the only file Tier 5 cells import from for harness functionality — `./internal/*` is off-limits to cells by convention. Read [`tests/helpers/behavioral-dsl/README.md`](../tests/helpers/behavioral-dsl/README.md) for the full DSL surface.

## DSL surface (post 2026-05-20 rename pass)

The behavioral DSL was renamed for readability after the W4 first-batch landed. Failure messages and snapshot artifacts use the **new** identifiers; older handovers and plan revisions may still reference the old names. Use this table when reading either:

| Old name | New name | Notes |
| --- | --- | --- |
| `expectInvariantViolation` | `assertContractViolatedThroughout` | The Risk R-D sentinel — passes WHILE the bug exists, fails the moment it's fixed. |
| `assertAllInvariants` | `assertContractedOutcome` | Direct contract assertion — fails WHILE the bug exists, passes when fixed. |
| `cleanly()` | `exitedNormally()` | |
| `doesNotExist()` | `tmuxIsTornDown()` | |
| `balancedEscapes()` | `terminalRestoredCleanly()` | |
| `hasIntactPerStepFiles()` | `stepArtifactsIntact()` | |
| `isInState(...)` | `showsInkState(...)` | |
| `assertTerminalState(...)` | `assertTerminalEscapeStream(...)` | |
| `assertWorkflowState(...)` | `assertPersistedState(...)` | |
| `typeInAttachTty(...)` | `typeIntoOrchStdin(...)` | |
| `closeStdin()` (DSL action) | `closeOrchStdin()` | The `SpawnHandle.closeStdin` port keeps the short name. |

The §6.5 contract table at `tests/helpers/behavioral-dsl/internal/invariants.ts` is unchanged — same matchers, new identifiers.

## Choosing the right assertion shape

Tier 5 cells pick **one of two** verbs against the §6.5 contract rows. The choice is load-bearing — it determines the cell's lifecycle on the next fix.

### `assertContractedOutcome(scenario, withinMs(...))` — permanent regression test

Polls until every matcher in the contract row passes; throws `InvariantAssertionFailure` if the budget expires with violations outstanding.

- **Today (bug present):** the cell **FAILS** in CI with the named violations (e.g. `assertContractedOutcome("pane-q-during-run") failed with 3 violation(s): exitedNormally / tmuxIsTornDown / hasStatus("cancelled")`).
- **When the bug is fixed:** the cell **PASSES**. Keep it as a permanent regression guard.
- **Use when:** you want the cell to outlive the fix and continue catching regressions.

This is what `q-during-fake-mid-step.real.test.ts` uses today.

### `assertContractViolatedThroughout(scenario, withinMs(...))` — the Risk R-D sentinel

Polls the snapshot stream; throws **immediately** if any snapshot's violation list is empty (orch reached the contracted clean state); returns success if violations persist for the full budget.

- **Today (bug present):** the cell **PASSES** — the snapshot's `violations` list is never empty, so the assertion holds throughout the budget.
- **When the bug is fixed:** the cell **FAILS** with `assertContractViolatedThroughout("…"): violation list is empty — orch reached the contracted clean state; the bug appears fixed. DELETE this cell, do not invert the assertion.`
- **Use when:** the cell exists specifically to capture *bug evidence* (the snapshot artifact under `__snapshots__/` is the deliverable). On fix, **delete** the cell + its snapshot — do NOT invert the assertion or mark `it.skip`.

The first-batch cells split: `q-during-emitting-fake-mid-step.real.test.ts` plus the three `ctrl-c-{once,twice,thrice}-in-attached-during-mid-step.real.test.ts` cells use this sentinel and must be deleted on fix; the single `q-during-fake-mid-step.real.test.ts` cell stays via `assertContractedOutcome`.

## `__snapshots__/` convention

`assertContractViolatedThroughout` optionally persists its captured violation snapshot to disk as the durable bug-evidence ticket. The artifact is keyed by `<scenario>.last.json` (e.g. `pane-q-during-run.last.json`, `attach-tty-ctrl-c.last.json`), committed under `tests/integration/lifecycle/__snapshots__/`, and referenced from the U11 findings doc.

Default test runs are **pure** — no on-disk side effects. Set the `LIFECYCLE_SNAPSHOT_DIR` env var to opt in:

```sh
LIFECYCLE_SNAPSHOT_DIR=tests/integration/lifecycle/__snapshots__ \
  bun test tests/integration/lifecycle/
```

Each cell that uses `assertContractViolatedThroughout` and is reached during the run overwrites its scenario's `.last.json` with a freshly captured snapshot. Refresh + commit the diff to update the bug-evidence ticket. On fix (sentinel cells fail and get deleted), delete the matching snapshot file too.

## Promoting Tier 1 to Tier 4

```diff
- describe.skipIf(!canRunRealTmux())('Tier 1 — autonomous-live', () => {
-   const agent = new FakeRunner(fps).script({...})
+ describe.skipIf(!canRunRealTmuxE2E('claude'))('Tier 4 — autonomous-live', () => {
+   const agent = claude()
```

Everything else — fixture boot, `mountTmuxHost`, `runWorkflow`, `right.waitForText` — stays identical.

## Gating

- **Tier 1** auto-skips when `tmux` is not on PATH (existing `Bun.which('tmux')` convention).
- **Tier 4** auto-skips unless `tmux` is on PATH **AND** the named CLI binary is on PATH **AND** `RUN_REAL_TMUX_E2E=1`. Developer-opt-in until a future PR adds a scheduled CI job.
- **Tier 5** cells auto-skip on `!canRunRealTmux()` (same as Tier 1) — every first-batch cell is `ScriptedFakeRunner`-driven, so `tmux` on PATH is the only requirement. Real-CLI Tier 5 variants are deferred follow-up; when one lands, it'll additionally require `RUN_REAL_TMUX_E2E=1` and the named CLI on PATH (same as Tier 4), via the `canRunRealTmuxE2E('codex')` / `canRunRealTmuxE2E('claude')` predicate kept available for that purpose. Tier 5 cells live under `tests/integration/lifecycle/` and are run via `bun test tests/integration/lifecycle/`; the plan's intent is to keep them off the pre-commit gate, though the current `bun test tests/unit tests/integration` script still picks them up — see plan Risk R-A for the long-term split.

## Harness API surface

See [`tests/helpers/real-tmux/README.md`](../tests/helpers/real-tmux/README.md) for the full API. The high points:

- `createRealTmuxFixture(opts)` — boots an isolated tmux server, allocates a state base, returns a disposable handle.
- `mountTmuxHost(fixture, opts)` — composes `createTmuxHost` against the fixture and exposes `left` / `right` pane handles + `runWorkflow` + `sendKeys`.
- `right.capture()` / `right.captureRaw()` — ANSI-stripped or raw bytes.
- `right.waitForText(needle, { timeoutMs })` / `right.waitFor(predicate, { timeoutMs })` — bounded polling.
- `canRunRealTmux()` / `canRunRealTmuxE2E(cli)` — skip predicates.

## Where the boundary is

- Anything Tier 1 cannot prove with a FakeRunner (real interactive PTY, real network, real argv on disk) belongs in Tier 4.
- Anything Tier 1's in-process `TmuxHost` mount cannot exercise (CLI signal handlers in `execute-with-attach.ts:64-78`, attached-TTY keypresses, external `tmux kill-*` verbs, terminal hangup) belongs in Tier 5.
- Anything Tier 2 cannot prove with `<StepsView>` alone (controller-side state, swap ordering) belongs in Tier 1.
- Anything Tier 3 covers (argv flags, env passthrough, escape rules) **never** belongs in Tier 1, 4, or 5 — the tmux contract is its own surface.
