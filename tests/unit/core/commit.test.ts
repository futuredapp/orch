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

  it('accepts a message that slugifies to exactly 121 chars', () => {
    // 128 total - 'commit:'.length (7) = 121 slug chars
    const slug121 = 'a'.repeat(121)

    const s = commit(slug121)

    expect(s.name as string).toBe(`commit:${slug121}`)
  })

  it('throws for a message whose slug exceeds 121 chars', () => {
    const slug122 = 'a'.repeat(122)

    expect(() => commit(slug122)).toThrow()
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
