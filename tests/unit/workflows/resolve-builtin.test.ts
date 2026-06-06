// MIGRATED → tests-new/unit/workflows/resolve-builtin.test.ts (parent U12) — relocated verbatim (import paths only); kept skipped on disk (D2).
import { describe, expect, it } from 'bun:test'
import * as nodePath from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Path, path } from '../../../src/services/index.ts'
import { BUILTIN_NAMES, isBuiltinName, resolveBuiltin } from '../../../src/workflows/index.ts'

// The source dir is derived from THIS test file's location (repo-relative),
// independent of process.cwd(). Comparing the resolver's output against it
// proves the resolver anchors to orch's own source tree, not the caller's cwd.
const repoRoot = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), '../../..')
const sourceWorkflowsDir = nodePath.join(repoRoot, 'src', 'workflows')

describe.skip('isBuiltinName', () => {
  it('is true for a name carrying the orch:: prefix', () => {
    expect(isBuiltinName('orch::work-cc')).toBe(true)
  })

  it('is false for a bare workflow name', () => {
    expect(isBuiltinName('work-cc')).toBe(false)
  })

  it('is false for the empty string', () => {
    expect(isBuiltinName('')).toBe(false)
  })

  it('is false when orch:: appears mid-string rather than as a prefix', () => {
    expect(isBuiltinName('my-orch::work-cc')).toBe(false)
  })
})

describe.skip('resolveBuiltin', () => {
  it('resolves orch::work-cc to the packaged module under orch source, not cwd', () => {
    const resolved = resolveBuiltin('orch::work-cc')

    expect(resolved).toBe(path(nodePath.join(sourceWorkflowsDir, 'work-cc', 'index.ts')))
  })

  it('resolves orch::work-codex to the packaged codex module under orch source', () => {
    const resolved = resolveBuiltin('orch::work-codex')

    expect(resolved).toBe(path(nodePath.join(sourceWorkflowsDir, 'work-codex', 'index.ts')))
  })

  it('returns an absolute, source-anchored path (guards the dev-vs-installed decision)', () => {
    const resolved: Path = resolveBuiltin('orch::work-cc')

    expect(nodePath.isAbsolute(resolved)).toBe(true)
    expect(resolved.startsWith(sourceWorkflowsDir)).toBe(true)
  })

  it('resolves a bare name identically to its orch:: form (prefix is optional here)', () => {
    expect(resolveBuiltin('work-cc')).toBe(resolveBuiltin('orch::work-cc'))
  })

  it('throws naming the available built-ins for an unknown built-in name', () => {
    try {
      resolveBuiltin('orch::nope')
      expect.unreachable('should have thrown')
    } catch (err) {
      const message = (err as Error).message
      expect(message).toContain('orch::nope')
      for (const name of BUILTIN_NAMES) {
        expect(message).toContain(`orch::${name}`)
      }
    }
  })

  it('rejects an inherited Object.prototype key with the unknown-built-in error, not a TypeError', () => {
    expect(() => resolveBuiltin('orch::constructor')).toThrow(/Unknown built-in workflow/)
    expect(() => resolveBuiltin('orch::__proto__')).toThrow(/Unknown built-in workflow/)
  })
})
