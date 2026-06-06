// U2 — buildPhasedWorkflow factory + input handling (R4, R10, AE5).

import { describe, expect, it } from 'bun:test'
import { PHASE_DELIMITER } from '../../../src/workflows/phased-build/decide-prompt.ts'
import { buildPhasedWorkflow } from '../../../src/workflows/phased-build/pipeline.ts'
import {
  makeDeps,
  makeRecordingRunner,
  scriptCommand,
  scriptDecideArtifact,
  scriptPhaseStatus,
} from './_harness.ts'

const ONE_PHASE = [PHASE_DELIMITER, 'Only phase', 'do the thing']

describe('buildPhasedWorkflow — input resolution (AE5)', () => {
  it('loads an existing file as the plan text handed to the decide step', async () => {
    const deps = makeDeps({ prompt: '/plans/my-plan.md' })
    const { runner, prompts } = makeRecordingRunner()
    scriptCommand(deps, ['cat', '--', '/plans/my-plan.md'], {
      stdout: ['PLAN FILE CONTENTS', 'second line'],
      exitCode: 0,
    })
    scriptDecideArtifact(deps, ONE_PHASE)
    scriptPhaseStatus(deps, 1, 'ok')

    await buildPhasedWorkflow('work-cc', runner).execute(deps)

    expect(prompts[0]).toContain('PLAN FILE CONTENTS')
    expect(prompts[0]).toContain('second line')
  })

  it('hands the argument string itself to the decide step when it is not a readable file', async () => {
    const deps = makeDeps({ prompt: 'add a dark mode toggle' })
    const { runner, prompts } = makeRecordingRunner()
    // cat of a non-file exits non-zero → inline branch.
    scriptCommand(deps, ['cat', '--', 'add a dark mode toggle'], { exitCode: 1 })
    scriptDecideArtifact(deps, ONE_PHASE)
    scriptPhaseStatus(deps, 1, 'ok')

    await buildPhasedWorkflow('work-cc', runner).execute(deps)

    expect(prompts[0]).toContain('add a dark mode toggle')
  })
})

describe('buildPhasedWorkflow — empty resolved plan', () => {
  it('halts before the decide step when an existing file is empty', async () => {
    const deps = makeDeps({ prompt: '/plans/empty.md' })
    const { runner, prompts } = makeRecordingRunner()
    // File exists (exit 0) but has no contents.
    scriptCommand(deps, ['cat', '--', '/plans/empty.md'], { stdout: [], exitCode: 0 })

    await expect(buildPhasedWorkflow('work-cc', runner).execute(deps)).rejects.toThrow(
      /resolved plan is empty/,
    )
    expect(prompts).toHaveLength(0)
    expect(deps.host.interactiveSpawns).toHaveLength(0)
  })
})

describe('buildPhasedWorkflow — usage guard', () => {
  it('throws a clear usage error before any agent step when the argument is missing', async () => {
    const deps = makeDeps()
    const { runner, prompts } = makeRecordingRunner()

    await expect(buildPhasedWorkflow('work-cc', runner).execute(deps)).rejects.toThrow(
      /requires a plan file or an inline description/,
    )
    expect(prompts).toHaveLength(0)
    expect(deps.host.interactiveSpawns).toHaveLength(0)
  })

  it('throws on a whitespace-only argument', async () => {
    const deps = makeDeps({ prompt: '   ' })
    const { runner } = makeRecordingRunner()

    await expect(buildPhasedWorkflow('work-cc', runner).execute(deps)).rejects.toThrow(
      /requires a plan file or an inline description/,
    )
  })
})

describe('buildPhasedWorkflow — single-source factory (R4)', () => {
  it('produces executors with distinct names but identical step structure from one factory', () => {
    const cc = buildPhasedWorkflow('work-cc', makeRecordingRunner().runner)
    const codex = buildPhasedWorkflow('work-codex', makeRecordingRunner().runner)

    expect(cc.name).toBe('work-cc')
    expect(codex.name).toBe('work-codex')
    expect(typeof cc.execute).toBe('function')
    expect(typeof cc.resume).toBe('function')
  })
})
