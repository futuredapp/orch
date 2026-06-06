/**
 * Integration: the Ink interactive view (`ink-view.tsx`) — the human/dev UI for
 * the predictable fake. Verifies the two things the raw entry can't give a
 * human: keystrokes ECHO as you type, and a submitted line moves into the
 * message list. Then proves channel parity — a scripted `type_and_send` over the
 * control file renders into the SAME list and render log via the SAME core
 * engine — and that a manual `finish`/`q` terminates.
 *
 * No mocks: the real `interactive-core` engine/reader, real fs (temp dir), and
 * ink-testing-library as the Ink edge (the same seam the steps-view tests use).
 * The bootstrap (`ink-entry.tsx`) runs `main()` at import and so is never
 * imported; the importable view layer is what we exercise here.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { appendFile, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as nodePath from 'node:path'
import { render } from 'ink-testing-library'
import type { OutputSink } from '../../../src/runners/scripted-fake/command-engine.ts'
import { resolveControlPaths } from '../../../src/runners/scripted-fake/index.ts'
import {
  App,
  inkSink,
  MessageModel,
  wireSubmit,
} from '../../../src/runners/scripted-fake/ink-view.tsx'
import {
  type ControlReader,
  createControlReader,
  createDeferred,
  createEngine,
  type Deferred,
  type Engine,
} from '../../../src/runners/scripted-fake/interactive-core.ts'

const ENTER = '\r'

function tick(ms = 30): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function waitForFrame(
  ui: { lastFrame(): string | undefined },
  pred: (frame: string) => boolean,
): Promise<string> {
  const deadline = Date.now() + 3_000
  for (;;) {
    const frame = ui.lastFrame() ?? ''
    if (pred(frame)) return frame
    if (Date.now() >= deadline) throw new Error(`waitForFrame timeout; last:\n${frame}`)
    await tick(20)
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

interface Wiring {
  readonly model: MessageModel
  readonly sink: OutputSink
  readonly engine: Engine
  readonly finished: Deferred<number>
  readonly reader: ControlReader
  readonly renderLogPath: string
  readonly controlPath: string
  readonly ackDir: string
  readonly controlDir: string
}

let runStateDir: string

beforeEach(async () => {
  runStateDir = await mkdtemp(nodePath.join(tmpdir(), 'scripted-fake-ink-'))
})

afterEach(async () => {
  await rm(runStateDir, { recursive: true, force: true })
})

// Build the full view wiring against a temp control transport, exactly as
// `ink-entry.tsx`'s `main` does — minus the bootstrap (render loop, ready
// marker, exit). The render log + control dir are created so the sink can write.
async function buildWiring(key: string): Promise<Wiring> {
  const paths = resolveControlPaths({ runStateDir, key })
  await mkdir(paths.controlDir, { recursive: true })
  await mkdir(paths.ackDir, { recursive: true })
  const model = new MessageModel()
  const sink = inkSink(model, paths.renderLogPath)
  const engine = createEngine()
  const finished = createDeferred<number>()
  const reader = createControlReader(paths, sink, engine, finished)
  return {
    model,
    sink,
    engine,
    finished,
    reader,
    renderLogPath: paths.renderLogPath,
    controlPath: paths.controlPath,
    ackDir: paths.ackDir,
    controlDir: paths.controlDir,
  }
}

describe('ink-view — manual typing echoes and submits', () => {
  it('echoes characters into the input prompt before Enter is pressed', async () => {
    const w = await buildWiring('plan')
    const ui = render(
      <App
        model={w.model}
        stepKey="plan"
        onSubmitLine={wireSubmit(w.engine, w.sink, w.finished)}
      />,
    )

    ui.stdin.write('hello')
    const frame = await waitForFrame(ui, (f) => f.includes('hello'))

    expect(frame).toContain('hello') // the raw entry would show nothing here
    ui.unmount()
  })

  it('moves a submitted line into the message list and appends it to the render log once', async () => {
    const w = await buildWiring('plan')
    const ui = render(
      <App
        model={w.model}
        stepKey="plan"
        onSubmitLine={wireSubmit(w.engine, w.sink, w.finished)}
      />,
    )

    ui.stdin.write('first line')
    await waitForFrame(ui, (f) => f.includes('first line'))
    ui.stdin.write(ENTER)

    await waitForFrame(ui, (f) => f.includes('first line'))
    await w.engine.drained()
    const log = await readFile(w.renderLogPath, 'utf-8')

    expect(w.model.lines.map((l) => l.text)).toEqual(['first line'])
    expect(log).toBe('first line\n')
    ui.unmount()
  })
})

describe('ink-view — channel parity with a scripted driver', () => {
  it('renders a control type_and_send into the same list + render log and acks it', async () => {
    const w = await buildWiring('execute')
    const ui = render(
      <App
        model={w.model}
        stepKey="execute"
        onSubmitLine={wireSubmit(w.engine, w.sink, w.finished)}
      />,
    )

    // A scripted driver writes NDJSON to the control file; the core reader picks
    // it up exactly as the running entry's poll loop would.
    await appendFile(
      w.controlPath,
      `${JSON.stringify({ cmd: 'type_and_send', text: 'scripted!' })}\n`,
    )
    await w.reader.drainOnce()
    await w.engine.drained()

    const frame = await waitForFrame(ui, (f) => f.includes('scripted!'))
    const log = await readFile(w.renderLogPath, 'utf-8')

    expect(frame).toContain('scripted!')
    expect(log).toBe('scripted!\n')
    expect(await fileExists(nodePath.join(w.ackDir, '1.ack'))).toBe(true)
    ui.unmount()
  })
})

describe('ink-view — finish terminates the step', () => {
  it('resolves the finished deferred when the user submits "q"', async () => {
    const w = await buildWiring('report')
    const ui = render(
      <App
        model={w.model}
        stepKey="report"
        onSubmitLine={wireSubmit(w.engine, w.sink, w.finished)}
      />,
    )

    ui.stdin.write('q')
    await waitForFrame(ui, (f) => f.includes('q'))
    ui.stdin.write(ENTER)

    const code = await w.finished.promise

    expect(code).toBe(0)
    ui.unmount()
  })
})
