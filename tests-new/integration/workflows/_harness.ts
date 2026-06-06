// Shared, explicit factories for the phased-build integration tests. No hidden
// state: each test calls makeDeps()/makeRecordingRunner() fresh and scripts its
// own command responses on the returned FakeProcessService.

import type { WorkflowDeps } from '../../../src/core/index.ts'
import { defineRunner, type Runner, type RunnerContext } from '../../../src/runners/index.ts'
import {
  FakeClock,
  FakeFsService,
  FakeGitService,
  FakeProcessService,
  path,
} from '../../../src/services/index.ts'
import { FakePromptService } from '../../../src/services/prompt/index.ts'
import { FileStateStore, type RunId } from '../../../src/state/index.ts'
import { ARTIFACT_PATH } from '../../../src/workflows/phased-build/decide-prompt.ts'
import { createFakeHost, type FakeHost } from '@orch/test/fake-host.ts'

export type PhasedBuildDeps = WorkflowDeps & {
  host: FakeHost
  processService: FakeProcessService
}

export function makeDeps(args?: { readonly prompt?: string }): PhasedBuildDeps {
  const fs = new FakeFsService()
  const host = createFakeHost({ mode: 'two-pane' })
  const processService = new FakeProcessService()
  return {
    fsService: fs,
    gitService: new FakeGitService(),
    processService,
    clock: new FakeClock(1000),
    stateStore: new FileStateStore({ fs, basePath: path('/runs') }),
    runId: 'r-2026-06-02-100000-aa' as RunId,
    cwd: path('/workspace'),
    host,
    promptService: new FakePromptService(),
    interactivity: 'interactive' as const,
    ...(args !== undefined ? { args } : {}),
  }
}

export interface RecordingRunner {
  readonly runner: Runner
  /** The `ctx.prompt` of every interactive agent step, in invocation order. */
  readonly prompts: readonly string[]
  readonly state: { prepareCalls: number; cleanupCalls: number }
}

/**
 * An interactive + autoStop runner that records the prompt it is handed for
 * each step. Needs no FakeProcessService scripting — the FakeHost never spawns
 * the interactive process, it only records the spawn.
 */
export function makeRecordingRunner(): RecordingRunner {
  const prompts: string[] = []
  const state = { prepareCalls: 0, cleanupCalls: 0 }
  const runner = defineRunner({
    name: 'recording-fake',
    supports: { interactive: true, structuredOutput: false },
    buildCommand: (ctx: RunnerContext) => {
      prompts.push(ctx.prompt)
      return { argv: ['recording-fake'], env: ctx.env }
    },
    parseEvents: () => null,
    extractStructuredOutput: () => undefined,
    toTranscriptLines: () => [],
    prepareAutoStop: async () => {
      state.prepareCalls++
      return {
        env: {},
        cleanup: async () => {
          state.cleanupCalls++
        },
      }
    },
  })
  return { runner, prompts, state }
}

/** The recorded prompts that belong to an implement step (one per phase). */
export function implementPrompts(prompts: readonly string[]): readonly string[] {
  return prompts.filter((p) => p.includes('Implement ONLY phase'))
}

/** Script a single `command` step response keyed by exact argv. */
export function scriptCommand(
  deps: PhasedBuildDeps,
  argv: readonly string[],
  response: { stdout?: readonly string[]; exitCode: number; stderr?: readonly string[] },
): void {
  deps.processService.when(argv).respondWith({
    stdout: [...(response.stdout ?? [])],
    exitCode: response.exitCode,
    ...(response.stderr !== undefined ? { stderr: [...response.stderr] } : {}),
  })
}

/**
 * Script the truncate-before-decide + read-back pair: the artifact is emptied,
 * then the read-back returns `artifactLines` as the decide-phases artifact.
 */
export function scriptDecideArtifact(
  deps: PhasedBuildDeps,
  artifactLines: readonly string[],
): void {
  scriptCommand(deps, ['rm', '-f', ARTIFACT_PATH], { exitCode: 0 })
  scriptCommand(deps, ['cat', ARTIFACT_PATH], { stdout: artifactLines, exitCode: 0 })
}

/**
 * Script the per-phase sentinel pair: the status file is emptied, then read
 * back as `status` (e.g. `'ok'` or `'blocked: reason'`). A missing-file read
 * is modeled with `status: undefined` (non-zero exit, empty stdout).
 */
export function scriptPhaseStatus(
  deps: PhasedBuildDeps,
  phaseNumber: number,
  status: string | undefined,
): void {
  const statusPath = `.orch/phase-${phaseNumber}-status`
  scriptCommand(deps, ['rm', '-f', statusPath], { exitCode: 0 })
  if (status === undefined) {
    scriptCommand(deps, ['cat', statusPath], { exitCode: 1 })
  } else {
    scriptCommand(deps, ['cat', statusPath], { stdout: [status], exitCode: 0 })
  }
}
