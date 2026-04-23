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

    let killed = false
    let iterationDone: () => void
    const iterationPromise = new Promise<void>((resolve) => {
      iterationDone = resolve
    })

    const makeIterator = (lines: readonly string[]): AsyncIterable<string> => ({
      [Symbol.asyncIterator]: () => {
        let index = 0
        return {
          async next() {
            if (killed) {
              throw new DOMException('Aborted', 'AbortError')
            }
            if (index < lines.length) {
              return { value: lines[index++] as string, done: false }
            }
            return { value: undefined, done: true }
          },
        }
      },
    })

    const stdoutLines = response.stdout ?? []
    const stderrLines = response.stderr ?? []

    const stdoutIterable: AsyncIterable<string> = {
      [Symbol.asyncIterator]: () => {
        const inner = makeIterator(stdoutLines)[Symbol.asyncIterator]()
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

    return {
      stdout: stdoutIterable,
      stderr: makeIterator(stderrLines),
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
