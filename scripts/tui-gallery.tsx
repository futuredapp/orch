// ---------------------------------------------------------------------------
// tui-gallery — DEV-ONLY. Render the fixture catalog to human-reviewable
// frame artifacts: `<name>.w<width>.txt` (stripped), `.ansi` (SGR colors),
// `.png` (via `freeze`, skipped when absent), plus an `index.html` contact
// sheet. NOT a test and NOT on the `bun run check` gate — review the output
// with your eyes.
//
//   bun run tui:gallery                  # everything, into artifacts/tui-gallery/
//   bun run tui:gallery -- --filter ask  # only fixtures whose name matches
//   bun run tui:gallery -- --no-png      # skip freeze even when installed
//
// Renders through the model driver's Ink harness (`renderModel`) — the same
// no-tmux seam the `model` test category uses — so what you review here is
// exactly what the controller decides to show.

import { mkdir, writeFile } from 'node:fs/promises'
import * as nodePath from 'node:path'
import { renderPng, rendererAvailable } from '../examples/qa/render.ts'
import { stripAnsi } from '../src/observability/index.ts'
import { renderModel } from '../tests/dsl/drivers/model-ink-harness.ts'
import { FIXTURES, type GalleryFixture } from './tui-gallery-fixtures.tsx'

const DEFAULT_WIDTHS = [56, 80, 120] as const
const DEFAULT_ROWS = 24

interface Args {
  readonly out: string
  readonly png: boolean
  readonly filter: string | undefined
}

function parseArgs(argv: readonly string[]): Args {
  let out = 'artifacts/tui-gallery'
  let png = true
  let filter: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--out') out = argv[++i] ?? out
    else if (a === '--no-png') png = false
    else if (a === '--filter') filter = argv[++i]
  }
  return { out, png, filter }
}

async function waitFor(
  read: () => string | undefined,
  predicate: (frame: string) => boolean,
  what: string,
  timeoutMs = 2_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const frame = read()
    if (frame !== undefined && predicate(frame)) return frame
    if (Date.now() >= deadline) {
      throw new Error(`tui-gallery: timed out waiting for ${what}. Last frame:\n${frame ?? ''}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

interface Capture {
  readonly fixture: GalleryFixture
  readonly width: number
  readonly txtFile: string
  readonly pngFile: string | undefined
  readonly text: string
}

async function captureFixture(
  fixture: GalleryFixture,
  width: number,
  outDir: string,
): Promise<{ readonly capture: Capture; readonly ansiPath: string }> {
  const ui = renderModel(fixture.element(), {
    columns: width,
    rows: fixture.rows ?? DEFAULT_ROWS,
  })
  try {
    await waitFor(ui.lastFrame, (f) => f.length > 0, `${fixture.name} first frame`)
    if (fixture.keys !== undefined && fixture.keys.length > 0) {
      // Let React flush focus effects (useFocus registration, TextInput focus
      // gating) before the first keystroke — writing on the first frame races
      // them and the input is dropped.
      await new Promise((resolve) => setTimeout(resolve, 60))
      for (const key of fixture.keys) {
        ui.stdin.write(key)
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    }
    const settled = fixture.settled
    const raw =
      settled !== undefined
        ? await waitFor(ui.lastFrame, (f) => settled(stripAnsi(f)), `${fixture.name} to settle`)
        : (ui.lastFrame() ?? '')
    const base = `${fixture.name}.w${width}`
    const ansiPath = nodePath.join(outDir, `${base}.ansi`)
    const txtPath = nodePath.join(outDir, `${base}.txt`)
    await writeFile(ansiPath, raw, 'utf-8')
    await writeFile(txtPath, stripAnsi(raw), 'utf-8')
    return {
      capture: {
        fixture,
        width,
        txtFile: `${base}.txt`,
        pngFile: undefined,
        text: stripAnsi(raw),
      },
      ansiPath,
    }
  } finally {
    ui.unmount()
  }
}

function escapeHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function indexHtml(captures: readonly Capture[]): string {
  const byFixture = new Map<string, Capture[]>()
  for (const c of captures) {
    const list = byFixture.get(c.fixture.name) ?? []
    list.push(c)
    byFixture.set(c.fixture.name, list)
  }
  const sections = [...byFixture.entries()]
    .map(([name, caps]) => {
      const first = caps[0]
      const title = first === undefined ? name : first.fixture.title
      const panes = caps
        .map((c) => {
          const img =
            c.pngFile !== undefined
              ? `<img src="${c.pngFile}" alt="${escapeHtml(name)} at ${c.width} cols">`
              : `<pre>${escapeHtml(c.text)}</pre>`
          return `<figure><figcaption>${c.width} cols · <a href="${c.txtFile}">txt</a></figcaption>${img}</figure>`
        })
        .join('\n')
      return `<section><h2>${escapeHtml(name)}</h2><p>${escapeHtml(title)}</p><div class="row">${panes}</div></section>`
    })
    .join('\n')
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>orch TUI gallery</title><style>
body{background:#0c1014;color:#d8e2ec;font-family:ui-monospace,monospace;padding:24px;}
h1{font-size:20px} h2{font-size:14px;color:#4cc9f0;margin:0 0 2px}
section{margin-bottom:28px;border-top:1px solid #1d2733;padding-top:14px}
p{color:#7d8b99;font-size:12px;margin:0 0 10px}
.row{display:flex;gap:14px;flex-wrap:wrap;align-items:flex-start}
figure{margin:0} figcaption{color:#7d8b99;font-size:11px;margin-bottom:4px}
figcaption a{color:#4cc9f0}
pre{background:#0a0e12;border:1px solid #1d2733;border-radius:6px;padding:10px;font-size:11px;line-height:1.35;margin:0}
img{max-width:560px;border:1px solid #1d2733;border-radius:6px}
</style></head><body><h1>orch TUI gallery</h1>
<p>Generated by <code>bun run tui:gallery</code> — review frames, then regenerate after visual changes.</p>
${sections}</body></html>
`
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const outDir = nodePath.resolve(args.out)
  await mkdir(outDir, { recursive: true })

  const fixtures = FIXTURES.filter(
    (f) => args.filter === undefined || f.name.includes(args.filter),
  )
  const freeze = args.png && (await rendererAvailable())
  if (args.png && !freeze) {
    process.stdout.write(
      '(freeze not found — PNGs skipped. Install: brew install charmbracelet/tap/freeze)\n',
    )
  }

  const captures: Capture[] = []
  for (const fixture of fixtures) {
    const widths = fixture.widths ?? DEFAULT_WIDTHS
    const rendered: string[] = []
    for (const width of widths) {
      const { capture, ansiPath } = await captureFixture(fixture, width, outDir)
      let pngFile: string | undefined
      if (freeze) {
        pngFile = `${fixture.name}.w${width}.png`
        await renderPng({ ansiPath, pngPath: nodePath.join(outDir, pngFile), language: 'ansi' })
      }
      captures.push({ ...capture, pngFile })
      rendered.push(String(width))
    }
    process.stdout.write(`  ✓ ${fixture.name}  (${rendered.join(' ')})\n`)
  }

  await writeFile(nodePath.join(outDir, 'index.html'), indexHtml(captures), 'utf-8')
  process.stdout.write(
    `\n${captures.length} frames → ${outDir}\nopen ${nodePath.join(outDir, 'index.html')}\n`,
  )
}

await main()
