// End-to-end integration test for typed-prompt-vars (U10 / Phase 3 cap).
//
// Exercises all three contract sources documented in the plan:
//   1. inline `prompt: '...{{x}}'` literal (TLT extractor)
//   2. `promptFile: '@/...'` lookup (sidecar augmentation)
//   3. explicit `RunOverrides.vars` shape (runtime substitution)
//
// The fixture lives under `tests/fixtures/typed-vars/reusable-step-workflow/`
// and demonstrates the AE3 reusable-step pattern: a single `step.define` is
// invoked multiple times with different vars and lands two distinct cache
// entries inside the same workflow run.

import { describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createFakeHost } from '@orch/test/fake-host.ts'
import { runCodegen } from '../../../src/codegen/index.ts'
import { FakePromptFileReader } from '../../../src/core/prompt-file/fake-prompt-file-reader.ts'
import { __setPromptFileReader } from '../../../src/core/prompt-file/prompt-file-reader.ts'
import { step } from '../../../src/core/step.ts'
import { type WorkflowDeps, workflow } from '../../../src/core/workflow.ts'
import { defineRunner, type Runner, type RunnerContext } from '../../../src/runners/index.ts'
import { BunFsService } from '../../../src/services/fs/bun-fs-service.ts'
import {
  FakeClock,
  FakeFsService,
  FakeGitService,
  FakeProcessService,
  path,
} from '../../../src/services/index.ts'
import { FakePromptService } from '../../../src/services/prompt/index.ts'
import { FileStateStore, type RunId } from '../../../src/state/index.ts'

const FIXTURE_DIR = join(process.cwd(), 'tests/fixtures/typed-vars/reusable-step-workflow')
// Virtual path: used ONLY as the FakePromptFileReader map key and the tmp-copy
// target name. It is never read from disk (it sits under gitignored `.orch/`).
const FIXTURE_PROMPT_PATH = `${FIXTURE_DIR}/.orch/prompts/brainstorm.md`
// On-disk content path: tracked, non-`.orch`, resolved relative to this test
// file so it survives the eventual tests-new/ → tests/ rename.
const FIXTURE_CONTENT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '_support',
  'fixtures',
  'typed-vars',
  'reusable-step-workflow',
  'brainstorm.md',
)

function rid(s: string): RunId {
  return s as RunId
}

function makeDeps(): WorkflowDeps {
  const fs = new FakeFsService()
  return {
    fsService: fs,
    gitService: new FakeGitService(),
    processService: new FakeProcessService(),
    clock: new FakeClock(1000),
    stateStore: new FileStateStore({ fs, basePath: path('/runs') }),
    runId: rid('r-2026-05-28-100000-aa'),
    cwd: path('/workspace'),
    host: createFakeHost(),
    promptService: new FakePromptService(),
    interactivity: 'interactive' as const,
  }
}

interface Capture {
  readonly runner: Runner
  readonly prompts: string[]
}

function capturingRunner(deps: WorkflowDeps, name: string): Capture {
  const prompts: string[] = []
  const argv = [`:${name}:`] as const
  const terminal = JSON.stringify({ kind: 'terminal', type: 'turn-complete', data: 'ok' })
  for (let i = 0; i < 16; i++) {
    ;(deps.processService as FakeProcessService)
      .when(argv)
      .respondWith({ stdout: [terminal], exitCode: 0 })
  }
  return {
    prompts,
    runner: defineRunner({
      name,
      supports: { interactive: false, structuredOutput: false },
      buildCommand(ctx: RunnerContext) {
        prompts.push(ctx.prompt)
        return { argv: [...argv], env: ctx.env }
      },
      parseEvents(line: string) {
        return line.trim() === '' ? null : JSON.parse(line)
      },
      extractStructuredOutput() {
        return 'ok'
      },
      toTranscriptLines() {
        return []
      },
    }),
  }
}

describe('typed-vars: reusable step across multiple run() calls', () => {
  it('inline {{topic}} literal: distinct vars produce distinct cache entries', async () => {
    const deps = makeDeps()
    const cap = capturingRunner(deps, 'tv1')
    const STEP = step.define('brainstorm', {
      agent: cap.runner,
      prompt: 'Topic: {{topic}}',
    })

    const wf = workflow('test', async (run) => {
      await run(STEP, { vars: { topic: 'A' } })
      await run(STEP, { vars: { topic: 'B' } })
    })
    await wf.execute(deps)

    expect(cap.prompts).toEqual(['Topic: A', 'Topic: B'])
    const state = await deps.stateStore.loadRun(deps.runId)
    const keys = Object.keys(state?.steps ?? {})
    expect(keys.length).toBe(2)
    for (const k of keys) expect(k.startsWith('brainstorm:vars-')).toBe(true)
    expect(keys[0]).not.toBe(keys[1])
  })

  it('promptFile path: substitution happens at run() time, file is read at define()', async () => {
    const reader = new FakePromptFileReader(FIXTURE_DIR, {
      [FIXTURE_PROMPT_PATH]: await readFile(FIXTURE_CONTENT_PATH, 'utf8'),
    })
    __setPromptFileReader(reader)

    const deps = makeDeps()
    const cap = capturingRunner(deps, 'tv2')
    const STEP = step.define('brainstorm', {
      agent: cap.runner,
      promptFile: '@/.orch/prompts/brainstorm.md',
    })

    const wf = workflow('test', async (run) => {
      await run(STEP, { vars: { topic: 'crows', depth: 3 } })
      await run(STEP, { vars: { topic: 'magpies' } })
    })
    await wf.execute(deps)

    expect(cap.prompts.length).toBe(2)
    expect(cap.prompts[0]).toContain('Topic: crows')
    expect(cap.prompts[0]).toContain('Depth: 3')
    expect(cap.prompts[1]).toContain('Topic: magpies')
    // Optional depth substitutes to '' when omitted.
    expect(cap.prompts[1]).toContain('Depth: \n')
  })

  it('optional {{name?}} placeholder substitutes to empty when run() omits vars', async () => {
    // Regression: `templateHasPlaceholders` previously matched only the
    // non-optional form, so `prompt: 'Hi {{name?}}'` short-circuited and the
    // raw `{{name?}}` token leaked to the runner.
    const deps = makeDeps()
    const cap = capturingRunner(deps, 'tv-optional')
    const STEP = step.define('greet', {
      agent: cap.runner,
      prompt: 'Hi {{name?}}',
    })

    const wf = workflow('test', async (run) => {
      await run(STEP)
    })
    await wf.execute(deps)

    expect(cap.prompts).toEqual(['Hi '])
  })

  it('explicit RunOverrides.prompt bypasses substitution entirely (R10)', async () => {
    const deps = makeDeps()
    const cap = capturingRunner(deps, 'tv3')
    const STEP = step.define('brainstorm', {
      agent: cap.runner,
      prompt: 'Topic: {{topic}}',
    })

    const wf = workflow('test', async (run) => {
      await run(STEP, { prompt: 'fully replaced', vars: { topic: 'ignored' } })
    })
    await wf.execute(deps)

    expect(cap.prompts).toEqual(['fully replaced'])
  })
})

describe('typed-vars: cold-clone codegen produces the right augmentation', () => {
  it('runCodegen against the reusable-step fixture emits a valid sidecar', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'orch-typed-vars-cold-'))
    try {
      const bunFs = new BunFsService()
      await bunFs.mkdir(path(`${tmp}/.orch/prompts`), { recursive: true })
      const source = await readFile(FIXTURE_CONTENT_PATH, 'utf8')
      await writeFile(`${tmp}/.orch/prompts/brainstorm.md`, source)

      const result = await runCodegen(
        { fs: bunFs },
        {
          configDir: path(tmp),
          include: ['.orch/prompts/**/*.md'],
          exclude: [],
        },
      )

      expect(result.errors).toEqual([])
      expect(result.written.length).toBe(1)
      const sidecar = await readFile(`${tmp}/.orch/prompts/brainstorm.md.d.ts`, 'utf8')
      expect(sidecar).toContain(`"@/.orch/prompts/brainstorm.md"`)
      expect(sidecar).toContain('topic: string | number | boolean')
      expect(sidecar).toContain('depth?: string | number | boolean')
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })
})
