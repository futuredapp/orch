import { describe, expect, it } from 'bun:test'
import {
  classifyKey,
  resolveStepsKeyAction,
  type StepsKeymapContext,
} from '../../../../../src/hosts/two-pane/steps-view/steps-view-keymap.ts'

const baseCtx: StepsKeymapContext = {
  helpOpen: false,
  hasErrorBanner: false,
  failureActions: false,
}

describe('resolveStepsKeyAction', () => {
  it('returns close-help for Esc while the help overlay is open', () => {
    // Arrange
    const ctx = { ...baseCtx, helpOpen: true }

    // Act
    const action = resolveStepsKeyAction('', { escape: true }, ctx)

    // Assert
    expect(action).toEqual({ type: 'close-help' })
  })

  it('returns close-help for ? while the help overlay is open', () => {
    const ctx = { ...baseCtx, helpOpen: true }

    const action = resolveStepsKeyAction('?', {}, ctx)

    expect(action).toEqual({ type: 'close-help' })
  })

  it('swallows every other key while the help overlay is open', () => {
    const ctx = { ...baseCtx, helpOpen: true }

    const quit = resolveStepsKeyAction('q', {}, ctx)
    const scroll = resolveStepsKeyAction('j', {}, ctx)
    const commit = resolveStepsKeyAction('', { return: true }, ctx)

    expect(quit).toEqual({ type: 'none' })
    expect(scroll).toEqual({ type: 'none' })
    expect(commit).toEqual({ type: 'none' })
  })

  it('returns dismiss-banner for Esc when an error banner is showing', () => {
    const ctx = { ...baseCtx, hasErrorBanner: true }

    const action = resolveStepsKeyAction('', { escape: true }, ctx)

    expect(action).toEqual({ type: 'dismiss-banner' })
  })

  it('returns none for Esc when no error banner is showing', () => {
    const action = resolveStepsKeyAction('', { escape: true }, baseCtx)

    expect(action).toEqual({ type: 'none' })
  })

  it('maps j and k to one-row scrolls', () => {
    expect(resolveStepsKeyAction('k', {}, baseCtx)).toEqual({ type: 'scroll', to: 'up' })
    expect(resolveStepsKeyAction('j', {}, baseCtx)).toEqual({ type: 'scroll', to: 'down' })
  })

  it('maps PgUp and PgDn to page scrolls', () => {
    expect(resolveStepsKeyAction('', { pageUp: true }, baseCtx)).toEqual({
      type: 'scroll',
      to: 'page-up',
    })
    expect(resolveStepsKeyAction('', { pageDown: true }, baseCtx)).toEqual({
      type: 'scroll',
      to: 'page-down',
    })
  })

  it('maps Home and g to a jump to the top', () => {
    expect(resolveStepsKeyAction('', { home: true }, baseCtx)).toEqual({
      type: 'scroll',
      to: 'top',
    })
    expect(resolveStepsKeyAction('g', {}, baseCtx)).toEqual({ type: 'scroll', to: 'top' })
  })

  it('maps End and G to a jump to the live tail', () => {
    expect(resolveStepsKeyAction('', { end: true }, baseCtx)).toEqual({
      type: 'scroll',
      to: 'bottom',
    })
    expect(resolveStepsKeyAction('G', {}, baseCtx)).toEqual({ type: 'scroll', to: 'bottom' })
  })

  it('maps the arrow keys to selection moves', () => {
    expect(resolveStepsKeyAction('', { upArrow: true }, baseCtx)).toEqual({
      type: 'move-selection',
      dir: 'up',
    })
    expect(resolveStepsKeyAction('', { downArrow: true }, baseCtx)).toEqual({
      type: 'move-selection',
      dir: 'down',
    })
  })

  it('maps Enter to a selection commit', () => {
    expect(resolveStepsKeyAction('', { return: true }, baseCtx)).toEqual({
      type: 'commit-selection',
    })
  })

  it('maps f and F to follow-live', () => {
    expect(resolveStepsKeyAction('f', {}, baseCtx)).toEqual({ type: 'follow-live' })
    expect(resolveStepsKeyAction('F', {}, baseCtx)).toEqual({ type: 'follow-live' })
  })

  it('maps Ctrl-C to quit even when failure actions are enabled', () => {
    const ctx = { ...baseCtx, failureActions: true }

    const action = resolveStepsKeyAction('c', { ctrl: true }, ctx)

    expect(action).toEqual({ type: 'quit' })
  })

  it('keeps r and c inert when failure actions are disabled', () => {
    expect(resolveStepsKeyAction('r', {}, baseCtx)).toEqual({ type: 'none' })
    expect(resolveStepsKeyAction('c', {}, baseCtx)).toEqual({ type: 'none' })
  })

  it('maps r and c to the retry actions when failure actions are enabled', () => {
    const ctx = { ...baseCtx, failureActions: true }

    expect(resolveStepsKeyAction('r', {}, ctx)).toEqual({ type: 'retry' })
    expect(resolveStepsKeyAction('R', {}, ctx)).toEqual({ type: 'retry' })
    expect(resolveStepsKeyAction('c', {}, ctx)).toEqual({ type: 'retry-continue' })
    expect(resolveStepsKeyAction('C', {}, ctx)).toEqual({ type: 'retry-continue' })
  })

  it('maps q to quit and ? to open-help', () => {
    expect(resolveStepsKeyAction('q', {}, baseCtx)).toEqual({ type: 'quit' })
    expect(resolveStepsKeyAction('?', {}, baseCtx)).toEqual({ type: 'open-help' })
  })

  it('returns none for an unbound key', () => {
    expect(resolveStepsKeyAction('x', {}, baseCtx)).toEqual({ type: 'none' })
  })
})

describe('classifyKey', () => {
  it('tags special keys ahead of character keys', () => {
    expect(classifyKey('g', { home: true })).toBe('home')
    expect(classifyKey('', { upArrow: true })).toBe('up')
    expect(classifyKey('c', { ctrl: true })).toBe('ctrl-c')
  })

  it('tags plain character keys through the char map', () => {
    expect(classifyKey('j', {})).toBe('j')
    expect(classifyKey('q', {})).toBe('q')
    expect(classifyKey('?', {})).toBe('?')
  })

  it('tags anything unrecognised as other', () => {
    expect(classifyKey('z', {})).toBe('other')
  })
})
