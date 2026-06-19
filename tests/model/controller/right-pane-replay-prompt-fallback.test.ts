// `model/controller` category (see ./README.md): plain class tests at the
// `FakeTmuxService` seam, no `scenario()`. These pin the U6 (R8 acceptance)
// decision: when a completed autonomous step is replayed and the frozen
// per-step tee is empty/absent (file logging was off), the replay FALLBACK
// must reconstruct the `prompt:` preamble from the always-on prompt store and
// prepend it above the re-rendered transcript — and the primary (tee-present)
// branch must NOT be double-prefixed.
//
// Real filesystem under a tmpdir: the behaviour under test is which bytes the
// replay path writes to the warm-cache file the pane then tails, so the file
// content is the assertion surface.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import type { StepName } from '../../../src/core/types.ts'
import { createRightPaneController } from '../../../src/hosts/two-pane/pane-map/index.ts'
import { createPaneQueue } from '../../../src/hosts/two-pane/pane-queue.ts'
import { renderPromptPreamble } from '../../../src/hosts/two-pane/prompt-preamble.ts'
import { createPromptStore } from '../../../src/hosts/two-pane/prompt-store.ts'
import { createNullSessionLogger, type SessionLogger } from '../../../src/observability/index.ts'
import { FakeTmuxService, paneId, socketName } from '../../../src/services/tmux/index.ts'
import { path as toPath } from '../../../src/services/types.ts'
import { type RunId, runId as toRunId } from '../../../src/state/index.ts'
import { bufferStream, flush, makeStep, makeStore } from './_support.ts'

const RUN_ID: RunId = toRunId('r-2026-06-19-120000-rp')
const RIGHT_PANE = paneId('%1')
const LEFT_PANE = paneId('%0')
const SOCKET = socketName('orch-main-replay-prompt')

const stepName = (s: string): StepName => s as StepName

const PROMPT = 'assemble me with an injected marker MARKER-7'

let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp('/tmp/orch-replay-prompt-')
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

/** Last element of the tail command a createSession spawned — the path the
 *  replay pane tails. */
function tailedPath(tmux: FakeTmuxService): string {
  return String(tailCommand(tmux)[tailCommand(tmux).length - 1])
}

/** The full command a createSession spawned — e.g. `['tail','-n','+1','-F',path]`. */
function tailCommand(tmux: FakeTmuxService): readonly string[] {
  const create = tmux.recordedCalls.find((c) => c.method === 'createSession')
  if (create?.method !== 'createSession') throw new Error('expected a createSession call')
  const command = create.opts.command
  if (command === undefined || command.length === 0)
    throw new Error('expected a command on createSession')
  return command
}

/** The argument to `tail -n` — `+1` (from-start) or the bounded backfill count. */
function tailLinesArg(tmux: FakeTmuxService): string {
  const command = tailCommand(tmux)
  const flagIndex = command.indexOf('-n')
  if (flagIndex === -1 || command[flagIndex + 1] === undefined)
    throw new Error('expected a `-n <lines>` argument on the tail command')
  return String(command[flagIndex + 1])
}

describe('right-pane-controller replay — prompt preamble from the always-on store', () => {
  it('Covers AT-7 (logging-disabled). prepends the persisted prompt above the re-rendered transcript when the frozen tee is absent', async () => {
    // Arrange: a completed autonomous step with a transcript on disk and a
    // prompt persisted to the ALWAYS-ON store — but NO file logger, so the
    // frozen tee path is null and the replay takes the fallback branch.
    const tmux = new FakeTmuxService()
    const stateDir = `${tempDir}/state`
    await mkdir(stateDir, { recursive: true })

    await createPromptStore(toPath(stateDir)).write(stepName('plan'), PROMPT)
    await writeFile(
      `${stateDir}/transcript.ndjson`,
      `${JSON.stringify({ kind: 'info', type: 'text', payload: { text: 'AGENT-OUTPUT-TOKEN' } })}\n`,
      'utf8',
    )

    const controller = createRightPaneController({
      tmux,
      socket: SOCKET,
      leftPaneId: LEFT_PANE,
      rightPaneId: RIGHT_PANE,
      paneQueue: createPaneQueue(),
      stateStore: makeStore(RUN_ID, {
        plan: makeStep({ name: 'plan', mode: 'autonomous', transcriptPath: 'transcript.ndjson' }),
      }),
      runId: RUN_ID,
      stateDir: toPath(stateDir),
      cwd: toPath(tempDir),
      env: {},
      stderr: bufferStream(),
      width: 200,
      height: 50,
    })

    // Act: revisit the completed step.
    tmux.nextCreateSessionPaneId(paneId('%70'))
    controller.onIntent({ type: 'enter', stepName: 'plan' })
    await flush()

    // Assert: the warm-cache file the pane tails leads with the prompt preamble
    // (label + the persisted prompt) and still contains the agent output below.
    const replayText = await readFile(tailedPath(tmux), 'utf8')
    expect(replayText.startsWith(renderPromptPreamble(PROMPT))).toBe(true)
    expect(replayText).toContain('MARKER-7')
    expect(replayText.indexOf('AGENT-OUTPUT-TOKEN')).toBeGreaterThan(replayText.indexOf('MARKER-7'))

    await controller.stop()
  })

  it('Covers AT-7 (R2/R8/KTD8). spawns a from-start tail (`-n +1`), not the bounded backfill, so a prompt longer than the backfill window still backfills its head on the fallback branch', async () => {
    // Arrange: same logging-disabled fallback shape as above — a persisted
    // prompt plus a transcript, no file logger. The fallback prepends the
    // `prompt:` head to the warm-cache file; if the pane tails it with the
    // bounded `tail -n 5000`, a prompt+transcript exceeding that window drops
    // the head. The regression: the spawned tail must read from line 1.
    const tmux = new FakeTmuxService()
    const stateDir = `${tempDir}/state`
    await mkdir(stateDir, { recursive: true })

    await createPromptStore(toPath(stateDir)).write(stepName('plan'), PROMPT)
    await writeFile(
      `${stateDir}/transcript.ndjson`,
      `${JSON.stringify({ kind: 'info', type: 'text', payload: { text: 'AGENT-OUTPUT-TOKEN' } })}\n`,
      'utf8',
    )

    const controller = createRightPaneController({
      tmux,
      socket: SOCKET,
      leftPaneId: LEFT_PANE,
      rightPaneId: RIGHT_PANE,
      paneQueue: createPaneQueue(),
      stateStore: makeStore(RUN_ID, {
        plan: makeStep({ name: 'plan', mode: 'autonomous', transcriptPath: 'transcript.ndjson' }),
      }),
      runId: RUN_ID,
      stateDir: toPath(stateDir),
      cwd: toPath(tempDir),
      env: {},
      stderr: bufferStream(),
      width: 200,
      height: 50,
    })

    // Act: revisit the completed step (fallback branch — no logger).
    tmux.nextCreateSessionPaneId(paneId('%72'))
    controller.onIntent({ type: 'enter', stepName: 'plan' })
    await flush()

    // Assert: the replay tails from line 1, not the bounded `-n 5000` window.
    expect(tailLinesArg(tmux)).toBe('+1')

    await controller.stop()
  })

  it('Covers AT-7 (no-transcript fallback). spawns a from-start tail even when no transcript was recorded, so the persisted prompt head still backfills', async () => {
    // Arrange: a persisted prompt but NO transcript path on the step — the
    // `transcriptPath === undefined` fallback return. It still prepends the
    // preamble, so it too must be tailed from the start.
    const tmux = new FakeTmuxService()
    const stateDir = `${tempDir}/state`
    await mkdir(stateDir, { recursive: true })

    await createPromptStore(toPath(stateDir)).write(stepName('plan'), PROMPT)

    const controller = createRightPaneController({
      tmux,
      socket: SOCKET,
      leftPaneId: LEFT_PANE,
      rightPaneId: RIGHT_PANE,
      paneQueue: createPaneQueue(),
      stateStore: makeStore(RUN_ID, {
        plan: makeStep({ name: 'plan', mode: 'autonomous' }),
      }),
      runId: RUN_ID,
      stateDir: toPath(stateDir),
      cwd: toPath(tempDir),
      env: {},
      stderr: bufferStream(),
      width: 200,
      height: 50,
    })

    tmux.nextCreateSessionPaneId(paneId('%73'))
    controller.onIntent({ type: 'enter', stepName: 'plan' })
    await flush()

    expect(tailLinesArg(tmux)).toBe('+1')
    const replayText = await readFile(tailedPath(tmux), 'utf8')
    expect(replayText.startsWith(renderPromptPreamble(PROMPT))).toBe(true)

    await controller.stop()
  })

  it('does not double-prefix the prompt when the frozen tee is present (primary branch untouched)', async () => {
    // Arrange: file logging IS on and the frozen tee already embeds the
    // preamble (written live at step:start in Phase 1). The store ALSO holds
    // the prompt. The primary branch must win and tail the tee directly — never
    // writing a fallback `.replay` file, so the prompt cannot appear twice.
    const tmux = new FakeTmuxService()
    const stateDir = `${tempDir}/state`
    const logsDir = `${stateDir}/logs`
    await mkdir(`${logsDir}/agents/plan`, { recursive: true })
    const teePath = `${logsDir}/agents/plan/formatted_output.ansi`
    await writeFile(teePath, `${renderPromptPreamble(PROMPT)}AGENT-OUTPUT-TOKEN\r\n`, 'utf8')
    await createPromptStore(toPath(stateDir)).write(stepName('plan'), PROMPT)

    const logger: SessionLogger = {
      ...createNullSessionLogger({ runId: RUN_ID }),
      logsDir: toPath(logsDir),
    }

    const controller = createRightPaneController({
      tmux,
      socket: SOCKET,
      leftPaneId: LEFT_PANE,
      rightPaneId: RIGHT_PANE,
      paneQueue: createPaneQueue(),
      stateStore: makeStore(RUN_ID, {
        plan: makeStep({ name: 'plan', mode: 'autonomous', transcriptPath: 'transcript.ndjson' }),
      }),
      runId: RUN_ID,
      stateDir: toPath(stateDir),
      cwd: toPath(tempDir),
      env: {},
      stderr: bufferStream(),
      width: 200,
      height: 50,
      logger,
    })

    tmux.nextCreateSessionPaneId(paneId('%71'))
    controller.onIntent({ type: 'enter', stepName: 'plan' })
    await flush()

    // The pane tails the frozen tee (primary branch), not a fallback file.
    expect(tailedPath(tmux)).toBe(teePath)
    // No fallback `.replay` file was written, so the preamble is not duplicated.
    await expect(readFile(`${stateDir}/.replay/plan.txt`, 'utf8')).rejects.toThrow()
    const teeText = await readFile(teePath, 'utf8')
    expect(teeText.indexOf('prompt:')).toBe(teeText.lastIndexOf('prompt:'))

    await controller.stop()
  })
})
