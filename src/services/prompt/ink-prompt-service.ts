import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HostUnavailableError } from '../../hosts/host.ts'
import type { FsService } from '../fs/index.ts'
import { embeddedChildArgv } from '../process/embedded-child.ts'
import { mergeEnv } from '../process/merge-env.ts'
import { type Path, path as toPath } from '../types.ts'
import type { PromptCtx, PromptResult, PromptService, PromptSpec } from './prompt-service.ts'

// Internal CLI re-entry subcommand for the `ask()` prompt child. Used by this
// launcher (producer) and the CLI dispatcher (consumer); see embedded-child.ts.
// A compiled binary cannot exec the embedded `ink-runner.ts` directly, so it
// re-invokes `orch __ask --spec ... --result ...`.
export const ASK_SUBCOMMAND = '__ask'

// ---------------------------------------------------------------------------
// InkPromptService — spawn-Ink-child orchestrator (two-pane mode).
// ---------------------------------------------------------------------------
//
// Renders an `ask()` prompt by spawning `ink-runner.ts` as a child process
// through `host.runInteractive`. The child mounts AskApp in the right pane's
// PTY, writes the resolved PromptResult to a temp file atomically, then
// exits. The parent reads the temp file and returns the result.
//
// Why a child process and not in-proc Ink? Two-pane's PTY is a tmux pane,
// not the orch CLI's controlling TTY. Ink's `render()` writes to
// `process.stdout` of the calling process — so for Ink to render in the
// pane, the Ink-using code has to BE running in the pane. The existing
// `host.runInteractive` seam already handles "respawn the right pane with
// this argv and wait for it to exit", so reusing it is the lowest-risk path.
//
// Spawn cost: Bun cold-start ~30-80 ms; human reaction time to a prompt is
// ≥250 ms. Spawn is invisible to the user — see plan § Spawn cost
// back-of-envelope.
//
// Distribution: in a dev checkout the default `runnerScript` resolves via
// `import.meta.url` to the in-repo `ink-runner.ts` and is run as `bun
// <path>`. In a `bun build --compile` binary that path is under Bun's
// embedded FS and can't be exec'd, so `embeddedChildArgv` re-invokes the
// binary as `orch __ask ...` instead — `main.ts` routes it to `runAskRunner`.

export interface InkPromptServiceDeps {
  readonly fs: FsService
  /** Defaults to `process.execPath` (the bun binary running orch). */
  readonly bunExecPath?: string
  /** Defaults to `<this dir>/ink-runner.ts` resolved via `import.meta.url`. */
  readonly runnerScript?: Path
}

export class InkPromptService implements PromptService {
  readonly #fs: FsService
  readonly #bunExecPath: string
  readonly #runnerScript: Path

  constructor(deps: InkPromptServiceDeps) {
    this.#fs = deps.fs
    this.#bunExecPath = deps.bunExecPath ?? process.execPath
    this.#runnerScript = deps.runnerScript ?? defaultRunnerScript()
  }

  async ask(spec: PromptSpec, ctx: PromptCtx): Promise<PromptResult> {
    if (ctx.host.mode === 'plain') {
      throw new Error(
        'InkPromptService misrouted under --mode=plain — wire ReadlinePromptService instead',
      )
    }

    const dir = await this.#fs.tempDir('orch-ask-')
    const resultPath = toPath(join(dir as string, 'result.json'))
    // Title the frame with the step name so the user knows what they are
    // answering (the executor's spec doesn't carry it — only ctx does).
    const titledSpec: PromptSpec = { ...spec, title: spec.title ?? (ctx.stepName as string) }
    const specB64 = Buffer.from(JSON.stringify(titledSpec), 'utf8').toString('base64')
    // Dev checkout: `[bun, ink-runner.ts, ...]`. Compiled binary: `[orch,
    // __ask, ...]` — the runner is embedded and must be reached via the CLI.
    const argv = embeddedChildArgv({
      execPath: this.#bunExecPath,
      runnerScript: this.#runnerScript as string,
      subcommand: ASK_SUBCOMMAND,
      trailing: ['--spec', specB64, '--result', resultPath as string],
    })
    const env = mergeEnv(process.env, {}, {})
    const cwd = toPath(process.cwd())

    try {
      await ctx.host.runInteractive({ argv, env, cwd, stepName: ctx.stepName })

      // The two-pane host's runInteractive returns exit code 0 unconditionally
      // — tmux's pane-died hook doesn't surface the child exit code. Treat the
      // presence of the result file as the success signal.
      if (!(await this.#fs.exists(resultPath))) {
        // Disambiguate "the host died under us (tmux server gone, terminal
        // closed)" from "the child crashed or the user killed the pane". The
        // former misleads users into blaming their input — see incident
        // r-2026-05-22-212450-07 where the tmux server died externally while
        // the prompt was open and orch surfaced the generic message.
        const reachability = await ctx.host.probeReachability()
        if (!reachability.reachable) {
          throw new HostUnavailableError(
            `InkPromptService: host became unreachable while waiting for "${ctx.stepName}"` +
              (reachability.reason !== undefined ? ` — ${reachability.reason}` : ''),
            undefined,
          )
        }
        throw new Error(
          `InkPromptService: child for "${ctx.stepName}" exited without writing a result. ` +
            'Either the user killed the pane, the Ink renderer crashed, or the ' +
            'runner script could not be located.',
        )
      }
      const body = await this.#fs.readFile(resultPath)
      return JSON.parse(body) as PromptResult
    } finally {
      // Best-effort cleanup. The temp dir lives under os.tmpdir() — leaks at
      // worst become a few hundred bytes per ask until the OS reaps the dir.
      await this.#fs.remove(dir).catch(() => {})
    }
  }
}

function defaultRunnerScript(): Path {
  const thisFile = fileURLToPath(import.meta.url)
  return toPath(join(dirname(thisFile), 'ink-runner.ts'))
}
