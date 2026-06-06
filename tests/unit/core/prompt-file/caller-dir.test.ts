// MIGRATED → tests-new/unit/core/prompt-file/caller-dir.test.ts (parent U10) — relocated verbatim (import paths only); kept skipped on disk (D2).
import { describe, expect, it } from 'bun:test'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { callerDir, parseCallerDir } from '../../../../src/core/prompt-file/caller-dir.ts'
import { PromptFileError } from '../../../../src/core/prompt-file/errors.ts'

const THIS_DIR = dirname(fileURLToPath(import.meta.url))

describe.skip('callerDir', () => {
  it('returns the directory of the test file itself when called directly', () => {
    const dir = callerDir(callerDir)

    expect(dir as string).toBe(THIS_DIR)
  })

  // Note: an "in-test wrapper" test is unreliable on Bun because Bun
  // aggressively inlines short user functions, dropping their stack frames.
  // The real-call paths (defineStep, loadPrompt) do enough surrounding work
  // that they are NOT inlined; their behavior is covered by the
  // step-define-prompt-file.test.ts and load-prompt.test.ts suites.
  // parseCallerDir (below) exercises the multi-frame skip logic directly
  // against hand-crafted stacks without depending on engine quirks.
})

describe.skip('parseCallerDir', () => {
  it('returns the dir of the frame immediately after the named skip frame', () => {
    const stack =
      'Error\n' +
      '    at callerDir (file:///abs/src/core/prompt-file/caller-dir.ts:5:5)\n' +
      '    at loadPrompt (file:///abs/src/core/prompt-file/load-prompt.ts:10:5)\n' +
      '    at userWorkflow (file:///abs/examples/foo/index.ts:7:3)'

    const dir = parseCallerDir(stack, 'loadPrompt')

    expect(dir as unknown as string).toBe('/abs/examples/foo')
  })

  it('walks past multiple internal frames to reach the defineStep caller', () => {
    const stack =
      'Error\n' +
      '    at callerDir (file:///abs/src/core/prompt-file/caller-dir.ts:5:5)\n' +
      '    at resolvePromptFile (file:///abs/src/core/step.ts:200:5)\n' +
      '    at defineStep (file:///abs/src/core/step.ts:150:5)\n' +
      '    at Object.<anonymous> (file:///abs/examples/foo/index.ts:7:3)'

    const dir = parseCallerDir(stack, 'defineStep')

    expect(dir as unknown as string).toBe('/abs/examples/foo')
  })

  it('parses Node-style stack with bare absolute path frames after the skip', () => {
    const stack =
      'Error\n    at loadPrompt (/abs/src/core/prompt-file/load-prompt.ts:10:5)\n' +
      '    at handler (/proj/lib/handler.ts:42:8)'

    const dir = parseCallerDir(stack, 'loadPrompt')

    expect(dir as unknown as string).toBe('/proj/lib')
  })

  it('matches dotted function names by their trailing token', () => {
    const stack =
      'Error\n' +
      '    at Object.defineStep (file:///abs/src/core/step.ts:150:5)\n' +
      '    at user (file:///abs/examples/foo/index.ts:7:3)'

    const dir = parseCallerDir(stack, 'defineStep')

    expect(dir as unknown as string).toBe('/abs/examples/foo')
  })

  it('returns undefined when no frame matches skipName', () => {
    const stack =
      'Error\n' + '    at somethingElse (file:///abs/src/core/prompt-file/caller-dir.ts:5:5)'

    expect(parseCallerDir(stack, 'loadPrompt')).toBeUndefined()
  })

  it('returns undefined when the skip frame is the last frame', () => {
    const stack = 'Error\n    at loadPrompt (file:///abs/src/core/prompt-file/load-prompt.ts:10:5)'

    expect(parseCallerDir(stack, 'loadPrompt')).toBeUndefined()
  })

  it('returns undefined for an empty stack', () => {
    expect(parseCallerDir('', 'loadPrompt')).toBeUndefined()
  })
})

describe.skip('callerDir failure path', () => {
  it('throws PromptFileError(cause:read-failed) when the stack has no parseable frames', () => {
    // Force the no-frame branch by intercepting the stack getter on the
    // single Error instance that `callerDir` constructs. We patch the
    // `Error` constructor for one synchronous call and restore it in
    // `finally` so the test never leaks global state. With an empty stack,
    // `parseCallerDir` returns undefined and `callerDir` must throw.
    const OriginalError = globalThis.Error
    // biome-ignore lint/suspicious/noExplicitAny: minimal targeted patch for one call
    const Patched: any = function PatchedError(msg?: string): Error {
      const err = new OriginalError(msg)
      Object.defineProperty(err, 'stack', { value: '', configurable: true })
      return err
    }
    Patched.prototype = OriginalError.prototype
    // biome-ignore lint/suspicious/noExplicitAny: see above
    ;(globalThis as any).Error = Patched

    let thrown: unknown
    try {
      try {
        callerDir(callerDir)
      } catch (e) {
        thrown = e
      }
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: restore
      ;(globalThis as any).Error = OriginalError
    }

    expect(thrown).toBeInstanceOf(PromptFileError)
    expect((thrown as PromptFileError).cause).toBe('read-failed')
  })
})
