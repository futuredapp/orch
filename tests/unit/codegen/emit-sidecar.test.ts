import { describe, expect, it } from 'bun:test'
import { emitSidecar } from '../../../src/codegen/emit-sidecar.ts'
import { path } from '../../../src/services/types.ts'

describe('emitSidecar', () => {
  const projectRoot = path('/proj')

  it('produces a .d.ts targeted next to the source file', () => {
    const out = emitSidecar(path('/proj/.orch/prompts/x.md'), projectRoot, {
      required: ['a'],
      optional: ['b'],
    })
    expect(String(out.targetPath)).toBe('/proj/.orch/prompts/x.md.d.ts')
  })

  it('augments PromptFileRegistry under the `@/<relative>` key', () => {
    const out = emitSidecar(path('/proj/.orch/prompts/x.md'), projectRoot, {
      required: ['a'],
      optional: ['b'],
    })
    expect(out.registryKey).toBe('@/.orch/prompts/x.md')
    expect(out.content).toContain(`"@/.orch/prompts/x.md"`)
    expect(out.content).toContain(`declare module 'orch'`)
    expect(out.content).toContain('interface PromptFileRegistry')
  })

  it('emits required keys as `string | number | boolean`', () => {
    const out = emitSidecar(path('/proj/.orch/prompts/x.md'), projectRoot, {
      required: ['topic'],
      optional: [],
    })
    expect(out.content).toContain('topic: string | number | boolean')
  })

  it('emits optional keys with a trailing `?`', () => {
    const out = emitSidecar(path('/proj/.orch/prompts/x.md'), projectRoot, {
      required: [],
      optional: ['depth'],
    })
    expect(out.content).toContain('depth?: string | number | boolean')
  })

  it('emits both required and optional keys joined with `;`', () => {
    const out = emitSidecar(path('/proj/.orch/prompts/x.md'), projectRoot, {
      required: ['topic'],
      optional: ['depth'],
    })
    expect(out.content).toContain(
      'topic: string | number | boolean; depth?: string | number | boolean',
    )
  })

  it('emits `Record<string, never>` for a placeholder-free template', () => {
    const out = emitSidecar(path('/proj/.orch/prompts/static.md'), projectRoot, {
      required: [],
      optional: [],
    })
    expect(out.content).toContain(': Record<string, never>')
  })

  it('ends with `export {}` to make the sidecar a module', () => {
    const out = emitSidecar(path('/proj/.orch/prompts/x.md'), projectRoot, {
      required: ['a'],
      optional: [],
    })
    expect(out.content.trimEnd().endsWith('export {}')).toBe(true)
  })

  it('starts with an AUTO-GENERATED comment header', () => {
    const out = emitSidecar(path('/proj/.orch/prompts/x.md'), projectRoot, {
      required: ['a'],
      optional: [],
    })
    expect(out.content.startsWith('// AUTO-GENERATED')).toBe(true)
  })

  it('throws when the source path contains a newline (comment-injection guard)', () => {
    // Without the guard, a newline in the source path would break out of the
    // `// Source: <relative>` single-line comment and inject TypeScript
    // declarations into the emitted sidecar.
    expect(() =>
      emitSidecar(path('/proj/.orch/prompts/evil\ninjected.md'), projectRoot, {
        required: [],
        optional: [],
      }),
    ).toThrow(/newline/)
  })
})
