#!/usr/bin/env bun
/**
 * `ink-entry.tsx` — the Ink list+input interactive entry: the human/dev-facing
 * sibling of the raw `interactive-entry.ts`. Selected by
 * `scriptedFake({ interactive: true, interactiveUi: 'ink' })`.
 *
 * It renders a scrolling message list plus a `<TextInput>` prompt, so typed
 * characters ECHO as you type (the raw entry shows nothing until Enter). Both
 * input channels — the TextInput and the NDJSON control file — route through the
 * SAME shared engine and sink as every other entry, so `type_and_send` /
 * `finish` behave identically and the durable contracts (`.ready`, `.ack`, the
 * render log) are preserved unchanged. A driver (`drive.ts`) cannot tell which
 * UI is mounted.
 *
 * This file is the BOOTSTRAP only (mirrors `steps-view-runner.tsx`): it runs
 * `main()` at import and calls `process.exit`, so it is never imported by a
 * test. The testable view layer lives in `ink-view.tsx`.
 *
 * Ink needs a real PTY for raw-mode input, so this entry runs in a tmux/PTY pane
 * (the two-pane and plain hosts both spawn a PTY). The non-TTY integration test
 * keeps using the raw entry; this one is exercised via ink-testing-library and
 * in real-tmux.
 *
 * Inputs (env, threaded by the executor at spawn — U1): `ORCH_STEP_KEY`,
 * `ORCH_RUN_STATE_DIR`, `ORCH_PARENT_PID`. `finish` is clean-exit only.
 */

import { render } from 'ink'
import { ORCH_STEP_KEY_ENV } from './addressing.ts'
import { App, inkSink, MessageModel, wireSubmit } from './ink-view.tsx'
import {
  controlPollLoop,
  createControlReader,
  createDeferred,
  createEngine,
  makeParentExited,
  prepareControlDir,
  reapLoop,
  resolveControlFromEnv,
  resolveOrchParentPid,
  writeReadyMarker,
} from './interactive-core.ts'

async function main(): Promise<number> {
  const paths = resolveControlFromEnv()
  await prepareControlDir(paths)

  const model = new MessageModel()
  const sink = inkSink(model, paths.renderLogPath)
  const engine = createEngine()
  const finished = createDeferred<number>()
  const reader = createControlReader(paths, sink, engine, finished)
  const parentExited = makeParentExited(resolveOrchParentPid())
  const stepKey = process.env[ORCH_STEP_KEY_ENV] ?? 'step'

  const instance = render(
    <App model={model} stepKey={stepKey} onSubmitLine={wireSubmit(engine, sink, finished)} />,
    { exitOnCtrlC: false, patchConsole: false },
  )

  void controlPollLoop(reader, engine, finished, parentExited)
  void reapLoop(engine, finished, parentExited)

  // Idle-waiting (R13): the channels are wired and the view is mounted.
  await writeReadyMarker(paths.readyPath)

  await finished.promise
  // Final control drain before stopping (cross-channel contract — see the raw
  // entry): ack a command appended just before a concurrent `finish`.
  await reader.drainOnce()
  engine.stop()
  await engine.drained()
  instance.unmount()
  return 0
}

for (const sig of ['SIGHUP', 'SIGTERM'] as const) {
  process.on(sig, () => process.exit(0))
}

try {
  const code = await main()
  process.exit(code)
} catch (err) {
  process.stderr.write(`ink fake: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
}
