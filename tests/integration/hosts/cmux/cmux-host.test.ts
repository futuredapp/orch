// Phase 1 acceptance tests (AT-1 through AT-12) for the cmux integration.
//
// These drive the FULL composition path — `createCmuxHost` + `createCompositeHost`
// + the real workflow executor (`workflow(...).execute(deps)`) + `FakeRunner` +
// `FakeProcessService` — exactly as production wires it in `runCmd`. The
// run-end acceptance tests (AT-4 through AT-7, AT-12) additionally drive
// `executeWithAttach` so the `beforeTeardown → notifyRunEnd` hook is exercised;
// poking `cmuxHost.onLifecycleEvent` directly would pass even if CmuxHost were
// never composed with the executor (see the acceptance-tests feasibility
// appendix).
//
// Every cmux side effect is a `processService.spawn(['cmux', ...])` call, so the
// `FakeProcessService` call history is the external observation surface. The
// harness and exact-argv scripting helpers live in `./cmux-test-support.ts`.

import { afterEach, describe, expect, it } from 'bun:test'
import { EXIT } from '../../../../src/cli/main.ts'
import { FakeProcessService } from '../../../../src/services/index.ts'
import {
  buildHarness,
  clearStatusCalls,
  notifyCalls,
  RUNNER,
  runBare,
  runViaAttach,
  type StepSpec,
  SURFACE,
  scriptInteractiveNotify,
  scriptPing,
  scriptRunEndFail,
  scriptRunEndOk,
  scriptStepPills,
  setStatusCalls,
} from './cmux-test-support.ts'

// ---------------------------------------------------------------------------
// AT-1 — First step start sets all four sidebar pills with step position
// ---------------------------------------------------------------------------

describe('AT-1 — first step sets all four sidebar pills', () => {
  let fps: FakeProcessService
  afterEach(() => fps.assertAllConsumed())

  it('fires four set-status pills for the first step with the position counter', async () => {
    const wf = 'wf'
    const steps: StepSpec[] = [
      { name: 'plan', mode: 'autonomous' },
      { name: 'review', mode: 'autonomous' },
      { name: 'build', mode: 'autonomous' },
    ]
    fps = new FakeProcessService()
    scriptPing(fps, 0)
    scriptStepPills(fps, { wf, step: 'plan', index: 1, runner: RUNNER, mode: 'autonomous' })
    scriptStepPills(fps, { wf, step: 'review', index: 2, runner: RUNNER, mode: 'autonomous' })
    scriptStepPills(fps, { wf, step: 'build', index: 3, runner: RUNNER, mode: 'autonomous' })

    const h = await buildHarness({ wf, fps, steps, surfaceId: SURFACE })
    await runBare(h, wf, steps)

    // The first four set-status calls are step 1's pills.
    const firstFour = setStatusCalls(fps).slice(0, 4)
    const pairs = firstFour.map((c) => [c.argv[2], c.argv[3]])
    expect(pairs).toContainEqual(['orch_workflow', wf])
    expect(pairs).toContainEqual(['orch_step', 'plan · 1'])
    expect(pairs).toContainEqual(['orch_runner', RUNNER])
    expect(pairs).toContainEqual(['orch_mode', 'auto'])
  })
})

// ---------------------------------------------------------------------------
// AT-2 — Step transition refreshes pills in place, not accumulating
// ---------------------------------------------------------------------------

describe('AT-2 — step transition reuses keys, no pill accumulation', () => {
  let fps: FakeProcessService
  afterEach(() => fps.assertAllConsumed())

  it('reuses orch_step key with an incremented counter and keeps four pills per step', async () => {
    const wf = 'wf'
    const steps: StepSpec[] = [
      { name: 'plan', mode: 'autonomous' },
      { name: 'review', mode: 'interactive' },
    ]
    fps = new FakeProcessService()
    scriptPing(fps, 0)
    scriptStepPills(fps, { wf, step: 'plan', index: 1, runner: RUNNER, mode: 'autonomous' })
    scriptStepPills(fps, { wf, step: 'review', index: 2, runner: RUNNER, mode: 'interactive' })
    scriptInteractiveNotify(fps, { wf, step: 'review' })
    scriptRunEndOk(fps, { wf })

    const h = await buildHarness({ wf, fps, steps, surfaceId: SURFACE })
    await runBare(h, wf, steps)

    // Eight set-status total (4 per step), no accumulation. (The run-end pill
    // clears are `clear-status`, not `set-status`, so they don't count here.)
    expect(setStatusCalls(fps)).toHaveLength(8)

    // Filter on set-status so the run-end `clear-status orch_step` is excluded.
    const stepKeyCalls = setStatusCalls(fps).filter((c) => c.argv[2] === 'orch_step')
    expect(stepKeyCalls).toHaveLength(2)
    // Same stable key, incremented position.
    expect(stepKeyCalls[0]?.argv[3]).toBe('plan · 1')
    expect(stepKeyCalls[1]?.argv[3]).toBe('review · 2')

    // Mode pill refreshed in place from auto → interactive.
    const modeCalls = setStatusCalls(fps).filter((c) => c.argv[2] === 'orch_mode')
    expect(modeCalls.map((c) => c.argv[3])).toEqual(['auto', 'interactive'])
  })
})

// ---------------------------------------------------------------------------
// AT-3 — Interactive step start fires a "needs you" notification
// ---------------------------------------------------------------------------

describe('AT-3 — interactive step fires "needs you" notification', () => {
  let fps: FakeProcessService
  afterEach(() => fps.assertAllConsumed())

  it('notifies for the interactive step and not for the autonomous step', async () => {
    const wf = 'wf'
    const steps: StepSpec[] = [
      { name: 'build', mode: 'autonomous' },
      { name: 'review', mode: 'interactive' },
    ]
    fps = new FakeProcessService()
    scriptPing(fps, 0)
    scriptStepPills(fps, { wf, step: 'build', index: 1, runner: RUNNER, mode: 'autonomous' })
    scriptStepPills(fps, { wf, step: 'review', index: 2, runner: RUNNER, mode: 'interactive' })
    scriptInteractiveNotify(fps, { wf, step: 'review' })
    scriptRunEndOk(fps, { wf })

    const h = await buildHarness({ wf, fps, steps, surfaceId: SURFACE })
    await runBare(h, wf, steps)

    // Exactly one "needs you" notify — for the interactive step, not the
    // autonomous one. (The run-end completion notify is a separate body, so we
    // filter rather than asserting the total notify count.)
    const needsYou = notifyCalls(fps).filter((c) => c.argv.some((a) => a.includes('needs you')))
    expect(needsYou).toHaveLength(1)
    expect(needsYou[0]?.argv).toContain(`⏸ step 'review' needs you`)
  })
})

// ---------------------------------------------------------------------------
// AT-4 — Successful run fires a completion notification with duration
// ---------------------------------------------------------------------------

describe('AT-4 — successful run fires completion notification', () => {
  let fps: FakeProcessService
  afterEach(() => fps.assertAllConsumed())

  it('fires a completion notify with the workflow name and duration after the run settles', async () => {
    const wf = 'wf'
    const steps: StepSpec[] = [{ name: 'plan', mode: 'autonomous' }]
    fps = new FakeProcessService()
    scriptPing(fps, 0)
    scriptStepPills(fps, { wf, step: 'plan', index: 1, runner: RUNNER, mode: 'autonomous' })
    scriptRunEndOk(fps, { wf })

    const h = await buildHarness({ wf, fps, steps, surfaceId: SURFACE })
    const code = await runViaAttach(h, wf, steps)

    expect(code).toBe(EXIT.OK)
    const notify = notifyCalls(fps)[0]
    expect(notify?.argv).toContain(`orch · ${wf}`)
    expect(notify?.argv).toContain('✅ completed in 0m0s')

    // The completion notify lands after the last set-status pill.
    const calls = fps.cmuxCalls()
    const lastSetStatus = calls.reduce((max, c, i) => (c.argv[1] === 'set-status' ? i : max), -1)
    const notifyIdx = calls.findIndex((c) => c.argv[1] === 'notify')
    expect(notifyIdx).toBeGreaterThan(lastSetStatus)
  })
})

// ---------------------------------------------------------------------------
// AT-5 — Failed run fires a failure notification with the failing step name
// ---------------------------------------------------------------------------

describe('AT-5 — failed run fires failure notification with step name', () => {
  let fps: FakeProcessService
  afterEach(() => fps.assertAllConsumed())

  it('fires a failure notify carrying the failing step name', async () => {
    const wf = 'wf'
    const steps: StepSpec[] = [{ name: 'build', mode: 'autonomous', fail: true }]
    fps = new FakeProcessService()
    scriptPing(fps, 0)
    scriptStepPills(fps, { wf, step: 'build', index: 1, runner: RUNNER, mode: 'autonomous' })
    scriptRunEndFail(fps, { wf, failedStep: 'build' })

    const h = await buildHarness({ wf, fps, steps, surfaceId: SURFACE })
    const code = await runViaAttach(h, wf, steps)

    expect(code).toBe(EXIT.STEP_FAILURE)
    const notify = notifyCalls(fps)[0]
    expect(notify?.argv).toContain(`orch · ${wf}`)
    expect(notify?.argv).toContain(`❌ failed at step 'build'`)
  })
})

// ---------------------------------------------------------------------------
// AT-6 — All sidebar pills cleared when the run ends successfully
// ---------------------------------------------------------------------------

describe('AT-6 — pills cleared on successful run end', () => {
  let fps: FakeProcessService
  afterEach(() => fps.assertAllConsumed())

  it('clears all four pill keys after the completion notify', async () => {
    const wf = 'wf'
    const steps: StepSpec[] = [{ name: 'plan', mode: 'autonomous' }]
    fps = new FakeProcessService()
    scriptPing(fps, 0)
    scriptStepPills(fps, { wf, step: 'plan', index: 1, runner: RUNNER, mode: 'autonomous' })
    scriptRunEndOk(fps, { wf })

    const h = await buildHarness({ wf, fps, steps, surfaceId: SURFACE })
    await runViaAttach(h, wf, steps)

    const clears = clearStatusCalls(fps)
    expect(clears).toHaveLength(4)
    const clearedKeys = clears.map((c) => c.argv[2])
    expect(clearedKeys).toContain('orch_workflow')
    expect(clearedKeys).toContain('orch_step')
    expect(clearedKeys).toContain('orch_runner')
    expect(clearedKeys).toContain('orch_mode')

    // Clears land after the notify.
    const calls = fps.cmuxCalls()
    const notifyIdx = calls.findIndex((c) => c.argv[1] === 'notify')
    const firstClearIdx = calls.findIndex((c) => c.argv[1] === 'clear-status')
    expect(firstClearIdx).toBeGreaterThan(notifyIdx)
  })
})

// ---------------------------------------------------------------------------
// AT-7 — All sidebar pills cleared when the run ends with a failure
// ---------------------------------------------------------------------------

describe('AT-7 — pills cleared on failed run end', () => {
  let fps: FakeProcessService
  afterEach(() => fps.assertAllConsumed())

  it('clears all four pill keys after the failure notify', async () => {
    const wf = 'wf'
    const steps: StepSpec[] = [{ name: 'build', mode: 'autonomous', fail: true }]
    fps = new FakeProcessService()
    scriptPing(fps, 0)
    scriptStepPills(fps, { wf, step: 'build', index: 1, runner: RUNNER, mode: 'autonomous' })
    scriptRunEndFail(fps, { wf, failedStep: 'build' })

    const h = await buildHarness({ wf, fps, steps, surfaceId: SURFACE })
    await runViaAttach(h, wf, steps)

    const clears = clearStatusCalls(fps)
    expect(clears).toHaveLength(4)

    const calls = fps.cmuxCalls()
    const notifyIdx = calls.findIndex((c) => c.argv[1] === 'notify')
    const firstClearIdx = calls.findIndex((c) => c.argv[1] === 'clear-status')
    expect(firstClearIdx).toBeGreaterThan(notifyIdx)
  })
})

// ---------------------------------------------------------------------------
// AT-8 — CMUX_SURFACE_ID absent means zero cmux CLI invocations
// ---------------------------------------------------------------------------

describe('AT-8 — CMUX_SURFACE_ID absent → zero cmux invocations', () => {
  let fps: FakeProcessService
  afterEach(() => fps.assertAllConsumed())

  it('makes no cmux calls and the run completes normally', async () => {
    const wf = 'wf'
    const steps: StepSpec[] = [{ name: 'plan', mode: 'autonomous' }]
    fps = new FakeProcessService()
    // No cmux responses scripted: any cmux spawn would be recorded and the
    // count assertion would fail.

    const h = await buildHarness({ wf, fps, steps /* surfaceId omitted */ })
    const { threw } = await runBare(h, wf, steps)

    expect(threw).toBe(false)
    expect(fps.cmuxCalls()).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// AT-9 — cmux unavailable at startup disables the integration
// ---------------------------------------------------------------------------

describe('AT-9 — ping fails → only the probe call, then nothing', () => {
  let fps: FakeProcessService
  afterEach(() => fps.assertAllConsumed())

  it('makes exactly one cmux call (the probe) and the run completes normally', async () => {
    const wf = 'wf'
    const steps: StepSpec[] = [{ name: 'plan', mode: 'autonomous' }]
    fps = new FakeProcessService()
    scriptPing(fps, 1)

    const h = await buildHarness({ wf, fps, steps, surfaceId: SURFACE })
    const { threw } = await runBare(h, wf, steps)

    expect(threw).toBe(false)
    expect(fps.cmuxCalls()).toHaveLength(1)
    expect(fps.cmuxCalls()[0]?.argv).toEqual(['cmux', 'ping'])
  })
})

// ---------------------------------------------------------------------------
// AT-10 — A cmux CLI failure mid-run is swallowed
// ---------------------------------------------------------------------------

describe('AT-10 — mid-run cmux failure is swallowed', () => {
  let fps: FakeProcessService
  afterEach(() => fps.assertAllConsumed())

  it('does not affect the step or run when a set-status call exits non-zero', async () => {
    const wf = 'wf'
    const steps: StepSpec[] = [
      { name: 'plan', mode: 'autonomous' },
      { name: 'work', mode: 'autonomous' },
    ]
    fps = new FakeProcessService()
    scriptPing(fps, 0)
    // First step's pills all fail (exit 1) — must be swallowed.
    scriptStepPills(fps, {
      wf,
      step: 'plan',
      index: 1,
      runner: RUNNER,
      mode: 'autonomous',
      exitCode: 1,
    })
    // Second step's pills succeed — proving the run continued past the failure.
    scriptStepPills(fps, { wf, step: 'work', index: 2, runner: RUNNER, mode: 'autonomous' })

    const h = await buildHarness({ wf, fps, steps, surfaceId: SURFACE })
    const { threw } = await runBare(h, wf, steps)

    expect(threw).toBe(false)
    expect(setStatusCalls(fps)).toHaveLength(8)
  })
})

// ---------------------------------------------------------------------------
// AT-11 — Config switch disables the integration even when env var is set
// ---------------------------------------------------------------------------

describe('AT-11 — config switch disables the integration', () => {
  let fps: FakeProcessService
  afterEach(() => fps.assertAllConsumed())

  it('makes zero cmux calls (including no probe) when cmux.enabled is false', async () => {
    const wf = 'wf'
    const steps: StepSpec[] = [{ name: 'plan', mode: 'autonomous' }]
    fps = new FakeProcessService()
    // No cmux responses scripted.

    const h = await buildHarness({ wf, fps, steps, surfaceId: SURFACE, cmuxEnabled: false })
    const { threw } = await runBare(h, wf, steps)

    expect(threw).toBe(false)
    expect(fps.cmuxCalls()).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// AT-12 — Notification identifies the specific workflow
// ---------------------------------------------------------------------------

describe('AT-12 — completion notification identifies the specific workflow', () => {
  let fpsA: FakeProcessService
  let fpsB: FakeProcessService
  afterEach(() => {
    fpsA.assertAllConsumed()
    fpsB.assertAllConsumed()
  })

  it('carries each run its own workflow name and nothing from the other run', async () => {
    const steps: StepSpec[] = [{ name: 'plan', mode: 'autonomous' }]

    fpsA = new FakeProcessService()
    scriptPing(fpsA, 0)
    scriptStepPills(fpsA, {
      wf: 'lint-fix',
      step: 'plan',
      index: 1,
      runner: RUNNER,
      mode: 'autonomous',
    })
    scriptRunEndOk(fpsA, { wf: 'lint-fix' })

    fpsB = new FakeProcessService()
    scriptPing(fpsB, 0)
    scriptStepPills(fpsB, {
      wf: 'code-review',
      step: 'plan',
      index: 1,
      runner: RUNNER,
      mode: 'autonomous',
    })
    scriptRunEndOk(fpsB, { wf: 'code-review' })

    const hA = await buildHarness({ wf: 'lint-fix', fps: fpsA, steps, surfaceId: SURFACE })
    await runViaAttach(hA, 'lint-fix', steps)

    const hB = await buildHarness({ wf: 'code-review', fps: fpsB, steps, surfaceId: SURFACE })
    await runViaAttach(hB, 'code-review', steps)

    const notifyA = notifyCalls(fpsA)[0]?.argv.join(' ') ?? ''
    const notifyB = notifyCalls(fpsB)[0]?.argv.join(' ') ?? ''

    expect(notifyA).toContain('lint-fix')
    expect(notifyA).not.toContain('code-review')
    expect(notifyB).toContain('code-review')
    expect(notifyB).not.toContain('lint-fix')
  })
})

// ---------------------------------------------------------------------------
// AT-13 — Run end propagates to cmux when the workflow settles, not at teardown
// ---------------------------------------------------------------------------
//
// Regression for the stale-pill bug (run r-2026-06-07-200714-8t): a completed
// two-pane run kept the TUI mounted on its "run completed · q to quit" summary,
// so `beforeTeardown → notifyRunEnd` did not fire until the user pressed `q`.
// In the meantime cmux still advertised the last interactive step
// ("⏸ needs you", `interactive`, `ask:confirm · 3`). The run-end signal must
// reach cmux the moment the workflow settles — driven purely by the executor,
// independent of host teardown or the foreground attach being dismissed.
//
// `runBare` drives the executor + composite host only — NO `executeWithAttach`,
// NO `beforeTeardown` hook. So these tests fail unless run-end is fanned through
// `host.onLifecycleEvent`, exactly the production gap.

describe('AT-13 — successful run end propagates to cmux when the workflow settles', () => {
  let fps: FakeProcessService
  afterEach(() => fps.assertAllConsumed())

  it('fires the completion notify and clears every pill on settle, with no teardown hook', async () => {
    const wf = 'wf'
    const steps: StepSpec[] = [{ name: 'plan', mode: 'autonomous' }]
    fps = new FakeProcessService()
    scriptPing(fps, 0)
    scriptStepPills(fps, { wf, step: 'plan', index: 1, runner: RUNNER, mode: 'autonomous' })
    scriptRunEndOk(fps, { wf })

    const h = await buildHarness({ wf, fps, steps, surfaceId: SURFACE })
    const { threw } = await runBare(h, wf, steps)

    expect(threw).toBe(false)
    const notify = notifyCalls(fps)[0]
    expect(notify?.argv).toContain(`orch · ${wf}`)
    expect(notify?.argv).toContain('✅ completed in 0m0s')
    expect(clearStatusCalls(fps)).toHaveLength(4)
  })
})

// ---------------------------------------------------------------------------
// AT-14 — Failed run end propagates to cmux when the workflow settles
// ---------------------------------------------------------------------------
//
// Symmetric to AT-13 for the failure path: when a step fails the executor
// re-throws, and the failure notify + pill clears must still reach cmux the
// moment the run settles — driven by the executor (`run:ended` with a
// non-`completed` status), not deferred to host teardown.

describe('AT-14 — failed run end propagates to cmux when the workflow settles', () => {
  let fps: FakeProcessService
  afterEach(() => fps.assertAllConsumed())

  it('fires the failure notify with the step name and clears every pill on settle', async () => {
    const wf = 'wf'
    const steps: StepSpec[] = [{ name: 'build', mode: 'autonomous', fail: true }]
    fps = new FakeProcessService()
    scriptPing(fps, 0)
    scriptStepPills(fps, { wf, step: 'build', index: 1, runner: RUNNER, mode: 'autonomous' })
    scriptRunEndFail(fps, { wf, failedStep: 'build' })

    const h = await buildHarness({ wf, fps, steps, surfaceId: SURFACE })
    const { threw } = await runBare(h, wf, steps)

    expect(threw).toBe(true)
    const notify = notifyCalls(fps)[0]
    expect(notify?.argv).toContain(`orch · ${wf}`)
    expect(notify?.argv).toContain(`❌ failed at step 'build'`)
    expect(clearStatusCalls(fps)).toHaveLength(4)
  })
})
