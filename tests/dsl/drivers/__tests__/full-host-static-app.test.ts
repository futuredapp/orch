import { describe, expect, it } from 'bun:test'
import type {
  HarnessStep,
  MountedHarness,
  PaneHandle,
  RealTmuxFixture,
  RunWorkflowResult,
} from '@orch/test/real-tmux/index.ts'
import type { Runner } from '../../../../src/runners/index.ts'
import { FakeRunner } from '../../../../src/runners/index.ts'
import { FakeProcessService } from '../../../../src/services/index.ts'
import type { FullHostSpec } from '../../app-surfaces.ts'
import { createStaticFullHostApp } from '../full-host-static-app.ts'

// Driver-level contract test for the W1 spec→descriptor passthrough (parent
// U9/W1). Pure unit: a spy `runWorkflow` captures the step descriptors the
// shared static engine builds, so NO tmux boots. It proves `mode`/`autoStop`
// ride through to `runWorkflow` when the spec sets them (unblocking the
// auto-stop real-agent smoke, W2) and are ABSENT when omitted — the byte-for-byte
// guarantee that existing fake/recorded scenarios are unaffected (risk R1).

const fakeAgent = (): Runner => new FakeRunner(new FakeProcessService())

/** A spy harness whose `runWorkflow` records the descriptors it is handed. */
function spyHarness(): { harness: MountedHarness; captured: () => readonly HarnessStep[] } {
  let seen: readonly HarnessStep[] = []
  // Only `left`/`right`/`sendKeys`/`runWorkflow`/`teardown` are exercised by the
  // static engine; the rest of MountedHarness is never reached on this path.
  const harness = {
    left: {} as PaneHandle,
    right: {} as PaneHandle,
    sendKeys: async (): Promise<void> => {},
    runWorkflow: async (steps: readonly HarnessStep[]): Promise<RunWorkflowResult> => {
      seen = steps
      return { completed: true }
    },
    teardown: async (): Promise<void> => {},
  } as unknown as MountedHarness

  return { harness, captured: () => seen }
}

const fixture = { dispose: async (): Promise<void> => {} } as unknown as RealTmuxFixture

function buildApp(captureName?: { value: string }) {
  const { harness, captured } = spyHarness()
  const app = createStaticFullHostApp({
    fixture,
    harness,
    label: 'test',
    agentForStep: () => ({ agent: fakeAgent(), prompt: captureName?.value }),
  })
  return { app, captured }
}

describe('createStaticFullHostApp — W1 interactive/autoStop passthrough', () => {
  it('forwards mode and autoStop onto every runWorkflow step descriptor when the spec sets them', async () => {
    const { app, captured } = buildApp()

    const spec: FullHostSpec = { steps: ['plan'], mode: 'interactive', autoStop: true }
    await app.launch(spec)
    await app.teardown()

    const steps = captured()
    expect(steps).toHaveLength(1)
    expect(steps[0]?.mode).toBe('interactive')
    expect(steps[0]?.autoStop).toBe(true)
  })

  it('omits mode and autoStop from the descriptor when the spec omits them (existing scenarios unaffected)', async () => {
    const { app, captured } = buildApp()

    const spec: FullHostSpec = { steps: ['plan'] }
    await app.launch(spec)
    await app.teardown()

    const step = captured()[0]
    expect(step).toBeDefined()
    expect('mode' in (step ?? {})).toBe(false)
    expect('autoStop' in (step ?? {})).toBe(false)
  })
})
