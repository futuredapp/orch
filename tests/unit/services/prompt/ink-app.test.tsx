import { afterEach, describe, expect, it, setDefaultTimeout } from 'bun:test'
import { cleanup, render } from 'ink-testing-library'
import { AskApp } from '../../../../src/services/prompt/ink-app.tsx'
import type { PromptResult, PromptSpec } from '../../../../src/services/prompt/prompt-service.ts'

// Every test here drives a real Ink mount through the real event loop: each
// keystroke is a chain of real `setTimeout` + React-reconciler + effect-pass
// round-trips (see `tick`/`pressKey`/`waitForFrame` below). A single test does
// up to ~a dozen such serialized round-trips - e.g. the `hello` typing test
// (8 presses) and the ArrowRight test (4 presses + 4 frame waits). Under
// nominal timers each finishes in well under a second, but Ink relies on the
// real event loop, so when timers are delayed (a slow or loaded machine, or a
// cold process warming the reconciler) those round-trips inflate and the
// heaviest tests brush past Bun's 5s default. This is a real-timer budget
// ceiling, not a hang: bound loops cap the worst case, so a generous default
// removes the flake without weakening a single assertion.
setDefaultTimeout(20_000)

// ink-testing-library raw key codes — Ink interprets these as keypress events.
const TAB = '\t'
const SHIFT_TAB = '[Z'
const ARROW_UP = '\u001B[A'
const ARROW_DOWN = '\u001B[B'
const ARROW_RIGHT = '\u001B[C'
const ARROW_LEFT = '\u001B[D'
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

// Ink dispatches stdin to keypress handlers, which call setState (focus +
// values). The next render is async: it lands one or more microtasks later
// on React's scheduler, and the new `useInput`/`useFocus` registrations
// commit in a subsequent effect pass. A single `setTimeout(N)` is racy
// because no fixed delay can guarantee all four stages (stdin handler →
// state update → render → effect re-subscription) settle on a loaded
// machine. `tick` widens the floor; `pressKey` adds frame-presence polling
// + microtask drains for sequences that race the reconciler.
// Use real `setTimeout` — Ink relies on the real event loop for
// `setRawMode` + stdin readable callbacks.
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 60))
}

// Press a key and wait for the resulting render + effect pass to settle.
// Polls `ui.frames.length` for a new frame produced after the write, then
// drains microtasks so dependent effects (e.g. useInput re-subscribing on
// the newly-focused element) finish before the next key.
async function pressKey(
  ui: { readonly stdin: { write: (s: string) => void }; readonly frames: string[] },
  key: string,
): Promise<void> {
  const before = ui.frames.length
  ui.stdin.write(key)
  const deadline = Date.now() + 250
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5))
    if (ui.frames.length > before) break
  }
  for (let i = 0; i < 4; i++) await Promise.resolve()
  await new Promise((r) => setTimeout(r, 10))
}

// Wait for a render frame matching `predicate(frame)`. Used to synchronize
// on focus-claim before dispatching keystrokes — `pressKey` immediately
// after `render()` raced the `useFocus({autoFocus:true})` effect, dropping
// the first stdin write when the TextInput wasn't yet focus-gated true.
async function waitForFrame(
  ui: { readonly lastFrame: () => string | undefined },
  predicate: (frame: string) => boolean,
  timeoutMs = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const f = ui.lastFrame() ?? ''
    if (predicate(f)) {
      // The matched frame proves the render committed, but the dependent
      // child effects (TextInput's useInput re-subscribing on focus prop)
      // run on a follow-up effect pass. Drain microtasks + a small timer
      // before returning so the next keystroke isn't dropped on a still-
      // gated useInput.
      for (let i = 0; i < 8; i++) await Promise.resolve()
      await new Promise((r) => setTimeout(r, 20))
      return
    }
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(
    `waitForFrame: predicate did not match within ${timeoutMs}ms. Last frame: ${ui.lastFrame() ?? '(none)'}`,
  )
}

describe('AskApp', () => {
  // ink-testing-library's `cleanup()` unmounts any orphan instance and
  // resets module-level state. Each test calls `ui.unmount()` explicitly,
  // but a defensive `cleanup` between tests prevents one test's stdin
  // listener / focus state from leaking into the next on Bun's shared
  // process.stdin space.
  afterEach(() => {
    cleanup()
  })

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
    // Wait for `useFocus({autoFocus:true})` to claim — the focus indicator
    // `›` next to `notes:` is the durable proof that the TextInput's
    // `focus` prop is true and will route subsequent keystrokes.
    await waitForFrame(ui, (f) => f.includes('▌ notes:'))

    await pressKey(ui, 'hi')
    await pressKey(ui, ESC)

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
    // Wait for `useFocus({autoFocus:true})` to claim — the focus indicator
    // `›` next to `notes:` is the durable proof that the TextInput's
    // `focus` prop is true and will route subsequent keystrokes.
    await waitForFrame(ui, (f) => f.includes('▌ notes:'))

    await pressKey(ui, CTRL_C)

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
    // Wait for `useFocus({autoFocus:true})` to claim — the focus indicator
    // `›` next to `notes:` is the durable proof that the TextInput's
    // `focus` prop is true and will route subsequent keystrokes.
    await waitForFrame(ui, (f) => f.includes('▌ notes:'))

    // First field auto-focuses; type into it. Per-char presses give the
    // TextInput's `onChange` enough time to commit each character before
    // the next arrives, vs. a single 'hello' write that races the first
    // char against a still-warming useInput subscription.
    for (const c of 'hello') await pressKey(ui, c)
    // Tab over the second field, then to the first button.
    await pressKey(ui, TAB)
    await pressKey(ui, TAB)
    await pressKey(ui, ENTER)

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
    await pressKey(ui, TAB)
    await pressKey(ui, TAB)
    await pressKey(ui, TAB)
    await pressKey(ui, ENTER)

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
    await pressKey(ui, TAB)
    await pressKey(ui, SHIFT_TAB)
    await pressKey(ui, 'x')
    await pressKey(ui, TAB)
    await pressKey(ui, TAB)
    await pressKey(ui, TAB)
    await pressKey(ui, ENTER)

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
    // No fields → first button is `autoFocus`. Wait for the question to
    // render (proves mount completed); the focus claim follows on the next
    // effect pass which `pressKey` will wait for via frame polling.
    await waitForFrame(ui, (f) => f.includes('continue?'))
    await tick()

    await pressKey(ui, ENTER)

    expect(r.take()).toEqual({
      cancelled: false,
      button: 'ok',
      fields: {},
    })

    ui.unmount()
  })

  it('ArrowDown steps field 0 → field 1 → buttons and wraps back to field 0', async () => {
    const r = makeResolver()
    const ui = render(<AskApp spec={SPEC_TWO_FIELDS_TWO_BUTTONS} onResolve={r.onResolve} />)
    await tick()
    await waitForFrame(ui, (f) => f.includes('▌ notes:'))

    await pressKey(ui, ARROW_DOWN)
    await waitForFrame(ui, (f) => f.includes('▌ reason:'))
    await pressKey(ui, ARROW_DOWN)
    await waitForFrame(ui, (f) => f.includes('❯ continue'))
    await pressKey(ui, ARROW_DOWN)
    await waitForFrame(ui, (f) => f.includes('▌ notes:'))

    expect(r.take()).toBeUndefined()

    ui.unmount()
  })

  it('ArrowUp from the first field wraps to the button row', async () => {
    const r = makeResolver()
    const ui = render(<AskApp spec={SPEC_TWO_FIELDS_TWO_BUTTONS} onResolve={r.onResolve} />)
    await tick()
    await waitForFrame(ui, (f) => f.includes('▌ notes:'))

    await pressKey(ui, ARROW_UP)
    await waitForFrame(ui, (f) => f.includes('❯ continue'))
    await pressKey(ui, ENTER)

    expect(r.take()).toEqual({
      cancelled: false,
      button: 'continue',
      fields: { notes: '', reason: '' },
    })

    ui.unmount()
  })

  it('ArrowRight moves along the button row and wraps from the last button to the first', async () => {
    const r = makeResolver()
    const ui = render(<AskApp spec={SPEC_NO_FIELDS_TWO_BUTTONS} onResolve={r.onResolve} />)
    await tick()
    await waitForFrame(ui, (f) => f.includes('❯ ok'))

    await pressKey(ui, ARROW_RIGHT)
    await waitForFrame(ui, (f) => f.includes('❯ cancel'))
    await pressKey(ui, ARROW_RIGHT)
    await waitForFrame(ui, (f) => f.includes('❯ ok'))
    await pressKey(ui, ARROW_LEFT)
    await waitForFrame(ui, (f) => f.includes('❯ cancel'))
    await pressKey(ui, ENTER)

    expect(r.take()).toEqual({ cancelled: false, button: 'cancel', fields: {} })

    ui.unmount()
  })

  it('Enter in a field advances to the next element instead of submitting', async () => {
    const r = makeResolver()
    const ui = render(<AskApp spec={SPEC_TWO_FIELDS_TWO_BUTTONS} onResolve={r.onResolve} />)
    await tick()
    await waitForFrame(ui, (f) => f.includes('▌ notes:'))

    for (const c of 'hi') await pressKey(ui, c)
    await pressKey(ui, ENTER)
    await waitForFrame(ui, (f) => f.includes('▌ reason:'))
    await pressKey(ui, ENTER)
    await waitForFrame(ui, (f) => f.includes('❯ continue'))
    await pressKey(ui, ENTER)

    expect(r.take()).toEqual({
      cancelled: false,
      button: 'continue',
      fields: { notes: 'hi', reason: '' },
    })

    ui.unmount()
  })

  it('renders the frame title and the field counter on the focused field', async () => {
    const r = makeResolver()
    const spec: PromptSpec = { ...SPEC_TWO_FIELDS_TWO_BUTTONS, title: 'choose-approach' }
    const ui = render(<AskApp spec={spec} onResolve={r.onResolve} />)
    await tick()
    await waitForFrame(ui, (f) => f.includes('▌ notes:'))

    const frame = ui.lastFrame() ?? ''
    expect(frame).toContain('ask · choose-approach')
    expect(frame).toContain('1/2 fields')

    ui.unmount()
  })

  it('Tab past the last button hands focus to the steps pane when onFocusPane is wired', async () => {
    const r = makeResolver()
    let focusOuts = 0
    const ui = render(
      <AskApp
        spec={SPEC_NO_FIELDS_TWO_BUTTONS}
        onResolve={r.onResolve}
        onFocusPane={() => {
          focusOuts++
        }}
      />,
    )
    await tick()
    await waitForFrame(ui, (f) => f.includes('❯ ok'))

    await pressKey(ui, TAB)
    await waitForFrame(ui, (f) => f.includes('❯ cancel'))
    await pressKey(ui, TAB)

    expect(focusOuts).toBe(1)
    expect(r.take()).toBeUndefined()

    ui.unmount()
  })

  it('Shift-Tab on the first element hands focus to the steps pane when onFocusPane is wired', async () => {
    const r = makeResolver()
    let focusOuts = 0
    const ui = render(
      <AskApp
        spec={SPEC_TWO_FIELDS_TWO_BUTTONS}
        onResolve={r.onResolve}
        onFocusPane={() => {
          focusOuts++
        }}
      />,
    )
    await tick()
    await waitForFrame(ui, (f) => f.includes('▌ notes:'))

    await pressKey(ui, SHIFT_TAB)

    expect(focusOuts).toBe(1)
    expect(r.take()).toBeUndefined()

    ui.unmount()
  })

  it('Tab past the last button wraps to the first field when onFocusPane is absent', async () => {
    const r = makeResolver()
    const ui = render(<AskApp spec={SPEC_TWO_FIELDS_TWO_BUTTONS} onResolve={r.onResolve} />)
    await tick()
    await waitForFrame(ui, (f) => f.includes('▌ notes:'))

    await pressKey(ui, TAB)
    await pressKey(ui, TAB)
    await pressKey(ui, TAB)
    await waitForFrame(ui, (f) => f.includes('❯ retry'))
    await pressKey(ui, TAB)
    await waitForFrame(ui, (f) => f.includes('▌ notes:'))

    expect(r.take()).toBeUndefined()

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

    await pressKey(ui, ENTER)
    await pressKey(ui, ENTER)
    await pressKey(ui, ENTER)

    expect(calls).toBe(1)
    expect(r.take()?.cancelled).toBe(false)

    ui.unmount()
  })
})
