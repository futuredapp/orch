// CLI integration coverage for U4 — runCmd must construct a `ResumeRegistry`
// and pass the same live reference both into `hostFactory` (so the right
// pane can resolve a runner on Enter) AND into `wfDeps` (so `runStepOnce`
// populates the registry as steps execute). Without this wiring the right
// pane refuses with "no runner wired" for every past step.
//
// What this test proves: the registry reaches the host. The
// runStepOnce-side registration is already covered by
// `tests/unit/core/workflow-resume-registry.test.ts`; the same-reference
// property between host and executor is a single literal binding in
// `src/cli/commands/run.ts`, so any regression there shows up here as the
// host receiving `undefined`.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import { runCmd } from '../../../src/cli/commands/run.ts'
import type { CliDeps } from '../../../src/cli/deps.ts'
import { type CliOpts, EXIT, type HostFactory } from '../../../src/cli/main.ts'
import { stepName as toStepName } from '../../../src/core/types.ts'
import { createPlainHost } from '../../../src/hosts/index.ts'
import { createNullSessionLogger } from '../../../src/observability/index.ts'
import {
  BunFsService,
  FakeClock,
  FakeGitService,
  FakeProcessService,
  path,
} from '../../../src/services/index.ts'
import { FakeConfirmService, FakePromptService } from '../../../src/services/prompt/index.ts'
import { FileRunRegistry, FileStateStore } from '../../../src/state/index.ts'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp('/tmp/orch-resume-reg-cli-')
  await fs.mkdir(`${tmpDir}/workflows`, { recursive: true })
  await fs.writeFile(
    `${tmpDir}/orch.config.ts`,
    `export default { workflows: { demo: './workflows/demo.ts' } }\n`,
  )
  // Smallest valid workflow: a single command step. Avoids the
  // interactive-TTY requirement so the assertion can stay focused on the
  // CLI plumbing (host factory receives the registry).
  await fs.writeFile(
    `${tmpDir}/workflows/demo.ts`,
    [
      `import { workflow, command } from '${path(process.cwd())}/src/index.ts'`,
      '',
      "export default workflow('demo', async (run) => {",
      "  await run(command('noop', { argv: ['true'], onFailure: 'halt' }))",
      '})',
      '',
    ].join('\n'),
  )
})

afterEach(async () => {
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true })
})

function makeDeps(): CliDeps {
  const bunFs = new BunFsService()
  const basePath = path(tmpDir)
  const processService = new FakeProcessService()
  // The `command` step uses ProcessService.spawn — script a successful exit.
  processService.when(['true']).respondWith({ exitCode: 0 })
  return {
    processService,
    fsService: bunFs,
    gitService: new FakeGitService(),
    clock: new FakeClock(1000),
    stateStore: new FileStateStore({ fs: bunFs, basePath }),
    registry: new FileRunRegistry({ fs: bunFs, basePath }),
    cwd: path(tmpDir),
    statePath: basePath,
    debug: false,
    sessionLoggerFor: (rid) => createNullSessionLogger({ runId: rid }),
    promptServiceFor: () => new FakePromptService(),
    confirmService: new FakeConfirmService(),
    isStdinTty: true,
  }
}

const DEFAULT_OPTS: CliOpts = {
  mode: 'plain',
  format: 'text',
  noAttach: false,
  debug: false,
  interactivity: 'interactive',
  latest: false,
  step: undefined,
  follow: false,
  watch: false,
}

describe('runCmd forwards a live ResumeRegistry', () => {
  it('passes a defined ResumeRegistry into hostFactory inputs', async () => {
    const deps = makeDeps()
    let capturedRegistry: NonNullable<Parameters<HostFactory>[0]['resumeRegistry']> | undefined

    const spyFactory: HostFactory = async (args) => {
      capturedRegistry = args.resumeRegistry
      return createPlainHost({
        stdout: args.stdout,
        stderr: args.stderr,
        format: 'text',
        clock: args.clock,
        runId: args.runId,
        processService: deps.processService,
      })
    }

    const code = await runCmd(deps, 'demo', {}, DEFAULT_OPTS, spyFactory)
    expect(code).toBe(EXIT.OK)

    // The registry reached the host. No interactive agent step ran in this
    // workflow, so the registry is correctly empty — but defined, which is
    // what the right-pane controller needs to distinguish R10 ("no runner
    // wired") from R11 ("not yet replayed").
    expect(capturedRegistry).toBeDefined()
    if (capturedRegistry === undefined) throw new Error('unreachable')
    expect(typeof capturedRegistry.getRunnerForStep).toBe('function')
    expect(capturedRegistry.getRunnerForStep(toStepName('noop'))).toBeUndefined()
  })
})
