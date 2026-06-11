// ---------------------------------------------------------------------------
// tui-playground-world — DEV-ONLY. The playground's tiny state machine: a
// mutable "world" of steps the digit hotkeys advance, projected into a
// `StepsViewState` each render. Pure functions; the Ink wiring lives in
// `tui-playground.tsx`.
// ---------------------------------------------------------------------------

import type {
  Banner,
  StepRow,
  StepStatus,
  StepsViewState,
  ViewMode,
} from '../src/hosts/two-pane/steps-view/index.ts'

interface WorldStep {
  readonly name: string
  readonly status: StepStatus
  readonly startedAt?: number
  readonly endedAt?: number
}

export interface PlaygroundWorld {
  readonly steps: readonly WorldStep[]
  readonly banner: Banner | undefined
  readonly view: ViewMode
  readonly finished: boolean
  readonly seq: number
  readonly initialCount: number
}

export function initialWorld(count: number): PlaygroundWorld {
  const now = Date.now()
  const steps = Array.from({ length: count }, (_, i): WorldStep => {
    const name = `step-${String(i + 1).padStart(2, '0')}`
    if (i < count - 1) {
      return { name, status: 'completed', startedAt: now - (count - i) * 8_000, endedAt: now - (count - i - 1) * 8_000 }
    }
    return { name, status: 'running', startedAt: now - 3_000 }
  })
  return { steps, banner: undefined, view: { mode: 'live' }, finished: false, seq: 0, initialCount: count }
}

export function mutateWorld(world: PlaygroundWorld, digit: string): PlaygroundWorld {
  switch (digit) {
    case '1':
      return addStep(world)
    case '2':
      return startNext(completeCurrent(world))
    case '3':
      return completeCurrent(world)
    case '4':
      return failCurrent(world)
    case '5':
      return withBanner(world, 'info', 'info banner from the playground (auto-clears)')
    case '6':
      return withBanner(world, 'error', 'error banner from the playground — Esc to dismiss')
    case '7':
      return { ...world, finished: true }
    case '0':
      return initialWorld(world.initialCount)
    default:
      return world
  }
}

function addStep(world: PlaygroundWorld): PlaygroundWorld {
  const name = `step-${String(world.steps.length + 1).padStart(2, '0')}`
  return { ...world, steps: [...world.steps, { name, status: 'pending' }] }
}

function completeCurrent(world: PlaygroundWorld): PlaygroundWorld {
  return mapRunning(world, (s) => ({ ...s, status: 'completed', endedAt: Date.now() }))
}

function failCurrent(world: PlaygroundWorld): PlaygroundWorld {
  return mapRunning(world, (s) => ({ ...s, status: 'failed', endedAt: Date.now() }))
}

function startNext(world: PlaygroundWorld): PlaygroundWorld {
  const idx = world.steps.findIndex((s) => s.status === 'pending')
  if (idx === -1) return world
  const steps = world.steps.map((s, i) =>
    i === idx ? { ...s, status: 'running' as const, startedAt: Date.now() } : s,
  )
  return { ...world, steps }
}

function mapRunning(
  world: PlaygroundWorld,
  fn: (s: WorldStep) => WorldStep,
): PlaygroundWorld {
  const idx = world.steps.findIndex((s) => s.status === 'running' || s.status === 'interactive')
  if (idx === -1) return world
  const current = world.steps[idx]
  if (current === undefined) return world
  return { ...world, steps: world.steps.map((s, i) => (i === idx ? fn(current) : s)) }
}

function withBanner(world: PlaygroundWorld, kind: 'info' | 'error', text: string): PlaygroundWorld {
  const seq = world.seq + 1
  return { ...world, seq, banner: { kind, text, seq } }
}

export function worldToState(world: PlaygroundWorld): StepsViewState {
  const steps: StepRow[] = world.steps.map((s) => ({
    kind: 'agent',
    mode: 'autonomous',
    status: s.status,
    name: s.name,
    ...(s.startedAt !== undefined ? { startedAt: s.startedAt } : {}),
    ...(s.endedAt !== undefined ? { endedAt: s.endedAt } : {}),
  }))
  const base = {
    run: { runId: 'r-playground', workflowName: 'playground', startedAt: 0 },
    steps,
    view: world.view,
    ...(world.banner !== undefined ? { banner: world.banner } : {}),
  }
  if (!world.finished) return { status: 'live', ...base }
  const failed = world.steps.filter((s) => s.status === 'failed').length
  const status = failed > 0 ? 'failed' : 'completed'
  return {
    status,
    ...base,
    summary: {
      endedAt: Date.now(),
      durationMs: 90_000,
      stepsTotal: steps.length,
      stepsCompleted: steps.length - failed,
      stepsFailed: failed,
    },
  }
}
