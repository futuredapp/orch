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

Allocates a fresh tmux socket in the reserved `orch-test-<pid>-<nonce>` namespace (decoupled from `runId`; `mountTmuxHost` threads it into `createTmuxHost`'s `socket` param so the host lands on it), a per-test `mkdtemp` state base, and the real service composition (`RealTmuxService`, `BunProcessService`, `BunFsService`, `BunClock`). Does **not** boot the orch session — that happens inside `mountTmuxHost` via `createTmuxHost`. The `orch-test-` prefix is what keeps the stale-socket preload (`tests/setup/reap-test-sockets.ts`) from ever naming — and killing — a live production `orch-r-…` server.

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
- `runPuppetWorkflow(items)` — drives a workflow of predictable-fake (scripted-fake puppet) steps, each addressable via `agent(label)`. See [Predictable fake](#predictable-fake--agentlabel--runpuppetworkflow).
- `agent(labelPath)` — per-instance handle for a predictable-fake step (distinct from the `left`/`right` pane handles). See below.
- `sendKeys(input)` / `sendKeysToPaneId(target, input)` — dispatches a named key (`Enter`, `Up`, `F`, …) or a literal string. Named keys go through tmux's named-key form; literals go through `RealTmuxService.sendKeys`. For manual typing into an interactive step, resolve the pane fresh (`await harness.right.paneId`) and target it.
- `logger`, `stateStore` — exposed for tests that want to read `.orch/state/<runId>/logs/` directly.
- `teardown()` — closes the host + logger (which kills the tmux server, reaping any live PTY child). Idempotent. Does **not** dispose the fixture.

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

### Predictable fake — `agent(label)` + `runPuppetWorkflow`

Drive a deterministic fake agent per-instance instead of scripting a `FakeRunner`. `runPuppetWorkflow(items)` runs scripted-fake **puppet** steps; each is addressed by the author's label via `agent(label)`, and driven through its control file — every step gated on a durable on-disk signal (`.ready` / `.ack`), never a pane scrape.

```ts
const fixture = await createRealTmuxFixture({ env: {} })
const harness = await mountTmuxHost(fixture, { disableStepsView: true })

const agent = harness.agent('s1')
const run = harness.runPuppetWorkflow([{ name: 's1' }]) // hold the promise; drive, then await

await agent.waitForReady()        // resolves once the instance is idle-waiting (R13)
await agent.typeAndSend('hello')  // appends a line; resolves after the instance acks it (R12)
await agent.finish()              // ends the step; the run advances
expect((await run).completed).toBe(true)
```

`PuppetWorkflowItem` is either a `PuppetStepSpec` (`{ name, as?, mode? }`) or `{ parallel: PuppetStepSpec[] }`. For parallel branches, give each a stable `as:` label so it is individually addressable (R9) — that label is the key you pass to `agent(...)`:

```ts
const a = harness.agent('a')
const b = harness.agent('b')
const run = harness.runPuppetWorkflow([
  { parallel: [{ name: 'fake', as: 'a' }, { name: 'fake', as: 'b' }] },
])
await a.waitForReady(); await b.waitForReady()
await a.typeAndSend('to-a'); await b.typeAndSend('to-b')
await a.finish(); await b.finish()
```

`agent(label)` is bound to this harness's `runId`, so two harnesses' handles never resolve each other's control files — concurrent-run isolation (R11) is structural. The handle exposes `controlPath` / `readyPath` / `renderLogPath` for direct on-disk assertions. Free-function forms `typeAndSend(handle, text)` / `finish(handle, code?)` are also exported.

#### Interactive puppet steps + manual typing (F1 / R6)

A step with `mode: 'interactive'` constructs an interactive runner — `supports.interactive` is frozen at construction, so the mode is baked into the runner per step. The two-pane host spawns it as a real PTY, it renders its own output into the pane, and it reads **both** the control file and manual stdin through one shared engine. Interactive steps cannot run inside `parallel()`, so they must be sequential items. `finish` is clean-exit only in interactive mode — a non-zero code is not propagated (the host returns exit 0).

The interactive entry has no headless transcript tee, so it writes a durable **render log** (`agent(label).renderLogPath`); `waitForRender(needle)` polls it. That is the race-free oracle for manual-typing assertions — do not scrape the pane.

```ts
const s1 = harness.agent('s1') // interactive
const s2 = harness.agent('s2') // headless
const run = harness.runPuppetWorkflow([
  { name: 's1', as: 's1', mode: 'interactive' },
  { name: 's2', as: 's2' },
])

await s1.waitForReady()
// Manual typing through a real PTY: resolve the pane fresh, type, press Enter.
const pane = await harness.right.paneId
await harness.sendKeysToPaneId(pane, 'typed-by-hand')
await harness.sendKeysToPaneId(pane, 'Enter')
await s1.waitForRender('typed-by-hand') // durable render-log oracle (R6)
await s1.finish()                        // clean exit; the run advances to s2

await s2.waitForReady()
await s2.typeAndSend('headless-line')
await s2.finish()
expect((await run).completed).toBe(true)
```

#### Leak guard (R14)

Snapshot the scripted-fake process count before a run and assert it returns to that baseline after teardown — a loud sentinel for the documented leaked-puppet scar (the entry's `ORCH_PARENT_PID` self-reap + tmux pane kill are the actual prevention):

```ts
const baseline = await scriptedFakeEntryCount()
// … run, drive, finish …
await harness.teardown()
await assertNoLeakedEntries(baseline)
```

### Skip predicates

- `canRunRealTmux(env?)` — true iff `tmux` is on PATH and `$TMUX` is unset.
- `canRunRealTmuxE2E(cli, env?)` — `canRunRealTmux()` AND the named CLI is on PATH AND `RUN_REAL_TMUX_E2E === '1'`.

## Gotchas

- **Nested tmux** — running from inside a tmux session throws immediately. The harness's own server can't isolate from the outer one. Run tests outside tmux.
- **Pane ids move** — `swap-pane` exchanges pane positions, not pane ids. The handles re-resolve each call; do not cache a `paneId` from one capture and reuse it.
- **FakeRunner argv** — `FakeRunner.buildCommand` returns argv `[':fake:', <nonce>]`. The fixture's `BunProcessService` can't spawn that; tests scripting a `FakeRunner` MUST pass a `FakeProcessService` as `agentProcessService`.
- **Interactive PTY + FakeRunner** — incompatible. The fake's argv is not a real binary, so an interactive `respawn-pane` would fail. Use an interactive **scripted-fake puppet** step (`mode: 'interactive'`) for deterministic real-PTY coverage; Tier 4 covers real CLIs.
- **Interactive output ≠ pane scrape** — interactive steps have no transcript tee. Assert on `agent(label).renderLogPath` via `waitForRender`, not `right.capture()` — pane scrapes are racy under fast teardown.
