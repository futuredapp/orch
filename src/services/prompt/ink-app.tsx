import { Box, Text, useFocus, useInput } from 'ink'
import TextInput from 'ink-text-input'
import type React from 'react'
import { useCallback, useState } from 'react'
import type { PromptField, PromptResult, PromptSpec } from './prompt-service.ts'

// ---------------------------------------------------------------------------
// AskApp — top-level Ink component for ask() prompts.
// ---------------------------------------------------------------------------
//
// Mounted by `ink-runner.ts` (the spawn-Ink-child) and by the unit tests via
// ink-testing-library. Resolves exactly once on the first submit/cancel,
// then waits to be unmounted by the parent.
//
// Layout:
//   ┌────────────────────────────┐
//   │ <question>                 │
//   │                            │
//   │ <field-name>:              │
//   │ [<text input>            ] │
//   │ ...                        │
//   │                            │
//   │  [btn-1]  [btn-2]  ...     │
//   │                            │
//   │ tab/shift-tab move · ...   │
//   └────────────────────────────┘
//
// Focus contract:
//   - First field auto-focuses; if no fields, first button auto-focuses.
//   - Tab/Shift-Tab cycle focus across (fields..., buttons...) in declaration
//     order via useFocusManager().focusNext / focusPrevious.
//   - Enter on a focused button submits.
//   - Esc / Ctrl-C cancel with whatever was typed so far.

export interface AskAppProps {
  readonly spec: PromptSpec
  readonly onResolve: (r: PromptResult) => void
}

export function AskApp({ spec, onResolve }: AskAppProps): React.ReactElement {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(spec.fields.map((f) => [f.name, ''])),
  )
  const [resolved, setResolved] = useState(false)

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

  // Tab / Shift-Tab focus traversal is handled natively by Ink's <App> when
  // `useFocus` components are mounted (see node_modules/ink/build/components/App.js
  // — the `tab` / `shift+tab` listener calls focusNext / focusPrevious for us).
  // We only need to capture Esc / Ctrl-C for cancel.
  useInput((input, key) => {
    if (key.escape) {
      cancel()
      return
    }
    if (key.ctrl && input.toLowerCase() === 'c') {
      cancel()
    }
  })

  const firstButtonAutoFocus = spec.fields.length === 0

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={2} paddingY={1}>
      <Text>{spec.question}</Text>
      <Box flexDirection="column" marginTop={1}>
        {spec.fields.map((f, idx) => (
          <FieldRow
            key={f.name}
            field={f}
            value={values[f.name] ?? ''}
            autoFocus={idx === 0}
            onChange={(v) => setValues((prev) => ({ ...prev, [f.name]: v }))}
          />
        ))}
      </Box>
      <Box marginTop={1} gap={2}>
        {spec.buttons.map((b, idx) => (
          <Button
            key={b}
            label={b}
            autoFocus={firstButtonAutoFocus && idx === 0}
            onPress={() => submit(b)}
          />
        ))}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>tab/shift-tab move · enter pick · esc cancel</Text>
      </Box>
    </Box>
  )
}

interface FieldRowProps {
  readonly field: PromptField
  readonly value: string
  readonly autoFocus: boolean
  readonly onChange: (v: string) => void
}

function FieldRow({ field, value, autoFocus, onChange }: FieldRowProps): React.ReactElement {
  const { isFocused } = useFocus({ autoFocus })
  // ink-text-input v6 prefixes a placeholder string while empty + focused.
  // The `focus` prop gates onChange so unfocused fields ignore keystrokes.
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={isFocused ? 'cyan' : undefined}>
        {isFocused ? '› ' : '  '}
        {field.name}:
      </Text>
      <Box>
        <Text>{isFocused ? '> ' : '  '}</Text>
        <TextInput
          value={value}
          onChange={onChange}
          focus={isFocused}
          {...(field.placeholder !== undefined ? { placeholder: field.placeholder } : {})}
        />
      </Box>
    </Box>
  )
}

interface ButtonProps {
  readonly label: string
  readonly autoFocus: boolean
  readonly onPress: () => void
}

function Button({ label, autoFocus, onPress }: ButtonProps): React.ReactElement {
  const { isFocused } = useFocus({ autoFocus })
  useInput(
    (_, key) => {
      if (isFocused && key.return) onPress()
    },
    { isActive: isFocused },
  )
  return <Text inverse={isFocused}> {label} </Text>
}
