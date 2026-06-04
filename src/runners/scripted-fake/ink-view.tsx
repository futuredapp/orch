/**
 * `ink-view.tsx` — the importable view layer for the Ink interactive entry.
 *
 * Split from the bootstrap (`ink-entry.tsx`) the same way `steps-view.tsx` is
 * split from `steps-view-runner.tsx`: the entry runs `main()` at import and
 * calls `process.exit`, so it can never be imported by a test. Everything
 * testable — the message model, the sink, the `<App>` component, and the
 * submit-wiring — lives here and is exercised via ink-testing-library.
 *
 * No import-time side effects (CLAUDE.md rule 8): only declarations.
 */

import { EventEmitter } from 'node:events'
import { appendFileSync } from 'node:fs'
import { Box, Text } from 'ink'
import TextInput from 'ink-text-input'
import { useEffect, useState } from 'react'
import type { OutputSink } from './command-engine.ts'
import { parseManualLine, runEngineOp } from './command-engine.ts'
import type { Deferred, Engine } from './interactive-core.ts'

// ---------------------------------------------------------------------------
// Message model — the rendered-line list. The control reader and the TextInput
// both push here (via the sink); the Ink view subscribes and re-renders. A
// plain EventEmitter mirrors the steps-view's model→on('change')→setState
// pattern (no import-time side effect: instantiated by the caller).
// ---------------------------------------------------------------------------
export interface RenderedLine {
  /** Monotonic id — a stable React key (line text may repeat, indexes shift). */
  readonly id: number
  readonly text: string
}

export class MessageModel extends EventEmitter {
  readonly lines: RenderedLine[] = []
  #nextId = 0
  add(line: string): void {
    this.lines.push({ id: this.#nextId++, text: line })
    this.emit('change')
  }
}

// Ink sink: each rendered line is appended to the list AND to the durable render
// log (parity with the raw entry's sink, so a driver's `waitForRender` oracle is
// identical). `finish` is a no-op — the coordinator drives the clean exit once
// the engine queue drains.
export function inkSink(model: MessageModel, renderLogPath: string): OutputSink {
  return {
    typeLine(text: string): void {
      model.add(text)
      appendFileSync(renderLogPath, `${text}\n`)
    },
    finish(_code: number): void {
      /* clean-exit-only; coordinator drives the unmount + exit */
    },
  }
}

// Wire a parsed manual line through the shared engine, resolving `finished` on a
// terminate op — identical semantics to the raw entry's stdin reader.
export function wireSubmit(
  engine: Engine,
  sink: OutputSink,
  finished: Deferred<number>,
): (line: string) => void {
  return (line: string): void => {
    const op = parseManualLine(line)
    if (op === null) return
    engine.enqueue(() => {
      const outcome = runEngineOp(op, sink)
      if (outcome.kind === 'terminate') finished.resolve(outcome.exitCode ?? 0)
    })
  }
}

export interface AppProps {
  readonly model: MessageModel
  readonly stepKey: string
  readonly onSubmitLine: (line: string) => void
}

export function App({ model, stepKey, onSubmitLine }: AppProps): React.ReactElement {
  const [lines, setLines] = useState<readonly RenderedLine[]>([...model.lines])
  const [value, setValue] = useState('')

  useEffect(() => {
    const handler = (): void => setLines([...model.lines])
    model.on('change', handler)
    return () => {
      model.off('change', handler)
    }
  }, [model])

  const submit = (submitted: string): void => {
    setValue('')
    onSubmitLine(submitted)
  }

  return (
    <Box flexDirection="column">
      <Text color="cyan">
        predictable fake · {stepKey} · type a line + Enter ("exit"/"q" to end)
      </Text>
      {lines.map((line) => (
        <Text key={line.id}>{line.text}</Text>
      ))}
      <Box>
        <Text color="green">{'❯ '}</Text>
        <TextInput value={value} onChange={setValue} onSubmit={submit} />
      </Box>
    </Box>
  )
}
