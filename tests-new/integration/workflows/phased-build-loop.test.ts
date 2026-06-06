// U4 — per-phase implement loop: implement-only, halt-on-failure (R9, R5).

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

const THREE_PHASES = [
  PHASE_DELIMITER,
  'Phase one title',
  'body one',
  PHASE_DELIMITER,
  'Phase two title',
  'body two',
  PHASE_DELIMITER,
  'Phase three title',
  'body three',
]

describe('implement loop — runs one step per phase in order (R5)', () => {
  it('runs exactly three implement steps in order and completes unattended', async () => {
    const deps = makeDeps({ prompt: 'inline' })
    const { runner, prompts } = makeRecordingRunner()
    scriptCommand(deps, ['cat', '--', 'inline'], { exitCode: 1 })
    scriptDecideArtifact(deps, THREE_PHASES)
    scriptPhaseStatus(deps, 1, 'ok')
    scriptPhaseStatus(deps, 2, 'ok')
    scriptPhaseStatus(deps, 3, 'ok')

    await buildPhasedWorkflow('work-cc', runner).execute(deps)

    const steps = implementPrompts(prompts)
    expect(steps).toHaveLength(3)
    expect(steps[0]).toContain('phase 1 of 3')
    expect(steps[1]).toContain('phase 2 of 3')
    expect(steps[2]).toContain('phase 3 of 3')
    // 1 decide + 3 implement interactive spawns, all auto-stopped.
    expect(deps.host.interactiveSpawns).toHaveLength(4)
    expect(deps.host.interactiveSpawns.every((s) => s.autoStop === true)).toBe(true)
  })

  it('caches each phase under a distinct key so resume re-enters the right phase', async () => {
    const deps = makeDeps({ prompt: 'inline' })
    const { runner } = makeRecordingRunner()
    scriptCommand(deps, ['cat', '--', 'inline'], { exitCode: 1 })
    scriptDecideArtifact(deps, THREE_PHASES)
    scriptPhaseStatus(deps, 1, 'ok')
    scriptPhaseStatus(deps, 2, 'ok')
    scriptPhaseStatus(deps, 3, 'ok')

    // No StepNameCollisionError ⇒ the per-phase `as: phase-N` keys are distinct.
    await buildPhasedWorkflow('work-cc', runner).execute(deps)

    const phaseSpawns = deps.host.interactiveSpawns.filter((s) => s.stepName.startsWith('phase-'))
    const keys = new Set(phaseSpawns.map((s) => s.stepName))
    expect(keys.size).toBe(3)
  })
})

describe('implement loop — implement-only prompts (R9)', () => {
  it('scopes each prompt to a single phase with no commit or validation instruction', async () => {
    const deps = makeDeps({ prompt: 'inline' })
    const { runner, prompts } = makeRecordingRunner()
    scriptCommand(deps, ['cat', '--', 'inline'], { exitCode: 1 })
    scriptDecideArtifact(deps, [PHASE_DELIMITER, 'Solo', 'just this'])
    scriptPhaseStatus(deps, 1, 'ok')

    await buildPhasedWorkflow('work-cc', runner).execute(deps)

    const prompt = implementPrompts(prompts)[0] ?? ''
    expect(prompt).toContain('Implement ONLY phase 1 of 1')
    expect(prompt).toMatch(/do NOT create a commit/i)
    expect(prompt).toMatch(/do NOT run the project tests/i)
  })
})

describe('implement loop — halt on phase failure (R9)', () => {
  it('halts before the next phase when a phase reports a non-ok sentinel', async () => {
    const deps = makeDeps({ prompt: 'inline' })
    const { runner, prompts } = makeRecordingRunner()
    scriptCommand(deps, ['cat', '--', 'inline'], { exitCode: 1 })
    scriptDecideArtifact(deps, THREE_PHASES)
    scriptPhaseStatus(deps, 1, 'ok')
    scriptPhaseStatus(deps, 2, 'blocked: ran out of context')
    // Phase 3's sentinel is intentionally NOT scripted — the run must halt
    // after phase 2 before reaching it.

    await expect(buildPhasedWorkflow('work-cc', runner).execute(deps)).rejects.toThrow(
      /Phase 2 .*did not report success/,
    )

    const steps = implementPrompts(prompts)
    expect(steps).toHaveLength(2) // phase 3 never built
  })

  it('halts when a phase leaves a missing or empty sentinel (no-write / crashed phase)', async () => {
    const deps = makeDeps({ prompt: 'inline' })
    const { runner, prompts } = makeRecordingRunner()
    scriptCommand(deps, ['cat', '--', 'inline'], { exitCode: 1 })
    scriptDecideArtifact(deps, [PHASE_DELIMITER, 'p1', PHASE_DELIMITER, 'p2'])
    scriptPhaseStatus(deps, 1, undefined) // cat exits non-zero, empty stdout

    await expect(buildPhasedWorkflow('work-cc', runner).execute(deps)).rejects.toThrow(
      /empty or missing/,
    )
    expect(implementPrompts(prompts)).toHaveLength(1)
  })
})
