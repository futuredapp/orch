# `tests/helpers/real-tmux/` — the real-tmux test harness

Reusable fixture for Tier 1 and Tier 4 two-pane tests. Boots an isolated tmux server, mounts a real `TmuxHost`, and exposes typed handles for the left and right panes plus a workflow driver with a per-step agent slot.

Read [`docs/testing-strategy.md`](../../../docs/testing-strategy.md) first for the tier model and the triage rule. This README is the API surface.

## Quick start — Tier 1 test

```ts
import { afterEach, describe, expect, it } from 'bun:test'
import { FakeRunner } from '../../../../src/runners/index.ts'
import { FakeProcessService } from '../../../../src/services/process/fake-process-service.ts'
import {
  canRunRealTmux,
  createRealTmuxFixture,
  type MountedHarness,
  mountTmuxHost,
  type RealTmuxFixture,
} from '../../helpers/real-tmux/index.ts'

const tmuxAvailable = canRunRealTmux()

let fixturesToDispose: RealTmuxFixture[] = []
let harnessesToTeardown: MountedHarness[] = []

afterEach(async () => {
  for (const h of harnessesToTeardown) await h.teardown()
  harnessesToTeardown = []
  for (const f of fixturesToDispose) await f.dispose()
  fixturesToDispose = []
})

describe.skipIf(!tmuxAvailable)('Tier 1 — <bug class>', () => {
  it('<visible outcome>', async () => {
    const fixture = await createRealTmuxFixture({ env: {} })
    fixturesToDispose.push(fixture)
    const fps = new FakeProcessService()
    const harness = await mountTmuxHost(fixture, { disableStepsView: true, agentProcessService: fps })
    harnessesToTeardown.push(harness)

    const agent = new FakeRunner(fps)
    agent.script({ events: [{ kind: 'info', type: 'assistant', payload: { text: 'hello' } }], structuredOutput: 'ok' })

    const run = await harness.runWorkflow([{ name: 'plan', agent }])
    expect(run.completed).toBe(true)
    await harness.right.waitForText('hello', { timeoutMs: 3000 })
  }, 15_000)
})
```

## Quick start — Tier 4 promotion

Same body. Swap the agent slot and the skip predicate.

```ts
import { canRunRealTmuxE2E } from '../../helpers/real-tmux/index.ts'
import { claude } from '../../../src/runners/index.ts'

describe.skipIf(!canRunRealTmuxE2E('claude'))('Tier 4 — <bug class>', () => {
  it('<visible outcome>', async () => {
    const fixture = await createRealTmuxFixture({ env: {} })
    fixturesToDispose.push(fixture)
    const harness = await mountTmuxHost(fixture, { disableStepsView: false })
    harnessesToTeardown.push(harness)

    const result = await harness.runWorkflow([{ name: 'plan', agent: claude(), prompt: 'say hi' }])
    expect(result.completed).toBe(true)
    await harness.right.waitForText('hi', { timeoutMs: 30_000 })
  }, 120_000)
})
```

## API surface

### `createRealTmuxFixture(opts?) → RealTmuxFixture`

Allocates a fresh tmux socket (`orch-${runId}` so `createTmuxHost` lands on it), a per-test `mkdtemp` state base, and the real service composition (`RealTmuxService`, `BunProcessService`, `BunFsService`, `BunClock`). Does **not** boot the orch session — that happens inside `mountTmuxHost` via `createTmuxHost`.

Options:

| Option | Default | When to override |
| --- | --- | --- |
| `runId` | `generateRunId({ clock })` | Reproducing a specific run-id in a regression test. |
| `stateBase` | `mkdtemp(tmpdir()/orch-harness-)` | Sharing a state base across sub-tests (rare). |
| `width`, `height` | `200 × 50` | Asserting on width-dependent layouts. |
| `env` | `process.env` | Tests pass `{}` to bypass the nested-tmux guard in CI; pass `{ TMUX: '/...' }` to exercise the guard. |

The fixture must be disposed (`await fixture.dispose()`) — typically in `afterEach`. Disposal is idempotent.

### `mountTmuxHost(fixture, opts?) → MountedHarness`

Composes `createTmuxHost(...)` against the fixture's services. Returns:

- `host` — the live `Host` port.
- `left`, `right` — `PaneHandle` for each visible pane. Pane ids are resolved dynamically on every capture — `swap-pane` operations change which pane id occupies the slot, and the handle follows.
- `runWorkflow(steps)` — drives an actual workflow body through `workflow(...).execute(deps)` with each step's `agent: Runner` slot wired in.
- `sendKeys(input)` / `sendKeysToPaneId(target, input)` — dispatches a named key (`Enter`, `Up`, `F`, …) or a literal string. Named keys go through tmux's named-key form; literals go through `RealTmuxService.sendKeys`.
- `logger`, `stateStore` — exposed for tests that want to read `.orch/state/<runId>/logs/` directly.
- `teardown()` — closes the host + logger. Idempotent. Does **not** dispose the fixture.

Options:

| Option | Default | When to override |
| --- | --- | --- |
| `workflowName` | `'harness-workflow'` | Asserting on the workflow name in the steps-view header. |
| `disableStepsView` | `false` | Tier 1 right-pane-only tests: skip the steps-view daemon so the left pane stays a `cat` placeholder. |
| `agentProcessService` | `fixture.processService` | Tier 1: pass a `FakeProcessService` so `FakeRunner.script(...)` argv stubs apply. Tier 4: omit so `BunProcessService` actually spawns the CLI. |
| `transcriptRenderer` | `undefined` | Right-pane-controller's transcript formatter on Enter-to-inspect. |

### `PaneHandle`

```ts
interface PaneHandle {
  readonly paneId: Promise<PaneId>     // resolves to the pane id currently in this slot
  capture(): Promise<string>           // ANSI-stripped visible text
  captureRaw(): Promise<string>        // raw bytes (escape sequences preserved)
  waitForText(needle, { timeoutMs }): Promise<void>
  waitFor(predicate, { timeoutMs }): Promise<void>
}
```

`waitForText` rejects with an error containing the last captured frame if the timeout elapses — diagnostic context lives on the error message, not in test logs.

### Skip predicates

- `canRunRealTmux(env?)` — true iff `tmux` is on PATH and `$TMUX` is unset.
- `canRunRealTmuxE2E(cli, env?)` — `canRunRealTmux()` AND the named CLI is on PATH AND `RUN_REAL_TMUX_E2E === '1'`.

## Gotchas

- **Nested tmux** — running from inside a tmux session throws immediately. The harness's own server can't isolate from the outer one. Run tests outside tmux.
- **Pane ids move** — `swap-pane` exchanges pane positions, not pane ids. The handles re-resolve each call; do not cache a `paneId` from one capture and reuse it.
- **FakeRunner argv** — `FakeRunner.buildCommand` returns argv `[':fake:', <nonce>]`. The fixture's `BunProcessService` can't spawn that; tests scripting a `FakeRunner` MUST pass a `FakeProcessService` as `agentProcessService`.
- **Interactive PTY + FakeRunner** — incompatible. The fake's argv is not a real binary, so an interactive `respawn-pane` would fail. Tier 4 covers real PTY behavior.
