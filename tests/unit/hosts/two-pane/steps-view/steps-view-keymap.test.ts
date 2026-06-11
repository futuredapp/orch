import { describe, expect, it } from 'bun:test'
import {
  classifyKey,
  resolveStepsKeyAction,
  type StepsKeymapContext,
} from '../../../../../src/hosts/two-pane/steps-view/steps-view-keymap.ts'

const baseCtx: StepsKeymapContext = {
  dialogOpen: false,
  hasErrorBanner: false,
  failureActions: false,
  isLive: true,
}

describe('resolveStepsKeyAction', () => {
  it('swallows every key while a dialog is open — the dialog owns the keyboard', () => {
    const ctx = { ...baseCtx, dialogOpen: true }

    expect(resolveStepsKeyAction('q', {}, ctx)).toEqual({ type: 'none' })
    expect(resolveStepsKeyAction('j', {}, ctx)).toEqual({ type: 'none' })
    expect(resolveStepsKeyAction('', { escape: true }, ctx)).toEqual({ type: 'none' })
    expect(resolveStepsKeyAction('', { return: true }, ctx)).toEqual({ type: 'none' })
  })

  it('returns dismiss-banner for Esc when an error banner is showing', () => {
    const ctx = { ...baseCtx, hasErrorBanner: true }

    const action = resolveStepsKeyAction('', { escape: true }, ctx)

    expect(action).toEqual({ type: 'dismiss-banner' })
  })

  it('returns none for Esc when no error banner is showing', () => {
    expect(resolveStepsKeyAction('', { escape: true }, baseCtx)).toEqual({ type: 'none' })
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

  it('maps Home/g to the top and End/G to the live tail', () => {
    expect(resolveStepsKeyAction('', { home: true }, baseCtx)).toEqual({
      type: 'scroll',
      to: 'top',
    })
    expect(resolveStepsKeyAction('g', {}, baseCtx)).toEqual({ type: 'scroll', to: 'top' })
    expect(resolveStepsKeyAction('', { end: true }, baseCtx)).toEqual({
      type: 'scroll',
      to: 'bottom',
    })
    expect(resolveStepsKeyAction('G', {}, baseCtx)).toEqual({ type: 'scroll', to: 'bottom' })
  })

  it('maps the arrow keys to selection moves and Enter to a commit', () => {
    expect(resolveStepsKeyAction('', { upArrow: true }, baseCtx)).toEqual({
      type: 'move-selection',
      dir: 'up',
    })
    expect(resolveStepsKeyAction('', { downArrow: true }, baseCtx)).toEqual({
      type: 'move-selection',
      dir: 'down',
    })
    expect(resolveStepsKeyAction('', { return: true }, baseCtx)).toEqual({
      type: 'commit-selection',
    })
  })

  it('maps f and F to follow-live', () => {
    expect(resolveStepsKeyAction('f', {}, baseCtx)).toEqual({ type: 'follow-live' })
    expect(resolveStepsKeyAction('F', {}, baseCtx)).toEqual({ type: 'follow-live' })
  })

  it('maps Ctrl-C to an immediate quit even on a live run', () => {
    expect(resolveStepsKeyAction('c', { ctrl: true }, baseCtx)).toEqual({ type: 'quit' })
  })

  it('asks to confirm q on a live run and quits immediately on a terminal one', () => {
    expect(resolveStepsKeyAction('q', {}, baseCtx)).toEqual({
      type: 'open-dialog',
      dialog: 'confirm-quit',
    })
    expect(resolveStepsKeyAction('q', {}, { ...baseCtx, isLive: false })).toEqual({
      type: 'quit',
    })
  })

  it('keeps r, c, and a inert when failure actions are disabled', () => {
    expect(resolveStepsKeyAction('r', {}, baseCtx)).toEqual({ type: 'none' })
    expect(resolveStepsKeyAction('c', {}, baseCtx)).toEqual({ type: 'none' })
    expect(resolveStepsKeyAction('a', {}, baseCtx)).toEqual({ type: 'none' })
  })

  it('maps r and c to the retry actions when failure actions are enabled', () => {
    const ctx = { ...baseCtx, failureActions: true, isLive: false }

    expect(resolveStepsKeyAction('r', {}, ctx)).toEqual({ type: 'retry' })
    expect(resolveStepsKeyAction('R', {}, ctx)).toEqual({ type: 'retry' })
    expect(resolveStepsKeyAction('c', {}, ctx)).toEqual({ type: 'retry-continue' })
    expect(resolveStepsKeyAction('C', {}, ctx)).toEqual({ type: 'retry-continue' })
  })

  it('opens the failure-actions dialog on a when failure actions are enabled', () => {
    const ctx = { ...baseCtx, failureActions: true, isLive: false }

    expect(resolveStepsKeyAction('a', {}, ctx)).toEqual({
      type: 'open-dialog',
      dialog: 'failure-actions',
    })
  })

  it('opens the help dialog on ?', () => {
    expect(resolveStepsKeyAction('?', {}, baseCtx)).toEqual({
      type: 'open-dialog',
      dialog: 'help',
    })
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
