// generate-changelog — the dogfooding changelog workflow (R17, AE4).
//
// Mocks only at the ProcessService edge (CLAUDE.md rule #3): the real workflow
// executor + real Claude runner build the spawn; FakeProcessService records it.
// FakeProcessService.spawn records every call BEFORE it looks for a scripted
// response, so deliberately leaving the autonomous step unscripted lets us read
// back exactly what the workflow tried to spawn (its assembled prompt) while the
// execute() promise rejects with the fake's "no scripted response" — that
// rejection is the assertion that exactly one autonomous step was attempted.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as nodePath from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from '../../../orch.config.ts'
import { __setPromptFileReader } from '../../../src/core/prompt-file/prompt-file-reader.ts'
import generateChangelog from '../../../workflows/generate-changelog/index.ts'
import { makeDeps } from './_harness.ts'

// The workflow reads its promptFile relative to projectRoot(), which the default
// reader derives (and caches) from process.cwd(). Other integration files that
// chdir into temp dirs can leak cwd and poison that cache, making the read throw
// a traversal error instead of reaching the spawn. Pin cwd to the repo root and
// reset the cached reader per test so this file is self-contained.
const REPO_ROOT = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), '../../..')
let savedCwd: string

beforeEach(() => {
  savedCwd = process.cwd()
  process.chdir(REPO_ROOT)
  __setPromptFileReader(undefined)
})

afterEach(() => {
  __setPromptFileReader(undefined)
  process.chdir(savedCwd)
})

/** The prompt string an autonomous Claude argv carries (the arg after `-p`). */
function promptOf(argv: readonly string[]): string {
  const i = argv.indexOf('-p')
  return i >= 0 ? (argv[i + 1] ?? '') : ''
}

describe('generate-changelog — registration (dry-run preflight)', () => {
  it('is registered in orch.config.ts pointing at its entry module', () => {
    expect(config.workflows['generate-changelog']).toBe('workflows/generate-changelog/index.ts')
  })

  it('default-exports a WorkflowExecutor named generate-changelog', () => {
    expect(generateChangelog.name).toBe('generate-changelog')
    expect(typeof generateChangelog.execute).toBe('function')
    expect(typeof generateChangelog.resume).toBe('function')
  })
})

describe('generate-changelog — the single autonomous changelog step', () => {
  it('spawns exactly one autonomous Claude step whose prompt carries the conventional-commit grouping', async () => {
    const deps = makeDeps()

    await expect(generateChangelog.execute(deps)).rejects.toThrow(/no scripted response/)

    expect(deps.processService.calls).toHaveLength(1)
    const argv = deps.processService.calls[0]?.argv ?? []
    expect(argv).toContain('--dangerously-skip-permissions')
    const prompt = promptOf(argv)
    expect(prompt).toContain('Conventional Commits')
    expect(prompt).toContain('### Features')
    expect(prompt).toContain('### Fixes')
    expect(prompt).toContain('### Chores')
    // The prompt-file template resolved and substituted (proves the file exists,
    // is non-empty, and the changelog.prompt.md content flowed through).
    expect(prompt).toContain('CHANGELOG.md')
  })

  it('forwards an explicit args.prompt range into the assembled prompt', async () => {
    const deps = makeDeps({ prompt: 'v0.1.0..HEAD as v0.2.0' })

    await expect(generateChangelog.execute(deps)).rejects.toThrow(/no scripted response/)

    const prompt = promptOf(deps.processService.calls[0]?.argv ?? [])
    expect(prompt).toContain('v0.1.0..HEAD as v0.2.0')
  })

  it('falls back to a derive-it-yourself instruction when no range is given', async () => {
    const deps = makeDeps()

    await expect(generateChangelog.execute(deps)).rejects.toThrow(/no scripted response/)

    const prompt = promptOf(deps.processService.calls[0]?.argv ?? [])
    expect(prompt).toContain('derive the range yourself')
  })
})
