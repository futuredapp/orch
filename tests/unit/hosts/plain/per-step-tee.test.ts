// ---------------------------------------------------------------------------
// Per-step tee — opens/closes formatted_output.{ansi,txt} sinks per step and
// writes verbatim ANSI to one and stripped-ANSI to the other. Ordering and
// file independence are the contract.
// ---------------------------------------------------------------------------

import { describe, expect, it } from 'bun:test'
import { stepName } from '../../../../src/core/types.ts'
import { createPerStepTee, NULL_PER_STEP_TEE } from '../../../../src/hosts/plain/per-step-tee.ts'
import { createFileSessionLogger } from '../../../../src/observability/file-session-logger.ts'
import { FakeClock, FakeFsService, path } from '../../../../src/services/index.ts'
import { runId as runIdFactory } from '../../../../src/state/index.ts'

const RUN_ID = runIdFactory('r-2026-04-28-tee001')
const BASE = path('/state')
const ESC = String.fromCharCode(0x1b)

function make(): {
  logger: ReturnType<typeof createFileSessionLogger>
  fs: FakeFsService
} {
  const fs = new FakeFsService()
  const logger = createFileSessionLogger({
    fs,
    clock: new FakeClock(0),
    runId: RUN_ID,
    basePath: BASE,
    debug: false,
  })
  return { logger, fs }
}

describe('createPerStepTee', () => {
  it('returns the null tee when no logger is provided', () => {
    expect(createPerStepTee(undefined)).toBe(NULL_PER_STEP_TEE)
  })

  it('writes ANSI bytes verbatim and stripped form to the txt sibling', async () => {
    const { logger, fs } = make()
    const tee = createPerStepTee(logger)
    const step = stepName('demo')

    tee.open(step)
    tee.write(step, `${ESC}[31mhello${ESC}[0m\n`)
    tee.close(step)
    await tee.drain()
    await logger.close()

    const ansi = await fs.readFile(path(`${BASE}/${RUN_ID}/logs/agents/demo/formatted_output.ansi`))
    const txt = await fs.readFile(path(`${BASE}/${RUN_ID}/logs/agents/demo/formatted_output.txt`))

    expect(ansi).toBe(`${ESC}[31mhello${ESC}[0m\n`)
    expect(txt).toBe('hello\n')
  })

  it('write before open is a no-op (silent or interactive steps leave no files)', async () => {
    const { logger, fs } = make()
    const tee = createPerStepTee(logger)

    tee.write(stepName('silent'), 'should not land\n')
    await tee.drain()
    await logger.close()

    expect(
      await fs.exists(path(`${BASE}/${RUN_ID}/logs/agents/silent/formatted_output.ansi`)),
    ).toBe(false)
  })

  it('keeps two parallel branches independent', async () => {
    const { logger, fs } = make()
    const tee = createPerStepTee(logger)
    const a = stepName('alpha')
    const b = stepName('beta')

    tee.open(a)
    tee.open(b)
    tee.write(a, 'A1\n')
    tee.write(b, 'B1\n')
    tee.write(a, 'A2\n')
    tee.write(b, 'B2\n')
    tee.close(a)
    tee.close(b)
    await tee.drain()
    await logger.close()

    const aBody = await fs.readFile(
      path(`${BASE}/${RUN_ID}/logs/agents/alpha/formatted_output.ansi`),
    )
    const bBody = await fs.readFile(
      path(`${BASE}/${RUN_ID}/logs/agents/beta/formatted_output.ansi`),
    )
    expect(aBody).toBe('A1\nA2\n')
    expect(bBody).toBe('B1\nB2\n')
  })

  it('open is idempotent — repeated open() reuses the existing sinks (resume safety)', async () => {
    const { logger, fs } = make()
    const tee = createPerStepTee(logger)
    const step = stepName('demo')

    tee.open(step)
    tee.write(step, 'first\n')
    tee.open(step) // would re-truncate if it created a new sink
    tee.write(step, 'second\n')
    tee.close(step)
    await tee.drain()
    await logger.close()

    const body = await fs.readFile(path(`${BASE}/${RUN_ID}/logs/agents/demo/formatted_output.ansi`))
    expect(body).toBe('first\nsecond\n')
  })

  it('drain closes any sinks left open by SIGINT mid-step', async () => {
    const { logger, fs } = make()
    const tee = createPerStepTee(logger)
    const step = stepName('demo')

    tee.open(step)
    tee.write(step, 'partial\n')
    // No close() — simulate SIGINT before step:complete arrives.
    await tee.drain()
    await logger.close()

    const body = await fs.readFile(path(`${BASE}/${RUN_ID}/logs/agents/demo/formatted_output.ansi`))
    expect(body).toBe('partial\n')
  })
})
