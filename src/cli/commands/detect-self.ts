import type { FsService } from '../../services/fs/index.ts'
import type { Path } from '../../services/types.ts'
import { path } from '../../services/types.ts'

/**
 * Did the user invoke `orch init` (or `orch new`) from the orch source
 * repository itself? `bun link orch` symlinks orch into the host project, so
 * `process.cwd()` resolves to where the user invoked the CLI — not into the
 * orch source tree. We check exactly at `cwd` (no walk-up) so running from a
 * subdirectory of the orch repo does not trip the guard.
 *
 * The guard fires when `<cwd>/package.json` declares `name === 'orch'` AND
 * `<cwd>/src/cli/main.ts` exists. The two-signal check rejects a host
 * project that happened to name itself 'orch' but lacks the orch source
 * layout.
 */
export async function isInsideOrchSourceRepo(
  deps: { readonly fsService: FsService },
  cwd: Path,
): Promise<boolean> {
  const pkgPath = path(`${cwd}/package.json`)
  let pkgJson: string
  try {
    pkgJson = await deps.fsService.readFile(pkgPath)
  } catch {
    return false
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(pkgJson)
  } catch {
    return false
  }
  if (typeof parsed !== 'object' || parsed === null) return false
  const name = (parsed as { name?: unknown }).name
  if (name !== 'orch') return false
  return deps.fsService.exists(path(`${cwd}/src/cli/main.ts`))
}
