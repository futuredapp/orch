// End-of-run summary block — printed by executeWithAttach on both the
// success and the mapped-failure paths. The unit test (tests/unit/cli/
// execute-with-attach.test.ts) covers the same writes against a fake host;
// this integration test wires a real PlainHost + a real relative path so it
// also catches "we forgot to wire summary in run.ts" if the field stops
// being passed through.

import { describe, expect, it } from 'bun:test'
import { executeWithAttach } from '../../../src/cli/commands/execute-with-attach.ts'
import { relativeRunDir } from '../../../src/cli/commands/relative-run-dir.ts'
import { EXIT } from '../../../src/cli/main.ts'
import { StepError, stepName } from '../../../src/core/index.ts'
import { createPlainHost } from '../../../src/hosts/index.ts'
import { FakeClock, path } from '../../../src/services/index.ts'

function bufferStream(): { stream: NodeJS.WritableStream; text: () => string } {
  const chunks: string[] = []
  const stream = {
    write(chunk: unknown): boolean {
      chunks.push(typeof chunk === 'string' ? chunk : String(chunk))
      return true
    },
  } as unknown as NodeJS.WritableStream
  return { stream, text: () => chunks.join('') }
}

const RUN_ID = 'r-2026-04-29-143052-7k'

describe('end-of-run summary (integration)', () => {
  it('prints the two-line success block with a relative data path', async () => {
    const stderr = bufferStream()
    const stdout = bufferStream()
    const host = createPlainHost({
      stdout: stdout.stream,
      stderr: stderr.stream,
      format: 'text',
      clock: new FakeClock(0),
      runId: RUN_ID as Parameters<typeof createPlainHost>[0]['runId'],
    })

    const cwd = path('/Users/me/project')
    const statePath = path('/Users/me/project/.orch/state')
    const runDir = relativeRunDir(cwd, statePath, RUN_ID)

    const code = await executeWithAttach({
      host,
      workflow: Promise.resolve(),
      runId: RUN_ID,
      stderr: stderr.stream,
      mapError: () => undefined,
      summary: { workflowName: 'hello-file', runDir },
    })

    expect(code).toBe(EXIT.OK)
    expect(stderr.text()).toContain(
      `Workflow "hello-file" completed.\n  data: .orch/state/${RUN_ID}/\n`,
    )
    expect(runDir.startsWith('/')).toBe(false)
  })

  it('prints the two-line failure block with the mapped reason', async () => {
    const stderr = bufferStream()
    const stdout = bufferStream()
    const host = createPlainHost({
      stdout: stdout.stream,
      stderr: stderr.stream,
      format: 'text',
      clock: new FakeClock(0),
      runId: RUN_ID as Parameters<typeof createPlainHost>[0]['runId'],
    })

    const cwd = path('/Users/me/project')
    const statePath = path('/Users/me/project/.orch/state')
    const runDir = relativeRunDir(cwd, statePath, RUN_ID)

    const stepError = new StepError(stepName('demo'), 1, 'boom')

    const code = await executeWithAttach({
      host,
      workflow: Promise.reject(stepError),
      runId: RUN_ID,
      stderr: stderr.stream,
      mapError: (err) =>
        err instanceof StepError ? { code: EXIT.STEP_FAILURE, reason: err.message } : undefined,
      summary: { workflowName: 'hello-file', runDir },
    })

    expect(code).toBe(EXIT.STEP_FAILURE)
    expect(stderr.text()).toContain(
      `Workflow "hello-file" failed: ${stepError.message}\n  data: .orch/state/${RUN_ID}/\n`,
    )
  })
})
