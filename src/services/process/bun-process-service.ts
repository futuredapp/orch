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

    const wantsRaw = opts.rawStreams === true

    let proc: ReturnType<typeof Bun.spawn>
    try {
      proc = Bun.spawn({
        cmd: [...opts.argv],
        cwd: opts.cwd,
        env: opts.env,
        stdin: wantsRaw ? 'pipe' : 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      })
    } catch (err: unknown) {
      throw new ProcessSpawnError(`Failed to spawn: ${opts.argv.join(' ')}`, err)
    }

    const stderrStream = proc.stderr as ReadableStream<Uint8Array>
    const stdoutStream = proc.stdout as ReadableStream<Uint8Array>

    if (!wantsRaw) {
      // Default path — unchanged from the original implementation. Both
      // streams are line-framed and live: a consumer that drains them
      // concurrently observes lines as soon as the child writes a '\n'.
      // Callers MUST drain stderr concurrently with stdout to avoid pipe
      // backpressure deadlock — see Watch-outs S1 in process-service.ts.
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

    // rawStreams: true — tee stdout so the line-framer and the byte
    // accumulator each get their own independent stream. A single underlying
    // ReadableStream only supports one reader; without the tee, attaching
    // frameLines() would lock out the byte pump.
    const [forFraming, forBuffer] = stdoutStream.tee()
    const chunks = accumulateChunks(forBuffer)
    // `stdin: 'pipe'` above means Bun returns a FileSink with a synchronous
    // `write(data)` method. The Bun type signature is broader (`number |
    // FileSink | undefined`) than this branch's runtime guarantee — narrow
    // structurally so the call below type-checks.
    const stdin = proc.stdin as { write: (data: string | Uint8Array) => unknown }

    return {
      stdout: frameLines(forFraming),
      stderr: frameLines(stderrStream),
      writeStdin(data: string | Uint8Array) {
        stdin.write(data)
      },
      stdoutBytes() {
        return Buffer.concat(chunks)
      },
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

/**
 * Pumps every chunk from a `ReadableStream<Uint8Array>` into a shared array.
 * Returned array is mutated in-place; callers use `Buffer.concat(...)` to
 * snapshot at any moment. Errors during read are swallowed — the buffer just
 * stops growing, matching the "monotonic, never reset" contract.
 */
function accumulateChunks(stream: ReadableStream<Uint8Array>): Uint8Array[] {
  const chunks: Uint8Array[] = []
  void (async () => {
    const reader = stream.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
      }
    } catch {
      // Swallow — buffer just stops growing.
    } finally {
      reader.releaseLock()
    }
  })()
  return chunks
}
