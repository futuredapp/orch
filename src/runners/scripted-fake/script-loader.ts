/**
 * Reads the JSON file pointed to by `ORCH_LIFECYCLE_SCRIPT` and validates it
 * against `ScriptedFakeScriptFileSchema`. Throws a clear error when the env
 * var is unset, the file is missing/malformed, or the schema fails.
 *
 * Used by `src/runners/scripted-fake/__entry.ts` at the start of each
 * scripted-fake step invocation.
 */

import type { FsService } from '../../services/fs/fs-service.ts'
import { path } from '../../services/types.ts'
import {
  ORCH_LIFECYCLE_SCRIPT_ENV,
  type ScriptedFakeScriptFile,
  ScriptedFakeScriptFileSchema,
  type StepScript,
} from './types.ts'

export class ScriptLoadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ScriptLoadError'
  }
}

export interface LoadScriptDeps {
  readonly fs: FsService
  readonly env: Readonly<Record<string, string | undefined>>
}

export async function loadScriptedFakeScript(
  deps: LoadScriptDeps,
): Promise<ScriptedFakeScriptFile> {
  const scriptPath = deps.env[ORCH_LIFECYCLE_SCRIPT_ENV]
  if (typeof scriptPath !== 'string' || scriptPath.length === 0) {
    throw new ScriptLoadError(
      `${ORCH_LIFECYCLE_SCRIPT_ENV} env var is unset — scripted-fake runner ` +
        'is a Tier 5 fixture-only adapter and must not be reached without one',
    )
  }

  let raw: string
  try {
    raw = await deps.fs.readFile(path(scriptPath))
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    throw new ScriptLoadError(`cannot read ${ORCH_LIFECYCLE_SCRIPT_ENV} (${scriptPath}): ${reason}`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    throw new ScriptLoadError(`${scriptPath} is not valid JSON: ${reason}`)
  }

  const result = ScriptedFakeScriptFileSchema.safeParse(parsed)
  if (!result.success) {
    const summary = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    throw new ScriptLoadError(`${scriptPath} failed schema validation: ${summary}`)
  }
  return result.data
}

export function resolveStepScript(file: ScriptedFakeScriptFile, stepName: string): StepScript {
  const entry = file.steps[stepName]
  if (entry === undefined) {
    const available = Object.keys(file.steps).join(', ')
    throw new ScriptLoadError(
      `no script entry for step "${stepName}" (available: ${available || '(none)'})`,
    )
  }
  return entry
}
