// U10 smoke pin: every subworkflow example file loads cleanly, exports a
// WorkflowExecutor with the expected `name`, and the registry in
// `examples/orch.config.ts` resolves every entry. Then a fake-runner workflow
// exercises `runWorkflow` end-to-end to prove the primitive composes the
// subworkflows authored in the same shape the examples use.
//
// Real CLI runners stay out — each example's `step.define({agent: claude(...)})`
// builds the runner at module-evaluation time, but no `execute()` call ever
// fires here, so no subprocess is spawned. The end-to-end coverage uses a
// silent fake runner cloned from `tests/unit/core/run-workflow.test.ts`.

import { describe, expect, it } from 'bun:test'
import branchIsolated from '../../../examples/branch-isolated/index.ts'
import complexFeature from '../../../examples/complex-feature/index.ts'
import feature from '../../../examples/feature/index.ts'
import config from '../../../examples/orch.config.ts'
import parent from '../../../examples/parent/index.ts'
import shipMany from '../../../examples/ship-many/index.ts'
import shipOne from '../../../examples/ship-one/index.ts'
import simpleFeature from '../../../examples/simple-feature/index.ts'
import { runWorkflow } from '../../../src/core/run-workflow.ts'
import { step } from '../../../src/core/step.ts'
import { type StepLifecycleEvent, type WorkflowDeps, workflow } from '../../../src/core/workflow.ts'
import { defineRunner, type Runner, type RunnerContext } from '../../../src/runners/index.ts'
import {
  FakeClock,
  FakeFsService,
  FakeGitService,
  FakeProcessService,
  path,
} from '../../../src/services/index.ts'
import { FakePromptService } from '../../../src/services/prompt/index.ts'
import { FileStateStore, type RunId } from '../../../src/state/index.ts'
import { createFakeHost } from '@orch/test/fake-host.ts'

const rid = (s: string): RunId => s as RunId

function makeDeps(): WorkflowDeps {
  const fs = new FakeFsService()
  return {
    fsService: fs,
    gitService: new FakeGitService(),
    processService: new FakeProcessService(),
    clock: new FakeClock(1000),
    stateStore: new FileStateStore({ fs, basePath: path('/runs') }),
    runId: rid('r-2026-06-01-100000-aa'),
    cwd: path('/workspace'),
    host: createFakeHost(),
    promptService: new FakePromptService(),
    interactivity: 'interactive' as const,
  }
}

function silentRunner(deps: WorkflowDeps, name: string): Runner {
  const argv = [`:${name}:`] as const
  const terminal = JSON.stringify({ kind: 'terminal', type: 'turn-complete', data: 'ok' })
  for (let i = 0; i < 40; i++) {
    ;(deps.processService as FakeProcessService).when(argv).respondWith({
      stdout: [terminal],
      exitCode: 0,
    })
  }
  return defineRunner({
    name,
    supports: { interactive: false, structuredOutput: false },
    buildCommand(ctx: RunnerContext) {
      return { argv: [...argv], env: ctx.env }
    },
    parseEvents(line: string) {
      if (line.trim() === '') return null
      return JSON.parse(line)
    },
    extractStructuredOutput() {
      return 'ok'
    },
    toTranscriptLines() {
      return []
    },
  })
}

function lifecycleEvents(deps: WorkflowDeps): readonly StepLifecycleEvent[] {
  const host = deps.host as ReturnType<typeof createFakeHost>
  return host.recorded
    .filter((r): r is { kind: 'lifecycle'; event: StepLifecycleEvent } => r.kind === 'lifecycle')
    .map((r) => r.event)
}

describe('subworkflow examples — module load + registry shape', () => {
  it('each example exports a default WorkflowExecutor with the expected name', () => {
    expect(feature.name).toBe('feature')
    expect(simpleFeature.name).toBe('simple-feature')
    expect(complexFeature.name).toBe('complex-feature')
    expect(parent.name).toBe('parent')
    expect(branchIsolated.name).toBe('branch-isolated')
    expect(shipMany.name).toBe('ship-many')
    expect(shipOne.name).toBe('ship-one')
  })

  it('every subworkflow example is registered in examples/orch.config.ts', () => {
    const expected = [
      'feature',
      'simple-feature',
      'complex-feature',
      'parent',
      'branch-isolated',
      'ship-many',
      'ship-one',
    ]
    for (const name of expected) {
      expect(config.workflows).toHaveProperty(name)
    }
  })

  it('each example exposes a `execute` and `resume` callable surface', () => {
    for (const ex of [
      feature,
      simpleFeature,
      complexFeature,
      parent,
      branchIsolated,
      shipMany,
      shipOne,
    ]) {
      expect(typeof ex.execute).toBe('function')
      expect(typeof ex.resume).toBe('function')
    }
  })
})

describe('subworkflow examples — runWorkflow end-to-end with fake runner', () => {
  it('parent + sub composition emits enter/exit and runs sub step under the sub-path cache key', async () => {
    const deps = makeDeps()
    const PLAN = step.define('plan', { agent: silentRunner(deps, 'r1'), prompt: 'plan-it' })

    const sub = workflow('simple-feature', async (run) => {
      await run(PLAN)
    })
    const parent = workflow('feature', async () => {
      await runWorkflow(sub, {})
    })

    await parent.execute(deps)

    const events = lifecycleEvents(deps)
    const types = events.map((e) => e.type)
    expect(types).toEqual(['subworkflow:enter', 'step:start', 'step:complete', 'subworkflow:exit'])

    // Persisted step key uses the `sub>name` form so the parent can run
    // another sub with a colliding leaf name without tripping R20.
    const persisted = await deps.stateStore.loadRun(deps.runId)
    expect(persisted?.steps['simple-feature>plan']).toBeDefined()
    expect(persisted?.steps['simple-feature>plan']?.subPath).toEqual(['simple-feature'])
  })

  it('homogeneous parallel of two distinct subs runs without tripping R20', async () => {
    const deps = makeDeps()
    const PLAN_A = step.define('plan', { agent: silentRunner(deps, 'rA'), prompt: 'A' })
    const PLAN_B = step.define('plan', { agent: silentRunner(deps, 'rB'), prompt: 'B' })

    const shipA = workflow('ship-a', async (run) => {
      await run(PLAN_A)
    })
    const shipB = workflow('ship-b', async (run) => {
      await run(PLAN_B)
    })

    const { parallel } = await import('../../../src/core/parallel.ts')

    const root = workflow('root', async () => {
      await parallel(
        [
          { name: 'shipA', sub: shipA },
          { name: 'shipB', sub: shipB },
        ],
        async (branch) => {
          await runWorkflow(branch.sub, {})
        },
      )
    })

    await root.execute(deps)

    const persisted = await deps.stateStore.loadRun(deps.runId)
    expect(persisted?.steps['ship-a>plan']).toBeDefined()
    expect(persisted?.steps['ship-b>plan']).toBeDefined()
    // Both branches' steps run inside the parallel block — projector consumes
    // this flag for R23 suppression.
    expect(persisted?.steps['ship-a>plan']?.insideParallel).toBe(true)
    expect(persisted?.steps['ship-b>plan']?.insideParallel).toBe(true)
  })
})
