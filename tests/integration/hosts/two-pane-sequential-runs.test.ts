// ---------------------------------------------------------------------------
// Reproducer for "second run blinks and exits" bug.
// ---------------------------------------------------------------------------
//
// User-reported symptom (2026-04-28):
//
//   $ bunx orch run riddle-solver-proper      # first run: works fine
//   $ bunx orch run riddle-solver-proper      # second run: terminal "blinks"
//                                              #   (alt-screen flashes), command
//                                              #   disappears, no state dir
//                                              #   created, nothing logged
//
// The hypothesis space:
//
//   1. State leaks across runs in the same process — covered by the
//      `same process, two host cycles` test below. Catches anything where
//      one run leaves a singleton, listener, or env mutation that breaks the
//      next host.
//
//   2. State leaks across processes via the tmux socket layer — covered by
//      `two CLI subprocesses share state` test. Each invocation gets a fresh
//      runId / socket, so any cross-run breakage points at a global tmux
//      side effect (orphaned servers, leaked options, etc.).
//
//   3. State leaks via the workspace filesystem — covered by `same workspace
//      reused`. `riddle.txt` / `solution.txt` left over from run 1 don't
//      crash the host on run 2.
//
// Each test runs the FULL host lifecycle (create → interactive step via
// respawn-pane → teardown) against a real tmux server. The interactive
// "agent" is `true(1)` — exits 0 immediately, fires `pane-died`, unblocks
// `runInteractive`. No Claude credentials needed.
//
// Skipped when tmux is not on PATH so this stays in the default unit/
// integration suite.

import { afterEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import { Writable } from 'node:stream'
import { step, type WorkflowDeps, workflow } from '../../../src/core/index.ts'
import { createTmuxHost } from '../../../src/hosts/index.ts'
import { createNullSessionLogger } from '../../../src/observability/index.ts'
import { defineRunner, type Runner, type RunnerCommand } from '../../../src/runners/index.ts'
import {
  BunClock,
  BunFsService,
  BunProcessService,
  FakeGitService,
  path,
} from '../../../src/services/index.ts'
import { FakePromptService } from '../../../src/services/prompt/index.ts'
import { RealTmuxService } from '../../../src/services/tmux/index.ts'
import { FileStateStore, type RunId } from '../../../src/state/index.ts'

const canRun = Bun.which('tmux') !== null

// `true(1)` exits 0 immediately. Inside a tmux pane that triggers the
// global `pane-died` hook — the only signal `runInteractive` waits on.
const trueRunner: Readonly<Runner> = defineRunner({
  name: 'fake',
  supports: { interactive: true, structuredOutput: false },
  defaultView: { kind: 'transcript', pane: 'right' },
  buildCommand(): RunnerCommand {
    return { argv: ['true'], env: {} }
  },
  parseEvents(): null {
    return null
  },
  extractStructuredOutput(): undefined {
    return undefined
  },
  toTranscriptLines() {
    return []
  },
})

function bufferStream(): { stream: NodeJS.WritableStream; text: () => string } {
  const chunks: string[] = []
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(String(chunk))
      cb()
    },
  })
  return { stream: stream as unknown as NodeJS.WritableStream, text: () => chunks.join('') }
}

interface SingleRunResult {
  readonly runId: RunId
  readonly stderrText: string
}

async function runOnce(opts: {
  readonly runId: string
  readonly cwd: string
  readonly statePath: string
  readonly tmuxSockets: string[]
}): Promise<SingleRunResult> {
  const runId = opts.runId as RunId
  opts.tmuxSockets.push(`orch-${runId}`)

  const stderr = bufferStream()
  const processService = new BunProcessService()
  const tmux = new RealTmuxService({ processService })
  const bunFs = new BunFsService()

  const basePath = path(opts.statePath)
  const stateStore = new FileStateStore({ fs: bunFs, basePath })

  const host = await createTmuxHost({
    tmux,
    fs: bunFs,
    processService,
    clock: new BunClock(),
    runId,
    workflowName: 'demo',
    stderr: stderr.stream,
    skipAttach: true,
    skipVersionCheck: false,
    env: {},
    cwd: opts.cwd,
    logger: createNullSessionLogger({ runId }),
    // U6: right-pane interactive requires the controller. Wire basePath +
    // stateStore so createTmuxHost constructs one. disableStepsView keeps
    // this test from spawning the steps-view Ink child (a separate concern).
    basePath,
    stateStore,
    disableStepsView: true,
  })

  const wfDeps: WorkflowDeps = {
    stateStore,
    processService,
    clock: new BunClock(),
    runId,
    cwd: path(opts.cwd),
    fsService: bunFs,
    gitService: new FakeGitService(),
    workflowName: 'demo',
    args: {},
    host,
    promptService: new FakePromptService(),
    interactivity: 'interactive' as const,
    logger: createNullSessionLogger({ runId }),
  }

  try {
    await workflow('demo', async (run) => {
      await run(step.define('interactive-noop', { agent: trueRunner, mode: 'interactive' }))
    }).execute(wfDeps)
  } finally {
    await host.teardown()
  }

  return { runId, stderrText: stderr.text() }
}

async function killSocket(socket: string): Promise<void> {
  const proc = Bun.spawn(['tmux', '-L', socket, 'kill-server'], {
    stdout: 'ignore',
    stderr: 'ignore',
  })
  await proc.exited
}

describe.skipIf(!canRun)('two-pane host - sequential runs against real tmux', () => {
  let tmuxSockets: string[] = []
  let tmpDirs: string[] = []

  afterEach(async () => {
    for (const s of tmuxSockets) await killSocket(s)
    tmuxSockets = []
    for (const d of tmpDirs) await fs.rm(d, { recursive: true, force: true }).catch(() => {})
    tmpDirs = []
  })

  it('two consecutive runs in the same process both finish cleanly', async () => {
    const tmpDir = await fs.mkdtemp('/tmp/orch-seq-test-')
    tmpDirs.push(tmpDir)
    const statePath = `${tmpDir}/.orch/state`

    const r1 = await runOnce({
      runId: 'r-2026-04-28-031568-o6',
      cwd: tmpDir,
      statePath,
      tmuxSockets,
    })

    // Sanity: first run produced no error banner on stderr.
    expect(r1.stderrText).not.toContain('attach exited')
    expect(r1.stderrText).not.toContain('respawn-pane failed')

    // Second run — the regression site. If anything from run 1 leaks into
    // the new host's setup, this is where it surfaces.
    const r2 = await runOnce({
      runId: 'r-2026-04-28-983232-a7',
      cwd: tmpDir,
      statePath,
      tmuxSockets,
    })

    expect(r2.stderrText).not.toContain('attach exited')
    expect(r2.stderrText).not.toContain('respawn-pane failed')
  })

  it('two consecutive runs against the same workspace filesystem both finish cleanly', async () => {
    // Mirrors the user's actual sequence: `examples/` already has
    // `riddle.txt` + `solution.txt` from run 1 when run 2 starts.
    const tmpDir = await fs.mkdtemp('/tmp/orch-seq-files-')
    tmpDirs.push(tmpDir)
    await fs.writeFile(`${tmpDir}/riddle.txt`, 'leftover from run 1\n')
    await fs.writeFile(`${tmpDir}/solution.txt`, 'leftover from run 1\n')

    const r1 = await runOnce({
      runId: 'r-2026-04-28-725320-mg',
      cwd: tmpDir,
      statePath: `${tmpDir}/.orch/state`,
      tmuxSockets,
    })
    expect(r1.stderrText).not.toContain('respawn-pane failed')

    const r2 = await runOnce({
      runId: 'r-2026-04-28-472508-ey',
      cwd: tmpDir,
      statePath: `${tmpDir}/.orch/state`,
      tmuxSockets,
    })
    expect(r2.stderrText).not.toContain('respawn-pane failed')
  })

  it('two consecutive CLI subprocess invocations both produce a state directory', async () => {
    // Closest in-tree mirror of the user's shell sequence:
    //
    //   $ bunx orch run demo
    //   $ bunx orch run demo
    //
    // Each invocation is a fresh process, fresh tmux server (different
    // socket). If the second exits ≠ 0 or doesn't write a state dir, this
    // is our smoking gun — and the test artifacts (stdout/stderr) tell us
    // exactly where it died.
    const tmpDir = await fs.mkdtemp('/tmp/orch-seq-cli-')
    tmpDirs.push(tmpDir)

    const repoRoot = process.cwd()
    const cliPath = `${repoRoot}/src/cli/main.ts`

    await fs.writeFile(
      `${tmpDir}/orch.config.ts`,
      [
        `import { defineConfig } from '${repoRoot}/src/config/index.ts'`,
        `export default defineConfig({ workflows: { demo: 'demo.ts' } })`,
        '',
      ].join('\n'),
    )
    await fs.writeFile(
      `${tmpDir}/demo.ts`,
      [
        `import { workflow, step } from '${repoRoot}/src/core/index.ts'`,
        `import { defineRunner } from '${repoRoot}/src/runners/index.ts'`,
        '',
        'const fake = defineRunner({',
        "  name: 'fake',",
        '  supports: { interactive: true, structuredOutput: false },',
        "  defaultView: { kind: 'transcript', pane: 'right' },",
        "  buildCommand: () => ({ argv: ['true'], env: {} }),",
        '  parseEvents: () => null,',
        '  extractStructuredOutput: () => undefined,',
        '  toTranscriptLines: () => [],',
        '})',
        '',
        "export default workflow('demo', async (run) => {",
        "  await run(step.define('interactive-noop', { agent: fake, mode: 'interactive' }))",
        '})',
        '',
      ].join('\n'),
    )

    interface RunOutput {
      readonly exitCode: number
      readonly stdout: string
      readonly stderr: string
    }
    const spawnOnce = (): RunOutput => {
      const r = Bun.spawnSync({
        cmd: ['bun', 'run', cliPath, 'run', 'demo', '--mode=two-pane', '--no-attach'],
        cwd: tmpDir,
        // Real env so PATH/HOME/TMPDIR reach the spawned tmux server.
        env: process.env as Record<string, string>,
      })
      return {
        exitCode: r.exitCode ?? -1,
        stdout: r.stdout?.toString() ?? '',
        stderr: r.stderr?.toString() ?? '',
      }
    }

    const r1 = spawnOnce()
    expect(r1).toMatchObject({ exitCode: 0 })

    // Track sockets created by the subprocess so afterEach reaps them.
    // The subprocess's runId is in the `Running workflow "demo" (r-…)` line.
    const r1Match = r1.stderr.match(/r-\d{4}-\d{2}-\d{2}-\d{6}-[a-z0-9]{2}/)
    if (r1Match !== null) tmuxSockets.push(`orch-${r1Match[0]}`)

    const r2 = spawnOnce()
    const r2Match = r2.stderr.match(/r-\d{4}-\d{2}-\d{2}-\d{6}-[a-z0-9]{2}/)
    if (r2Match !== null) tmuxSockets.push(`orch-${r2Match[0]}`)

    // The whole point of this test: if run 2 exits non-zero, we've
    // reproduced the bug. The stdout/stderr in the assertion message gives
    // the maintainer a one-line diagnosis when the test fails.
    expect(r2).toMatchObject({ exitCode: 0 })

    // And both invocations must have produced a per-run state directory —
    // the symptom in the original bug report was "no state dir created".
    const stateEntries = await fs.readdir(`${tmpDir}/.orch/state`)
    const runDirs = stateEntries.filter((e) => /^r-\d{4}-\d{2}-\d{2}-\d{6}-[a-z0-9]{2}$/.test(e))
    expect(runDirs.length).toBe(2)
  })
})
