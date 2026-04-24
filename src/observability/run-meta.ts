// ---------------------------------------------------------------------------
// Run metadata — shape written to `logs/run.meta.json`.
// ---------------------------------------------------------------------------
//
// A snapshot of the run's reproducibility context at launch. Values are
// captured once at `runCmd` / `resumeCmd` entry and never mutated (resume
// bumps `resumedAt` by rewriting the file). Env values are redacted to
// `envKeys` only by default; callers that want values (gated on
// `ORCH_LOG_ENV_VALUES=1`) must go through `redactEnvValues` first.

import { envKeys as envKeyList, redactEnvValues } from './redact.ts'

export interface BuildRunMetaOptions {
  readonly runId: string
  readonly workflowName: string
  readonly argv: readonly string[]
  readonly env: Readonly<Record<string, string | undefined>>
  readonly mode: string
  readonly debug: boolean
  readonly orchVersion: string
  readonly os: string
  readonly startedAtIso: string
  /** Gated on `ORCH_LOG_ENV_VALUES=1`. When true, `env` values are emitted
   *  (with secrets redacted to `***`). Defaults to false. */
  readonly emitEnvValues?: boolean
  readonly resumedAtIso?: string
}

export type RunMeta = Readonly<Record<string, unknown>>

export function buildRunMeta(opts: BuildRunMetaOptions): RunMeta {
  const base: Record<string, unknown> = {
    orchVersion: opts.orchVersion,
    runId: opts.runId,
    workflowName: opts.workflowName,
    mode: opts.mode,
    debug: opts.debug,
    argv: [...opts.argv],
    os: opts.os,
    startedAt: opts.startedAtIso,
  }
  if (opts.emitEnvValues === true) {
    base.env = redactEnvValues(opts.env)
  } else {
    base.envKeys = envKeyList(opts.env)
  }
  if (opts.resumedAtIso !== undefined) {
    base.resumedAt = opts.resumedAtIso
  }
  return base
}
