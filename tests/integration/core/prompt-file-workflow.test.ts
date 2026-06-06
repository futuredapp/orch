// MIGRATED → tests-new/integration/core/prompt-file-workflow.test.ts (parent U10) — relocated verbatim (import paths only); kept skipped on disk (D2).
import { afterEach, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { PromptFileError } from '../../../src/core/prompt-file/errors.ts'
import { FakePromptFileReader } from '../../../src/core/prompt-file/fake-prompt-file-reader.ts'
import { loadPrompt } from '../../../src/core/prompt-file/load-prompt.ts'
import { __setPromptFileReader } from '../../../src/core/prompt-file/prompt-file-reader.ts'
import { schema } from '../../../src/core/schema.ts'
import { step } from '../../../src/core/step.ts'
import { FakeRunner } from '../../../src/runners/index.ts'
import { FakeProcessService } from '../../../src/services/index.ts'

// Anchors. Mirrors the example workflow's file layout. After U2 (R23 break),
// substitution lives at `assemblePrompt` time, not at `step.define` time — so
// these tests assert that step.define stores the raw template and that
// `loadPrompt` composition still substitutes eagerly (loadPrompt is a separate
// path; it is the inline-composition escape hatch and continues to take vars).
const THIS_FILE = fileURLToPath(import.meta.url)
const REPO_ROOT = resolve(dirname(THIS_FILE), '..', '..', '..')
const EXAMPLE_ROOT = resolve(REPO_ROOT, 'examples')
const WORKFLOW_DIR = resolve(EXAMPLE_ROOT, 'file-prompts-demo')

function realFile(p: string): string {
  return readFileSync(p, 'utf8')
}

function freshExampleReader(): FakePromptFileReader {
  return new FakePromptFileReader(EXAMPLE_ROOT, {
    [`${WORKFLOW_DIR}/slug.md`]: realFile(`${WORKFLOW_DIR}/slug.md`),
    [`${WORKFLOW_DIR}/research.md`]: realFile(`${WORKFLOW_DIR}/research.md`),
    [`${WORKFLOW_DIR}/summarize.md`]: realFile(`${WORKFLOW_DIR}/summarize.md`),
    [`${EXAMPLE_ROOT}/.orch/prompts/session-context.md`]: realFile(
      `${EXAMPLE_ROOT}/.orch/prompts/session-context.md`,
    ),
  })
}

function fakeAgent(): FakeRunner {
  return new FakeRunner(new FakeProcessService())
}

afterEach(() => {
  __setPromptFileReader(undefined)
})

describe.skip('file-prompts-demo workflow loads with the real .md files', () => {
  it('imports the workflow module without throwing — step.define calls live inside the workflow body, so module load is purely the workflow() factory call', async () => {
    const mod = await import('../../../examples/file-prompts-demo/index.ts')

    expect(typeof mod.default).toBe('object')
    expect(typeof mod.default.execute).toBe('function')
  })
})

describe.skip('file-prompts-demo step.define stores raw templates (post-U2)', () => {
  it('slug step holds the raw template (substitution deferred to run())', () => {
    __setPromptFileReader(freshExampleReader())

    const slugStep = step.define('slug', {
      agent: fakeAgent(),
      promptFile: '@/file-prompts-demo/slug.md',
      returns: schema(z.object({ slug: z.string() })),
    })

    if (slugStep.config.kind !== 'agent') throw new Error('expected agent')
    expect(slugStep.config.prompt).toContain('{{userPrompt}}')
    expect(slugStep.config.promptFile as string).toBe(`${WORKFLOW_DIR}/slug.md`)
  })

  it('AE5: loadPrompt continues to substitute eagerly (composition escape hatch)', () => {
    __setPromptFileReader(freshExampleReader())

    const slug = 'csv-exporter'
    const sessionsDir = 'docs/sessions/csv-exporter'
    const researchBody = loadPrompt('@/file-prompts-demo/research.md', { slug, sessionsDir })
    const sessionContext = loadPrompt('@/.orch/prompts/session-context.md', { sessionsDir })

    expect(researchBody).toContain(slug)
    expect(researchBody).toContain(sessionsDir)
    expect(researchBody).not.toContain('{{')

    expect(sessionContext).toContain(sessionsDir)
    expect(sessionContext).not.toContain('{{')

    const combined = `${researchBody}\n\n${sessionContext}`
    expect(combined).toContain('Session management')
  })

  it('summarize step holds the raw template (substitution deferred to run())', () => {
    __setPromptFileReader(freshExampleReader())

    const summarizeStep = step.define('summarize', {
      agent: fakeAgent(),
      promptFile: '@/file-prompts-demo/summarize.md',
    })

    if (summarizeStep.config.kind !== 'agent') throw new Error('expected agent')
    expect(summarizeStep.config.prompt).toContain('{{sessionsDir}}')
  })
})

describe.skip('file-prompts-demo regression: broken fixture surfaces typos at run-time', () => {
  it('a workflow .md with a typo throws PromptFileError naming BOTH placeholder and key — but at run() not define()', async () => {
    const fixtureDir = resolve(REPO_ROOT, 'tests/fixtures/prompt-file-workflows/broken-typo')
    __setPromptFileReader(
      new FakePromptFileReader(REPO_ROOT, {
        [`${fixtureDir}/broken.md`]: realFile(`${fixtureDir}/broken.md`),
      }),
    )

    // Define-time succeeds — the raw template is just stored.
    const brokenStep = step.define('broken-fixture', {
      agent: fakeAgent(),
      promptFile: '@/tests/fixtures/prompt-file-workflows/broken-typo/broken.md',
    })

    expect(brokenStep.config.kind).toBe('agent')

    // The typo would surface at assemblePrompt time when the workflow runs
    // `run(STEP, { vars: { userPrompt: 'x' } })` because the template
    // references {{user_prompt}}. We verify the substitute() path catches it
    // directly here — the workflow-level scenario is covered in
    // tests/unit/core/workflow-vars-cache-key.test.ts.
    const { substitute } = await import('../../../src/core/prompt-file/substitute.ts')
    let thrown: unknown
    try {
      substitute(brokenStep.config.kind === 'agent' ? (brokenStep.config.prompt ?? '') : '', {
        userPrompt: 'x',
      })
    } catch (e) {
      thrown = e
    }

    expect(thrown).toBeInstanceOf(PromptFileError)
    const err = thrown as PromptFileError
    expect(err.cause).toBe('missing-placeholder')
    expect(err.message).toContain('user_prompt')
    expect(err.message).toContain('userPrompt')
  })
})
