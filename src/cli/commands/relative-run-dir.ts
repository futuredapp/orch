import { relative } from 'node:path'
import type { Path } from '../../services/index.ts'

/** `<statePath>/<runId>` rendered relative to `cwd`. Used by the end-of-run
 *  summary so the user can `cd`/`tail` into the run dir without recomputing
 *  the path from the ID. */
export function relativeRunDir(cwd: Path, statePath: Path, runId: string): string {
  return `${relative(cwd, statePath)}/${runId}`
}
