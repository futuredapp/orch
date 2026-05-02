import { describe, expect, it } from 'bun:test'
import { render } from 'ink-testing-library'
import { AskApp } from '../../../../src/services/prompt/ink-app.tsx'
import type { PromptResult, PromptSpec } from '../../../../src/services/prompt/prompt-service.ts'

// ink-testing-library raw key codes — Ink interprets these as keypress events.
const TAB = '\t'
const SHIFT_TAB = '[Z'
const ENTER = '\r'
const ESC = ''
const CTRL_C = ''

const SPEC_TWO_FIELDS_TWO_BUTTONS: PromptSpec = {
  question: 'continue or retry?',
  fields: [{ name: 'notes', placeholder: 'optional' }, { name: 'reason' }],
  buttons: ['continue', 'retry'],
}

const SPEC_NO_FIELDS_TWO_BUTTONS: PromptSpec = {
  question: 'continue?',
  fields: [],
  buttons: ['ok', 'cancel'],
}

interface Resolver {
  readonly onResolve: (r: PromptResult) => void
  readonly take: () => PromptResult | undefined
}

function makeResolver(): Resolver {
  let captured: PromptResult | undefined
  return {
    onResolve: (r) => {
      captured = r
    },
    take: () => captured,
  }
}

// Ink batches state changes through React's reconciler before re-rendering,
// and `useFocus`'s focus-id update lands on the same tick path. 5 ms is too
// short for a multi-step state machine (focus → re-render → re-subscribe
// useInput) to settle; 30 ms is empirically the floor below which `Tab` /
// `Enter` sequences race the reconciler. Use real `setTimeout`, not fake
// timers — Ink relies on the real event loop for `setRawMode` and stdin
// readable callbacks.
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 30))
}

describe('AskApp', () => {
  it('renders the question, all field labels, and all button labels', async () => {
    const r = makeResolver()
    const ui = render(<AskApp spec={SPEC_TWO_FIELDS_TWO_BUTTONS} onResolve={r.onResolve} />)
    await tick()

    const frame = ui.lastFrame() ?? ''
    expect(frame).toContain('continue or retry?')
    expect(frame).toContain('notes:')
    expect(frame).toContain('reason:')
    expect(frame).toContain('continue')
    expect(frame).toContain('retry')

    ui.unmount()
  })

  it('cancels on Esc with the values typed so far', async () => {
    const r = makeResolver()
    const ui = render(<AskApp spec={SPEC_TWO_FIELDS_TWO_BUTTONS} onResolve={r.onResolve} />)
    await tick()

    ui.stdin.write('hi')
    await tick()
    ui.stdin.write(ESC)
    await tick()

    expect(r.take()).toEqual({
      cancelled: true,
      fields: { notes: 'hi', reason: '' },
    })

    ui.unmount()
  })

  it('cancels on Ctrl-C with the values typed so far', async () => {
    const r = makeResolver()
    const ui = render(<AskApp spec={SPEC_TWO_FIELDS_TWO_BUTTONS} onResolve={r.onResolve} />)
    await tick()

    ui.stdin.write(CTRL_C)
    await tick()

    expect(r.take()).toEqual({
      cancelled: true,
      fields: { notes: '', reason: '' },
    })

    ui.unmount()
  })

  it('typing into the focused TextInput updates the field value at submit', async () => {
    const r = makeResolver()
    const ui = render(<AskApp spec={SPEC_TWO_FIELDS_TWO_BUTTONS} onResolve={r.onResolve} />)
    await tick()

    // First field auto-focuses; type into it.
    ui.stdin.write('hello')
    await tick()
    // Tab over the second field, then to the first button.
    ui.stdin.write(TAB)
    await tick()
    ui.stdin.write(TAB)
    await tick()
    ui.stdin.write(ENTER)
    await tick()

    expect(r.take()).toEqual({
      cancelled: false,
      button: 'continue',
      fields: { notes: 'hello', reason: '' },
    })

    ui.unmount()
  })

  it('Tab cycles focus from field 0 to field 1 to button 0 to button 1', async () => {
    const r = makeResolver()
    const ui = render(<AskApp spec={SPEC_TWO_FIELDS_TWO_BUTTONS} onResolve={r.onResolve} />)
    await tick()

    // Three Tab presses bring focus from field 0 → field 1 → button 0 → button 1.
    ui.stdin.write(TAB)
    await tick()
    ui.stdin.write(TAB)
    await tick()
    ui.stdin.write(TAB)
    await tick()
    ui.stdin.write(ENTER)
    await tick()

    expect(r.take()).toEqual({
      cancelled: false,
      button: 'retry',
      fields: { notes: '', reason: '' },
    })

    ui.unmount()
  })

  it('Shift-Tab cycles focus backwards', async () => {
    const r = makeResolver()
    const ui = render(<AskApp spec={SPEC_TWO_FIELDS_TWO_BUTTONS} onResolve={r.onResolve} />)
    await tick()

    // Forward to field 1, back to field 0, forward 3× to button 1.
    ui.stdin.write(TAB)
    await tick()
    ui.stdin.write(SHIFT_TAB)
    await tick()
    ui.stdin.write('x')
    await tick()
    ui.stdin.write(TAB)
    await tick()
    ui.stdin.write(TAB)
    await tick()
    ui.stdin.write(TAB)
    await tick()
    ui.stdin.write(ENTER)
    await tick()

    expect(r.take()).toEqual({
      cancelled: false,
      button: 'retry',
      fields: { notes: 'x', reason: '' },
    })

    ui.unmount()
  })

  it('auto-focuses the first button when there are no fields', async () => {
    const r = makeResolver()
    const ui = render(<AskApp spec={SPEC_NO_FIELDS_TWO_BUTTONS} onResolve={r.onResolve} />)
    await tick()

    ui.stdin.write(ENTER)
    await tick()

    expect(r.take()).toEqual({
      cancelled: false,
      button: 'ok',
      fields: {},
    })

    ui.unmount()
  })

  it('resolves only once even if the user mashes Enter after submit', async () => {
    const r = makeResolver()
    let calls = 0
    const ui = render(
      <AskApp
        spec={SPEC_NO_FIELDS_TWO_BUTTONS}
        onResolve={(result) => {
          calls++
          r.onResolve(result)
        }}
      />,
    )
    await tick()

    ui.stdin.write(ENTER)
    await tick()
    ui.stdin.write(ENTER)
    await tick()
    ui.stdin.write(ENTER)
    await tick()

    expect(calls).toBe(1)
    expect(r.take()?.cancelled).toBe(false)

    ui.unmount()
  })
})
