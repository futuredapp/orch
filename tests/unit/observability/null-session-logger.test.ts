// MIGRATED → tests-new/unit/observability/null-session-logger.test.ts (parent U13) — relocated verbatim (import paths only); kept skipped on disk (D2).
import { describe, expect, it } from 'bun:test'
import { stepName } from '../../../src/core/types.ts'
import { createNullSessionLogger } from '../../../src/observability/null-session-logger.ts'

describe.skip('createNullSessionLogger', () => {
  it('returns a SessionLogger whose append resolves without side effects', async () => {
    const logger = createNullSessionLogger()
    await expect(logger.append('spawns', { foo: 'bar' })).resolves.toBeUndefined()
  })

  it('returns null from rawSink regardless of the relPath', () => {
    const logger = createNullSessionLogger()
    expect(logger.rawSink('agents/demo.stdout')).toBeNull()
  })

  it('exposes a debug flag that defaults to false', () => {
    expect(createNullSessionLogger().debug).toBe(false)
  })

  it('honours an explicit debug flag override', () => {
    expect(createNullSessionLogger({ debug: true }).debug).toBe(true)
  })

  it('forStep returns a span with a non-empty stepSpanId and the requested stepName', () => {
    const logger = createNullSessionLogger()
    const name = stepName('demo')
    const span = logger.forStep(name)
    expect(span.stepName).toBe(name)
    expect(span.stepSpanId.length).toBeGreaterThan(0)
  })

  it('forStep returns distinct stepSpanIds across calls', () => {
    const logger = createNullSessionLogger()
    const a = logger.forStep(stepName('demo'))
    const b = logger.forStep(stepName('demo'))
    expect(a.stepSpanId).not.toBe(b.stepSpanId)
  })

  it('writeFile and close resolve without touching disk', async () => {
    const logger = createNullSessionLogger()
    await expect(logger.writeFile('run.meta.json', '{}')).resolves.toBeUndefined()
    await expect(logger.close()).resolves.toBeUndefined()
  })

  it('streamSink returns a no-op sink whose write and close resolve', async () => {
    const logger = createNullSessionLogger()
    const sink = logger.streamSink('agents/demo/raw_output.ndjson')
    await expect(sink.write('anything')).resolves.toBeUndefined()
    await expect(sink.close()).resolves.toBeUndefined()
  })

  it('streamSink accepts truncateOnOpen and stays a no-op', async () => {
    const logger = createNullSessionLogger()
    const sink = logger.streamSink('agents/demo/raw_output.ndjson', { truncateOnOpen: true })
    await expect(sink.write('anything')).resolves.toBeUndefined()
    await expect(sink.close()).resolves.toBeUndefined()
  })
})
