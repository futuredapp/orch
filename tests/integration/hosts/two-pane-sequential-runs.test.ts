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
//   2. State leaks via the workspace filesystem — covered by `same workspace
//      reused`. `riddle.txt` / `solution.txt` left over from run 1 don't
//      crash the host on run 2.
//
//   3. State leaks across processes via the tmux socket layer — covered by
//      `two CLI subprocesses`. Each invocation is a fresh process / runId /
//      socket, so any cross-run breakage points at a global tmux side effect.
//
// Flakiness note (2026-05-26): the in-process cases (1, 2) used to hand-roll
// their own host lifecycle with HARDCODED runIds, which meant a fixed tmux
// socket name (`orch-<runId>`). Under the full suite's parallel-file load that
// invited socket collisions ("duplicate session: orch") and bypassed the
// shared fixture's stale-socket reaper + nested-tmux guard. They now ride
// `createRealTmuxFixture` + `mountTmuxHost`, which allocate a UNIQUE socket per
// run and wire the SIGINT/SIGTERM reaper. The subprocess case (3) keeps its
// cross-process shape — it genuinely spawns the CLI — but gets an explicit
// real-tmux timeout (was inheriting Bun's 5s default, the proximate flake) and
// reaps the sockets its subprocesses create.
//
// Each in-process case runs the FULL host lifecycle (mount → interactive step
// via the hidden-pane respawn → teardown) against a real tmux server. The
// interactive "agent" is `true(1)` — exits 0 immediately, fires `pane-died`,
// unblocks `runInteractive`. No Claude credentials needed.
//
// Skipped when tmux is not on PATH (or we are nested inside tmux).

import { afterEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import { defineRunner, type Runner, type RunnerCommand } from '../../../src/runners/index.ts'
import { path as toPath } from '../../../src/services/types.ts'
import {
  canRunRealTmux,
  createRealTmuxFixture,
  type MountedHarness,
  mountTmuxHost,
  REAL_TMUX_TEST_TIMEOUT_MS,
  type RealTmuxFixture,
  type RunWorkflowResult,
} from '../../helpers/real-tmux/index.ts'

const canRun = canRunRealTmux()

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

async function killSocket(socket: string): Promise<void> {
  const proc = Bun.spawn(['tmux', '-L', socket, 'kill-server'], {
    stdout: 'ignore',
    stderr: 'ignore',
  })
  await proc.exited
  // kill-server leaves the socket file behind; remove it so the subprocess
  // sockets leave nothing on disk (the fixture does the same on dispose).
  const uid = process.getuid?.() ?? 0
  for (const dir of [`/tmp/tmux-${uid}`, `/private/tmp/tmux-${uid}`]) {
    await fs.rm(`${dir}/${socket}`, { force: true }).catch(() => {})
  }
}

describe.skipIf(!canRun)('two-pane host - sequential runs against real tmux', () => {
  let fixtures: RealTmuxFixture[] = []
  let harnesses: MountedHarness[] = []
  let tmpDirs: string[] = []
  // Sockets created by spawned CLI subprocesses (case 3) — the fixture cannot
  // own these, so we reap them here to leave no servers behind on failure.
  let subprocessSockets: string[] = []

  afterEach(async () => {
    for (const h of harnesses) await h.teardown()
    for (const f of fixtures) await f.dispose()
    for (const s of subprocessSockets) await killSocket(s)
    for (const d of tmpDirs) await fs.rm(d, { recursive: true, force: true }).catch(() => {})
    fixtures = []
    harnesses = []
    subprocessSockets = []
    tmpDirs = []
  })

  // Mount a host on a fresh fixture (unique socket) and run one interactive
  // noop step end to end. `stateBase` is shared across calls when the test
  // needs two runs to see the same workspace filesystem.
  async function runOnce(opts: { readonly stateBase?: string } = {}): Promise<RunWorkflowResult> {
    const fixture = await createRealTmuxFixture({
      env: {},
      ...(opts.stateBase !== undefined ? { stateBase: toPath(opts.stateBase) } : {}),
    })
    fixtures.push(fixture)
    const harness = await mountTmuxHost(fixture, { disableStepsView: true })
    harnesses.push(harness)
    return harness.runWorkflow([
      { name: 'interactive-noop', agent: trueRunner, mode: 'interactive' },
    ])
  }

  it(
    'two consecutive runs in the same process both finish cleanly',
    async () => {
      const r1 = await runOnce()
      expect(r1.completed).toBe(true)

      // Second run — the regression site. If anything from run 1 leaks into
      // the new host's setup, this is where it surfaces.
      const r2 = await runOnce()
      expect(r2.completed).toBe(true)
    },
    REAL_TMUX_TEST_TIMEOUT_MS,
  )

  it(
    'two consecutive runs against the same workspace filesystem both finish cleanly',
    async () => {
      // Mirrors the user's actual sequence: `examples/` already has
      // `riddle.txt` + `solution.txt` from run 1 when run 2 starts. Both runs
      // share one stateBase (cwd + .orch/state) but each gets its own socket.
      const tmpDir = await fs.mkdtemp('/tmp/orch-seq-files-')
      tmpDirs.push(tmpDir)
      await fs.writeFile(`${tmpDir}/riddle.txt`, 'leftover from run 1\n')
      await fs.writeFile(`${tmpDir}/solution.txt`, 'leftover from run 1\n')

      const r1 = await runOnce({ stateBase: tmpDir })
      expect(r1.completed).toBe(true)

      const r2 = await runOnce({ stateBase: tmpDir })
      expect(r2.completed).toBe(true)
    },
    REAL_TMUX_TEST_TIMEOUT_MS,
  )

  it(
    'two consecutive CLI subprocess invocations both produce a state directory',
    async () => {
      // Closest in-tree mirror of the user's shell sequence:
      //
      //   $ bunx orch run demo
      //   $ bunx orch run demo
      //
      // Each invocation is a fresh process, fresh tmux server (different
      // socket, derived from a freshly generated runId). If the second exits
      // ≠ 0 or doesn't write a state dir, this is our smoking gun — and the
      // captured stdout/stderr gives a one-line diagnosis.
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

      const trackSocket = (out: RunOutput): void => {
        const m = out.stderr.match(/r-\d{4}-\d{2}-\d{2}-\d{6}-[a-z0-9]{2}/)
        if (m !== null) subprocessSockets.push(`orch-${m[0]}`)
      }

      const r1 = spawnOnce()
      trackSocket(r1)
      expect(r1).toMatchObject({ exitCode: 0 })

      const r2 = spawnOnce()
      trackSocket(r2)
      // The whole point of this test: if run 2 exits non-zero, we've
      // reproduced the bug.
      expect(r2).toMatchObject({ exitCode: 0 })

      // And both invocations must have produced a per-run state directory —
      // the symptom in the original bug report was "no state dir created".
      const stateEntries = await fs.readdir(`${tmpDir}/.orch/state`)
      const runDirs = stateEntries.filter((e) => /^r-\d{4}-\d{2}-\d{2}-\d{6}-[a-z0-9]{2}$/.test(e))
      expect(runDirs.length).toBe(2)
    },
    REAL_TMUX_TEST_TIMEOUT_MS,
  )
})
