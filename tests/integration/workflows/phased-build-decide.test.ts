// U3 — decide-phases step + emit/parse/validate contract (R6, R7, R8, AE3, AE4).

import { describe, expect, it } from 'bun:test'
import { PHASE_DELIMITER } from '../../../src/workflows/phased-build/decide-prompt.ts'
import { buildPhasedWorkflow } from '../../../src/workflows/phased-build/pipeline.ts'
import {
  implementPrompts,
  makeDeps,
  makeRecordingRunner,
  scriptCommand,
  scriptDecideArtifact,
  scriptPhaseStatus,
} from './_harness.ts'

// An input plan that already declares FIVE phases — used to prove the pipeline
// does NOT parse phases out of the input (AE3 / R6).
const PRE_PHASED_INPUT = [
  PHASE_DELIMITER,
  'input phase 1',
  PHASE_DELIMITER,
  'input phase 2',
  PHASE_DELIMITER,
  'input phase 3',
  PHASE_DELIMITER,
  'input phase 4',
  PHASE_DELIMITER,
  'input phase 5',
].join('\n')

describe('decide-phases — fresh decision overrides any pre-written phases (AE3, R6)', () => {
  it('uses the freshly-emitted artifact, not the phase structure in the input plan', async () => {
    const deps = makeDeps({ prompt: PRE_PHASED_INPUT })
    const { runner, prompts } = makeRecordingRunner()
    scriptCommand(deps, ['cat', '--', PRE_PHASED_INPUT], { exitCode: 1 }) // inline (multi-line)
    // The decide step "emits" only TWO phases despite the input declaring five.
    scriptDecideArtifact(deps, [PHASE_DELIMITER, 'fresh A', PHASE_DELIMITER, 'fresh B'])
    scriptPhaseStatus(deps, 1, 'ok')
    scriptPhaseStatus(deps, 2, 'ok')

    await buildPhasedWorkflow('work-cc', runner).execute(deps)

    // Two implement steps — driven by the artifact (2), not the input (5).
    expect(implementPrompts(prompts)).toHaveLength(2)
    expect(prompts[1]).toContain('fresh A')
    expect(prompts[2]).toContain('fresh B')
  })

  it("prompts the agent to re-derive rather than copy the input's structure", async () => {
    const deps = makeDeps({ prompt: 'a small change' })
    const { runner, prompts } = makeRecordingRunner()
    scriptCommand(deps, ['cat', '--', 'a small change'], { exitCode: 1 })
    scriptDecideArtifact(deps, [PHASE_DELIMITER, 'only'])
    scriptPhaseStatus(deps, 1, 'ok')

    await buildPhasedWorkflow('work-cc', runner).execute(deps)

    expect(prompts[0]).toMatch(/do NOT mechanically\s+reproduce/i)
    expect(prompts[0]).toContain('1 and 4 phases')
  })
})

describe('decide-phases — step shape (R5)', () => {
  it('runs the decide step interactively with autoStop enabled', async () => {
    const deps = makeDeps({ prompt: 'inline' })
    const { runner } = makeRecordingRunner()
    scriptCommand(deps, ['cat', '--', 'inline'], { exitCode: 1 })
    scriptDecideArtifact(deps, [PHASE_DELIMITER, 'p1'])
    scriptPhaseStatus(deps, 1, 'ok')

    await buildPhasedWorkflow('work-cc', runner).execute(deps)

    const decideSpawn = deps.host.interactiveSpawns[0]
    expect(String(decideSpawn?.stepName)).toBe('decide-phases')
    expect(decideSpawn?.autoStop).toBe(true)
  })
})

describe('decide-phases — empty artifact halts the run (R8, R-4 guard)', () => {
  it('halts when the read-back is empty (a decide step that wrote nothing)', async () => {
    const deps = makeDeps({ prompt: 'inline' })
    const { runner, prompts } = makeRecordingRunner()
    scriptCommand(deps, ['cat', '--', 'inline'], { exitCode: 1 })
    // Truncate succeeds; read-back returns nothing (no-write decide).
    scriptCommand(deps, ['rm', '-f', '.orch/phased-build-phases.md'], { exitCode: 0 })
    scriptCommand(deps, ['cat', '.orch/phased-build-phases.md'], { exitCode: 0 })

    await expect(buildPhasedWorkflow('work-cc', runner).execute(deps)).rejects.toThrow(
      /no well-formed phases/,
    )
    // The decide step ran, but no implement step did.
    expect(implementPrompts(prompts)).toHaveLength(0)
  })
})
