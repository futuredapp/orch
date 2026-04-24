// ---------------------------------------------------------------------------
// Orch version — cached read of the package.json version string.
// ---------------------------------------------------------------------------
//
// Baseline session logs embed the orch version (`run.meta.json.orchVersion`,
// run-local `README.md`). A single cached async read avoids touching disk on
// every log write. Resolution order:
//
//   1. Walk up from this file's directory until we find a `package.json`.
//   2. If anything fails (frozen deploy, weird bundling), fall back to
//      '0.0.0' — never throw. Log writers must not fail on version detection.

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const FALLBACK = '0.0.0'

let cached: Promise<string> | undefined

export function orchVersion(): Promise<string> {
  if (cached === undefined) cached = resolveVersion()
  return cached
}

async function resolveVersion(): Promise<string> {
  try {
    const thisFile = fileURLToPath(import.meta.url)
    let dir = dirname(thisFile)
    for (let depth = 0; depth < 8; depth++) {
      const candidate = join(dir, 'package.json')
      try {
        const body = await readFile(candidate, 'utf8')
        const pkg = JSON.parse(body) as { version?: unknown }
        if (typeof pkg.version === 'string' && pkg.version.length > 0) return pkg.version
        return FALLBACK
      } catch {
        /* keep walking */
      }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    return FALLBACK
  } catch {
    return FALLBACK
  }
}
