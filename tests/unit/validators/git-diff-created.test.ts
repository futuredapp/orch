import { describe, expect, it } from 'bun:test'
import { stepName } from '../../../src/core/types.ts'
import { FakeFsService, FakeGitService, path } from '../../../src/services/index.ts'
import {
  gitDiffCreated,
  type ValidatorCtx,
  type ValidatorServices,
} from '../../../src/validators/index.ts'

function makeCtxWithBaseline(baseline: string | undefined): {
  ctx: ValidatorCtx
  services: ValidatorServices
  git: FakeGitService
} {
  const git = new FakeGitService()
  return {
    git,
    services: { fs: new FakeFsService(), git },
    ctx: {
      stepName: stepName('plan'),
      cwd: path('/work'),
      value: undefined,
      ...(baseline !== undefined ? { preRunSnapshot: { headSha: baseline } } : {}),
    },
  }
}

describe('gitDiffCreated', () => {
  it('declares headSha as a capability need so the executor captures a baseline', () => {
    const v = gitDiffCreated()

    expect(v.needs).toEqual(['headSha'])
  })

  it('returns ok when hasDiffSince reports a diff relative to the baseline', async () => {
    const { services, ctx, git } = makeCtxWithBaseline('abc1234')
    git.setHasDiff(path('/work'), 'abc1234', true)

    const result = await gitDiffCreated().run(services, ctx)

    expect(result.ok).toBe(true)
  })

  it('returns a failure with the short baseline when there is no diff', async () => {
    const { services, ctx, git } = makeCtxWithBaseline('abcdef1234567890')
    git.setHasDiff(path('/work'), 'abcdef1234567890', false)

    const result = await gitDiffCreated().run(services, ctx)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain('abcdef12')
      expect(result.reason).toContain('No file changes')
    }
  })

  it('returns a distinct failure reason when the baseline was never captured', async () => {
    const { services, ctx } = makeCtxWithBaseline(undefined)

    const result = await gitDiffCreated().run(services, ctx)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain('no baseline HEAD SHA captured')
    }
  })
})
