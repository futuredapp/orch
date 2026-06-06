import { describe, expect, it } from 'bun:test'
import { renderKindDetails } from '../../../../src/hosts/two-pane/kind-details.tsx'
import type { StepRow } from '../../../../src/hosts/two-pane/steps-view/index.ts'

// Pure presentation — string in, string out. The right-pane controller pipes
// the result straight into `tmux sendKeys`, so we test the formatting itself
// without spinning up an Ink tree.

describe('renderKindDetails for commit kind', () => {
  it('renders the SHA on a CommitResult-shaped value', () => {
    const step: StepRow = {
      kind: 'commit',
      status: 'completed',
      name: 'commit:feat-auth',
      value: { sha: 'abcdef0' },
    }

    const out = renderKindDetails({ step })

    expect(out).toContain('── commit:feat-auth ──')
    expect(out).toContain('commit sha: abcdef0')
  })

  it('renders the no-commit fallback when value is null (clean tree)', () => {
    const step: StepRow = {
      kind: 'commit',
      status: 'completed',
      name: 'commit:noop',
      value: null,
    }

    const out = renderKindDetails({ step })

    expect(out).toContain('── commit:noop ──')
    expect(out).toContain('(no commit — working tree was clean)')
  })
})

describe('renderKindDetails for worktree kind', () => {
  it('renders path / branch / fromRef from a WorktreeResult-shaped value', () => {
    const step: StepRow = {
      kind: 'worktree',
      status: 'completed',
      name: 'worktree:auth-branch',
      value: { path: '/tmp/wt', branch: 'feat/auth', fromRef: 'main' },
    }

    const out = renderKindDetails({ step })

    expect(out).toContain('── worktree:auth-branch ──')
    expect(out).toContain('path:    /tmp/wt')
    expect(out).toContain('branch:  feat/auth')
    expect(out).toContain('fromRef: main')
  })
})

describe('renderKindDetails for ask kind', () => {
  it('shows the cancelled marker when the prompt was cancelled', () => {
    const step: StepRow = {
      kind: 'ask',
      status: 'completed',
      name: 'ask:choose',
      value: { cancelled: true, fields: { name: 'partial' } },
    }

    const out = renderKindDetails({ step })

    expect(out).toContain('── ask:choose ──')
    expect(out).toContain('cancelled')
    expect(out).toContain('name: partial')
  })

  it('shows the chosen button + scalar fields when the user submitted', () => {
    const step: StepRow = {
      kind: 'ask',
      status: 'completed',
      name: 'ask:approve',
      value: { button: 'submit', name: 'martin' },
    }

    const out = renderKindDetails({ step })

    expect(out).toContain('── ask:approve ──')
    expect(out).toContain('button: submit')
    expect(out).toContain('name: martin')
  })
})
