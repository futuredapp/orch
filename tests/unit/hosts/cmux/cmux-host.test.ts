import { describe, expect, it } from 'bun:test'
import type { StepName } from '../../../../src/core/types.ts'
import { createCmuxHost } from '../../../../src/hosts/cmux/index.ts'
import {
  createNullSessionLogger,
  type JsonObject,
  type LogCategory,
  type SessionLogger,
} from '../../../../src/observability/index.ts'
import { FakeClock } from '../../../../src/services/clock/index.ts'
import { FakeProcessService, path } from '../../../../src/services/index.ts'

const STEP = 'plan' as StepName
const STEP2 = 'review' as StepName
const WF = 'my-wf'
const CWD = path('/tmp')
const ENV_WITH_SURFACE = { CMUX_SURFACE_ID: 'workspace1' }

// A SessionLogger that records every `append` so tests can assert the cmux gate
// outcome line. Built on the null logger so the rest of the surface stays no-op.
function capturingLogger(opts: { debug?: boolean } = {}): {
  logger: SessionLogger
  records: { category: LogCategory; record: JsonObject }[]
} {
  const records: { category: LogCategory; record: JsonObject }[] = []
  const base = createNullSessionLogger({ debug: opts.debug ?? false })
  const logger: SessionLogger = {
    ...base,
    async append(category: LogCategory, record: JsonObject): Promise<void> {
      records.push({ category, record })
    },
  }
  return { logger, records }
}

function gateOutcomes(records: { category: LogCategory; record: JsonObject }[]): unknown[] {
  return records
    .filter((r) => r.category === 'lifecycle' && r.record.type === 'cmux-host')
    .map((r) => r.record.outcome)
}

describe('createCmuxHost — probe / availability', () => {
  it('returns a no-op host with zero ProcessService calls when CMUX_SURFACE_ID is absent', async () => {
    const fps = new FakeProcessService()

    const host = await createCmuxHost({
      processService: fps,
      clock: new FakeClock(0),
      workflowName: WF,
      env: {},
      cwd: CWD,
    })

    host.onLifecycleEvent({ type: 'step:start', stepName: STEP, mode: 'autonomous' })
    await host.flush()

    expect(fps.cmuxCalls()).toHaveLength(0)
  })

  it('returns a no-op host when ping exits non-zero and fires no further cmux calls', async () => {
    const fps = new FakeProcessService()
    fps.when(['cmux', 'ping']).respondWith({ exitCode: 1 })

    const host = await createCmuxHost({
      processService: fps,
      clock: new FakeClock(0),
      workflowName: WF,
      env: ENV_WITH_SURFACE,
      cwd: CWD,
    })

    host.onLifecycleEvent({ type: 'step:start', stepName: STEP, mode: 'autonomous' })
    await host.flush()

    expect(fps.cmuxCalls()).toHaveLength(1)
    expect(fps.cmuxCalls()[0]?.argv).toEqual(['cmux', 'ping'])
  })

  it('returns a live host when CMUX_SURFACE_ID is set and ping exits 0', async () => {
    const fps = new FakeProcessService()
    fps.when(['cmux', 'ping']).respondWith({ exitCode: 0 })
    fps.when(['cmux', 'set-status', 'orch_workflow', WF]).respondWith({ exitCode: 0 })
    fps.when(['cmux', 'set-status', 'orch_step', `${STEP} · 1`]).respondWith({ exitCode: 0 })
    fps.when(['cmux', 'set-status', 'orch_runner', '']).respondWith({ exitCode: 0 })
    fps.when(['cmux', 'set-status', 'orch_mode', 'auto']).respondWith({ exitCode: 0 })

    const host = await createCmuxHost({
      processService: fps,
      clock: new FakeClock(0),
      workflowName: WF,
      env: ENV_WITH_SURFACE,
      cwd: CWD,
    })

    host.onLifecycleEvent({ type: 'step:start', stepName: STEP, mode: 'autonomous' })
    await host.flush()

    // ping + 4 set-status = 5 total cmux calls
    expect(fps.cmuxCalls()).toHaveLength(5)
    fps.assertAllConsumed()
  })

  it('returns a no-op host and skips the probe when cmux.enabled is false', async () => {
    const fps = new FakeProcessService()

    const host = await createCmuxHost({
      processService: fps,
      clock: new FakeClock(0),
      workflowName: WF,
      cmuxConfig: { enabled: false },
      env: ENV_WITH_SURFACE,
      cwd: CWD,
    })

    host.onLifecycleEvent({ type: 'step:start', stepName: STEP, mode: 'autonomous' })
    await host.flush()

    expect(fps.cmuxCalls()).toHaveLength(0)
  })
})

describe('createCmuxHost — pill lifecycle', () => {
  it('fires four cmux set-status calls with correct keys and values on the first step:start', async () => {
    const fps = new FakeProcessService()
    fps.when(['cmux', 'ping']).respondWith({ exitCode: 0 })
    fps.when(['cmux', 'set-status', 'orch_workflow', WF]).respondWith({ exitCode: 0 })
    fps.when(['cmux', 'set-status', 'orch_step', `${STEP} · 1`]).respondWith({ exitCode: 0 })
    fps.when(['cmux', 'set-status', 'orch_runner', 'claude']).respondWith({ exitCode: 0 })
    fps.when(['cmux', 'set-status', 'orch_mode', 'auto']).respondWith({ exitCode: 0 })

    const host = await createCmuxHost({
      processService: fps,
      clock: new FakeClock(0),
      workflowName: WF,
      env: ENV_WITH_SURFACE,
      cwd: CWD,
    })

    host.onLifecycleEvent({
      type: 'step:start',
      stepName: STEP,
      mode: 'autonomous',
      runnerName: 'claude',
    })
    await host.flush()

    const setCalls = fps.cmuxCalls().filter((c) => c.argv[1] === 'set-status')
    expect(setCalls).toHaveLength(4)

    const keyValuePairs = setCalls.map((c) => [c.argv[2], c.argv[3]])
    expect(keyValuePairs).toContainEqual(['orch_workflow', WF])
    expect(keyValuePairs).toContainEqual(['orch_step', `${STEP} · 1`])
    expect(keyValuePairs).toContainEqual(['orch_runner', 'claude'])
    expect(keyValuePairs).toContainEqual(['orch_mode', 'auto'])

    fps.assertAllConsumed()
  })

  it('fires eight set-status calls across two step:start events (4 per step)', async () => {
    const fps = new FakeProcessService()
    fps.when(['cmux', 'ping']).respondWith({ exitCode: 0 })

    fps.when(['cmux', 'set-status', 'orch_workflow', WF]).respondWith({ exitCode: 0 })
    fps.when(['cmux', 'set-status', 'orch_step', `${STEP} · 1`]).respondWith({ exitCode: 0 })
    fps.when(['cmux', 'set-status', 'orch_runner', 'claude']).respondWith({ exitCode: 0 })
    fps.when(['cmux', 'set-status', 'orch_mode', 'auto']).respondWith({ exitCode: 0 })

    fps.when(['cmux', 'set-status', 'orch_workflow', WF]).respondWith({ exitCode: 0 })
    fps.when(['cmux', 'set-status', 'orch_step', `${STEP2} · 2`]).respondWith({ exitCode: 0 })
    fps.when(['cmux', 'set-status', 'orch_runner', 'claude']).respondWith({ exitCode: 0 })
    fps.when(['cmux', 'set-status', 'orch_mode', 'auto']).respondWith({ exitCode: 0 })

    const host = await createCmuxHost({
      processService: fps,
      clock: new FakeClock(0),
      workflowName: WF,
      env: ENV_WITH_SURFACE,
      cwd: CWD,
    })

    host.onLifecycleEvent({
      type: 'step:start',
      stepName: STEP,
      mode: 'autonomous',
      runnerName: 'claude',
    })
    host.onLifecycleEvent({
      type: 'step:start',
      stepName: STEP2,
      mode: 'autonomous',
      runnerName: 'claude',
    })
    await host.flush()

    const setCalls = fps.cmuxCalls().filter((c) => c.argv[1] === 'set-status')
    expect(setCalls).toHaveLength(8)

    fps.assertAllConsumed()
  })

  it('uses the same orch_step key for both step transitions with incrementing counters', async () => {
    const fps = new FakeProcessService()
    fps.when(['cmux', 'ping']).respondWith({ exitCode: 0 })

    fps.when(['cmux', 'set-status', 'orch_workflow', WF]).respondWith({ exitCode: 0 })
    fps.when(['cmux', 'set-status', 'orch_step', `${STEP} · 1`]).respondWith({ exitCode: 0 })
    fps.when(['cmux', 'set-status', 'orch_runner', '']).respondWith({ exitCode: 0 })
    fps.when(['cmux', 'set-status', 'orch_mode', 'auto']).respondWith({ exitCode: 0 })

    fps.when(['cmux', 'set-status', 'orch_workflow', WF]).respondWith({ exitCode: 0 })
    fps.when(['cmux', 'set-status', 'orch_step', `${STEP2} · 2`]).respondWith({ exitCode: 0 })
    fps.when(['cmux', 'set-status', 'orch_runner', '']).respondWith({ exitCode: 0 })
    fps.when(['cmux', 'set-status', 'orch_mode', 'auto']).respondWith({ exitCode: 0 })

    const host = await createCmuxHost({
      processService: fps,
      clock: new FakeClock(0),
      workflowName: WF,
      env: ENV_WITH_SURFACE,
      cwd: CWD,
    })

    host.onLifecycleEvent({ type: 'step:start', stepName: STEP, mode: 'autonomous' })
    host.onLifecycleEvent({ type: 'step:start', stepName: STEP2, mode: 'autonomous' })
    await host.flush()

    const stepKeyCalls = fps.cmuxCalls().filter((c) => c.argv[2] === 'orch_step')
    expect(stepKeyCalls).toHaveLength(2)
    expect(stepKeyCalls[0]?.argv[3]).toBe(`${STEP} · 1`)
    expect(stepKeyCalls[1]?.argv[3]).toBe(`${STEP2} · 2`)

    fps.assertAllConsumed()
  })
})

describe('createCmuxHost — notifications', () => {
  it('fires a cmux notify call after the four set-status calls for an interactive step:start', async () => {
    const fps = new FakeProcessService()
    fps.when(['cmux', 'ping']).respondWith({ exitCode: 0 })
    fps.when(['cmux', 'set-status', 'orch_workflow', WF]).respondWith({ exitCode: 0 })
    fps.when(['cmux', 'set-status', 'orch_step', `${STEP} · 1`]).respondWith({ exitCode: 0 })
    fps.when(['cmux', 'set-status', 'orch_runner', 'claude']).respondWith({ exitCode: 0 })
    fps.when(['cmux', 'set-status', 'orch_mode', 'interactive']).respondWith({ exitCode: 0 })
    fps
      .when(['cmux', 'notify', '--title', `orch · ${WF}`, '--body', `⏸ step '${STEP}' needs you`])
      .respondWith({ exitCode: 0 })

    const host = await createCmuxHost({
      processService: fps,
      clock: new FakeClock(0),
      workflowName: WF,
      env: ENV_WITH_SURFACE,
      cwd: CWD,
    })

    host.onLifecycleEvent({
      type: 'step:start',
      stepName: STEP,
      mode: 'interactive',
      runnerName: 'claude',
    })
    await host.flush()

    const cmuxCalls = fps.cmuxCalls()
    const notifyCalls = cmuxCalls.filter((c) => c.argv[1] === 'notify')
    expect(notifyCalls).toHaveLength(1)
    expect(notifyCalls[0]?.argv).toContain(`⏸ step '${STEP}' needs you`)

    // notify appears after all four set-status calls
    const lastSetStatusIdx = cmuxCalls.reduce(
      (max, c, i) => (c.argv[1] === 'set-status' ? i : max),
      -1,
    )
    const notifyIdx = cmuxCalls.findIndex((c) => c.argv[1] === 'notify')
    expect(notifyIdx).toBeGreaterThan(lastSetStatusIdx)

    fps.assertAllConsumed()
  })

  it('does not fire a cmux notify call for an autonomous step:start', async () => {
    const fps = new FakeProcessService()
    fps.when(['cmux', 'ping']).respondWith({ exitCode: 0 })
    fps.when(['cmux', 'set-status', 'orch_workflow', WF]).respondWith({ exitCode: 0 })
    fps.when(['cmux', 'set-status', 'orch_step', `${STEP} · 1`]).respondWith({ exitCode: 0 })
    fps.when(['cmux', 'set-status', 'orch_runner', '']).respondWith({ exitCode: 0 })
    fps.when(['cmux', 'set-status', 'orch_mode', 'auto']).respondWith({ exitCode: 0 })

    const host = await createCmuxHost({
      processService: fps,
      clock: new FakeClock(0),
      workflowName: WF,
      env: ENV_WITH_SURFACE,
      cwd: CWD,
    })

    host.onLifecycleEvent({ type: 'step:start', stepName: STEP, mode: 'autonomous' })
    await host.flush()

    const notifyCalls = fps.cmuxCalls().filter((c) => c.argv[1] === 'notify')
    expect(notifyCalls).toHaveLength(0)

    fps.assertAllConsumed()
  })
})

describe('createCmuxHost — error swallowing', () => {
  it('does not throw when a cmux set-status call returns a non-zero exit code', async () => {
    const fps = new FakeProcessService()
    fps.when(['cmux', 'ping']).respondWith({ exitCode: 0 })
    fps.when(['cmux', 'set-status', 'orch_workflow', WF]).respondWith({ exitCode: 1 })
    fps.when(['cmux', 'set-status', 'orch_step', `${STEP} · 1`]).respondWith({ exitCode: 1 })
    fps.when(['cmux', 'set-status', 'orch_runner', '']).respondWith({ exitCode: 1 })
    fps.when(['cmux', 'set-status', 'orch_mode', 'auto']).respondWith({ exitCode: 1 })

    const host = await createCmuxHost({
      processService: fps,
      clock: new FakeClock(0),
      workflowName: WF,
      env: ENV_WITH_SURFACE,
      cwd: CWD,
    })

    expect(() =>
      host.onLifecycleEvent({ type: 'step:start', stepName: STEP, mode: 'autonomous' }),
    ).not.toThrow()

    await host.flush()

    expect(fps.cmuxCalls().filter((c) => c.argv[1] === 'set-status')).toHaveLength(4)
    fps.assertAllConsumed()
  })
})

describe('createCmuxHost — notifyRunEnd', () => {
  it('fires a completion notification with duration and clears all four pills on exit code 0', async () => {
    const clock = new FakeClock(0)
    const fps = new FakeProcessService()
    fps.when(['cmux', 'ping']).respondWith({ exitCode: 0 })
    fps.when(['cmux', 'set-status', 'orch_workflow', WF]).respondWith({ exitCode: 0 })
    fps.when(['cmux', 'set-status', 'orch_step', `${STEP} · 1`]).respondWith({ exitCode: 0 })
    fps.when(['cmux', 'set-status', 'orch_runner', '']).respondWith({ exitCode: 0 })
    fps.when(['cmux', 'set-status', 'orch_mode', 'auto']).respondWith({ exitCode: 0 })
    fps
      .when(['cmux', 'notify', '--title', `orch · ${WF}`, '--body', '✅ completed in 0m0s'])
      .respondWith({ exitCode: 0 })
    fps.when(['cmux', 'clear-status', 'orch_workflow']).respondWith({ exitCode: 0 })
    fps.when(['cmux', 'clear-status', 'orch_step']).respondWith({ exitCode: 0 })
    fps.when(['cmux', 'clear-status', 'orch_runner']).respondWith({ exitCode: 0 })
    fps.when(['cmux', 'clear-status', 'orch_mode']).respondWith({ exitCode: 0 })

    const host = await createCmuxHost({
      processService: fps,
      clock,
      workflowName: WF,
      env: ENV_WITH_SURFACE,
      cwd: CWD,
    })

    host.onLifecycleEvent({ type: 'step:start', stepName: STEP, mode: 'autonomous' })
    await host.notifyRunEnd(0)

    const cmuxCalls = fps.cmuxCalls()
    const notifyCall = cmuxCalls.find((c) => c.argv[1] === 'notify')
    expect(notifyCall?.argv).toContain('✅ completed in 0m0s')

    const clearCalls = cmuxCalls.filter((c) => c.argv[1] === 'clear-status')
    expect(clearCalls).toHaveLength(4)

    const clearedKeys = clearCalls.map((c) => c.argv[2])
    expect(clearedKeys).toContain('orch_workflow')
    expect(clearedKeys).toContain('orch_step')
    expect(clearedKeys).toContain('orch_runner')
    expect(clearedKeys).toContain('orch_mode')

    fps.assertAllConsumed()
  })

  it('fires a failure notification with the failing step name and clears pills on non-zero exit code', async () => {
    const fps = new FakeProcessService()
    fps.when(['cmux', 'ping']).respondWith({ exitCode: 0 })
    fps.when(['cmux', 'set-status', 'orch_workflow', WF]).respondWith({ exitCode: 0 })
    fps.when(['cmux', 'set-status', 'orch_step', `${STEP} · 1`]).respondWith({ exitCode: 0 })
    fps.when(['cmux', 'set-status', 'orch_runner', '']).respondWith({ exitCode: 0 })
    fps.when(['cmux', 'set-status', 'orch_mode', 'auto']).respondWith({ exitCode: 0 })
    fps
      .when(['cmux', 'notify', '--title', `orch · ${WF}`, '--body', `❌ failed at step '${STEP}'`])
      .respondWith({ exitCode: 0 })
    fps.when(['cmux', 'clear-status', 'orch_workflow']).respondWith({ exitCode: 0 })
    fps.when(['cmux', 'clear-status', 'orch_step']).respondWith({ exitCode: 0 })
    fps.when(['cmux', 'clear-status', 'orch_runner']).respondWith({ exitCode: 0 })
    fps.when(['cmux', 'clear-status', 'orch_mode']).respondWith({ exitCode: 0 })

    const host = await createCmuxHost({
      processService: fps,
      clock: new FakeClock(0),
      workflowName: WF,
      env: ENV_WITH_SURFACE,
      cwd: CWD,
    })

    host.onLifecycleEvent({ type: 'step:start', stepName: STEP, mode: 'autonomous' })
    host.onLifecycleEvent({
      type: 'step:failed',
      stepName: STEP,
      error: new Error('runner failed'),
    })
    await host.notifyRunEnd(1)

    const notifyCall = fps.cmuxCalls().find((c) => c.argv[1] === 'notify')
    expect(notifyCall?.argv).toContain(`❌ failed at step '${STEP}'`)

    const clearCalls = fps.cmuxCalls().filter((c) => c.argv[1] === 'clear-status')
    expect(clearCalls).toHaveLength(4)

    fps.assertAllConsumed()
  })

  it('fires a generic failure notification when no step has failed before notifyRunEnd', async () => {
    const fps = new FakeProcessService()
    fps.when(['cmux', 'ping']).respondWith({ exitCode: 0 })
    fps.when(['cmux', 'notify', '--title', `orch · ${WF}`, '--body', '❌ run failed']).respondWith({
      exitCode: 0,
    })
    fps.when(['cmux', 'clear-status', 'orch_workflow']).respondWith({ exitCode: 0 })
    fps.when(['cmux', 'clear-status', 'orch_step']).respondWith({ exitCode: 0 })
    fps.when(['cmux', 'clear-status', 'orch_runner']).respondWith({ exitCode: 0 })
    fps.when(['cmux', 'clear-status', 'orch_mode']).respondWith({ exitCode: 0 })

    const host = await createCmuxHost({
      processService: fps,
      clock: new FakeClock(0),
      workflowName: WF,
      env: ENV_WITH_SURFACE,
      cwd: CWD,
    })

    await host.notifyRunEnd(1)

    const notifyCall = fps.cmuxCalls().find((c) => c.argv[1] === 'notify')
    expect(notifyCall?.argv).toContain('❌ run failed')

    fps.assertAllConsumed()
  })
})

describe('createCmuxHost — subprocess env passthrough (regression)', () => {
  // Regression for the silent no-op bug: the real ProcessService treats `env`
  // as a full replacement, so spawning cmux with `{}` left it without a PATH
  // and the `cmux ping` probe failed with ENOENT — disabling the integration
  // in every real environment. Every cmux spawn must carry the inherited PATH.
  it('gives every cmux spawn the inherited PATH instead of an empty env', async () => {
    const PATH_VALUE = '/usr/local/bin:/usr/bin'
    const fps = new FakeProcessService()
    fps.when(['cmux', 'ping']).respondWith({ exitCode: 0 })
    fps.when(['cmux', 'set-status', 'orch_workflow', WF]).respondWith({ exitCode: 0 })
    fps.when(['cmux', 'set-status', 'orch_step', `${STEP} · 1`]).respondWith({ exitCode: 0 })
    fps.when(['cmux', 'set-status', 'orch_runner', '']).respondWith({ exitCode: 0 })
    fps.when(['cmux', 'set-status', 'orch_mode', 'auto']).respondWith({ exitCode: 0 })

    const host = await createCmuxHost({
      processService: fps,
      clock: new FakeClock(0),
      workflowName: WF,
      env: { CMUX_SURFACE_ID: 'workspace1', PATH: PATH_VALUE },
      cwd: CWD,
    })

    host.onLifecycleEvent({ type: 'step:start', stepName: STEP, mode: 'autonomous' })
    await host.flush()

    const calls = fps.cmuxCalls()
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) {
      expect(call.env.PATH).toBe(PATH_VALUE)
    }

    fps.assertAllConsumed()
  })
})

describe('createCmuxHost — gate-outcome logging', () => {
  it('records outcome "disabled-no-surface-id" when CMUX_SURFACE_ID is absent', async () => {
    const fps = new FakeProcessService()
    const { logger, records } = capturingLogger()

    await createCmuxHost({
      processService: fps,
      clock: new FakeClock(0),
      workflowName: WF,
      env: {},
      cwd: CWD,
      logger,
    })

    expect(gateOutcomes(records)).toEqual(['disabled-no-surface-id'])
  })

  it('records outcome "disabled-config" when cmux.enabled is false', async () => {
    const fps = new FakeProcessService()
    const { logger, records } = capturingLogger()

    await createCmuxHost({
      processService: fps,
      clock: new FakeClock(0),
      workflowName: WF,
      cmuxConfig: { enabled: false },
      env: ENV_WITH_SURFACE,
      cwd: CWD,
      logger,
    })

    expect(gateOutcomes(records)).toEqual(['disabled-config'])
  })

  it('records outcome "disabled-ping-failed" when the probe exits non-zero', async () => {
    const fps = new FakeProcessService()
    fps.when(['cmux', 'ping']).respondWith({ exitCode: 1 })
    const { logger, records } = capturingLogger()

    await createCmuxHost({
      processService: fps,
      clock: new FakeClock(0),
      workflowName: WF,
      env: ENV_WITH_SURFACE,
      cwd: CWD,
      logger,
    })

    expect(gateOutcomes(records)).toEqual(['disabled-ping-failed'])
  })

  it('records outcome "active" when the surface, config, and probe all pass', async () => {
    const fps = new FakeProcessService()
    fps.when(['cmux', 'ping']).respondWith({ exitCode: 0 })
    const { logger, records } = capturingLogger()

    await createCmuxHost({
      processService: fps,
      clock: new FakeClock(0),
      workflowName: WF,
      env: ENV_WITH_SURFACE,
      cwd: CWD,
      logger,
    })

    expect(gateOutcomes(records)).toEqual(['active'])
  })
})
