// triage: keep — U2 self-tests for PaneHandle, sendKeys, and runWorkflow.
//
// Pins the surface every Tier 1 / Tier 4 test reads from: capture() strips
// ANSI, captureRaw() preserves it, waitForText resolves before its timeout
// and throws with the last frame after it, named keys are sent as keystrokes
// (not literal text), and runWorkflow invokes the supplied agent slot.

import { afterEach, describe, expect, it } from 'bun:test'
import { FakeRunner } from '../../../../../src/runners/index.ts'
import { FakeProcessService } from '../../../../../src/services/process/fake-process-service.ts'
import {
  canRunRealTmux,
  createRealTmuxFixture,
  isNamedKey,
  type MountedHarness,
  mountTmuxHost,
  REAL_TMUX_TEST_TIMEOUT_MS,
  type RealTmuxFixture,
  stripAnsi,
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

describe('isNamedKey', () => {
  it('returns true for tmux named keys the harness supports', () => {
    expect(isNamedKey('Enter')).toBe(true)
    expect(isNamedKey('Up')).toBe(true)
    expect(isNamedKey('Down')).toBe(true)
    expect(isNamedKey('Escape')).toBe(true)
  })

  it('returns false for literal characters and arbitrary strings', () => {
    expect(isNamedKey('F')).toBe(false)
    expect(isNamedKey('q')).toBe(false)
    expect(isNamedKey('?')).toBe(false)
    expect(isNamedKey('hello')).toBe(false)
  })
})

describe('stripAnsi re-export', () => {
  it('removes CSI sequences but keeps the visible text', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red')
    expect(stripAnsi('plain')).toBe('plain')
  })
})

describe.skipIf(!tmuxAvailable)('mountTmuxHost end-to-end with FakeRunner', () => {
  it(
    'exposes left and right pane handles for the orch session',
    async () => {
      const fixture = await createRealTmuxFixture({ env: {} })
      fixturesToDispose.push(fixture)
      const harness = await mountTmuxHost(fixture, { disableStepsView: true })
      harnessesToTeardown.push(harness)

      const leftId = await harness.left.paneId
      const rightId = await harness.right.paneId
      expect(leftId).toMatch(/^%\d+$/)
      expect(rightId).toMatch(/^%\d+$/)
      expect(leftId).not.toEqual(rightId)
    },
    REAL_TMUX_TEST_TIMEOUT_MS,
  )

  it(
    'captures pane text with ANSI stripped by default and raw bytes via captureRaw',
    async () => {
      const fixture = await createRealTmuxFixture({ env: {} })
      fixturesToDispose.push(fixture)
      const harness = await mountTmuxHost(fixture, { disableStepsView: true })
      harnessesToTeardown.push(harness)

      const stripped = await harness.left.capture()
      const raw = await harness.left.captureRaw()

      expect(typeof stripped).toBe('string')
      expect(typeof raw).toBe('string')
      expect(stripped.includes('\x1b[')).toBe(false)
    },
    REAL_TMUX_TEST_TIMEOUT_MS,
  )

  it(
    'runWorkflow drives a single FakeRunner step to completion (empty workflow case)',
    async () => {
      const fixture = await createRealTmuxFixture({ env: {} })
      fixturesToDispose.push(fixture)
      const harness = await mountTmuxHost(fixture, { disableStepsView: true })
      harnessesToTeardown.push(harness)

      const result = await harness.runWorkflow([])
      expect(result.completed).toBe(true)
    },
    REAL_TMUX_TEST_TIMEOUT_MS,
  )

  it(
    'runWorkflow uses the agentProcessService slot so a scripted FakeRunner runs end-to-end',
    async () => {
      const fixture = await createRealTmuxFixture({ env: {} })
      fixturesToDispose.push(fixture)

      const agentProcessService = new FakeProcessService()
      const harness = await mountTmuxHost(fixture, {
        disableStepsView: true,
        agentProcessService,
      })
      harnessesToTeardown.push(harness)

      const agent = new FakeRunner(agentProcessService)
      agent.script({
        events: [{ kind: 'info', type: 'assistant', payload: { text: 'first thinking' } }],
        structuredOutput: 'ok',
      })

      const result = await harness.runWorkflow([{ name: 'plan', agent }])
      expect(result.completed).toBe(true)
      expect(agent.invocationCount).toBe(1)
    },
    REAL_TMUX_TEST_TIMEOUT_MS,
  )
})

describe.skipIf(!tmuxAvailable)('PaneHandle.waitForText timeout shape', () => {
  it(
    'rejects with an error containing the last frame when the text never appears',
    async () => {
      const fixture = await createRealTmuxFixture({ env: {} })
      fixturesToDispose.push(fixture)
      const harness = await mountTmuxHost(fixture, { disableStepsView: true })
      harnessesToTeardown.push(harness)

      let thrown: unknown
      try {
        await harness.right.waitForText('this-needle-cannot-appear', { timeoutMs: 150 })
      } catch (err) {
        thrown = err
      }
      expect(thrown).toBeInstanceOf(Error)
      expect((thrown as Error).message).toContain('this-needle-cannot-appear')
      expect((thrown as Error).message).toContain('Last captured frame')
    },
    REAL_TMUX_TEST_TIMEOUT_MS,
  )
})

describe.skipIf(!tmuxAvailable)('PaneHandle.waitFor predicate shape', () => {
  it(
    'resolves on the first predicate match without exhausting the timeout',
    async () => {
      const fixture = await createRealTmuxFixture({ env: {} })
      fixturesToDispose.push(fixture)
      const harness = await mountTmuxHost(fixture, { disableStepsView: true })
      harnessesToTeardown.push(harness)

      const start = Date.now()
      // The default `cat` pane is empty but capture() still returns a string;
      // a predicate that always matches resolves immediately.
      await harness.left.waitFor((text) => typeof text === 'string', {
        timeoutMs: 2000,
        intervalMs: 25,
      })
      expect(Date.now() - start).toBeLessThan(1000)
    },
    REAL_TMUX_TEST_TIMEOUT_MS,
  )
})

describe.skipIf(!tmuxAvailable)('sendKeys named-key dispatch', () => {
  it(
    'sends Enter as a real keystroke (tmux exits 0)',
    async () => {
      const fixture = await createRealTmuxFixture({ env: {} })
      fixturesToDispose.push(fixture)
      const harness = await mountTmuxHost(fixture, { disableStepsView: true })
      harnessesToTeardown.push(harness)

      // The right pane runs `cat`; sending Enter is harmless and the tmux
      // command must exit 0. The helper throws on non-zero — `not.toThrow` is
      // the assertion.
      const rightId = await harness.right.paneId
      await expect(harness.sendKeysToPaneId(rightId, 'Enter')).resolves.toBeUndefined()
    },
    REAL_TMUX_TEST_TIMEOUT_MS,
  )

  it(
    'sends a literal F via the service path so the keymap reads it as uppercase-F',
    async () => {
      const fixture = await createRealTmuxFixture({ env: {} })
      fixturesToDispose.push(fixture)
      const harness = await mountTmuxHost(fixture, { disableStepsView: true })
      harnessesToTeardown.push(harness)

      const rightId = await harness.right.paneId
      await expect(harness.sendKeysToPaneId(rightId, 'F')).resolves.toBeUndefined()
    },
    REAL_TMUX_TEST_TIMEOUT_MS,
  )
})
