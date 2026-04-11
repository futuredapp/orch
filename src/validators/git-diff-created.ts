import type { Validator, ValidatorResult } from './validator.ts'

/**
 * Asserts that the working tree has changed since the pre-run baseline.
 *
 * Requires `preRunSnapshot.headSha` — the executor captures it before the
 * runner because this validator declares `needs: ['headSha']`. Missing
 * baseline is a clear failure, not a silent pass.
 *
 * Uses `git diff --quiet` (O(1) memory) via `GitService.hasDiffSince` —
 * never buffers the full diff even when the step touched thousands of files.
 */
export function gitDiffCreated(): Validator {
  return {
    name: 'gitDiffCreated',
    needs: ['headSha'],
    async run(services, ctx): Promise<ValidatorResult> {
      const baseline = ctx.preRunSnapshot?.headSha
      if (baseline === undefined) {
        return {
          ok: false,
          reason: 'gitDiffCreated: no baseline HEAD SHA captured — is cwd a git repo?',
          hint: 'Run the step in a git repository so a baseline can be snapshotted.',
        }
      }
      const hasDiff = await services.git.hasDiffSince(ctx.cwd, baseline)
      if (!hasDiff) {
        return {
          ok: false,
          reason: `No file changes since baseline ${baseline.slice(0, 8)}`,
          hint: 'The step should produce or modify at least one tracked file.',
        }
      }
      return { ok: true }
    },
  }
}
