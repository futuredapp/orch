import { afterEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as nodePath from 'node:path'
import { dryRunCmd } from '../../../../src/cli/commands/dry-run.ts'
import type { CliDeps } from '../../../../src/cli/deps.ts'
import { type CliOpts, EXIT } from '../../../../src/cli/main.ts'
import { createNullSessionLogger } from '../../../../src/observability/index.ts'
import {
  BunFsService,
  FakeClock,
  FakeGitService,
  FakeProcessService,
  path,
} from '../../../../src/services/index.ts'
import { FakeConfirmService, FakePromptService } from '../../../../src/services/prompt/index.ts'
import { FileRunRegistry, FileStateStore } from '../../../../src/state/index.ts'

const SRC_INDEX = nodePath.resolve(import.meta.dir, '../../../../src/index.ts')

const DEFAULT_OPTS: CliOpts = {
  mode: undefined,
  format: 'text',
  noAttach: false,
  debug: false,
  interactivity: 'interactive',
  latest: false,
  step: undefined,
  follow: false,
  watch: false,
}

const tmpDirs: string[] = []

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })))
})

async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp('/tmp/orch-dry-run-test-')
  tmpDirs.push(dir)
  return dir
}

/** A temp dir with a `.orch/orch.config.ts` mapping `name` to a real workflow
 *  file built with the public `workflow()` factory. Duplicates the
 *  load-workflow fixture idioms locally — two files don't warrant shared infra. */
async function makeWorkflowFixture(name: string): Promise<string> {
  const dir = await makeTmpDir()
  const file = nodePath.join(dir, `${name}.ts`)
  await fs.writeFile(
    file,
    `import { workflow } from '${SRC_INDEX}'\n` +
      `export default workflow('${name}', async () => {})\n`,
  )
  await fs.mkdir(nodePath.join(dir, '.orch'), { recursive: true })
  await fs.writeFile(
    nodePath.join(dir, '.orch', 'orch.config.ts'),
    `export const config = { workflows: ${JSON.stringify({ [name]: file })} }\n`,
  )
  return dir
}

function makeDeps(cwd: string): CliDeps {
  const bunFs = new BunFsService()
  const basePath = path(`${cwd}/.orch/state`)
  return {
    processService: new FakeProcessService(),
    fsService: bunFs,
    gitService: new FakeGitService(),
    clock: new FakeClock(1000),
    stateStore: new FileStateStore({ fs: bunFs, basePath }),
    registry: new FileRunRegistry({ fs: bunFs, basePath }),
    cwd: path(cwd),
    statePath: basePath,
    debug: false,
    sessionLoggerFor: (rid) => createNullSessionLogger({ runId: rid }),
    promptServiceFor: () => new FakePromptService(),
    confirmService: new FakeConfirmService(),
    isStdinTty: true,
  }
}

interface CapturedStream {
  readonly text: () => string
  readonly restore: () => void
}

function captureStream(stream: 'stdout' | 'stderr'): CapturedStream {
  const target = process[stream]
  const chunks: string[] = []
  const orig = target.write.bind(target)
  // biome-ignore lint/suspicious/noExplicitAny: monkey-patching for test capture
  ;(target as any).write = (chunk: any): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString())
    return true
  }
  return {
    text: () => chunks.join(''),
    restore: () => {
      // biome-ignore lint/suspicious/noExplicitAny: restore original
      ;(target as any).write = orig
    },
  }
}

describe('dryRunCmd (integration)', () => {
  it('returns CONFIG_ERROR and prints a usage line when the name is empty', async () => {
    const dir = await makeTmpDir()
    const io = captureStream('stderr')

    let code: number
    try {
      code = await dryRunCmd(makeDeps(dir), '', {}, DEFAULT_OPTS)
    } finally {
      io.restore()
    }

    expect(code).toBe(EXIT.CONFIG_ERROR)
    expect(io.text().startsWith('Usage: orch dry-run')).toBe(true)
  })

  it('propagates the loader exit code when the workflow cannot be loaded', async () => {
    const dir = await makeTmpDir()
    const io = captureStream('stderr')

    let code: number
    try {
      code = await dryRunCmd(makeDeps(dir), 'absent', {}, DEFAULT_OPTS)
    } finally {
      io.restore()
    }

    expect(code).toBe(EXIT.CONFIG_ERROR)
  })

  it('returns OK and reports the loaded workflow on the happy path', async () => {
    const dir = await makeWorkflowFixture('hello')
    const io = captureStream('stdout')

    let code: number
    try {
      code = await dryRunCmd(makeDeps(dir), 'hello', {}, DEFAULT_OPTS)
    } finally {
      io.restore()
    }

    expect(code).toBe(EXIT.OK)
    expect(io.text()).toContain('Dry-run: "hello"')
    expect(io.text()).toContain('loaded successfully')
  })

  it('whitespace-normalizes and truncates a long prompt preview to 80 chars ending with an ellipsis', async () => {
    const dir = await makeWorkflowFixture('hello')
    const longPrompt = `line one\n\n   line two   with     runs of spaces ${'x'.repeat(80)} trailing tail`
    const io = captureStream('stdout')

    let code: number
    try {
      code = await dryRunCmd(makeDeps(dir), 'hello', { prompt: longPrompt }, DEFAULT_OPTS)
    } finally {
      io.restore()
    }

    expect(code).toBe(EXIT.OK)
    const promptLine = io
      .text()
      .split('\n')
      .find((l) => l.startsWith('Prompt:'))
    expect(promptLine).toBeDefined()
    const preview = (promptLine ?? '').replace(/^Prompt:\s+/, '')
    expect(preview.endsWith('…')).toBe(true)
    expect(preview.length).toBeLessThanOrEqual(80)
    expect(preview).not.toContain('\n')
    expect(preview).not.toContain('  ')
  })
})
