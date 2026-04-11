import type { Validator, ValidatorResult } from './validator.ts'

/**
 * Asserts that HEAD moved since the pre-run baseline — i.e. the step
 * actually produced a commit, not just an unstaged edit.
 *
 * Requires `preRunSnapshot.headSha`. Fails loudly if the baseline was
 * never captured (non-git cwd).
 */
export function gitCommitCreated(): Validator {
  return {
    name: 'gitCommitCreated',
    needs: ['headSha'],
    async run(services, ctx): Promise<ValidatorResult> {
      const baseline = ctx.preRunSnapshot?.headSha
      if (baseline === undefined) {
        return {
          ok: false,
          reason: 'gitCommitCreated: no baseline HEAD SHA captured — is cwd a git repo?',
          hint: 'Run the step in a git repository so a baseline can be snapshotted.',
        }
      }
      const current = await services.git.headSha(ctx.cwd)
      if (current === baseline) {
        return {
          ok: false,
          reason: `HEAD is still ${baseline.slice(0, 8)} — no commit was created`,
          hint: 'The step should commit its changes (e.g. `git commit`).',
        }
      }
      return { ok: true }
    },
  }
}
