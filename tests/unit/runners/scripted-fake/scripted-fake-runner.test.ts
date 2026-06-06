// MIGRATED → tests-new/unit/runners/scripted-fake/scripted-fake-runner.test.ts (parent U11) — relocated verbatim (import paths only); kept skipped on disk (D2).
import { describe, expect, it } from 'bun:test'
import { scriptedFake } from '../../../../src/runners/scripted-fake/index.ts'
import type { RunnerContext } from '../../../../src/runners/types.ts'
import { path } from '../../../../src/services/types.ts'

function ctxFor(overrides: Partial<RunnerContext> = {}): RunnerContext {
  return {
    cwd: path('/tmp'),
    env: {},
    prompt: 'noop',
    extraArgs: [],
    ...overrides,
  }
}

describe.skip('scriptedFake()', () => {
  it('refuses an empty stepName at construction time', () => {
    expect(() => scriptedFake({ stepName: '' })).toThrow(/stepName/)
  })

  it('builds an argv that re-invokes the entry script under bun', () => {
    const runner = scriptedFake({ stepName: 'plan' })

    const cmd = runner.buildCommand(ctxFor())

    expect(cmd.argv[0]).toBe('bun')
    expect(cmd.argv[1]).toMatch(/scripted-fake\/__entry\.ts$/)
  })

  it('exports ORCH_LIFECYCLE_STEP_NAME so the entry process can pick its script row', () => {
    const runner = scriptedFake({ stepName: 'execute' })

    const cmd = runner.buildCommand(ctxFor())

    expect(cmd.env.ORCH_LIFECYCLE_STEP_NAME).toBe('execute')
  })

  it('lets ctx.env win last over the runner-set step name (mergeEnv contract)', () => {
    const runner = scriptedFake({ stepName: 'plan' })

    const cmd = runner.buildCommand(ctxFor({ env: { ORCH_LIFECYCLE_STEP_NAME: 'override' } }))

    expect(cmd.env.ORCH_LIFECYCLE_STEP_NAME).toBe('override')
  })

  it('parses NDJSON RunnerEvents from stdout', () => {
    const runner = scriptedFake({ stepName: 'plan' })

    const event = runner.parseEvents(
      JSON.stringify({ kind: 'info', type: 'thinking', payload: { text: 'hmm' } }),
    )

    expect(event).toEqual({ kind: 'info', type: 'thinking', payload: { text: 'hmm' } })
  })

  it('returns null for blank lines and unparseable JSON instead of throwing', () => {
    const runner = scriptedFake({ stepName: 'plan' })

    expect(runner.parseEvents('')).toBeNull()
    expect(runner.parseEvents('   ')).toBeNull()
    expect(runner.parseEvents('{nope')).toBeNull()
  })

  it('extracts structuredOutput from a turn-complete terminal event', () => {
    const runner = scriptedFake({ stepName: 'plan' })

    const out = runner.extractStructuredOutput({
      kind: 'terminal',
      type: 'turn-complete',
      data: { score: 7 },
    })

    expect(out).toEqual({ score: 7 })
  })

  it('returns undefined when the terminal event is an error', () => {
    const runner = scriptedFake({ stepName: 'plan' })

    const out = runner.extractStructuredOutput({
      kind: 'terminal',
      type: 'error',
      message: 'fail',
    })

    expect(out).toBeUndefined()
  })

  it('surfaces a terminal/error event as a failed block in the transcript', () => {
    const runner = scriptedFake({ stepName: 'plan' })

    const lines = runner.toTranscriptLines({
      kind: 'terminal',
      type: 'error',
      message: 'rate limited',
    })

    expect(lines).toEqual([{ kind: 'block', heading: 'failed', rows: [['error', 'rate limited']] }])
  })

  it('surfaces an info event with text payload as an assistant line', () => {
    const runner = scriptedFake({ stepName: 'plan' })

    const lines = runner.toTranscriptLines({
      kind: 'info',
      type: 'assistant',
      payload: { text: 'hello' },
    })

    expect(lines).toEqual([
      { kind: 'line', category: 'assistant', label: 'assistant>', body: 'hello' },
    ])
  })

  it('reports the runner name and supports flags so defineRunner validation passes', () => {
    const runner = scriptedFake({ stepName: 'plan' })

    expect(runner.name).toBe('scripted-fake')
    expect(runner.supports.interactive).toBe(false)
    expect(runner.supports.structuredOutput).toBe(true)
    expect(runner.defaultView).toEqual({ kind: 'transcript', pane: 'right' })
  })
})
