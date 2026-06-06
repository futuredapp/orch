// MIGRATED → tests-new/integration/runners/claude/claude-structured-real.test.ts (parent U11) — relocated verbatim (import paths only); kept skipped on disk (D2).
import { describe, expect, it } from 'bun:test'
import { z } from 'zod'
import { schema } from '../../../../src/core/schema.ts'
import { step } from '../../../../src/core/step.ts'
import type { WorkflowDeps } from '../../../../src/core/workflow.ts'
import { workflow } from '../../../../src/core/workflow.ts'
import { claude } from '../../../../src/runners/index.ts'
import { BunClock } from '../../../../src/services/clock/index.ts'
import { FakeFsService, FakeGitService } from '../../../../src/services/index.ts'
import { BunProcessService } from '../../../../src/services/process/index.ts'
import { FakePromptService } from '../../../../src/services/prompt/index.ts'
import { path } from '../../../../src/services/types.ts'
import { FileStateStore, type RunId } from '../../../../src/state/index.ts'
import { createFakeHost } from '../../../helpers/fake-host.ts'

const canRun = process.env.RUN_REAL_CLAUDE === '1' && Bun.which('claude') !== null

const rid = (s: string): RunId => s as RunId

const researchSchema = z.object({
  title: z.string(),
  items: z.array(z.string()),
  count: z.number(),
})

function makeDeps(): WorkflowDeps {
  const fs = new FakeFsService()
  return {
    fsService: fs,
    gitService: new FakeGitService(),
    processService: new BunProcessService(),
    clock: new BunClock(),
    stateStore: new FileStateStore({ fs, basePath: path('/runs') }),
    runId: rid('r-2026-04-12-real1'),
    cwd: path(process.cwd()),
    host: createFakeHost(),
    promptService: new FakePromptService(),
    interactivity: 'interactive' as const,
  }
}

describe.skip('ClaudeRunner real CLI — structured output', () => {
  it('real Claude with --json-schema returns Zod-parsed, type-safe value', async () => {
    // `bare: false` so the CLI can use the dev machine's keychain auth.
    const runner = claude({ bare: false })
    const STEP = step.define('structured', {
      agent: runner,
      prompt:
        'Return a JSON object with exactly these fields: ' +
        'title (string), items (array of 2 strings), count (number equal to items length). ' +
        'Example: {"title":"Test","items":["a","b"],"count":2}',
      returns: schema(researchSchema),
    })

    const deps = makeDeps()
    let result: z.infer<typeof researchSchema> | undefined
    const wf = workflow('test', async (run) => {
      result = await run(STEP)
    })
    await wf.execute(deps)

    expect(result).toBeDefined()
    expect(typeof result?.title).toBe('string')
    expect(Array.isArray(result?.items)).toBe(true)
    expect(typeof result?.count).toBe('number')
  }, 60_000)
})
