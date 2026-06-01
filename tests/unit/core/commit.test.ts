import { describe, expect, it } from 'bun:test'
import { commit } from '../../../src/core/commit.ts'

describe('commit() factory', () => {
  it('derives step name from message: after research becomes commit:after-research', () => {
    const s = commit('after research')

    expect(s.name as string).toBe('commit:after-research')
  })

  it('config has kind commit', () => {
    const s = commit('checkpoint')

    expect(s.config.kind).toBe('commit')
  })

  it('preserves the original message in config', () => {
    const s = commit('checkpoint after research')

    if (s.config.kind !== 'commit') throw new Error('expected commit config')
    expect(s.config.message).toBe('checkpoint after research')
  })

  it('returns a frozen Step object', () => {
    const s = commit('freeze me')

    expect(Object.isFrozen(s)).toBe(true)
  })

  it('throws for an empty message', () => {
    expect(() => commit('')).toThrow()
  })

  it('throws for a whitespace-only message', () => {
    expect(() => commit('   ')).toThrow()
  })

  it('throws for all-punctuation message that slugifies to empty', () => {
    expect(() => commit('!!!')).toThrow()
  })

  it('throws for a message containing null bytes', () => {
    expect(() => commit('hello\0world')).toThrow('null')
  })

  it('throws for a message containing newlines', () => {
    expect(() => commit('line one\nline two')).toThrow('newline')
  })

  it('accepts a message that slugifies to exactly 505 chars', () => {
    // 512 total (MAX_STEP_NAME_LENGTH, widened by U4 to accommodate sub
    // cache keys) - 'commit:'.length (7) = 505 slug chars
    const slug505 = 'a'.repeat(505)

    const s = commit(slug505)

    expect(s.name as string).toBe(`commit:${slug505}`)
  })

  it('throws for a message whose slug exceeds 505 chars', () => {
    const slug506 = 'a'.repeat(506)

    expect(() => commit(slug506)).toThrow()
  })

  it('strips leading and trailing non-alphanumeric characters from the slug', () => {
    const s = commit('--hello world--')

    expect(s.name as string).toBe('commit:hello-world')
  })

  it('lowercases the message in the slug', () => {
    const s = commit('Checkpoint After Research')

    expect(s.name as string).toBe('commit:checkpoint-after-research')
  })
})
