import { afterEach, describe, expect, it } from 'bun:test'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PromptFileError } from '../../../../src/core/prompt-file/errors.ts'
import { FakePromptFileReader } from '../../../../src/core/prompt-file/fake-prompt-file-reader.ts'
import { loadPrompt } from '../../../../src/core/prompt-file/load-prompt.ts'
import { __setPromptFileReader } from '../../../../src/core/prompt-file/prompt-file-reader.ts'

// This test file lives at <root>/tests/unit/core/prompt-file/load-prompt.test.ts.
// callerDir(loadPrompt) returns this directory. We pretend our "project root"
// is one level up so we can test workflow-local and @/ resolution.
const THIS_DIR = dirname(fileURLToPath(import.meta.url))
const PROJ_ROOT = dirname(dirname(dirname(THIS_DIR)))

afterEach(() => {
  __setPromptFileReader(undefined)
})

describe('loadPrompt', () => {
  it('reads a workflow-local file and substitutes vars', () => {
    const fake = new FakePromptFileReader(PROJ_ROOT, {
      [`${THIS_DIR}/greeting.md`]: 'Hello {{name}}',
    })
    __setPromptFileReader(fake)

    const out = loadPrompt('greeting.md', { name: 'world' })

    expect(out).toBe('Hello world')
  })

  it('AE5: resolves the @/ sentinel against the project root', () => {
    const fake = new FakePromptFileReader(PROJ_ROOT, {
      [`${PROJ_ROOT}/.orch/prompts/preamble.md`]: 'Preamble for {{user}}',
    })
    __setPromptFileReader(fake)

    const out = loadPrompt('@/.orch/prompts/preamble.md', { user: 'alice' })

    expect(out).toBe('Preamble for alice')
  })

  it('AE5: composing two fragments produces the substituted concatenation', () => {
    const fake = new FakePromptFileReader(PROJ_ROOT, {
      [`${THIS_DIR}/intro.md`]: 'Intro {{topic}}',
      [`${PROJ_ROOT}/.orch/prompts/session-context.md`]: 'Sessions at {{dir}}',
    })
    __setPromptFileReader(fake)

    const intro = loadPrompt('intro.md', { topic: 't' })
    const ctx = loadPrompt('@/.orch/prompts/session-context.md', { dir: '/tmp' })

    expect(intro).toBe('Intro t')
    expect(ctx).toBe('Sessions at /tmp')
  })

  it('throws read-failed when the file is not in the reader', () => {
    const fake = new FakePromptFileReader(PROJ_ROOT, {})
    __setPromptFileReader(fake)

    let thrown: unknown
    try {
      loadPrompt('missing.md', {})
    } catch (e) {
      thrown = e
    }

    expect(thrown).toBeInstanceOf(PromptFileError)
    const err = thrown as PromptFileError
    expect(err.cause).toBe('read-failed')
    expect(err.promptFile).toContain('missing.md')
  })

  it('propagates missing-placeholder from substitute', () => {
    const fake = new FakePromptFileReader(PROJ_ROOT, {
      [`${THIS_DIR}/foo.md`]: 'uses {{title}}',
    })
    __setPromptFileReader(fake)

    let thrown: unknown
    try {
      loadPrompt('foo.md', { name: 'x' })
    } catch (e) {
      thrown = e
    }

    expect(thrown).toBeInstanceOf(PromptFileError)
    expect((thrown as PromptFileError).cause).toBe('missing-placeholder')
  })

  it('rejects a traversal path before any file read', () => {
    __setPromptFileReader(new FakePromptFileReader(PROJ_ROOT, {}))

    let thrown: unknown
    try {
      // @/.. is guaranteed to escape the project root.
      loadPrompt('@/../escape.md', {})
    } catch (e) {
      thrown = e
    }

    expect((thrown as PromptFileError).cause).toBe('traversal')
  })

  it('rejects unsupported vars types at the call site', () => {
    __setPromptFileReader(new FakePromptFileReader(PROJ_ROOT, {}))

    let thrown: unknown
    try {
      // @ts-expect-error — testing runtime guard against unsupported type
      loadPrompt('foo.md', { items: ['a'] })
    } catch (e) {
      thrown = e
    }

    expect((thrown as PromptFileError).cause).toBe('unsupported-type')
  })

  it('throws PromptFileError(cause: "empty-prompt") when the file is empty', () => {
    // Finding #31: an empty .md file used to silently render as an empty
    // prompt — workflows would dispatch agents with no instruction at all.
    // Both pure whitespace and completely empty contents must throw.
    const fake = new FakePromptFileReader(PROJ_ROOT, {
      [`${THIS_DIR}/empty.md`]: '',
      [`${THIS_DIR}/whitespace.md`]: '\n  \t\n',
    })
    __setPromptFileReader(fake)

    for (const file of ['empty.md', 'whitespace.md']) {
      let thrown: unknown
      try {
        loadPrompt(file)
      } catch (e) {
        thrown = e
      }
      expect(thrown).toBeInstanceOf(PromptFileError)
      expect((thrown as PromptFileError).cause).toBe('empty-prompt')
      expect((thrown as Error).message).toContain(file)
    }
  })

  it('does not share state between calls', () => {
    const fake = new FakePromptFileReader(PROJ_ROOT, {
      [`${THIS_DIR}/a.md`]: '{{x}}',
      [`${THIS_DIR}/b.md`]: '{{y}}',
    })
    __setPromptFileReader(fake)

    expect(loadPrompt('a.md', { x: '1' })).toBe('1')
    expect(loadPrompt('b.md', { y: '2' })).toBe('2')
  })
})
