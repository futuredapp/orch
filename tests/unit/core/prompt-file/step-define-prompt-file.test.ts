// MIGRATED → tests-new/unit/core/prompt-file/step-define-prompt-file.test.ts (parent U10) — relocated verbatim (import paths only); kept skipped on disk (D2).
import { afterEach, describe, expect, it } from 'bun:test'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { PromptFileError } from '../../../../src/core/prompt-file/errors.ts'
import { FakePromptFileReader } from '../../../../src/core/prompt-file/fake-prompt-file-reader.ts'
import { __setPromptFileReader } from '../../../../src/core/prompt-file/prompt-file-reader.ts'
import { schema } from '../../../../src/core/schema.ts'
import { step } from '../../../../src/core/step.ts'
import { FakeRunner } from '../../../../src/runners/index.ts'
import { FakeProcessService } from '../../../../src/services/index.ts'

const THIS_DIR = dirname(fileURLToPath(import.meta.url))
const PROJ_ROOT = dirname(dirname(dirname(THIS_DIR)))

function agent(): FakeRunner {
  return new FakeRunner(new FakeProcessService())
}

afterEach(() => {
  __setPromptFileReader(undefined)
})

// Under U2 (R23 break), `vars:` on step.define is rejected at define time.
// Substitution moved from define to assemblePrompt — these tests assert the
// new shape: define stores the raw template, and the workflow-level cache-key
// behavior + run-time substitution live in workflow-vars-cache-key.test.ts.

describe.skip('step.define with promptFile (raw template)', () => {
  it('stores the raw, unsubstituted file contents in the prompt field', () => {
    __setPromptFileReader(
      new FakePromptFileReader(PROJ_ROOT, {
        [`${THIS_DIR}/foo.md`]: 'Hello {{name}}',
      }),
    )

    const s = step.define('foo', { agent: agent(), promptFile: 'foo.md' })

    if (s.config.kind !== 'agent') throw new Error('expected agent step')
    expect(s.config.prompt).toBe('Hello {{name}}')
    expect(s.config.promptFile as string).toBe(`${THIS_DIR}/foo.md`)
  })

  it('does not retain `vars` on the resolved config', () => {
    __setPromptFileReader(
      new FakePromptFileReader(PROJ_ROOT, {
        [`${THIS_DIR}/foo.md`]: 'Hi {{n}}',
      }),
    )

    const s = step.define('foo', { agent: agent(), promptFile: 'foo.md' })

    expect((s.config as unknown as Record<string, unknown>).vars).toBeUndefined()
  })

  it('AE2 / R3: rejects both `prompt` and `promptFile` set together', () => {
    let thrown: unknown
    try {
      step.define('foo', { agent: agent(), prompt: 'inline', promptFile: 'foo.md' })
    } catch (e) {
      thrown = e
    }

    expect(thrown).toBeInstanceOf(PromptFileError)
    const err = thrown as PromptFileError
    expect(err.cause).toBe('mutex')
    expect(err.message).toContain('step.define("foo")')
    expect(err.message).toContain('pick one')
  })

  it('returns the raw file content when no placeholders are present', () => {
    __setPromptFileReader(
      new FakePromptFileReader(PROJ_ROOT, {
        [`${THIS_DIR}/foo.md`]: 'static prompt text',
      }),
    )

    const s = step.define('foo', { agent: agent(), promptFile: 'foo.md' })

    if (s.config.kind !== 'agent') throw new Error('expected agent step')
    expect(s.config.prompt).toBe('static prompt text')
  })

  it('AE4: resolves the @/ sentinel to the project root', () => {
    __setPromptFileReader(
      new FakePromptFileReader(PROJ_ROOT, {
        [`${PROJ_ROOT}/.orch/prompts/preamble.md`]: 'For {{user}}',
      }),
    )

    const s = step.define('foo', {
      agent: agent(),
      promptFile: '@/.orch/prompts/preamble.md',
    })

    if (s.config.kind !== 'agent') throw new Error('expected agent step')
    expect(s.config.prompt).toBe('For {{user}}')
    expect(s.config.promptFile as string).toBe(`${PROJ_ROOT}/.orch/prompts/preamble.md`)
  })

  it('R7: rejects a traversal path', () => {
    __setPromptFileReader(new FakePromptFileReader(PROJ_ROOT, {}))

    let thrown: unknown
    try {
      step.define('foo', { agent: agent(), promptFile: '@/../escape.md' })
    } catch (e) {
      thrown = e
    }

    expect((thrown as PromptFileError).cause).toBe('traversal')
  })

  it('produces a frozen step (preserves existing behavior)', () => {
    __setPromptFileReader(
      new FakePromptFileReader(PROJ_ROOT, {
        [`${THIS_DIR}/foo.md`]: 'x',
      }),
    )

    const s = step.define('foo', { agent: agent(), promptFile: 'foo.md' })

    expect(Object.isFrozen(s)).toBe(true)
  })
})

describe.skip('step.define interactive overload with promptFile', () => {
  it('accepts promptFile on the interactive overload and stores the raw template', () => {
    __setPromptFileReader(
      new FakePromptFileReader(PROJ_ROOT, {
        [`${THIS_DIR}/chat.md`]: 'Talk about {{topic}}',
      }),
    )

    const s = step.define('chat', {
      agent: agent(),
      mode: 'interactive',
      promptFile: 'chat.md',
    })

    if (s.config.kind !== 'agent') throw new Error('expected agent step')
    expect(s.config.prompt).toBe('Talk about {{topic}}')
    expect(s.config.mode).toBe('interactive')
  })

  it('rejects an interactive step with `returns:` (existing rule unchanged by new fields)', () => {
    __setPromptFileReader(
      new FakePromptFileReader(PROJ_ROOT, {
        [`${THIS_DIR}/chat.md`]: 'x',
      }),
    )

    expect(() =>
      step.define('chat', {
        agent: agent(),
        mode: 'interactive',
        promptFile: 'chat.md',
        returns: schema(z.object({ x: z.string() })),
      }),
    ).toThrow(/interactive steps cannot have "returns:"/)
  })
})

describe.skip('R23: vars on step.define is rejected at define time', () => {
  it('throws PromptFileError with cause "vars-on-define" when vars is set with promptFile', () => {
    __setPromptFileReader(
      new FakePromptFileReader(PROJ_ROOT, {
        [`${THIS_DIR}/foo.md`]: 'Hello {{name}}',
      }),
    )

    let thrown: unknown
    try {
      step.define('foo', {
        agent: agent(),
        promptFile: 'foo.md',
        // @ts-expect-error — `vars` is typed `never` on define; this asserts
        // the runtime backstop still throws for non-TS callers.
        vars: { name: 'x' },
      })
    } catch (e) {
      thrown = e
    }

    expect(thrown).toBeInstanceOf(PromptFileError)
    const err = thrown as PromptFileError
    expect(err.cause).toBe('vars-on-define')
    expect(err.message).toContain('step.define("foo")')
    expect(err.message).toContain('run(STEP, { vars: ... })')
  })

  it('throws cause "vars-on-define" even when promptFile is absent', () => {
    let thrown: unknown
    try {
      step.define('foo', {
        agent: agent(),
        // @ts-expect-error — see note above.
        vars: { x: 'y' },
      })
    } catch (e) {
      thrown = e
    }

    expect((thrown as PromptFileError).cause).toBe('vars-on-define')
  })

  it('error message points the user at the migration recipe', () => {
    let thrown: unknown
    try {
      step.define('foo', {
        agent: agent(),
        promptFile: 'foo.md',
        // @ts-expect-error — see note above.
        vars: { name: 'x' },
      })
    } catch (e) {
      thrown = e
    }

    expect((thrown as Error).message).toContain('typed-prompt-vars.md')
  })
})
