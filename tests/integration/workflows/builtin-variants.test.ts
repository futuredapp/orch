// U5 — the two packaged entry workflows (`orch::work-cc`, `orch::work-codex`).
//
// These prove the REAL bindings the resolver loads are runnable phased-build
// pipelines (not placeholders), that both share one body and differ only in the
// bound runner (R4, AE2), and that every agent step is interactive + autoStop
// with no autonomous step (R5). The full decide→parse→loop body is exercised by
// the U2–U4 suites; here we anchor the two shipped variants to it.

import { describe, expect, it } from 'bun:test'
import { PHASE_DELIMITER } from '../../../src/workflows/phased-build/decide-prompt.ts'
import { buildPhasedWorkflow } from '../../../src/workflows/phased-build/pipeline.ts'
import workCc from '../../../src/workflows/work-cc/index.ts'
import workCodex from '../../../src/workflows/work-codex/index.ts'
import {
  makeDeps,
  makeRecordingRunner,
  scriptCommand,
  scriptDecideArtifact,
  scriptPhaseStatus,
} from './_harness.ts'

const TWO_PHASES = [
  PHASE_DELIMITER,
  'Phase one',
  'body one',
  PHASE_DELIMITER,
  'Phase two',
  'body two',
]

describe('work-cc / work-codex entry modules are real phased-build executors (AE2)', () => {
  it('exports a work-cc executor named work-cc', () => {
    expect(workCc.name).toBe('work-cc')
    expect(typeof workCc.execute).toBe('function')
    expect(typeof workCc.resume).toBe('function')
  })

  it('exports a work-codex executor named work-codex', () => {
    expect(workCodex.name).toBe('work-codex')
    expect(typeof workCodex.execute).toBe('function')
    expect(typeof workCodex.resume).toBe('function')
  })

  // The decisive placeholder-vs-real check: the old stub threw "not implemented
  // yet" immediately; the real phased body throws the usage error on an empty
  // argument (the guard at the top of buildPhasedWorkflow). No runner runs.
  it('routes work-cc into the phased body — empty prompt yields the usage error, not a stub error', async () => {
    await expect(workCc.execute(makeDeps({ prompt: '' }))).rejects.toThrow(
      /work-cc requires a plan file or an inline description/,
    )
  })

  it('routes work-codex into the phased body — empty prompt yields the usage error, not a stub error', async () => {
    await expect(workCodex.execute(makeDeps({ prompt: '' }))).rejects.toThrow(
      /work-codex requires a plan file or an inline description/,
    )
  })
})

describe('the shared factory produces identical structure regardless of runner (R4, AE2)', () => {
  // Runner identity differing across the two variants is structural — the two
  // entry modules above pass different runners (claude vs codex) into ONE
  // factory. Here we prove that factory body is runner-agnostic by running it
  // with two interchangeable recording runners and asserting identical shape.
  it('both names run the same interactive-step sequence and prompts; only the runner differs', async () => {
    const ccDeps = makeDeps({ prompt: 'inline' })
    const { runner: ccRunner, prompts: ccPrompts } = makeRecordingRunner()
    scriptCommand(ccDeps, ['cat', '--', 'inline'], { exitCode: 1 })
    scriptDecideArtifact(ccDeps, TWO_PHASES)
    scriptPhaseStatus(ccDeps, 1, 'ok')
    scriptPhaseStatus(ccDeps, 2, 'ok')
    await buildPhasedWorkflow('work-cc', ccRunner).execute(ccDeps)

    const codexDeps = makeDeps({ prompt: 'inline' })
    const { runner: codexRunner, prompts: codexPrompts } = makeRecordingRunner()
    scriptCommand(codexDeps, ['cat', '--', 'inline'], { exitCode: 1 })
    scriptDecideArtifact(codexDeps, TWO_PHASES)
    scriptPhaseStatus(codexDeps, 1, 'ok')
    scriptPhaseStatus(codexDeps, 2, 'ok')
    await buildPhasedWorkflow('work-codex', codexRunner).execute(codexDeps)

    const shape = (deps: typeof ccDeps): readonly { step: string; autoStop?: boolean }[] =>
      deps.host.interactiveSpawns.map((s) => ({ step: String(s.stepName), autoStop: s.autoStop }))

    expect(shape(codexDeps)).toEqual(shape(ccDeps))
    expect(codexPrompts).toEqual(ccPrompts)
  })

  it('every agent step is interactive + autoStop — the pipeline has no autonomous step (R5)', async () => {
    const deps = makeDeps({ prompt: 'inline' })
    const { runner } = makeRecordingRunner()
    scriptCommand(deps, ['cat', '--', 'inline'], { exitCode: 1 })
    scriptDecideArtifact(deps, [PHASE_DELIMITER, 'Solo', 'body'])
    scriptPhaseStatus(deps, 1, 'ok')

    await buildPhasedWorkflow('work-cc', runner).execute(deps)

    // 1 decide + 1 implement = 2 interactive spawns, all auto-stopped. Agent
    // steps that ran autonomously would surface as host `runner` events instead.
    expect(deps.host.interactiveSpawns).toHaveLength(2)
    expect(deps.host.interactiveSpawns.every((s) => s.autoStop === true)).toBe(true)
    expect(deps.host.recorded.filter((r) => r.kind === 'runner')).toHaveLength(0)
  })
})

describe('orch::work-cc drives the full decide→parse→loop happy path unattended', () => {
  it('completes a 2-phase plan from an inline description with no human keystrokes', async () => {
    const deps = makeDeps({ prompt: 'inline plan' })
    const { runner } = makeRecordingRunner()
    scriptCommand(deps, ['cat', '--', 'inline plan'], { exitCode: 1 })
    scriptDecideArtifact(deps, TWO_PHASES)
    scriptPhaseStatus(deps, 1, 'ok')
    scriptPhaseStatus(deps, 2, 'ok')

    await expect(buildPhasedWorkflow('work-cc', runner).execute(deps)).resolves.toBeUndefined()

    expect(deps.host.interactiveSpawns).toHaveLength(3) // decide + 2 implement
  })
})
