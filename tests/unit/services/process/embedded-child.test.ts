// This pins the dev-checkout vs compiled-binary launch contract that
// `embedded-child` derives both call sites from. orch re-invokes itself to
// spawn its TUI children; in a dev checkout the head token is the on-disk
// runner file, but in a `bun build --compile` binary that file resolves under
// Bun's embedded FS (`/$bunfs/...`) and must be swapped for an internal
// subcommand. Passing a `/$bunfs/` path through as the head token is exactly
// the production incident that crashed the Homebrew binary's left pane with
// "Unknown command" → exit 2 → dead pane. These tests lock the detection rule
// and the argv shape so that regression cannot return unnoticed.

import { describe, expect, it } from 'bun:test'
import {
  embeddedChildArgv,
  isEmbeddedRunnerPath,
} from '../../../../src/services/process/embedded-child.ts'

describe('isEmbeddedRunnerPath', () => {
  it('returns true for a runner path under Bun embedded filesystem', () => {
    const runnerScript = '/$bunfs/root/steps-view-runner.tsx'

    const result = isEmbeddedRunnerPath(runnerScript)

    expect(result).toBe(true)
  })

  it('returns false for an absolute dev-checkout runner path', () => {
    const runnerScript = '/Users/dev/orch/src/hosts/two-pane/steps-view/steps-view-runner.tsx'

    const result = isEmbeddedRunnerPath(runnerScript)

    expect(result).toBe(false)
  })

  it('returns false for a relative path and for the empty string', () => {
    const relative = isEmbeddedRunnerPath('src/runner.tsx')
    const empty = isEmbeddedRunnerPath('')

    expect(relative).toBe(false)
    expect(empty).toBe(false)
  })
})

describe('embeddedChildArgv', () => {
  it('returns execPath then the runner script then trailing args in a dev checkout', () => {
    const argv = embeddedChildArgv({
      execPath: '/usr/local/bin/bun',
      runnerScript: '/repo/src/runner.tsx',
      subcommand: '__steps-view',
      trailing: ['--opts', 'abc'],
    })

    expect(argv).toEqual(['/usr/local/bin/bun', '/repo/src/runner.tsx', '--opts', 'abc'])
  })

  it('returns execPath then the subcommand then trailing args for a compiled binary, never the embedded runner path', () => {
    const runnerScript = '/$bunfs/root/steps-view-runner.tsx'

    const argv = embeddedChildArgv({
      execPath: '/usr/local/bin/orch',
      runnerScript,
      subcommand: '__steps-view',
      trailing: ['--opts', 'abc'],
    })

    expect(argv).toEqual(['/usr/local/bin/orch', '__steps-view', '--opts', 'abc'])
    expect(argv).not.toContain(runnerScript)
  })

  it('preserves trailing args verbatim and in order in both modes, including an empty trailing list', () => {
    const devArgv = embeddedChildArgv({
      execPath: '/usr/local/bin/bun',
      runnerScript: '/repo/src/runner.tsx',
      subcommand: '__ask',
      trailing: ['--spec', 'c3BlYw==', '--result', '/tmp/result.json'],
    })
    const binaryArgv = embeddedChildArgv({
      execPath: '/usr/local/bin/orch',
      runnerScript: '/$bunfs/root/runner.tsx',
      subcommand: '__ask',
      trailing: ['--spec', 'c3BlYw==', '--result', '/tmp/result.json'],
    })
    const emptyTrailing = embeddedChildArgv({
      execPath: '/usr/local/bin/orch',
      runnerScript: '/$bunfs/root/runner.tsx',
      subcommand: '__ask',
      trailing: [],
    })

    expect(devArgv).toEqual([
      '/usr/local/bin/bun',
      '/repo/src/runner.tsx',
      '--spec',
      'c3BlYw==',
      '--result',
      '/tmp/result.json',
    ])
    expect(binaryArgv).toEqual([
      '/usr/local/bin/orch',
      '__ask',
      '--spec',
      'c3BlYw==',
      '--result',
      '/tmp/result.json',
    ])
    expect(emptyTrailing).toEqual(['/usr/local/bin/orch', '__ask'])
  })
})
