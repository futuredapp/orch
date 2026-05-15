# Testing strategy — orch

This is the canonical reference for **where a test belongs** and **how to write it** for the two-pane host (`src/hosts/two-pane/**`). Outside this surface, follow the three-layer model in [CLAUDE.md](../CLAUDE.md#how-to-write-tests) plus the [`testing-strategy` skill](../.claude/skills/testing-strategy/SKILL.md).

## The four tiers

| Tier | Bug class it catches | Where the test lives | Boots tmux? | Boots real CLI? |
| --- | --- | --- | --- | --- |
| **Tier 1** | Visible right-pane / left-pane content and view state (right pane empty after `step:start`, transcript missing on replay, follow-live drops to the wrong source, banner doesn't appear). | `tests/integration/hosts/two-pane/tier-1/*.real.integration.test.ts` | Yes | No (FakeRunner) |
| **Tier 2** | Ink projection — state→view, key→intent, footer indicators, banner rendering. | `tests/unit/hosts/two-pane/steps-view/*.test.tsx` | No | No |
| **Tier 3** | `RealTmuxService` argv contract — tmux flags, escape rules, env passthrough. | `tests/unit/services/tmux/*.test.ts` (out of two-pane audit scope) | No (`FakeProcessService`) | No |
| **Tier 4** | Real-CLI end-to-end on real tmux — exactly Tier 1's body with a real `ClaudeRunner` / `CodexRunner` in the agent slot. | `tests/e2e/tier-4/*.real.e2e.test.ts` | Yes | Yes (env-gated) |

Each tier has a unique responsibility. The "mocked + real" pair across Tier 1 and Tier 4 is the **only** sanctioned duplication: Tier 1 catches the bug class deterministically with a FakeRunner; Tier 4 proves the same body still works against the real CLI.

## The triage rule

> **Would this test still pass if the visible pane were empty / wrong / unformatted? If yes, demote or delete.**

This is the question to ask before writing a new test, and the question the audit doc (`docs/plans/2026-05-12-002-feat-tiered-testing-strategy-two-pane-audit.md`) answered for every existing two-pane test.

## When to write at which tier

- **Add a new pane-map behavior (right-pane source registers, swaps, kills)** → Tier 1.
- **Add a new keymap entry or change the footer copy** → Tier 2.
- **Add new flags to a tmux argv** → Tier 3.
- **Validate a new Claude/Codex CLI scenario end-to-end** → Tier 4.
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

## Harness API surface

See [`tests/helpers/real-tmux/README.md`](../tests/helpers/real-tmux/README.md) for the full API. The high points:

- `createRealTmuxFixture(opts)` — boots an isolated tmux server, allocates a state base, returns a disposable handle.
- `mountTmuxHost(fixture, opts)` — composes `createTmuxHost` against the fixture and exposes `left` / `right` pane handles + `runWorkflow` + `sendKeys`.
- `right.capture()` / `right.captureRaw()` — ANSI-stripped or raw bytes.
- `right.waitForText(needle, { timeoutMs })` / `right.waitFor(predicate, { timeoutMs })` — bounded polling.
- `canRunRealTmux()` / `canRunRealTmuxE2E(cli)` — skip predicates.

## Where the boundary is

- Anything Tier 1 cannot prove with a FakeRunner (real interactive PTY, real network, real argv on disk) belongs in Tier 4.
- Anything Tier 2 cannot prove with `<StepsView>` alone (controller-side state, swap ordering) belongs in Tier 1.
- Anything Tier 3 covers (argv flags, env passthrough, escape rules) **never** belongs in Tier 1 or 4 — the tmux contract is its own surface.
