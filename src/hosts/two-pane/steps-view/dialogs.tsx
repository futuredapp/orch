// ---------------------------------------------------------------------------
// <DialogHost> + the steps-view dialogs (help, confirm-quit, failure-actions).
// ---------------------------------------------------------------------------
//
// Ink has no z-axis, so a dialog REPLACES the steps grid + footer inside the
// same measured frame budget instead of painting over them (no frame growth →
// no full-clear flicker; see `steps-view-layout.ts`). While a dialog is open
// the steps-view keymap swallows all input (`ctx.dialogOpen`) and the dialog's
// own `useInput` owns the keyboard: ←/→ or Tab move the button focus
// (`useFocusList`), ⏎ activates, Esc closes.

import { Box, Text, useInput } from 'ink'
import type React from 'react'
import { FocusButtonRow, useFocusList } from '../../../ui/index.ts'
import { HelpOverlay } from './help-overlay.tsx'

export type StepsDialog =
  | { readonly kind: 'help' }
  | { readonly kind: 'confirm-quit' }
  | { readonly kind: 'failure-actions' }

/** What a dialog button resolves to — mapped onto `StepsViewIntent` by the host. */
export type DialogAction = 'quit' | 'retry' | 'retry-continue'

export interface DialogHostProps {
  readonly dialog: StepsDialog
  readonly onClose: () => void
  readonly onAction: (action: DialogAction) => void
}

export function DialogHost({ dialog, onClose, onAction }: DialogHostProps): React.ReactElement {
  if (dialog.kind === 'help') return <HelpDialog onClose={onClose} />
  if (dialog.kind === 'confirm-quit')
    return <ConfirmQuitDialog onClose={onClose} onAction={onAction} />
  return <FailureActionsDialog onClose={onClose} onAction={onAction} />
}

// ---------------------------------------------------------------------------
// Help — the keymap reference. Content lives in `help-overlay.tsx`; this
// wrapper only owns the close keys (Esc / `?`).
// ---------------------------------------------------------------------------

function HelpDialog({ onClose }: { readonly onClose: () => void }): React.ReactElement {
  useInput((input, key) => {
    if (key.escape || input === '?') onClose()
  })
  return <HelpOverlay />
}

// ---------------------------------------------------------------------------
// Confirm-quit — `q` on a live run asks before detaching the viewer.
// ---------------------------------------------------------------------------

function ConfirmQuitDialog({
  onClose,
  onAction,
}: {
  readonly onClose: () => void
  readonly onAction: (action: DialogAction) => void
}): React.ReactElement {
  const labels = ['quit', 'stay'] as const
  const focus = useFocusList({ count: labels.length })

  useInput((input, key) => {
    if (key.escape) {
      onClose()
      return
    }
    // `qq` is the fast path: the first `q` opened this dialog, a second
    // confirms — pre-dialog muscle memory stays two keystrokes from working.
    if (input === 'q' || input === 'Q') {
      onAction('quit')
      return
    }
    if (key.return) {
      if (labels[focus.index] === 'quit') onAction('quit')
      else onClose()
      return
    }
    routeButtonNav(input, key, focus)
  })

  return (
    <DialogFrame title="Quit orch viewer?">
      <Text>The run keeps going in the background.</Text>
      <Text dimColor>Reattach later with: orch open</Text>
      <FocusButtonRow labels={labels} focusIndex={focus.index} />
      <Text dimColor>←/→ choose · ⏎ confirm · Esc stay</Text>
    </DialogFrame>
  )
}

// ---------------------------------------------------------------------------
// Failure-actions — visible buttons for the `failed` re-entry view's `r`/`c`
// chords. Opened with `a`; the chords keep working both outside and inside.
// ---------------------------------------------------------------------------

function FailureActionsDialog({
  onClose,
  onAction,
}: {
  readonly onClose: () => void
  readonly onAction: (action: DialogAction) => void
}): React.ReactElement {
  const labels = ['retry', 'retry & continue', 'close'] as const
  const focus = useFocusList({ count: labels.length })

  useInput((input, key) => {
    if (key.escape || input === 'a' || input === 'A') {
      onClose()
      return
    }
    if (input === 'r' || input === 'R') {
      onAction('retry')
      return
    }
    if (input === 'c' || input === 'C') {
      onAction('retry-continue')
      return
    }
    if (key.return) {
      const label = labels[focus.index]
      if (label === 'retry') onAction('retry')
      else if (label === 'retry & continue') onAction('retry-continue')
      else onClose()
      return
    }
    routeButtonNav(input, key, focus)
  })

  return (
    <DialogFrame title="Step failed — choose an action">
      <Text>retry runs the failed step once and re-parks.</Text>
      <Text>retry &amp; continue re-runs it and continues to completion.</Text>
      <FocusButtonRow labels={labels} focusIndex={focus.index} />
      <Text dimColor>←/→ choose · ⏎ run · r/c shortcuts · Esc close</Text>
    </DialogFrame>
  )
}

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

function routeButtonNav(
  input: string,
  key: {
    readonly leftArrow?: boolean
    readonly rightArrow?: boolean
    readonly tab?: boolean
    readonly shift?: boolean
  },
  focus: { next(): void; prev(): void },
): void {
  if (key.leftArrow === true || (key.tab === true && key.shift === true)) focus.prev()
  else if (key.rightArrow === true || key.tab === true || input === '\t') focus.next()
}

function DialogFrame({
  title,
  children,
}: {
  readonly title: string
  readonly children: React.ReactNode
}): React.ReactElement {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      marginTop={1}
      gap={1}
    >
      <Text bold>{title}</Text>
      {children}
    </Box>
  )
}
