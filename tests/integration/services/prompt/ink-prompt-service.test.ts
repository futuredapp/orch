// MIGRATED → tests-new/integration/services/prompt/ink-prompt-service.test.ts (parent U12) — relocated verbatim (import paths only); kept skipped on disk (D2).
import { describe, expect, it } from 'bun:test'
import { writeFile } from 'node:fs/promises'
import type { StepName } from '../../../../src/core/types.ts'
import { HostUnavailableError } from '../../../../src/hosts/host.ts'
import type {
  Host,
  HostReachability,
  InteractiveResult,
  InteractiveSpawn,
} from '../../../../src/hosts/index.ts'
import { BunFsService } from '../../../../src/services/index.ts'
import { InkPromptService } from '../../../../src/services/prompt/index.ts'
import type { PromptResult, PromptSpec } from '../../../../src/services/prompt/prompt-service.ts'
import { type Path, path as toPath } from '../../../../src/services/types.ts'

// ---------------------------------------------------------------------------
// Layer-2 integration test for InkPromptService — exercises the IPC contract
// (argv encoding, file IPC, cleanup) end-to-end against a fake Host whose
// runInteractive simulates the spawn-Ink-child by writing a result file.
// The actual Ink rendering is covered by ink-app.test.tsx.
// ---------------------------------------------------------------------------
//
// Why mock the Host here and not actually spawn the child? Spawning Ink with
// a piped stdin disables raw mode (no TTY) — Ink's `useFocus` short-circuits
// and the child never accepts a keystroke. Real-spawn-with-PTY is documented
// in the plan as a manual / future test; the IPC contract (which is what
// InkPromptService actually owns) is fully exercised by this file.

const SPEC: PromptSpec = {
  question: 'continue?',
  fields: [{ name: 'notes' }],
  buttons: ['continue', 'retry'],
}

interface FakeHostOptions {
  readonly handler: (spawn: InteractiveSpawn) => Promise<InteractiveResult>
  readonly mode?: 'plain' | 'two-pane' | 'single-pane'
  readonly reachability?: HostReachability
}

function makeHost({ handler, mode = 'two-pane', reachability }: FakeHostOptions): Host {
  return {
    mode,
    writeBanner: () => {},
    onRunnerEvent: () => {},
    onLifecycleEvent: () => {},
    onCommandLine: () => {},
    attach: async (pane) => ({
      pane,
      async detach() {
        /* no-op */
      },
    }),
    runInteractive: handler,
    attachForeground: async () => {
      /* no-op */
    },
    awaitForegroundShutdown: async () => 'attach-exited' as const,
    probeReachability: async () => reachability ?? { reachable: true },
    teardown: async () => {
      /* no-op */
    },
  }
}

describe.skip('InkPromptService (mocked host)', () => {
  it('encodes the spec as base64 JSON and reads the child-written result file', async () => {
    const fs = new BunFsService()
    const svc = new InkPromptService({ fs, runnerScript: toPath('/fake/runner.ts') })

    let capturedArgv: readonly string[] | undefined
    const host = makeHost({
      handler: async (spawn) => {
        capturedArgv = spawn.argv
        const ridx = spawn.argv.indexOf('--result')
        const resultPath = spawn.argv[ridx + 1]
        if (resultPath === undefined) throw new Error('test bug: --result missing')
        const result: PromptResult = {
          cancelled: false,
          button: 'continue',
          fields: { notes: 'hi' },
        }
        await writeFile(resultPath, JSON.stringify(result), 'utf8')
        return { exitCode: 0, durationMs: 1 }
      },
    })

    const result = await svc.ask(SPEC, { stepName: 'ask:test' as StepName, host })

    expect(result).toEqual({
      cancelled: false,
      button: 'continue',
      fields: { notes: 'hi' },
    })

    const sidx = (capturedArgv ?? []).indexOf('--spec')
    const specB64 = (capturedArgv ?? [])[sidx + 1]
    expect(typeof specB64).toBe('string')
    const decoded = JSON.parse(Buffer.from(specB64 ?? '', 'base64').toString('utf8')) as PromptSpec
    expect(decoded.question).toBe(SPEC.question)
    expect(decoded.buttons).toEqual([...SPEC.buttons])
    expect(decoded.fields).toEqual([...SPEC.fields])
  })

  it('throws a clear error when the child exits without writing a result file', async () => {
    const fs = new BunFsService()
    const svc = new InkPromptService({ fs, runnerScript: toPath('/fake/runner.ts') })
    const host = makeHost({
      handler: async () => ({ exitCode: 0, durationMs: 1 }),
    })

    await expect(svc.ask(SPEC, { stepName: 'ask:no-result' as StepName, host })).rejects.toThrow(
      /exited without writing a result/,
    )
  })

  // Pins the "the run crashed when I came back" bug reported against incident
  // r-2026-05-22-212450-07: while the prompt was open and the user was away,
  // the tmux server died externally; orch surfaced the generic "child exited
  // without writing a result" error which misleads the user into blaming
  // their input or the workflow. The correct behaviour is to detect that the
  // host is no longer reachable and throw HostUnavailableError instead.
  it('throws HostUnavailableError (not the generic message) when the host is unreachable after the child exited', async () => {
    const fs = new BunFsService()
    const svc = new InkPromptService({ fs, runnerScript: toPath('/fake/runner.ts') })
    const host = makeHost({
      handler: async () => ({ exitCode: 0, durationMs: 1 }),
      reachability: { reachable: false, reason: 'tmux server is no longer reachable' },
    })

    let caught: unknown
    try {
      await svc.ask(SPEC, { stepName: 'ask:tmux-died' as StepName, host })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(HostUnavailableError)
    const message = (caught as Error | undefined)?.message ?? ''
    expect(message).not.toMatch(/exited without writing a result/)
    expect(message).toMatch(/tmux|session|host/i)
  })

  it('cleans up the temp dir after a successful ask', async () => {
    const fs = new BunFsService()
    const svc = new InkPromptService({ fs, runnerScript: toPath('/fake/runner.ts') })

    let resultPathSeen: string | undefined
    const host = makeHost({
      handler: async (spawn) => {
        const ridx = spawn.argv.indexOf('--result')
        resultPathSeen = spawn.argv[ridx + 1]
        if (resultPathSeen === undefined) throw new Error('test bug: --result missing')
        const result: PromptResult = { cancelled: true, fields: {} }
        await writeFile(resultPathSeen, JSON.stringify(result), 'utf8')
        return { exitCode: 0, durationMs: 1 }
      },
    })

    await svc.ask(SPEC, { stepName: 'ask:cleanup' as StepName, host })

    expect(resultPathSeen).toBeDefined()
    const tempDir = (resultPathSeen as string).replace(/\/result\.json$/, '') as Path
    expect(await fs.exists(tempDir as Path)).toBe(false)
  })

  it('cleans up the temp dir even when the child errors', async () => {
    const fs = new BunFsService()
    const svc = new InkPromptService({ fs, runnerScript: toPath('/fake/runner.ts') })

    let resultPathSeen: string | undefined
    const host = makeHost({
      handler: async (spawn) => {
        const ridx = spawn.argv.indexOf('--result')
        resultPathSeen = spawn.argv[ridx + 1]
        return { exitCode: 0, durationMs: 1 }
      },
    })

    await expect(
      svc.ask(SPEC, { stepName: 'ask:cleanup-fail' as StepName, host }),
    ).rejects.toThrow()

    expect(resultPathSeen).toBeDefined()
    const tempDir = (resultPathSeen as string).replace(/\/result\.json$/, '') as Path
    expect(await fs.exists(tempDir as Path)).toBe(false)
  })

  it('rejects misrouting under --mode=plain', async () => {
    const fs = new BunFsService()
    const svc = new InkPromptService({ fs, runnerScript: toPath('/fake/runner.ts') })
    const host = makeHost({
      handler: async () => ({ exitCode: 0, durationMs: 1 }),
      mode: 'plain',
    })

    await expect(svc.ask(SPEC, { stepName: 'ask:wrong-host' as StepName, host })).rejects.toThrow(
      /misrouted under --mode=plain/,
    )
  })

  it('passes a cancelled-result through unchanged', async () => {
    const fs = new BunFsService()
    const svc = new InkPromptService({ fs, runnerScript: toPath('/fake/runner.ts') })
    const host = makeHost({
      handler: async (spawn) => {
        const ridx = spawn.argv.indexOf('--result')
        const resultPath = spawn.argv[ridx + 1]
        if (resultPath === undefined) throw new Error('test bug: --result missing')
        const result: PromptResult = { cancelled: true, fields: { notes: 'partial' } }
        await writeFile(resultPath, JSON.stringify(result), 'utf8')
        return { exitCode: 0, durationMs: 1 }
      },
    })

    const result = await svc.ask(SPEC, { stepName: 'ask:cancel' as StepName, host })

    expect(result).toEqual({ cancelled: true, fields: { notes: 'partial' } })
  })
})
