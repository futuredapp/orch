import { describe, expect, it } from 'bun:test'
import { Writable } from 'node:stream'
import type { StepName } from '../../../src/core/types.ts'
import type { StepLifecycleEvent } from '../../../src/core/workflow.ts'
import { createPlainHost } from '../../../src/hosts/index.ts'
import type { RunnerEvent } from '../../../src/runners/index.ts'
import { FakeClock } from '../../../src/services/index.ts'
import type { RunId } from '../../../src/state/index.ts'

function bufferStream(): { stream: NodeJS.WritableStream; text: () => string } {
  const chunks: string[] = []
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(String(chunk))
      cb()
    },
  })
  return { stream: stream as unknown as NodeJS.WritableStream, text: () => chunks.join('') }
}

const RUN_ID = 'r-2026-04-23-aaaaaa' as RunId
const STEP = 'plan' as StepName

function makeTextHost() {
  const stdout = bufferStream()
  const stderr = bufferStream()
  const host = createPlainHost({
    stdout: stdout.stream,
    stderr: stderr.stream,
    format: 'text',
    clock: new FakeClock(1_700_000_000_000),
    runId: RUN_ID,
  })
  return { host, stdout, stderr }
}

function makeJsonHost() {
  const stdout = bufferStream()
  const stderr = bufferStream()
  const host = createPlainHost({
    stdout: stdout.stream,
    stderr: stderr.stream,
    format: 'json',
    clock: new FakeClock(1_700_000_000_000),
    runId: RUN_ID,
  })
  return { host, stdout, stderr }
}

describe('PlainHost — text format', () => {
  it('writes the banner to stderr, not stdout', () => {
    const { host, stdout, stderr } = makeTextHost()
    host.writeBanner('[orch] mode=plain (flag: --mode=plain)')

    expect(stdout.text()).toBe('')
    expect(stderr.text()).toContain('[orch] mode=plain')
  })

  it('renders a lifecycle step:start event as [orch] step:start …', () => {
    const { host, stdout } = makeTextHost()
    const evt: StepLifecycleEvent = { type: 'step:start', stepName: STEP, mode: 'autonomous' }
    host.onLifecycleEvent(evt)

    expect(stdout.text()).toBe('[orch] step:start plan (autonomous)\n')
  })

  it('renders a runner event under the [stepName] prefix', () => {
    const { host, stdout } = makeTextHost()
    const evt: RunnerEvent = { kind: 'info', type: 'assistant', payload: { text: 'hi' } }
    host.onRunnerEvent(evt, STEP)

    expect(stdout.text()).toBe('[plan] assistant> hi\n')
  })

  it('suppresses runner events whose rendered line is null (turn-complete)', () => {
    const { host, stdout } = makeTextHost()
    host.onRunnerEvent({ kind: 'terminal', type: 'turn-complete' }, STEP)

    expect(stdout.text()).toBe('')
  })

  it('emits step:complete with duration', () => {
    const { host, stdout } = makeTextHost()
    host.onLifecycleEvent({ type: 'step:complete', stepName: STEP, durationMs: 250 })

    expect(stdout.text()).toBe('[orch] step:complete plan (250ms)\n')
  })
})

describe('PlainHost — step:failed frame', () => {
  it('writes the Story 1.5 failure frame to stderr after the [orch] line', () => {
    const { host, stdout, stderr } = makeTextHost()
    host.onLifecycleEvent({ type: 'step:failed', stepName: STEP, error: new Error('boom') })

    // The single-line summary still goes to stdout as before.
    expect(stdout.text()).toBe('[orch] step:failed plan: boom\n')

    // The inline failure frame follows on stderr with copy-paste hints.
    const err = stderr.text()
    expect(err).toContain('✗ step "plan" failed')
    expect(err).toContain('  boom')
    expect(err).toContain(`resume:  orch resume ${RUN_ID}`)
    expect(err).toContain(`logs:    orch logs ${RUN_ID}`)
  })

  it('renders a string error message without a stack block', () => {
    const { host, stderr } = makeTextHost()
    host.onLifecycleEvent({ type: 'step:failed', stepName: STEP, error: 'exit 137' })

    const err = stderr.text()
    expect(err).toContain('  exit 137')
    // No trailing "at …" frames when the error has no stack.
    expect(err).not.toMatch(/^\s{4}at /m)
  })

  it('suppresses the stderr failure frame when --format=json', () => {
    const { host, stderr } = makeJsonHost()
    host.onLifecycleEvent({ type: 'step:failed', stepName: STEP, error: new Error('boom') })

    expect(stderr.text()).toBe('')
  })
})

describe('PlainHost — json format', () => {
  it('suppresses the banner on stderr when --format=json', () => {
    const { host, stdout, stderr } = makeJsonHost()
    host.writeBanner('noise')

    expect(stdout.text()).toBe('')
    expect(stderr.text()).toBe('')
  })

  it('emits a flat NDJSON envelope with ts/run/ev/step fields for step:start', () => {
    const { host, stdout } = makeJsonHost()
    host.onLifecycleEvent({ type: 'step:start', stepName: STEP, mode: 'autonomous' })

    const line = stdout.text().trim()
    const parsed = JSON.parse(line)
    expect(parsed.ev).toBe('step.start')
    expect(parsed.step).toBe('plan')
    expect(parsed.mode).toBe('autonomous')
    expect(parsed.run).toBe(RUN_ID)
    expect(parsed.ts).toBe(new Date(1_700_000_000_000).toISOString())
  })

  it('emits one line per event', () => {
    const { host, stdout } = makeJsonHost()
    host.onLifecycleEvent({ type: 'step:start', stepName: STEP, mode: 'autonomous' })
    host.onLifecycleEvent({ type: 'step:complete', stepName: STEP, durationMs: 42 })

    const lines = stdout.text().trim().split('\n')
    expect(lines).toHaveLength(2)
    const first = lines[0] ?? ''
    const second = lines[1] ?? ''
    expect(JSON.parse(first).ev).toBe('step.start')
    expect(JSON.parse(second).ev).toBe('step.complete')
  })

  it('emits runner events as ev:event with kind/type', () => {
    const { host, stdout } = makeJsonHost()
    host.onRunnerEvent({ kind: 'info', type: 'assistant', payload: { text: 'hi' } }, STEP)

    const parsed = JSON.parse(stdout.text().trim())
    expect(parsed.ev).toBe('event')
    expect(parsed.kind).toBe('info')
    expect(parsed.type).toBe('assistant')
    expect(parsed.step).toBe('plan')
  })
})
