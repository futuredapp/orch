// Real-fs watch test for `orch types --watch`.
//
// `fs.watch` cannot be intercepted by FakeFsService — the precedent in
// `tests/unit/hosts/two-pane/steps-view/tail-state-json.test.ts` is to use a
// real tmpdir at the unit tier. We mirror that pattern here. The watch loop
// exits via the injected `stopSignal` rather than a real SIGINT so the test
// terminates deterministically.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
  tmpDir = await mkdtemp(join(tmpdir(), 'orch-types-watch-'))
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

const WATCH_OPTS: CliOpts = {
  mode: undefined,
  format: 'text',
  noAttach: false,
  debug: false,
  interactivity: 'noninteractive',
  latest: false,
  step: undefined,
  follow: false,
  watch: true,
}

function silenceStdio(): { restore: () => void } {
  const origOut = process.stdout.write.bind(process.stdout)
  const origErr = process.stderr.write.bind(process.stderr)
  // biome-ignore lint/suspicious/noExplicitAny: silence
  ;(process.stdout as any).write = (_chunk: any): boolean => true
  // biome-ignore lint/suspicious/noExplicitAny: silence
  ;(process.stderr as any).write = (_chunk: any): boolean => true
  return {
    restore: () => {
      // biome-ignore lint/suspicious/noExplicitAny: silence
      ;(process.stdout as any).write = origOut
      // biome-ignore lint/suspicious/noExplicitAny: silence
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

async function waitFor(
  predicate: () => Promise<boolean>,
  { timeoutMs, intervalMs }: { timeoutMs: number; intervalMs: number },
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`)
}

describe('orch types --watch', () => {
  it('regenerates sidecars when a prompt file changes', async () => {
    await writeConfig(
      tmpDir,
      `{ workflows: {}, prompts: { include: ['.orch/prompts/**/*.md'], exclude: [] } }`,
    )
    await new BunFsService().mkdir(path(`${tmpDir}/.orch/prompts`), { recursive: true })
    await writeFile(`${tmpDir}/.orch/prompts/a.md`, 'Hi {{name}}')

    const io = silenceStdio()
    let stopResolve!: () => void
    const stopSignal = new Promise<void>((resolve) => {
      stopResolve = resolve
    })

    const cmdPromise = typesCmd(makeDeps(tmpDir), '', {}, WATCH_OPTS, {
      pollIntervalMs: 60,
      trailingDebounceMs: 20,
      maxDebounceMs: 80,
      stopSignal,
    })

    try {
      // Initial sidecar is written before any change.
      await waitFor(
        async () => {
          try {
            const content = await readFile(`${tmpDir}/.orch/prompts/a.md.d.ts`, 'utf8')
            return content.includes('name: string | number | boolean')
          } catch {
            return false
          }
        },
        { timeoutMs: 1500, intervalMs: 25 },
      )

      // Mutate the source file → expect the sidecar to refresh.
      await writeFile(`${tmpDir}/.orch/prompts/a.md`, 'Hi {{name}} {{tone?}}')

      await waitFor(
        async () => {
          try {
            const content = await readFile(`${tmpDir}/.orch/prompts/a.md.d.ts`, 'utf8')
            return content.includes('tone?: string | number | boolean')
          } catch {
            return false
          }
        },
        { timeoutMs: 1500, intervalMs: 25 },
      )
    } finally {
      stopResolve()
      const code = await cmdPromise
      expect(code).toBe(EXIT.OK)
      io.restore()
    }
  })

  it('does not re-run codegen on every poll tick when nothing has changed', async () => {
    // Regression guard for finding #2: the poll backstop used to call
    // scheduleRead() unconditionally every 250 ms, which meant runCodegen
    // ran continuously even on an idle prompt tree. The fix gates the poll
    // tick behind an mtime check, so an idle ~600 ms window should result in
    // at most one codegen pass (the initial one).
    await writeConfig(
      tmpDir,
      `{ workflows: {}, prompts: { include: ['.orch/prompts/**/*.md'], exclude: [] } }`,
    )
    await new BunFsService().mkdir(path(`${tmpDir}/.orch/prompts`), { recursive: true })
    await writeFile(`${tmpDir}/.orch/prompts/a.md`, 'Hi {{name}}')

    const io = silenceStdio()
    let stopResolve!: () => void
    const stopSignal = new Promise<void>((resolve) => {
      stopResolve = resolve
    })

    const cmdPromise = typesCmd(makeDeps(tmpDir), '', {}, WATCH_OPTS, {
      pollIntervalMs: 40,
      trailingDebounceMs: 10,
      maxDebounceMs: 60,
      stopSignal,
    })

    try {
      // Wait long enough for the initial pass to land its sidecar.
      await waitFor(
        async () => {
          try {
            await readFile(`${tmpDir}/.orch/prompts/a.md.d.ts`, 'utf8')
            return true
          } catch {
            return false
          }
        },
        { timeoutMs: 1500, intervalMs: 20 },
      )

      // Capture mtime after the initial pass, then idle for ~600 ms (≈15
      // poll ticks at 40 ms). With the old behavior the sidecar would be
      // rewritten on every tick → its mtime would advance. With the gate in
      // place the file's mtime stays put.
      const { mtimeMs: mtime0 } = await import('node:fs/promises').then((m) =>
        m.stat(`${tmpDir}/.orch/prompts/a.md.d.ts`),
      )
      await new Promise<void>((resolve) => setTimeout(resolve, 600))
      const { mtimeMs: mtime1 } = await import('node:fs/promises').then((m) =>
        m.stat(`${tmpDir}/.orch/prompts/a.md.d.ts`),
      )
      expect(mtime1).toBe(mtime0)
    } finally {
      stopResolve()
      await cmdPromise
      io.restore()
    }
  })

  it('picks up a newly-created prompt file via the poll backstop', async () => {
    await writeConfig(
      tmpDir,
      `{ workflows: {}, prompts: { include: ['.orch/prompts/**/*.md'], exclude: [] } }`,
    )
    await new BunFsService().mkdir(path(`${tmpDir}/.orch/prompts`), { recursive: true })

    const io = silenceStdio()
    let stopResolve!: () => void
    const stopSignal = new Promise<void>((resolve) => {
      stopResolve = resolve
    })

    const cmdPromise = typesCmd(makeDeps(tmpDir), '', {}, WATCH_OPTS, {
      pollIntervalMs: 60,
      trailingDebounceMs: 20,
      maxDebounceMs: 80,
      stopSignal,
    })

    try {
      // Add a new file after the watcher is running. The poll backstop should
      // notice via reconcileWatchers + a subsequent codegen pass.
      await writeFile(`${tmpDir}/.orch/prompts/late.md`, 'late {{topic}}')

      await waitFor(
        async () => {
          try {
            const content = await readFile(`${tmpDir}/.orch/prompts/late.md.d.ts`, 'utf8')
            return content.includes('topic: string | number | boolean')
          } catch {
            return false
          }
        },
        { timeoutMs: 2000, intervalMs: 25 },
      )
    } finally {
      stopResolve()
      await cmdPromise
      io.restore()
    }
  })
})
