// ---------------------------------------------------------------------------
// <BannerBox> — single-line banner above the steps grid.
// ---------------------------------------------------------------------------
//
// `state.banner` (when present) renders as a single line above the steps
// grid. Info banners auto-clear after `ttlMs ?? DEFAULT_INFO_TTL_MS` (the
// effect lives in `steps-view.tsx`, keyed on `banner.seq` so rapid identical-
// text emits restart the timer). Error banners persist until replaced by a
// new emit or dismissed with `Esc`.

import { Box, Text } from 'ink'
import type React from 'react'
import type { Banner } from './step-types.ts'
import { truncate } from './steps-view-format.ts'

export const DEFAULT_INFO_TTL_MS = 4000

export function BannerBox({ banner }: { readonly banner: Banner }): React.ReactElement {
  if (banner.kind === 'error') {
    return (
      <Box>
        <Text color="red">{bannerText(banner)}</Text>
      </Box>
    )
  }
  return (
    <Box>
      <Text color="cyan" dimColor>
        {bannerText(banner)}
      </Text>
    </Box>
  )
}

/** The rendered banner string — also used to measure its wrapped height. */
export function bannerText(banner: Banner): string {
  return banner.kind === 'error'
    ? `! ${truncate(banner.text, 200)} · Esc dismiss`
    : truncate(banner.text, 200)
}
