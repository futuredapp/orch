import type {
  ForegroundHandle,
  ProcessService,
  SpawnHandle,
  SpawnOptions,
} from './process-service.ts'

export interface FakeResponse {
  readonly stdout?: readonly string[]
  readonly stderr?: readonly string[]
  readonly exitCode: number
  /**
   * Raw-bytes shape — used when the consumer spawns with `rawStreams: true`.
   * When set, the fake's `stdoutBytes()` returns this buffer and the
   * line-framed `stdout` iterable yields logical lines parsed from these
   * bytes (overrides the line-based `stdout` field if both are set).
   */
  readonly stdoutBytes?: Buffer
  /**
   * Mutable out-buffer for inspecting what `writeStdin` was called with.
   * The fake APPENDS one entry per `writeStdin` call (preserving call
   * boundaries) when `rawStreams: true`. Tests inspect this array after the
   * spawn finishes.
   */
  readonly stdinObservations?: Buffer[]
}

export interface FakeForegroundResponse {
  readonly exitCode: number
  /**
   * Optional gate — when present, `wait()` resolves only after this promise
   * settles. Lets tests script order between a foreground spawn and an
   * external event (workflow completion, simulated user detach). Without it,
   * `wait()` resolves immediately as before.
   */
  readonly exitWhen?: Promise<void>
}

export class FakeProcessService implements ProcessService {
  #queues = new Map<string, FakeResponse[]>()
  #foregroundQueues = new Map<string, FakeForegroundResponse[]>()

  when(argv: readonly string[]): { respondWith(response: FakeResponse): void } {
    const key = JSON.stringify(argv)
    return {
      respondWith: (response: FakeResponse) => {
        let queue = this.#queues.get(key)
        if (!queue) {
          queue = []
          this.#queues.set(key, queue)
        }
        queue.push(response)
      },
    }
  }

  whenForeground(argv: readonly string[]): { respondWith(response: FakeForegroundResponse): void } {
    const key = JSON.stringify(argv)
    return {
      respondWith: (response: FakeForegroundResponse) => {
        let queue = this.#foregroundQueues.get(key)
        if (!queue) {
          queue = []
          this.#foregroundQueues.set(key, queue)
        }
        queue.push(response)
      },
    }
  }

  spawn(opts: SpawnOptions): SpawnHandle {
    const key = JSON.stringify(opts.argv)
    const queue = this.#queues.get(key)
    const response = queue?.shift()
    if (!response) {
      throw new Error(`FakeProcessService: no scripted response for argv ${key}`)
    }

    const wantsRaw = opts.rawStreams === true
    const stdoutLines = deriveStdoutLines(response)
    const stderrLines = response.stderr ?? []

    let killed = false
    let iterationDone: () => void
    const iterationPromise = new Promise<void>((resolve) => {
      iterationDone = resolve
    })

    const stdoutIterable: AsyncIterable<string> = {
      [Symbol.asyncIterator]: () => {
        const inner = makeIterator(stdoutLines, () => killed)[Symbol.asyncIterator]()
        return {
          async next() {
            const result = await inner.next()
            if (result.done) {
              iterationDone()
            }
            return result
          },
        }
      },
    }

    const baseHandle = {
      stdout: stdoutIterable,
      stderr: makeIterator(stderrLines, () => killed),
      async wait() {
        await iterationPromise
        return { exitCode: killed ? -1 : response.exitCode }
      },
      kill() {
        if (!killed) {
          killed = true
          iterationDone()
        }
      },
    }

    if (!wantsRaw) {
      return baseHandle
    }

    const observations = response.stdinObservations
    const stdoutBuf = response.stdoutBytes ?? Buffer.alloc(0)
    return {
      ...baseHandle,
      writeStdin(data: string | Uint8Array) {
        if (observations === undefined) return
        observations.push(toBuffer(data))
      },
      stdoutBytes() {
        return stdoutBuf
      },
    }
  }

  spawnForeground(opts: SpawnOptions): ForegroundHandle {
    const key = JSON.stringify(opts.argv)
    const queue = this.#foregroundQueues.get(key)
    const response = queue?.shift()
    if (!response) {
      throw new Error(`FakeProcessService: no scripted foreground response for argv ${key}`)
    }

    let killed = false
    return {
      async wait() {
        if (response.exitWhen !== undefined) {
          await response.exitWhen
        }
        return { exitCode: killed ? -1 : response.exitCode }
      },
      kill() {
        killed = true
      },
    }
  }
}

function makeIterator(lines: readonly string[], isKilled: () => boolean): AsyncIterable<string> {
  return {
    [Symbol.asyncIterator]: () => {
      let index = 0
      return {
        async next() {
          if (isKilled()) {
            throw new DOMException('Aborted', 'AbortError')
          }
          if (index < lines.length) {
            return { value: lines[index++] as string, done: false }
          }
          return { value: undefined, done: true }
        },
      }
    },
  }
}

/**
 * Derives the logical lines the fake's `stdout` iterable yields. When the
 * response carries raw bytes, parse them; otherwise fall back to the
 * line-based `stdout` field.
 */
function deriveStdoutLines(response: FakeResponse): readonly string[] {
  if (response.stdoutBytes !== undefined) {
    return splitLines(response.stdoutBytes.toString('utf-8'))
  }
  return response.stdout ?? []
}

function splitLines(s: string): readonly string[] {
  if (s.length === 0) return []
  const trimmed = s.endsWith('\n') ? s.slice(0, -1) : s
  return trimmed.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
}

function toBuffer(data: string | Uint8Array): Buffer {
  if (typeof data === 'string') {
    return Buffer.from(data, 'utf-8')
  }
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
}
