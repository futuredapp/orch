import { existsSync } from 'node:fs'
import type { ProcessService, SpawnHandle, SpawnOptions } from './process-service.ts'
import { ProcessSpawnError } from './process-service.ts'
import { frameLines } from './line-framer.ts'

const STDERR_TAIL_SIZE = 200

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

    // Pump stderr eagerly to prevent pipe backpressure deadlock.
    // SpawnHandle.stderr iterates the tail buffer, not the live stream.
    const stderrTail: string[] = []
    const stderrDone = drainStderr(proc.stderr, stderrTail, STDERR_TAIL_SIZE)

    return {
      stdout: frameLines(proc.stdout),

      stderr: replayBuffer(stderrTail, stderrDone),

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

async function drainStderr(
  stderr: ReadableStream<Uint8Array>,
  tail: string[],
  maxLines: number,
): Promise<void> {
  for await (const line of frameLines(stderr)) {
    tail.push(line)
    if (tail.length > maxLines) {
      tail.shift()
    }
  }
}

async function* replayBuffer(tail: string[], done: Promise<void>): AsyncGenerator<string> {
  await done
  for (const line of tail) {
    yield line
  }
}
