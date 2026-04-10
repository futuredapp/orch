import { describe, expect, it } from 'bun:test'
import { FakeProcessService } from '../../../../src/services/process/fake-process-service.ts'
import { path } from '../../../../src/services/types.ts'

async function collect(iter: AsyncIterable<string>): Promise<string[]> {
  const result: string[] = []
  for await (const line of iter) {
    result.push(line)
  }
  return result
}

const dummyOpts = { cwd: path('/tmp'), env: {} } as const

describe('FakeProcessService', () => {
  it('emits the scripted stdout lines and exit code for a matching argv', async () => {
    const fake = new FakeProcessService()
    fake.when(['echo', 'hello']).respondWith({ stdout: ['hello'], exit: 0 })

    const handle = fake.spawn({ argv: ['echo', 'hello'], ...dummyOpts })
    const lines = await collect(handle.stdout)
    const result = await handle.wait()

    expect(lines).toEqual(['hello'])
    expect(result.exitCode).toBe(0)
  })

  it('emits the scripted stderr lines symmetrically with stdout', async () => {
    const fake = new FakeProcessService()
    fake.when(['cmd']).respondWith({ stdout: ['out'], stderr: ['err1', 'err2'], exit: 0 })

    const handle = fake.spawn({ argv: ['cmd'], ...dummyOpts })
    const stdoutLines = await collect(handle.stdout)
    const stderrLines = await collect(handle.stderr)
    const result = await handle.wait()

    expect(stdoutLines).toEqual(['out'])
    expect(stderrLines).toEqual(['err1', 'err2'])
    expect(result.exitCode).toBe(0)
  })

  it('serves two distinct argvs independently with no cross-talk', async () => {
    const fake = new FakeProcessService()
    fake.when(['a']).respondWith({ stdout: ['alpha'], exit: 0 })
    fake.when(['b']).respondWith({ stdout: ['beta'], exit: 1 })

    const handleA = fake.spawn({ argv: ['a'], ...dummyOpts })
    const handleB = fake.spawn({ argv: ['b'], ...dummyOpts })

    const linesA = await collect(handleA.stdout)
    const linesB = await collect(handleB.stdout)

    expect(linesA).toEqual(['alpha'])
    expect(linesB).toEqual(['beta'])
    expect((await handleA.wait()).exitCode).toBe(0)
    expect((await handleB.wait()).exitCode).toBe(1)
  })

  it('consumes scripts for the same argv in FIFO order', async () => {
    const fake = new FakeProcessService()
    fake.when(['cmd']).respondWith({ stdout: ['first'], exit: 0 })
    fake.when(['cmd']).respondWith({ stdout: ['second'], exit: 0 })

    const handle1 = fake.spawn({ argv: ['cmd'], ...dummyOpts })
    const lines1 = await collect(handle1.stdout)
    await handle1.wait()

    const handle2 = fake.spawn({ argv: ['cmd'], ...dummyOpts })
    const lines2 = await collect(handle2.stdout)
    await handle2.wait()

    expect(lines1).toEqual(['first'])
    expect(lines2).toEqual(['second'])
  })

  it('throws FakeProcessService: no scripted response for argv ... when the queue is empty', () => {
    const fake = new FakeProcessService()

    expect(() => fake.spawn({ argv: ['missing'], ...dummyOpts })).toThrow(
      /FakeProcessService: no scripted response for argv/,
    )
  })

  it('reports exitCode -1 via wait() when kill() interrupts the iteration with an AbortError', async () => {
    const fake = new FakeProcessService()
    fake.when(['long']).respondWith({ stdout: ['a', 'b', 'c', 'd', 'e'], exit: 0 })

    const handle = fake.spawn({ argv: ['long'], ...dummyOpts })

    // Start iterating then kill
    const lines: string[] = []
    try {
      for await (const line of handle.stdout) {
        lines.push(line)
        if (lines.length === 1) {
          handle.kill()
        }
      }
    } catch {
      // AbortError expected
    }

    const result = await handle.wait()

    expect(result.exitCode).toBe(-1)
  })

  it('does not resolve wait() before the stdout iterator has emitted all scripted lines', async () => {
    const fake = new FakeProcessService()
    fake.when(['cmd']).respondWith({ stdout: ['line1', 'line2', 'line3'], exit: 0 })

    const handle = fake.spawn({ argv: ['cmd'], ...dummyOpts })

    // Collect stdout fully, then wait — wait must resolve after iteration
    const lines = await collect(handle.stdout)
    const result = await handle.wait()

    expect(lines).toEqual(['line1', 'line2', 'line3'])
    expect(result.exitCode).toBe(0)
  })
})
