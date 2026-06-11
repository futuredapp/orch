import { scenario } from '../dsl/index.ts'

// Full-width selection band (2026-06-11). The committed row paints its gray
// background from the `▌` cursor across the WHOLE row — the trailing pad
// spaces carry the background all the way to the scrollbar column, instead of
// the band hugging the text (the reported "improve padding on the grayed
// selected step"). Only real tmux bytes can prove the band survives the
// Ink→pty→tmux path, so this is `screen`-only; the band spec (colour name +
// minimum pad) lives co-located on the Pane Object.

scenario(
  {
    name: 'the committed row paints its selection band across the full row as real tmux bytes',
    feature: 'selection-band',
    drivers: ['screen'],
    risk: 'selection-band-bytes',
    oldTestRefs: [],
  },
  async (app) => {
    // given — an overflowing list so the scrollbar column bounds the row width
    await app.resize(80, 12)
    await app.launch({
      steps: ['a01', 'a02', 'a03', 'a04', 'a05', 'a06', 'a07', 'a08', 'a09', 'a10'],
      stopAt: 'mid-step',
    })

    // then — the committed live row's band spans name + trailing pad
    await app.leftPane.assertStepSelected('a10')
    await app.leftPane.assertSelectionBandFillsRow('a10')
  },
)
