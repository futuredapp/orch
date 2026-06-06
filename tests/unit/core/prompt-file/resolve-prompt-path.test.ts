// MIGRATED → tests-new/unit/core/prompt-file/resolve-prompt-path.test.ts (parent U10) — relocated verbatim (import paths only); kept skipped on disk (D2).
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PromptFileError } from '../../../../src/core/prompt-file/errors.ts'
import { resolvePromptPath } from '../../../../src/core/prompt-file/resolve-prompt-path.ts'
import { path } from '../../../../src/services/types.ts'

const PROJ = path('/proj')
const WORKFLOW_DIR = path('/proj/examples/foo')

describe.skip('resolvePromptPath', () => {
  it('resolves a workflow-local relative path against callerDir', () => {
    const out = resolvePromptPath('foo.md', WORKFLOW_DIR, PROJ)

    expect(out as string).toBe('/proj/examples/foo/foo.md')
  })

  it('resolves a nested workflow-local path', () => {
    const out = resolvePromptPath('subdir/nested.md', WORKFLOW_DIR, PROJ)

    expect(out as string).toBe('/proj/examples/foo/subdir/nested.md')
  })

  it('resolves the @/ sentinel against the project root', () => {
    const out = resolvePromptPath('@/prompts/session-context.md', WORKFLOW_DIR, PROJ)

    expect(out as string).toBe('/proj/prompts/session-context.md')
  })

  it('AE4: same @/ fragment resolves identically from two different workflow dirs', () => {
    const fromA = resolvePromptPath('@/.orch/prompts/x.md', path('/proj/examples/a'), PROJ)
    const fromB = resolvePromptPath('@/.orch/prompts/x.md', path('/proj/examples/b'), PROJ)

    expect(fromA as string).toBe(fromB as string)
    expect(fromA as string).toBe('/proj/.orch/prompts/x.md')
  })

  it('rejects a path that escapes the project root via ..', () => {
    let thrown: unknown
    try {
      // /proj/examples/foo + ../../../etc → /proj/../etc → /etc — outside root.
      resolvePromptPath('../../../etc/passwd', WORKFLOW_DIR, PROJ)
    } catch (e) {
      thrown = e
    }

    expect(thrown).toBeInstanceOf(PromptFileError)
    expect((thrown as PromptFileError).cause).toBe('traversal')
  })

  it('rejects an @/ path that escapes the project root', () => {
    let thrown: unknown
    try {
      resolvePromptPath('@/../outside.md', WORKFLOW_DIR, PROJ)
    } catch (e) {
      thrown = e
    }

    expect(thrown).toBeInstanceOf(PromptFileError)
    expect((thrown as PromptFileError).cause).toBe('traversal')
  })

  it('rejects an empty input', () => {
    expect(() => resolvePromptPath('', WORKFLOW_DIR, PROJ)).toThrow(PromptFileError)
  })

  it('accepts a path equal to the project root edge case (resolved == root)', () => {
    // A file at the project root.
    const out = resolvePromptPath('@/README.md', WORKFLOW_DIR, PROJ)
    expect(out as string).toBe('/proj/README.md')
  })
})

describe.skip('resolvePromptPath — symlink R7 hardening', () => {
  // Finding #4: a relative path can pass the lexical isInside check while
  // pointing — via a symlink — at a target outside the project root. These
  // tests use real symlinks on real temp dirs to exercise the realpath gate.

  let projectRoot: string
  let outsideDir: string

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'orch-realpath-proj-'))
    outsideDir = await mkdtemp(join(tmpdir(), 'orch-realpath-outside-'))
  })

  afterEach(async () => {
    if (projectRoot) await rm(projectRoot, { recursive: true, force: true })
    if (outsideDir) await rm(outsideDir, { recursive: true, force: true })
  })

  it('rejects a symlink whose target sits outside the project root', async () => {
    await writeFile(join(outsideDir, 'secret.md'), 'classified payload')
    await symlink(join(outsideDir, 'secret.md'), join(projectRoot, 'escape.md'))

    let thrown: unknown
    try {
      resolvePromptPath('escape.md', path(projectRoot), path(projectRoot))
    } catch (e) {
      thrown = e
    }

    expect(thrown).toBeInstanceOf(PromptFileError)
    expect((thrown as PromptFileError).cause).toBe('traversal')
  })

  it('accepts a symlink whose target sits inside the project root', async () => {
    await writeFile(join(projectRoot, 'real.md'), 'inside')
    await symlink(join(projectRoot, 'real.md'), join(projectRoot, 'alias.md'))

    const out = resolvePromptPath('alias.md', path(projectRoot), path(projectRoot))

    // Resolves to the lexical path (not the realpath) — that's what callers
    // expect. The realpath check is purely for security, not normalization.
    expect(out as string).toBe(join(projectRoot, 'alias.md'))
  })

  it('falls back to the lexical check for non-existent paths', () => {
    // No file exists — there's nothing to realpath. The existing lexical
    // isInside check still rejects ../ traversal so this remains safe.
    const out = resolvePromptPath('does-not-exist.md', path(projectRoot), path(projectRoot))
    expect(out as string).toBe(join(projectRoot, 'does-not-exist.md'))
  })
})
