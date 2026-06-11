// ---------------------------------------------------------------------------
// <FocusButtonRow> — a horizontal row of buttons driven by a focus index.
// ---------------------------------------------------------------------------
//
// Pairs with `useFocusList`: the caller owns the index and the key routing
// (←/→/Tab/⏎); this renders the row. The `❯` marker keeps the focused button
// identifiable in plain bytes (NO_COLOR terminals, stripped test frames);
// inverse video is the primary affordance. Constant 2-char prefix so the row
// never jiggles as focus moves.

import { Box, Text } from 'ink'
import type React from 'react'

export interface FocusButtonRowProps {
  readonly labels: readonly string[]
  readonly focusIndex: number
  /**
   * When `false` (focus is elsewhere — e.g. still in a form field) no button
   * renders as focused. Default `true`.
   */
  readonly active?: boolean
}

export function FocusButtonRow({
  labels,
  focusIndex,
  active = true,
}: FocusButtonRowProps): React.ReactElement {
  return (
    <Box gap={2}>
      {labels.map((label, i) => {
        const focused = active && i === focusIndex
        return (
          <Text key={label} inverse={focused} color={focused ? 'cyan' : undefined}>
            {`${focused ? '❯' : ' '} ${label} `}
          </Text>
        )
      })}
    </Box>
  )
}
