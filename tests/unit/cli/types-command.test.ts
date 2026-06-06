// MIGRATED → tests-new/unit/cli/types-command.test.ts (parent U13) — relocated verbatim (import paths only); kept skipped on disk (D2).
// Unit tests for `orch types` (one-shot mode). Watch mode lives in
// `types-command-watch.test.ts` because it requires real fs + fs.watch.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { typesCmd } from '../../../src/cli/commands/types.ts'
import type { CliDeps } from '../../../src/cli/deps.ts'
import { type CliOpts, EXIT } from '../../../src/cli/main.ts'
import { createNullSessionLogger } from '../../../src/observability/index.ts'
import {
  BunFsService,
  FakeClock,
  FakeGitService,
  FakeProcessService,
  path,
} from '../../../src/services/index.ts'
import { FakeConfirmService, FakePromptService } from '../../../src/services/prompt/index.ts'
import { FileRunRegistry, FileStateStore, type RunId } from '../../../src/state/index.ts'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'orch-types-cmd-'))
})

afterEach(async () => {
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true })
})

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
    sessionLoggerFor: (rid: RunId) => createNullSessionLogger({ runId: rid }),
    promptServiceFor: () => new FakePromptService(),
    confirmService: new FakeConfirmService(),
    isStdinTty: false,
  }
}

const DEFAULT_OPTS: CliOpts = {
  mode: undefined,
  format: 'text',
  noAttach: false,
  debug: false,
  interactivity: 'noninteractive',
  latest: false,
  step: undefined,
  follow: false,
  watch: false,
}

function capture(): {
  stdout: () => string
  stderr: () => string
  restore: () => void
} {
  const outChunks: string[] = []
  const errChunks: string[] = []
  const origOut = process.stdout.write.bind(process.stdout)
  const origErr = process.stderr.write.bind(process.stderr)
  // biome-ignore lint/suspicious/noExplicitAny: test capture
  ;(process.stdout as any).write = (chunk: any): boolean => {
    outChunks.push(String(chunk))
    return true
  }
  // biome-ignore lint/suspicious/noExplicitAny: test capture
  ;(process.stderr as any).write = (chunk: any): boolean => {
    errChunks.push(String(chunk))
    return true
  }
  return {
    stdout: () => outChunks.join(''),
    stderr: () => errChunks.join(''),
    restore: () => {
      // biome-ignore lint/suspicious/noExplicitAny: test capture
      ;(process.stdout as any).write = origOut
      // biome-ignore lint/suspicious/noExplicitAny: test capture
      ;(process.stderr as any).write = origErr
    },
  }
}

async function writeConfig(cwd: string, body: string): Promise<void> {
  await writeFile(
    `${cwd}/orch.config.ts`,
    `import { defineConfig } from '${join(process.cwd(), 'src/index.ts').replace(/'/g, "\\'")}'
export const config = defineConfig(${body})
`,
  )
}

describe.skip('orch types (one-shot)', () => {
  it('writes one sidecar per discovered prompt file', async () => {
    await writeConfig(
      tmpDir,
      `{ workflows: {}, prompts: { include: ['.orch/prompts/**/*.md'], exclude: [] } }`,
    )
    await new BunFsService().mkdir(path(`${tmpDir}/.orch/prompts`), { recursive: true })
    await writeFile(`${tmpDir}/.orch/prompts/a.md`, 'Hi {{name}}')
    await writeFile(`${tmpDir}/.orch/prompts/b.md`, 'static text')

    const io = capture()
    let code: number
    try {
      code = await typesCmd(makeDeps(tmpDir), '', {}, DEFAULT_OPTS)
    } finally {
      io.restore()
    }

    expect(code).toBe(EXIT.OK)
    expect(io.stdout()).toContain('2 written')
  })

  it('suppresses the summary on a clean idempotent repeat run', async () => {
    // After R3, a pass that wrote nothing and produced no errors emits no
    // stdout — quiet behavior for agent loops and watch-mode redraws.
    await writeConfig(
      tmpDir,
      `{ workflows: {}, prompts: { include: ['.orch/prompts/**/*.md'], exclude: [] } }`,
    )
    await new BunFsService().mkdir(path(`${tmpDir}/.orch/prompts`), { recursive: true })
    await writeFile(`${tmpDir}/.orch/prompts/a.md`, 'Hi {{name}}')
    await writeFile(`${tmpDir}/.orch/prompts/b.md`, 'static text')

    const io1 = capture()
    try {
      await typesCmd(makeDeps(tmpDir), '', {}, DEFAULT_OPTS)
    } finally {
      io1.restore()
    }

    const io2 = capture()
    let code: number
    try {
      code = await typesCmd(makeDeps(tmpDir), '', {}, DEFAULT_OPTS)
    } finally {
      io2.restore()
    }

    expect(code).toBe(EXIT.OK)
    expect(io2.stdout()).toBe('')
    expect(io2.stderr()).toBe('')
  })

  it('exits non-zero when the config is missing', async () => {
    const io = capture()
    let code: number
    try {
      code = await typesCmd(makeDeps(tmpDir), '', {}, DEFAULT_OPTS)
    } finally {
      io.restore()
    }

    expect(code).toBe(EXIT.CONFIG_ERROR)
    expect(io.stderr()).toContain('Cannot load config')
  })

  it('emits NDJSON events when --format=json is set', async () => {
    // Finding #9: agents that read `orch types` output programmatically need
    // a structured per-source event stream. text mode keeps the prose
    // summary; json mode swaps it for one NDJSON line per result.
    await writeConfig(
      tmpDir,
      `{ workflows: {}, prompts: { include: ['.orch/prompts/**/*.md'], exclude: [] } }`,
    )
    await new BunFsService().mkdir(path(`${tmpDir}/.orch/prompts`), { recursive: true })
    await writeFile(`${tmpDir}/.orch/prompts/a.md`, 'Hi {{name}}')

    const io = capture()
    let code: number
    try {
      code = await typesCmd(makeDeps(tmpDir), '', {}, { ...DEFAULT_OPTS, format: 'json' })
    } finally {
      io.restore()
    }

    expect(code).toBe(EXIT.OK)
    const lines = io
      .stdout()
      .split('\n')
      .filter((l) => l.length > 0)
    expect(lines.length).toBe(1)
    const parsed = JSON.parse(lines[0] as string) as { event: string; path: string }
    expect(parsed.event).toBe('codegen.written')
    expect(parsed.path).toContain('.orch/prompts/a.md')
    expect(io.stderr()).toBe('')
  })

  it('falls back to the documented defaults when prompts is omitted', async () => {
    await writeConfig(tmpDir, `{ workflows: {} }`)
    await new BunFsService().mkdir(path(`${tmpDir}/.orch/prompts`), { recursive: true })
    await writeFile(`${tmpDir}/.orch/prompts/x.md`, 'Hi {{name}}')

    const io = capture()
    let code: number
    try {
      code = await typesCmd(makeDeps(tmpDir), '', {}, DEFAULT_OPTS)
    } finally {
      io.restore()
    }

    expect(code).toBe(EXIT.OK)
    expect(io.stdout()).toContain('1 written')
  })
})
