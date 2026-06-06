// MIGRATED → tests-new/unit/hosts/two-pane/replay-transcript.test.ts (parent U14) — demote-relocated (pane-agnostic unit); kept skipped on disk (D2).
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { renderTranscriptToString } from '../../../../src/hosts/two-pane/replay-transcript.ts'
import type { RunnerEvent, TranscriptLine } from '../../../../src/runners/index.ts'
import { path as toPath } from '../../../../src/services/types.ts'

// `renderTranscriptToString` reads a per-step `events.ndjson` sidecar, runs
// each event through a renderer (defaults to a JSON-fallback that surfaces
// the event kind+type+payload), and returns the rendered text as a single
// UTF-8 string. The right-pane-controller writes that string to a per-step
// file under `<stateDir>/.replay/<step>.txt` and respawns the right pane
// with `cat <file>` (so pty-echo doubling that bites sendKeys is irrelevant).

let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp('/tmp/orch-rpc-test-')
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

describe.skip('renderTranscriptToString with the default JSON-fallback renderer', () => {
  it('renders assistant info events into the replay payload', async () => {
    const lines = [
      JSON.stringify({ kind: 'info', type: 'assistant', payload: { text: 'hi' } }),
      JSON.stringify({ kind: 'info', type: 'assistant', payload: { text: 'world' } }),
      JSON.stringify({ kind: 'terminal', type: 'turn-complete' }),
    ].join('\n')
    const sidecar = toPath(`${tempDir}/events.ndjson`)
    await writeFile(sidecar, lines, 'utf8')

    const payload = await renderTranscriptToString({
      transcriptPath: sidecar,
      stepName: 'plan',
    })

    // Default JSON fallback labels lines as `info:<type>`; the assistant text
    // passes through inside the JSON body. Either signal proves the renderer
    // ran end-to-end on real input.
    expect(payload).toContain('info:assistant')
    expect(payload).toContain('hi')
    expect(payload).toContain('── replay plan ──')
  })

  it('renders the no-events placeholder when the sidecar contains no parseable events', async () => {
    const sidecar = toPath(`${tempDir}/empty.ndjson`)
    await writeFile(sidecar, '', 'utf8')

    const payload = await renderTranscriptToString({
      transcriptPath: sidecar,
      stepName: 'plan',
    })

    expect(payload).toContain('(no events)')
  })

  it('skips malformed lines silently rather than crashing the replay', async () => {
    // Two valid lines, one garbage in the middle. The default tail-style
    // posture is "drop and keep going".
    const sidecar = toPath(`${tempDir}/mixed.ndjson`)
    const lines = [
      JSON.stringify({ kind: 'info', type: 'assistant', payload: { text: 'first' } }),
      'this is not json',
      JSON.stringify({ kind: 'info', type: 'assistant', payload: { text: 'second' } }),
    ].join('\n')
    await writeFile(sidecar, lines, 'utf8')

    const payload = await renderTranscriptToString({
      transcriptPath: sidecar,
      stepName: 'plan',
    })

    expect(payload).toContain('first')
    expect(payload).toContain('second')
  })
})

describe.skip('renderTranscriptToString with an injected runner-shaped renderer', () => {
  it('runs every event through the supplied toTranscriptLines instead of the JSON fallback', async () => {
    const sidecar = toPath(`${tempDir}/events.ndjson`)
    const ndjson = [
      JSON.stringify({ kind: 'info', type: 'assistant', payload: { text: 'one' } }),
      JSON.stringify({ kind: 'info', type: 'assistant', payload: { text: 'two' } }),
    ].join('\n')
    await writeFile(sidecar, ndjson, 'utf8')

    const stubRenderer = (_event: RunnerEvent): readonly TranscriptLine[] => [
      { kind: 'line', category: 'assistant', label: 'assistant>', body: 'STUB-RENDER' },
    ]

    const payload = await renderTranscriptToString({
      transcriptPath: sidecar,
      stepName: 'plan',
      toTranscriptLines: stubRenderer,
    })

    expect(payload).toContain('STUB-RENDER')
    expect(payload).toContain('assistant>')
    // Default JSON-fallback marker — must not appear when a custom renderer
    // is supplied. This locks the wiring: the controller's defaulting bug
    // (which produced raw `info:assistant {…json…}` lines on Enter) cannot
    // reappear without flipping this expectation.
    expect(payload).not.toContain('info:assistant')
  })

  it('still renders the no-events placeholder when the sidecar is empty even with a custom renderer', async () => {
    const sidecar = toPath(`${tempDir}/empty.ndjson`)
    await writeFile(sidecar, '', 'utf8')

    const stubRenderer = (_event: RunnerEvent): readonly TranscriptLine[] => [
      { kind: 'line', category: 'assistant', label: 'assistant>', body: 'should-not-appear' },
    ]

    const payload = await renderTranscriptToString({
      transcriptPath: sidecar,
      stepName: 'plan',
      toTranscriptLines: stubRenderer,
    })

    expect(payload).toContain('(no events)')
    expect(payload).not.toContain('should-not-appear')
  })
})
