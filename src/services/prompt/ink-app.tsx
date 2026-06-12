import { Box, Text, useInput } from 'ink'
import TextInput from 'ink-text-input'
import type React from 'react'
import { useCallback, useState } from 'react'
import { FocusButtonRow, useFocusList } from '../../ui/index.ts'
import type { PromptField, PromptResult, PromptSpec } from './prompt-service.ts'

// ---------------------------------------------------------------------------
// AskApp — top-level Ink component for ask() prompts.
// ---------------------------------------------------------------------------
//
// Mounted by `ink-runner.ts` (the spawn-Ink-child) and by the unit tests via
// ink-testing-library. Resolves exactly once on the first submit/cancel,
// then waits to be unmounted by the parent.
//
// Focus model (P5): an explicit two-axis `useFocusList` pair replaces Ink's
// implicit `useFocus` tab order.
//   - The VERTICAL axis steps over rows: field 0 … field N-1, then the
//     button row as one row. `↑`/`↓` move along it and wrap.
//   - The HORIZONTAL axis is the button index, alive while the button row is
//     focused. `←`/`→` move along it and wrap; inside a field they stay with
//     the TextInput cursor.
//   - `Tab`/`Shift-Tab` keep their old FLAT semantics (field 0 → … →
//     button 0 → … → button N → field 0), reconstructed over both axes.
//   - `⏎` in a field advances to the next row (fast fill-then-confirm);
//     `⏎` on the button row submits the focused button.
//   - `Esc` / `Ctrl-C` cancel with whatever was typed so far.

export interface AskAppProps {
  readonly spec: PromptSpec
  readonly onResolve: (r: PromptResult) => void
  /**
   * P6 edge-out: invoked when `Tab` steps past the last button (or
   * `Shift-Tab` before the first element) — the runner wires it to
   * `tmux select-pane` so focus hands back to the steps pane. When absent
   * (unit tests, no tmux context) Tab keeps its wrapping flat cycle.
   */
  readonly onFocusPane?: () => void
}

export function AskApp({ spec, onResolve, onFocusPane }: AskAppProps): React.ReactElement {
  const fieldCount = spec.fields.length
  // Row index of the button row — one past the last field (0 when no fields).
  const buttonRow = fieldCount
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(spec.fields.map((f) => [f.name, ''])),
  )
  const [resolved, setResolved] = useState(false)
  const rows = useFocusList({ count: fieldCount + 1 })
  const buttons = useFocusList({ count: spec.buttons.length })
  const onButtonRow = rows.index === buttonRow

  const finish = useCallback(
    (r: PromptResult) => {
      if (resolved) return
      setResolved(true)
      onResolve(r)
    },
    [onResolve, resolved],
  )

  const submit = useCallback(
    (button: string) => finish({ cancelled: false, button, fields: values }),
    [finish, values],
  )

  const cancel = useCallback(() => finish({ cancelled: true, fields: values }), [finish, values])

  // Flat Tab order over both axes: stepping forward off the last button (or
  // backward off the first) crosses to the row axis, whose wrap closes the
  // cycle through the fields — unless `onFocusPane` is wired, in which case
  // stepping past either end hands focus to the steps pane instead.
  const atLastElement = onButtonRow && buttons.index === spec.buttons.length - 1
  const atFirstElement = fieldCount > 0 ? rows.index === 0 : buttons.index === 0
  const flatNext = (): void => {
    if (atLastElement && onFocusPane !== undefined) {
      onFocusPane()
      return
    }
    if (onButtonRow && buttons.index < spec.buttons.length - 1) {
      buttons.next()
    } else {
      rows.next()
      buttons.focus(0)
    }
  }
  const flatPrev = (): void => {
    if (atFirstElement && onFocusPane !== undefined) {
      onFocusPane()
      return
    }
    if (onButtonRow && buttons.index > 0) {
      buttons.prev()
    } else {
      rows.prev()
      buttons.focus(spec.buttons.length - 1)
    }
  }

  // The focused TextInput consumes plain characters and ←/→ (cursor moves);
  // it ignores ↑/↓/Tab, so this handler owns all navigation. `ink-text-input`
  // fires its own no-op on ⏎ — the advance below is the only effect.
  useInput((input, key) => {
    if (key.escape) {
      cancel()
      return
    }
    if (key.ctrl && input.toLowerCase() === 'c') {
      cancel()
      return
    }
    if (key.tab) {
      if (key.shift) flatPrev()
      else flatNext()
      return
    }
    if (key.upArrow) {
      rows.prev()
      return
    }
    if (key.downArrow) {
      rows.next()
      return
    }
    if (onButtonRow) {
      if (key.leftArrow) {
        buttons.prev()
        return
      }
      if (key.rightArrow) {
        buttons.next()
        return
      }
      if (key.return) {
        const button = spec.buttons[buttons.index]
        if (button !== undefined) submit(button)
      }
      return
    }
    if (key.return) rows.next()
  })

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1}>
      {spec.title !== undefined ? <Text color="cyan">{`ask · ${spec.title}`}</Text> : null}
      <Text bold>{spec.question}</Text>
      {fieldCount > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          {spec.fields.map((f, idx) => (
            <FieldRow
              key={f.name}
              field={f}
              value={values[f.name] ?? ''}
              focused={rows.index === idx}
              index={idx}
              total={fieldCount}
              onChange={(v) => setValues((prev) => ({ ...prev, [f.name]: v }))}
            />
          ))}
        </Box>
      ) : null}
      <Box marginTop={1}>
        <FocusButtonRow labels={spec.buttons} focusIndex={buttons.index} active={onButtonRow} />
      </Box>
      <Box marginTop={1}>
        {/* Truncate, never wrap: a wrapping hint changes the frame height at
            narrow widths. The leading hints matter most. */}
        <Text dimColor wrap="truncate-end">
          {fieldCount > 0
            ? '↑↓ fields · ←→ buttons · ⏎ next/submit · esc cancel'
            : '←→ choose · ⏎ pick · esc cancel'}
        </Text>
      </Box>
    </Box>
  )
}

interface FieldRowProps {
  readonly field: PromptField
  readonly value: string
  readonly focused: boolean
  readonly index: number
  readonly total: number
  readonly onChange: (v: string) => void
}

function FieldRow({
  field,
  value,
  focused,
  index,
  total,
  onChange,
}: FieldRowProps): React.ReactElement {
  // ink-text-input v6 prefixes a placeholder string while empty + focused.
  // The `focus` prop gates onChange so unfocused fields ignore keystrokes.
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box justifyContent="space-between">
        <Text bold={focused} color={focused ? 'cyan' : undefined} dimColor={!focused}>
          {focused ? '▌ ' : '  '}
          {field.name}:
        </Text>
        {focused && total > 1 ? <Text dimColor>{`${index + 1}/${total} fields`}</Text> : null}
      </Box>
      <Box>
        <Text color={focused ? 'cyan' : undefined}>{focused ? '> ' : '  '}</Text>
        <TextInput
          value={value}
          onChange={onChange}
          focus={focused}
          {...(field.placeholder !== undefined ? { placeholder: field.placeholder } : {})}
        />
      </Box>
    </Box>
  )
}
