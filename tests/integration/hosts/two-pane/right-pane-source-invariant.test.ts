// COVERED BY → tests-new/model/controller/right-pane-controller-sources.test.ts (mixed — see ledger)
// Cross-cutting invariant guard: no `respawnPane` invocation in
// `src/hosts/two-pane/` targets the visible right pane id.
//
// The pane-map design (U3–U8) routes EVERY visible-right-pane state change
// through `controller.showSource(...)` which issues a `tmux swap-pane`. The
// legacy `respawnPane(rightPaneId, ...)` paths — autonomous live (U5),
// interactive (U6), rollup (U7), past-step replay (U8) — have all been
// migrated. The per-test-file migrations in those units pin the new shape
// at the call-site level; this test is the static net that catches future
// regressions where a new code path bypasses the controller and respawns
// the visible slot directly.
//
// Implementation note: the check is a regex over file bytes (via
// `Bun.file().text()`) rather than a shell `grep`, so it runs the same
// across macOS / Linux / CI without depending on the system grep version
// or BSD-vs-GNU flags.

import { describe, expect, it } from 'bun:test'
import { readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const TWO_PANE_DIR = resolve(import.meta.dir, '../../../../src/hosts/two-pane')

async function listSourceFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...(await listSourceFiles(full)))
      continue
    }
    if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
      out.push(full)
    }
  }
  return out
}

// Strip line comments (`// ...`) and block comments (`/* ... */`) so that
// documented references to the legacy path (e.g. "see the legacy
// respawnPane path") don't trip the check. Strings are left intact; a real
// invocation embedded inside a string literal is still a code smell.
function stripComments(source: string): string {
  // Order matters: block first, then line. A naive line-strip would chop the
  // `*` lines of a JSDoc block. The block strip handles `/* ... */` greedily
  // across newlines.
  const noBlock = source.replace(/\/\*[\s\S]*?\*\//g, '')
  return noBlock.replace(/(^|[^:])\/\/.*$/gm, '$1')
}

// Match `respawnPane({...target: <something>rightPaneId...})` shapes.
// Anchors on the `respawnPane(` token and looks ahead up to 400 characters
// for a `target:` field that resolves to a `rightPaneId` symbol — covering
// `target: rightPaneId`, `target: opts.rightPaneId`, `target: deps.rightPaneId`,
// `target: ctx.rightPaneId`, etc. 400 chars is generous: real call sites
// span fewer than 200.
const FORBIDDEN_PATTERN = /respawnPane\s*\([\s\S]{0,400}?target:\s*(?:[\w.]+\.)?rightPaneId\b/

describe.skip('two-pane right-pane source invariant', () => {
  it('no respawnPane call in src/hosts/two-pane/ targets rightPaneId (use controller.showSource instead)', async () => {
    const files = await listSourceFiles(TWO_PANE_DIR)
    expect(files.length).toBeGreaterThan(0)
    const offenders: Array<{ readonly file: string; readonly snippet: string }> = []
    for (const file of files) {
      const raw = await Bun.file(file).text()
      const cleaned = stripComments(raw)
      const match = cleaned.match(FORBIDDEN_PATTERN)
      if (match !== null) {
        const idx = match.index ?? 0
        offenders.push({
          file,
          snippet: cleaned.slice(idx, Math.min(cleaned.length, idx + 200)),
        })
      }
    }
    if (offenders.length > 0) {
      const detail = offenders
        .map((o) => `  - ${o.file}\n      ${o.snippet.replace(/\s+/g, ' ').slice(0, 160)}`)
        .join('\n')
      throw new Error(
        `respawnPane(target: rightPaneId) invocations are forbidden in src/hosts/two-pane/.\n` +
          `Route visible-right-pane changes through controller.showSource(...) instead.\n` +
          `Offenders:\n${detail}`,
      )
    }
    expect(offenders).toHaveLength(0)
  })

  it('exercises the matcher on a synthetic forbidden snippet (self-test)', () => {
    const forbidden = `
      await tmux.respawnPane({
        socket: deps.socket,
        target: rightPaneId,
        argv: ['cat'],
      })
    `
    expect(stripComments(forbidden).match(FORBIDDEN_PATTERN)).not.toBeNull()

    // opts. prefix
    const forbiddenOpts = `tmux.respawnPane({ target: opts.rightPaneId, argv: ['cat'] })`
    expect(stripComments(forbiddenOpts).match(FORBIDDEN_PATTERN)).not.toBeNull()

    // Comment-only reference is ALLOWED (does not match after stripComments).
    const commentOnly = `// the legacy respawnPane(rightPaneId, ['cat']) path is gone`
    expect(stripComments(commentOnly).match(FORBIDDEN_PATTERN)).toBeNull()

    // Allowed: respawnPane on a left pane.
    const allowed = `tmux.respawnPane({ target: leftPaneId, argv: ['orch-daemon'] })`
    expect(stripComments(allowed).match(FORBIDDEN_PATTERN)).toBeNull()

    // Allowed: respawnPane with a non-rightPaneId variable.
    const allowed2 = `tmux.respawnPane({ target: targetPane, argv: ['x'] })`
    expect(stripComments(allowed2).match(FORBIDDEN_PATTERN)).toBeNull()
  })
})
