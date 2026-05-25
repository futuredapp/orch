// triage: keep — Tier 1 proof that interactive auto-stop closes a finished
// turn on real tmux without a human keystroke. Would FAIL (hang past the
// timeout) if the host never armed/raced the stop channel: the `cat` pane
// never exits on its own, so only the stop-signal → external-terminate path
// can resolve the workflow. We drive a real long-lived argv (`cat`) — the
// "echo runner" earlier interactive Tier 1 tests note is missing — so the
// PTY spawn is real while the agent's hook is played by the test signalling
// the stop channel directly.

import { afterEach, describe, expect, it } from 'bun:test'
import { defineRunner, type Runner, type RunnerContext } from '../../../../../src/runners/index.ts'
import { path } from '../../../../../src/services/types.ts'
import {
  canRunRealTmux,
  createRealTmuxFixture,
  type MountedHarness,
  mountTmuxHost,
  type RealTmuxFixture,
} from '../../../../helpers/real-tmux/index.ts'

const tmuxAvailable = canRunRealTmux()

let fixturesToDispose: RealTmuxFixture[] = []
let harnessesToTeardown: MountedHarness[] = []

afterEach(async () => {
  for (const h of harnessesToTeardown) await h.teardown()
  harnessesToTeardown = []
  for (const f of fixturesToDispose) await f.dispose()
  fixturesToDispose = []
})

/** A runner whose interactive command is a real long-lived binary. The pane
 *  stays alive (like an idle agent at a prompt) until orch terminates it, so a
 *  natural pane death can't masquerade as auto-stop. Supports auto-stop with a
 *  no-op preparation — the host injects the real socket/channel env. */
function longLivedRunner(argv: readonly string[]): Runner {
  return defineRunner({
    name: 'long-lived',
    supports: { interactive: true, structuredOutput: false },
    defaultView: { kind: 'transcript', pane: 'right' },
    buildCommand: (ctx: RunnerContext) => ({ argv, env: ctx.env }),
    parseEvents: () => null,
    extractStructuredOutput: () => undefined,
    toTranscriptLines: () => [],
    prepareAutoStop: async () => ({ env: {}, cleanup: async () => {} }),
  })
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function readLifecycle(
  fixture: RealTmuxFixture,
  harness: MountedHarness,
): Promise<Array<Record<string, unknown>>> {
  const dir = harness.logger.logsDir
  if (dir === null) return []
  const file = path(`${dir}/lifecycle.ndjson`)
  if (!(await fixture.fs.exists(file))) return []
  const text = await fixture.fs.readFile(file)
  return text
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

async function waitForLifecycle(
  fixture: RealTmuxFixture,
  harness: MountedHarness,
  predicate: (e: Record<string, unknown>) => boolean,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = (await readLifecycle(fixture, harness)).find(predicate)
    if (found) return found
    await delay(50)
  }
  throw new Error('timed out waiting for the expected lifecycle event')
}

describe.skipIf(!tmuxAvailable)('Tier 1 — interactive auto-stop', () => {
  it('closes itself when the stop channel is signaled, with no manual close', async () => {
    const fixture = await createRealTmuxFixture({ env: {} })
    fixturesToDispose.push(fixture)
    const harness = await mountTmuxHost(fixture, { disableStepsView: true })
    harnessesToTeardown.push(harness)

    const agent = longLivedRunner(['cat'])
    const runPromise = harness.runWorkflow([
      { name: 'brainstorm', agent, mode: 'interactive', autoStop: true },
    ])

    // Wait until orch has armed the race (it is now blocked on the channel).
    const armed = await waitForLifecycle(
      fixture,
      harness,
      (e) => e.type === 'interactive-auto-stop-armed',
      8000,
    )
    expect(armed.channel).toBe('auto-stop-brainstorm')

    // Play the agent hook's role: signal turn completion on the stop channel.
    await fixture.tmux.signalChannel({ socket: fixture.socket, channel: armed.channel as string })

    const result = await runPromise
    expect(result.completed).toBe(true)
  }, 20_000)

  it('records armed → signaled → terminated lifecycle events in order', async () => {
    const fixture = await createRealTmuxFixture({ env: {} })
    fixturesToDispose.push(fixture)
    const harness = await mountTmuxHost(fixture, { disableStepsView: true })
    harnessesToTeardown.push(harness)

    const agent = longLivedRunner(['cat'])
    const runPromise = harness.runWorkflow([
      { name: 'brainstorm', agent, mode: 'interactive', autoStop: true },
    ])

    const armed = await waitForLifecycle(
      fixture,
      harness,
      (e) => e.type === 'interactive-auto-stop-armed',
      8000,
    )
    await fixture.tmux.signalChannel({ socket: fixture.socket, channel: armed.channel as string })
    await runPromise

    const types = (await readLifecycle(fixture, harness)).map((e) => e.type)
    const armedAt = types.indexOf('interactive-auto-stop-armed')
    const signaledAt = types.indexOf('interactive-auto-stop-signaled')
    const terminatedAt = types.indexOf('interactive-auto-stop-terminated')
    expect(armedAt).toBeGreaterThanOrEqual(0)
    expect(signaledAt).toBeGreaterThan(armedAt)
    expect(terminatedAt).toBeGreaterThan(signaledAt)
  }, 20_000)

  it('a step without autoStop never arms and ignores a stop-channel signal', async () => {
    const fixture = await createRealTmuxFixture({ env: {} })
    fixturesToDispose.push(fixture)
    const harness = await mountTmuxHost(fixture, { disableStepsView: true })
    harnessesToTeardown.push(harness)

    const agent = longLivedRunner(['cat'])
    const runPromise = harness.runWorkflow([{ name: 'brainstorm', agent, mode: 'interactive' }])

    // The non-autoStop path waits on pane-exit only; once that wait starts the
    // pane is up and orch is blocked on it.
    await waitForLifecycle(fixture, harness, (e) => e.type === 'interactive-wait-start', 8000)

    const types = (await readLifecycle(fixture, harness)).map((e) => e.type)
    expect(types).not.toContain('interactive-auto-stop-armed')

    // Signal the channel orch never armed — a no-op for this step.
    await fixture.tmux.signalChannel({ socket: fixture.socket, channel: 'auto-stop-brainstorm' })

    const outcome = await Promise.race([
      runPromise.then(() => 'completed' as const),
      delay(800).then(() => 'still-running' as const),
    ])
    expect(outcome).toBe('still-running')

    // Clean up: close the cat pane (EOF) so the workflow can finish.
    const rightId = await harness.right.paneId
    await harness.sendKeysToPaneId(rightId, '\u0004')
    const result = await runPromise
    expect(result.completed).toBe(true)
  }, 20_000)
})
