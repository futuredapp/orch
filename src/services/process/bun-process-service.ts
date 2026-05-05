import { existsSync } from 'node:fs'
import { frameLines } from './line-framer.ts'
import type {
  ForegroundHandle,
  ProcessService,
  SpawnHandle,
  SpawnOptions,
} from './process-service.ts'
import { ProcessSpawnError } from './process-service.ts'

export class BunProcessService implements ProcessService {
  spawn(opts: SpawnOptions): SpawnHandle {
    if (!existsSync(opts.cwd)) {
      throw new ProcessSpawnError(`cwd does not exist: ${opts.cwd}`)
    }

    let proc: ReturnType<typeof Bun.spawn>
    try {
      proc = Bun.spawn({
        cmd: [...opts.argv],
        cwd: opts.cwd,
        env: opts.env,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      })
    } catch (err: unknown) {
      throw new ProcessSpawnError(`Failed to spawn: ${opts.argv.join(' ')}`, err)
    }

    // Both streams are line-framed and live: a consumer that drains them
    // concurrently observes lines as soon as the child writes a '\n'. The
    // command() step relies on this for its byte-for-byte pane streaming
    // promise; runners rely on it for the `--debug` raw-line hook. Callers
    // MUST drain stderr concurrently with stdout to avoid pipe backpressure
    // deadlock — see Watch-outs S1 in process-service.ts.
    const stdoutStream = proc.stdout as ReadableStream<Uint8Array>
    const stderrStream = proc.stderr as ReadableStream<Uint8Array>
    return {
      stdout: frameLines(stdoutStream),
      stderr: frameLines(stderrStream),

      async wait() {
        await proc.exited
        return { exitCode: proc.exitCode ?? -1 }
      },

      kill(signal: NodeJS.Signals = 'SIGTERM') {
        proc.kill(signal)
      },
    }
  }

  spawnForeground(opts: SpawnOptions): ForegroundHandle {
    if (!existsSync(opts.cwd)) {
      throw new ProcessSpawnError(`cwd does not exist: ${opts.cwd}`)
    }

    let proc: ReturnType<typeof Bun.spawn>
    try {
      proc = Bun.spawn({
        cmd: [...opts.argv],
        cwd: opts.cwd,
        env: opts.env,
        stdin: 'inherit',
        stdout: 'inherit',
        stderr: 'inherit',
      })
    } catch (err: unknown) {
      throw new ProcessSpawnError(`Failed to spawn foreground: ${opts.argv.join(' ')}`, err)
    }

    return {
      async wait() {
        await proc.exited
        return { exitCode: proc.exitCode ?? -1 }
      },
      kill(signal: NodeJS.Signals = 'SIGTERM') {
        proc.kill(signal)
      },
    }
  }
}
