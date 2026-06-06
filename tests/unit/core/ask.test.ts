import { describe, expect, it } from 'bun:test'
import { ask } from '../../../src/core/ask.ts'

describe('ask() factory', () => {
  it('returns a frozen Step with kind ask', () => {
    const s = ask({ name: 'continue', question: 'continue?', buttons: ['yes', 'no'] })

    expect(s.config.kind).toBe('ask')
    expect(Object.isFrozen(s)).toBe(true)
  })

  it('prefixes the step name slug with "ask:"', () => {
    const s = ask({ name: 'Continue Now', question: 'q', buttons: ['ok'] })

    expect(s.name as string).toBe('ask:continue-now')
  })

  it('preserves the question, fields, and buttons in config', () => {
    const s = ask({
      name: 'continue',
      question: 'do it?',
      fields: { notes: { placeholder: 'optional' } },
      buttons: ['yes', 'no'],
    })

    if (s.config.kind !== 'ask') throw new Error('expected ask config')
    expect(s.config.question).toBe('do it?')
    expect(Object.keys(s.config.fields)).toEqual(['notes'])
    expect(s.config.buttons).toEqual(['yes', 'no'])
  })

  it('omits defaultWhenNoninteractive from config when not provided', () => {
    const s = ask({ name: 'q', question: 'q?', buttons: ['ok'] })

    if (s.config.kind !== 'ask') throw new Error('expected ask config')
    expect(s.config.defaultWhenNoninteractive).toBeUndefined()
  })

  it('preserves defaultWhenNoninteractive when provided', () => {
    const s = ask({
      name: 'q',
      question: 'q?',
      buttons: ['ok'],
      defaultWhenNoninteractive: { button: 'ok' },
    })

    if (s.config.kind !== 'ask') throw new Error('expected ask config')
    expect(s.config.defaultWhenNoninteractive).toEqual({ button: 'ok' })
  })

  it('rejects an empty name', () => {
    expect(() => ask({ name: '', question: 'q?', buttons: ['ok'] })).toThrow('must not be empty')
  })

  it('rejects a whitespace-only name', () => {
    expect(() => ask({ name: '   ', question: 'q?', buttons: ['ok'] })).toThrow('whitespace-only')
  })

  it('rejects a name containing a null byte', () => {
    expect(() => ask({ name: 'a\0b', question: 'q?', buttons: ['ok'] })).toThrow('null')
  })

  it('rejects a name containing a newline', () => {
    expect(() => ask({ name: 'a\nb', question: 'q?', buttons: ['ok'] })).toThrow('newline')
  })

  it('rejects a name beginning with a dash', () => {
    expect(() => ask({ name: '-leading', question: 'q?', buttons: ['ok'] })).toThrow('dash')
  })

  it('rejects an all-punctuation name that slugifies to empty', () => {
    expect(() => ask({ name: '!!!', question: 'q?', buttons: ['ok'] })).toThrow('empty slug')
  })

  it('rejects an empty question', () => {
    expect(() => ask({ name: 'q', question: '', buttons: ['ok'] })).toThrow(
      'question must not be empty',
    )
  })

  it('rejects a whitespace-only question', () => {
    expect(() => ask({ name: 'q', question: '   ', buttons: ['ok'] })).toThrow('whitespace-only')
  })

  it('rejects a question containing a null byte', () => {
    expect(() => ask({ name: 'q', question: 'a\0b', buttons: ['ok'] })).toThrow('null')
  })

  it('rejects an empty buttons array', () => {
    expect(() => ask({ name: 'q', question: 'q?', buttons: [] })).toThrow('non-empty array')
  })

  it('rejects duplicate button labels', () => {
    expect(() => ask({ name: 'q', question: 'q?', buttons: ['yes', 'yes'] })).toThrow('unique')
  })

  it('rejects an empty button label', () => {
    expect(() => ask({ name: 'q', question: 'q?', buttons: [''] })).toThrow('must not be empty')
  })

  it('rejects a button label containing a newline', () => {
    expect(() => ask({ name: 'q', question: 'q?', buttons: ['a\nb'] })).toThrow('newline')
  })

  it('rejects a field key starting with a digit', () => {
    expect(() =>
      ask({ name: 'q', question: 'q?', fields: { '1bad': {} }, buttons: ['ok'] }),
    ).toThrow('invalid')
  })

  it('rejects a field key containing a hyphen', () => {
    expect(() =>
      ask({ name: 'q', question: 'q?', fields: { 'bad-key': {} }, buttons: ['ok'] }),
    ).toThrow('invalid')
  })

  it('rejects a field key starting with an underscore', () => {
    expect(() => ask({ name: 'q', question: 'q?', fields: { _bad: {} }, buttons: ['ok'] })).toThrow(
      'invalid',
    )
  })

  it('rejects a field key containing a dollar sign', () => {
    expect(() => ask({ name: 'q', question: 'q?', fields: { $bad: {} }, buttons: ['ok'] })).toThrow(
      'invalid',
    )
  })

  it('rejects a field key matching __proto__', () => {
    // `{ __proto__: x }` literal sets the prototype, not a property — use
    // `JSON.parse` to construct an object whose OWN keys include __proto__.
    const fields = JSON.parse('{"__proto__": {}}')
    expect(() => ask({ name: 'q', question: 'q?', fields, buttons: ['ok'] })).toThrow('reserved')
  })

  it('rejects a field key matching constructor', () => {
    expect(() =>
      ask({ name: 'q', question: 'q?', fields: { constructor: {} }, buttons: ['ok'] }),
    ).toThrow('reserved')
  })

  it('rejects a field key matching prototype', () => {
    expect(() =>
      ask({ name: 'q', question: 'q?', fields: { prototype: {} }, buttons: ['ok'] }),
    ).toThrow('reserved')
  })

  it('accepts a valid field key with letters, digits, and underscores', () => {
    const s = ask({
      name: 'q',
      question: 'q?',
      fields: { notes_2: { placeholder: 'p' } },
      buttons: ['ok'],
    })

    if (s.config.kind !== 'ask') throw new Error('expected ask config')
    expect(Object.keys(s.config.fields)).toEqual(['notes_2'])
  })
})
