// U6 — plain host arms for `subworkflow:enter` / `subworkflow:exit` /
// `host-error`. Sequential composition renders a one-line boundary; parallel
// composition suppresses the boundary (R16).

import { describe, expect, it } from 'bun:test'
import { PassThrough } from 'node:stream'
import { createPlainHost } from '../../../../src/hosts/plain/plain-host.ts'
import { FakeClock } from '../../../../src/services/index.ts'
import { runId as runIdFactory } from '../../../../src/state/index.ts'

function collectStream(): { stream: PassThrough; chunks: string[] } {
  const stream = new PassThrough()
  const chunks: string[] = []
  stream.on('data', (chunk) => {
    chunks.push(chunk instanceof Buffer ? chunk.toString() : String(chunk))
  })
  return { stream, chunks }
}

function makeTextHost() {
  const outBuf = collectStream()
  const errBuf = collectStream()
  const host = createPlainHost({
    stdout: outBuf.stream,
    stderr: errBuf.stream,
    format: 'text',
    clock: new FakeClock(0),
    runId: runIdFactory('r-2026-05-28-120000-aa'),
  })
  return { host, stdout: outBuf, stderr: errBuf }
}

function makeJsonHost() {
  const outBuf = collectStream()
  const errBuf = collectStream()
  const host = createPlainHost({
    stdout: outBuf.stream,
    stderr: errBuf.stream,
    format: 'json',
    clock: new FakeClock(0),
    runId: runIdFactory('r-2026-05-28-120001-bb'),
  })
  return { host, stdout: outBuf, stderr: errBuf }
}

describe('plain host (text) — subworkflow divider', () => {
  it('renders an enter divider for sequential composition', () => {
    const { host, stdout } = makeTextHost()
    host.onLifecycleEvent({ type: 'subworkflow:enter', name: 'simple-feature', depth: 1 })

    const joined = stdout.chunks.join('')
    expect(joined).toContain('▶ subworkflow: simple-feature')
    expect(joined).toContain('──')
  })

  it('renders an exit divider with the completed glyph', () => {
    const { host, stdout } = makeTextHost()
    host.onLifecycleEvent({
      type: 'subworkflow:exit',
      name: 'simple-feature',
      depth: 1,
      durationMs: 1234,
      outcome: 'completed',
    })

    const joined = stdout.chunks.join('')
    expect(joined).toContain('◀ subworkflow: simple-feature')
    expect(joined).toContain('1234ms')
  })

  it('renders an exit divider with the failed glyph when outcome is failed', () => {
    const { host, stdout } = makeTextHost()
    host.onLifecycleEvent({
      type: 'subworkflow:exit',
      name: 'sub',
      depth: 1,
      durationMs: 50,
      outcome: 'failed',
    })

    const joined = stdout.chunks.join('')
    expect(joined).toContain('✗ subworkflow: sub')
  })

  it('suppresses the divider for events flagged insideParallel', () => {
    const { host, stdout } = makeTextHost()
    host.onLifecycleEvent({
      type: 'subworkflow:enter',
      name: 'sub',
      depth: 1,
      insideParallel: true,
    })
    host.onLifecycleEvent({
      type: 'subworkflow:exit',
      name: 'sub',
      depth: 1,
      durationMs: 5,
      outcome: 'completed',
      insideParallel: true,
    })

    const joined = stdout.chunks.join('')
    expect(joined).not.toContain('subworkflow:')
    expect(joined).not.toContain('▶')
    expect(joined).not.toContain('◀')
  })

  it('renders a host-error diagnostic line', () => {
    const { host, stdout } = makeTextHost()
    host.onLifecycleEvent({
      type: 'host-error',
      source: 'subworkflow:exit',
      name: 'sub',
      depth: 1,
      message: 'something broke',
    })

    const joined = stdout.chunks.join('')
    expect(joined).toContain('host-error')
    expect(joined).toContain('subworkflow:exit')
    expect(joined).toContain('something broke')
  })
})

describe('plain host (json) — subworkflow records', () => {
  it('emits a subworkflow.enter JSON record', () => {
    const { host, stdout } = makeJsonHost()
    host.onLifecycleEvent({ type: 'subworkflow:enter', name: 'sub', depth: 1 })

    const line = stdout.chunks.join('').trim()
    const parsed = JSON.parse(line)
    expect(parsed.ev).toBe('subworkflow.enter')
    expect(parsed.name).toBe('sub')
    expect(parsed.depth).toBe(1)
  })

  it('emits a subworkflow.exit JSON record with outcome and durationMs', () => {
    const { host, stdout } = makeJsonHost()
    host.onLifecycleEvent({
      type: 'subworkflow:exit',
      name: 'sub',
      depth: 2,
      durationMs: 99,
      outcome: 'completed',
    })

    const line = stdout.chunks.join('').trim()
    const parsed = JSON.parse(line)
    expect(parsed.ev).toBe('subworkflow.exit')
    expect(parsed.depth).toBe(2)
    expect(parsed.durationMs).toBe(99)
    expect(parsed.outcome).toBe('completed')
  })

  it('emits a host-error JSON record', () => {
    const { host, stdout } = makeJsonHost()
    host.onLifecycleEvent({
      type: 'host-error',
      source: 'subworkflow:enter',
      name: 'sub',
      depth: 1,
      message: 'oops',
    })

    const line = stdout.chunks.join('').trim()
    const parsed = JSON.parse(line)
    expect(parsed.ev).toBe('host-error')
    expect(parsed.source).toBe('subworkflow:enter')
    expect(parsed.message).toBe('oops')
  })

  it('emits subworkflow records even when insideParallel is set (json is structured only)', () => {
    const { host, stdout } = makeJsonHost()
    host.onLifecycleEvent({
      type: 'subworkflow:enter',
      name: 'sub',
      depth: 1,
      insideParallel: true,
    })

    const line = stdout.chunks.join('').trim()
    const parsed = JSON.parse(line)
    expect(parsed.ev).toBe('subworkflow.enter')
  })
})
