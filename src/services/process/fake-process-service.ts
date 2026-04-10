import type { ProcessService, SpawnHandle, SpawnOptions } from './process-service.ts'

export interface FakeResponse {
  readonly stdout?: readonly string[]
  readonly stderr?: readonly string[]
  readonly exit: number
}

export class FakeProcessService implements ProcessService {
  #queues = new Map<string, FakeResponse[]>()

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
        return { exitCode: killed ? -1 : response.exit }
      },
      kill() {
        if (!killed) {
          killed = true
          iterationDone()
        }
      },
    }
  }
}
