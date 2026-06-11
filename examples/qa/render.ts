/**
 * render.ts — DEV-ONLY. Turn an ANSI pane capture into a PNG with `freeze`
 * (charmbracelet/freeze) so the QA agent can *see* color: glyph colors, the
 * yellow running spinner, red failures, dimmed pending rows, banners — none of
 * which survive a text capture. The PNG is a vision-model input the agent reads
 * with the Read tool.
 *
 * Why ANSI → PNG is clean: `tmux capture-pane -e` returns the already-emulated
 * grid with only SGR color codes re-applied (no cursor-movement noise), which is
 * exactly what `freeze` renders well. (See scripts/tmux-screenshot-poc.sh.)
 *
 * Honors CLAUDE.md rule #1: `freeze` is spawned through the injected
 * `ProcessService`, never `Bun.spawn` directly.
 */

import { writeFile } from 'node:fs/promises'
import * as nodePath from 'node:path'
import { BunProcessService, type ProcessService } from '../../src/services/process/index.ts'
import { path as toPath } from '../../src/services/types.ts'

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching an SGR sequence's ESC is the point
const SGR = /\u001b\[[0-9;]*m/g

/**
 * Drop trailing blank lines — a tmux pane capture is padded to the full pane
 * height. Keeps interior blanks; strips SGR only to test emptiness, so a
 * colored-but-blank line still counts. Without this a short pane renders as a
 * mostly-empty multi-thousand-pixel image and bloats the text the agent reads.
 */
export function trimTrailingBlank(text: string): string {
  const lines = text.split('\n')
  while (lines.length > 0) {
    const last = lines[lines.length - 1]
    if (last !== undefined && last.replace(SGR, '').trim() === '') lines.pop()
    else break
  }
  return lines.join('\n')
}

async function run(
  processService: ProcessService,
  argv: readonly string[],
): Promise<{ readonly output: string; readonly exitCode: number }> {
  const child = processService.spawn({ argv, cwd: toPath('/'), env: passthroughEnv() })
  const parts: string[] = []
  // freeze writes its "WROTE <path>" success line and its errors to stdout, so
  // merge both streams for diagnostics.
  const drainErr = (async () => {
    for await (const line of child.stderr) parts.push(line)
  })()
  const drainOut = (async () => {
    for await (const line of child.stdout) parts.push(line)
  })()
  const [{ exitCode }] = await Promise.all([child.wait(), drainErr, drainOut])
  return { output: parts.join('\n'), exitCode }
}

/** True iff `freeze` is on PATH (PNG rendering is available). */
export async function rendererAvailable(
  processService: ProcessService = new BunProcessService(),
): Promise<boolean> {
  const { exitCode } = await run(processService, ['freeze', '--version']).catch(() => ({
    exitCode: 1,
    output: '',
  }))
  return exitCode === 0
}

/**
 * Render one ANSI file to a PNG via `freeze`. Throws on a non-zero exit.
 * `language: 'ansi'` forces ANSI mode for frames freeze cannot auto-detect
 * (a tmux capture starts with SGR bytes and detects fine; an Ink debug frame
 * can start with plain text and trips "Language Unknown").
 */
export async function renderPng(
  args: { readonly ansiPath: string; readonly pngPath: string; readonly language?: string },
  processService: ProcessService = new BunProcessService(),
): Promise<void> {
  const { exitCode, output } = await run(processService, [
    'freeze',
    args.ansiPath,
    '--output',
    args.pngPath,
    ...(args.language !== undefined ? ['--language', args.language] : []),
  ])
  if (exitCode !== 0) throw new Error(`freeze failed (exit ${exitCode}): ${output}`)
}

/**
 * Stack two pane captures (labeled) into one PNG so the agent can eyeball the
 * whole TUI at once. A vertical stack avoids an ImageMagick dependency — only
 * `freeze` is needed. Writes `<idx>-both.ansi` + `<idx>-both.png`; returns the
 * PNG path.
 */
export async function renderStackedPng(
  args: {
    readonly outDir: string
    readonly idx: string
    readonly left: string
    readonly right: string
  },
  processService: ProcessService = new BunProcessService(),
): Promise<string> {
  const combined = `[1m── LEFT PANE ──[0m\n${args.left}\n\n[1m── RIGHT PANE ──[0m\n${args.right}\n`
  const ansiPath = nodePath.join(args.outDir, `${args.idx}-both.ansi`)
  const pngPath = nodePath.join(args.outDir, `${args.idx}-both.png`)
  await writeFile(ansiPath, combined, 'utf-8')
  await renderPng({ ansiPath, pngPath }, processService)
  return pngPath
}

function passthroughEnv(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) out[k] = v
  }
  return out
}
