import { describe, expect, it } from 'bun:test'
import { stepName } from '../../../src/core/types.ts'
import { FakeFsService, FakeGitService, path } from '../../../src/services/index.ts'
import {
  gitCommitCreated,
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

describe('gitCommitCreated', () => {
  it('declares headSha as a capability need', () => {
    const v = gitCommitCreated()

    expect(v.needs).toEqual(['headSha'])
  })

  it('returns ok when the current HEAD differs from the baseline', async () => {
    const { services, ctx, git } = makeCtxWithBaseline('aaaaaaa')
    git.setHeadSha(path('/work'), 'bbbbbbb')

    const result = await gitCommitCreated().run(services, ctx)

    expect(result.ok).toBe(true)
  })

  it('returns a failure when HEAD has not moved since the baseline', async () => {
    const { services, ctx, git } = makeCtxWithBaseline('abcdef1234')
    git.setHeadSha(path('/work'), 'abcdef1234')

    const result = await gitCommitCreated().run(services, ctx)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain('no commit was created')
    }
  })

  it('returns a distinct failure reason when the baseline was never captured', async () => {
    const { services, ctx } = makeCtxWithBaseline(undefined)

    const result = await gitCommitCreated().run(services, ctx)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain('no baseline HEAD SHA captured')
    }
  })
})
