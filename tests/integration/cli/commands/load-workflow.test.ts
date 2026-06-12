import { afterEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as nodePath from 'node:path'
import { isLoadError, loadWorkflow } from '../../../../src/cli/commands/load-workflow.ts'
import { EXIT } from '../../../../src/cli/main.ts'
import { path } from '../../../../src/services/index.ts'

// Absolute path to the public barrel so a workflow file written into an
// out-of-tree temp dir can `import { workflow } from '<abs>/src/index.ts'`
// without 'orch' being resolvable from /tmp. (The known cwd-sensitivity
// pitfall: we never `process.chdir` — `loadWorkflow(cwd, …)` takes cwd.)
const SRC_INDEX = nodePath.resolve(import.meta.dir, '../../../../src/index.ts')

const tmpDirs: string[] = []

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })))
})

async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp('/tmp/orch-load-workflow-test-')
  tmpDirs.push(dir)
  return dir
}

/** Write a `.orch/orch.config.ts` mapping `name` to an absolute workflow path.
 *  The config exports a plain object (no 'orch' import) so it imports cleanly
 *  from a temp dir; the schema only requires `workflows: Record<string,string>`. */
async function writeConfig(dir: string, workflows: Record<string, string>): Promise<void> {
  await fs.mkdir(nodePath.join(dir, '.orch'), { recursive: true })
  await fs.writeFile(
    nodePath.join(dir, '.orch', 'orch.config.ts'),
    `export const config = { workflows: ${JSON.stringify(workflows)} }\n`,
  )
}

/** Write a real workflow file built with the public `workflow()` factory and
 *  return its absolute path. */
async function writeWorkflowFile(dir: string, name: string): Promise<string> {
  const file = nodePath.join(dir, `${name}.ts`)
  await fs.writeFile(
    file,
    `import { workflow } from '${SRC_INDEX}'\n` +
      `export default workflow('${name}', async () => {})\n`,
  )
  return file
}

interface CapturedStderr {
  readonly text: () => string
  readonly restore: () => void
}

function captureStderr(): CapturedStderr {
  const chunks: string[] = []
  const orig = process.stderr.write.bind(process.stderr)
  // biome-ignore lint/suspicious/noExplicitAny: monkey-patching for test capture
  ;(process.stderr as any).write = (chunk: any): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString())
    return true
  }
  return {
    text: () => chunks.join(''),
    restore: () => {
      // biome-ignore lint/suspicious/noExplicitAny: restore original
      ;(process.stderr as any).write = orig
    },
  }
}

describe('loadWorkflow (integration)', () => {
  it('returns a load error with CONFIG_ERROR and writes to stderr when no config exists', async () => {
    const dir = await makeTmpDir()
    const io = captureStderr()

    let result: Awaited<ReturnType<typeof loadWorkflow>>
    try {
      result = await loadWorkflow(path(dir), 'hello')
    } finally {
      io.restore()
    }

    expect(isLoadError(result)).toBe(true)
    if (isLoadError(result)) expect(result.code).toBe(EXIT.CONFIG_ERROR)
    expect(io.text().length).toBeGreaterThan(0)
  })

  it('suppresses the stderr message under quiet when the config is missing', async () => {
    const dir = await makeTmpDir()
    const io = captureStderr()

    let result: Awaited<ReturnType<typeof loadWorkflow>>
    try {
      result = await loadWorkflow(path(dir), 'hello', { quiet: true })
    } finally {
      io.restore()
    }

    expect(isLoadError(result)).toBe(true)
    expect(io.text()).toBe('')
  })

  it('returns a load error naming the unknown workflow when the name is not in the config', async () => {
    const dir = await makeTmpDir()
    await writeConfig(dir, { hello: await writeWorkflowFile(dir, 'hello') })
    const io = captureStderr()

    let result: Awaited<ReturnType<typeof loadWorkflow>>
    try {
      result = await loadWorkflow(path(dir), 'missing')
    } finally {
      io.restore()
    }

    expect(isLoadError(result)).toBe(true)
    if (isLoadError(result)) expect(result.code).toBe(EXIT.CONFIG_ERROR)
    expect(io.text()).toContain('missing')
  })

  it('returns a load error when the default export is not a WorkflowExecutor', async () => {
    const dir = await makeTmpDir()
    const file = nodePath.join(dir, 'bad.ts')
    await fs.writeFile(file, 'export default { execute() {} }\n')
    await writeConfig(dir, { bad: file })
    const io = captureStderr()

    let result: Awaited<ReturnType<typeof loadWorkflow>>
    try {
      result = await loadWorkflow(path(dir), 'bad')
    } finally {
      io.restore()
    }

    expect(isLoadError(result)).toBe(true)
    if (isLoadError(result)) expect(result.code).toBe(EXIT.CONFIG_ERROR)
    expect(io.text()).toContain('must export a default WorkflowExecutor')
  })

  it('loads the executor and config for a valid workflow built with workflow()', async () => {
    const dir = await makeTmpDir()
    await writeConfig(dir, { hello: await writeWorkflowFile(dir, 'hello') })

    const result = await loadWorkflow(path(dir), 'hello')

    expect(isLoadError(result)).toBe(false)
    if (!isLoadError(result)) {
      expect(result.executor.name).toBe('hello')
      expect(result.config.workflows.hello).toBeDefined()
    }
  })
})
