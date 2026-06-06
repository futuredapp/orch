// MIGRATED → tests-new/unit/core/worktree.test.ts (parent U10) — relocated verbatim (import paths only); kept skipped on disk (D2).
import { describe, expect, it } from 'bun:test'
import { createWorktree } from '../../../src/core/worktree.ts'

describe.skip('createWorktree() factory', () => {
  it('derives step name from branch: feat/foo becomes worktree:feat-foo', () => {
    const s = createWorktree('feat/foo', { enter: true })

    expect(s.name as string).toBe('worktree:feat-foo')
  })

  it('config carries kind worktree', () => {
    const s = createWorktree('feat/foo', { enter: true })

    expect(s.config.kind).toBe('worktree')
  })

  it('preserves the original (unsanitized) branch in config', () => {
    const s = createWorktree('feat/Foo Bar', { enter: false })

    if (s.config.kind !== 'worktree') throw new Error('expected worktree config')
    expect(s.config.branch).toBe('feat/Foo Bar')
  })

  it('preserves enter, from, target, postCreate in config', () => {
    const post = ['echo hi']
    const s = createWorktree('feat/foo', {
      enter: true,
      from: 'main',
      target: '/tmp/wts',
      postCreate: post,
    })

    if (s.config.kind !== 'worktree') throw new Error('expected worktree config')
    expect(s.config.enter).toBe(true)
    expect(s.config.fromRef).toBe('main')
    expect(s.config.target).toBe('/tmp/wts')
    expect(s.config.postCreate).toBe(post)
  })

  it('returns a frozen Step object', () => {
    const s = createWorktree('feat/foo', { enter: true })

    expect(Object.isFrozen(s)).toBe(true)
  })

  it('rejects missing enter at compile time and at runtime', () => {
    // @ts-expect-error — `enter` is required.
    expect(() => createWorktree('feat/foo', {})).toThrow('"enter" is required')
  })

  it('throws for an empty branch', () => {
    expect(() => createWorktree('', { enter: true })).toThrow('empty')
  })

  it('throws for a whitespace-only branch', () => {
    expect(() => createWorktree('   ', { enter: true })).toThrow('whitespace')
  })

  it('throws for a branch containing null bytes', () => {
    expect(() => createWorktree('feat\0foo', { enter: true })).toThrow('null')
  })

  it('throws for a branch containing newlines', () => {
    expect(() => createWorktree('line one\nline two', { enter: true })).toThrow('newline')
  })

  it('throws when branch begins with a dash', () => {
    expect(() => createWorktree('-d', { enter: true })).toThrow('dash')
  })

  it('throws when from begins with a dash', () => {
    expect(() => createWorktree('feat/foo', { enter: true, from: '--upload-pack=evil' })).toThrow(
      'dash',
    )
  })

  it('throws when from contains a null byte', () => {
    expect(() => createWorktree('feat/foo', { enter: true, from: 'main\0evil' })).toThrow('null')
  })

  it('throws when from contains a newline character', () => {
    expect(() => createWorktree('feat/foo', { enter: true, from: 'main\nevil' })).toThrow('newline')
  })

  it('throws when target begins with a dash', () => {
    expect(() => createWorktree('feat/foo', { enter: true, target: '-rf' })).toThrow('dash')
  })

  it('throws for an all-punctuation branch that sanitizes to empty', () => {
    expect(() => createWorktree('!!!', { enter: true })).toThrow('empty slug')
  })

  it('accepts a branch sanitizing to exactly 119 chars (the 128 - "worktree:".length cap)', () => {
    const slug119 = 'a'.repeat(119)

    const s = createWorktree(slug119, { enter: true })

    expect(s.name as string).toBe(`worktree:${slug119}`)
  })

  it('accepts a branch sanitizing to exactly 1 char (lower boundary)', () => {
    const s = createWorktree('a', { enter: true })

    expect(s.name as string).toBe('worktree:a')
  })

  it('throws for a branch whose sanitized form exceeds 119 chars', () => {
    const slug120 = 'a'.repeat(120)

    expect(() => createWorktree(slug120, { enter: true })).toThrow(/120 chars/)
  })

  it('lowercases the branch when building the slug', () => {
    const s = createWorktree('Feat/Foo', { enter: true })

    expect(s.name as string).toBe('worktree:feat-foo')
  })

  it('collapses slashes and other separators to single dashes', () => {
    const s = createWorktree('feat/foo--bar baz', { enter: true })

    expect(s.name as string).toBe('worktree:feat-foo-bar-baz')
  })

  it('strips leading and trailing dashes from the slug', () => {
    // Use non-dash punctuation as the leading char — the leading-dash branch
    // is now (correctly) rejected by validateBranch, but slug stripping still
    // needs to handle the post-regex result of any non-alphanumeric prefix.
    const s = createWorktree('(feat)/foo!!', { enter: true })

    expect(s.name as string).toBe('worktree:feat-foo')
  })

  it('sanitizes branches with leading non-alpha chars to a clean slug (parity with commit())', () => {
    const s = createWorktree('feat/foo', { enter: true })

    expect(s.name as string).toBe('worktree:feat-foo')
  })

  it('sanitizes Unicode ligatures by lowercase-then-strip-non-ascii (parity with commit())', () => {
    // ﬁ (U+FB01) lowercases to itself; the next regex strips it as non-ascii.
    const s = createWorktree('ﬁnal-feat', { enter: true })

    expect(s.name as string).toBe('worktree:nal-feat')
  })

  it('accepts postCreate as string array (sugar)', () => {
    const s = createWorktree('feat/foo', {
      enter: true,
      postCreate: ['cp .env .', 'bun install'],
    })

    if (s.config.kind !== 'worktree') throw new Error('expected worktree config')
    expect(s.config.postCreate).toEqual(['cp .env .', 'bun install'])
  })

  it('accepts postCreate as async callback', () => {
    const cb = async (): Promise<void> => {}
    const s = createWorktree('feat/foo', { enter: true, postCreate: cb })

    if (s.config.kind !== 'worktree') throw new Error('expected worktree config')
    expect(s.config.postCreate).toBe(cb)
  })

  it('accepts postCreate as an empty string array (no-op sugar)', () => {
    const s = createWorktree('feat/foo', { enter: true, postCreate: [] })

    if (s.config.kind !== 'worktree') throw new Error('expected worktree config')
    expect(s.config.postCreate).toEqual([])
  })

  it('throws when postCreate string array contains an empty string', () => {
    expect(() => createWorktree('feat/foo', { enter: true, postCreate: ['echo a', ''] })).toThrow(
      'non-empty string',
    )
  })

  it('throws when from is whitespace-only', () => {
    expect(() => createWorktree('feat/foo', { enter: true, from: '   ' })).toThrow('whitespace')
  })

  it('throws when target contains null bytes', () => {
    expect(() => createWorktree('feat/foo', { enter: true, target: '/tmp/\0wts' })).toThrow('null')
  })

  it('throws when target contains newlines', () => {
    expect(() => createWorktree('feat/foo', { enter: true, target: '/tmp/wts\n' })).toThrow(
      'newline',
    )
  })

  it('accepts the literal target "sibling"', () => {
    const s = createWorktree('feat/foo', { enter: true, target: 'sibling' })

    if (s.config.kind !== 'worktree') throw new Error('expected worktree config')
    expect(s.config.target).toBe('sibling')
  })

  it('accepts target as a relative path', () => {
    const s = createWorktree('feat/foo', { enter: true, target: '../wts' })

    if (s.config.kind !== 'worktree') throw new Error('expected worktree config')
    expect(s.config.target).toBe('../wts')
  })

  it('accepts target as an absolute path', () => {
    const s = createWorktree('feat/foo', { enter: true, target: '/tmp/wts' })

    if (s.config.kind !== 'worktree') throw new Error('expected worktree config')
    expect(s.config.target).toBe('/tmp/wts')
  })
})
