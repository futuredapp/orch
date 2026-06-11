// ---------------------------------------------------------------------------
// <HelpOverlay> — the `?` keymap help block.
// ---------------------------------------------------------------------------
//
// Rendered by `steps-view.tsx` while `helpOpen`; all other input is swallowed
// by the keymap until it closes (Esc / `?`).

import { Box, Text } from 'ink'
import type React from 'react'

export function HelpOverlay(): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1} marginTop={1}>
      <Text bold>Keymap</Text>
      <Text>↑/↓ move selection</Text>
      <Text>j/k scroll one row · PgUp/PgDn scroll a page</Text>
      <Text>Home (or g) jump to top · End (or G) jump to live tail</Text>
      <Text>⏎ view selected step</Text>
      <Text>f follow live (or rollup) — returns to the most recent live source</Text>
      <Text>Esc close this help · dismiss error banner</Text>
      <Text>? toggle this help</Text>
      <Text>q quit (run continues)</Text>
      <Text> </Text>
      <Text dimColor>
        Footer indicator: ▶ live · ⏸ viewing &lt;step&gt; · ↑ scrolled · End live
      </Text>
      <Text dimColor>Banner: info auto-clears (~4s) · error persists until Esc or next emit</Text>
    </Box>
  )
}
