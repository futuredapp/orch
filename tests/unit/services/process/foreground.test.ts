import { describe, expect, it } from 'bun:test'
import { FakeProcessService } from '../../../../src/services/process/fake-process-service.ts'
import { path } from '../../../../src/services/types.ts'

const dummyOpts = { cwd: path('/tmp'), env: {} } as const

describe('FakeProcessService.spawnForeground', () => {
  it('returns the scripted exit code when a foreground process completes', async () => {
    const fake = new FakeProcessService()
    fake.whenForeground(['claude', '--session-id', 'abc']).respondWith({ exitCode: 0 })

    const handle = fake.spawnForeground({ argv: ['claude', '--session-id', 'abc'], ...dummyOpts })
    const result = await handle.wait()

    expect(result.exitCode).toBe(0)
  })

  it('returns a non-zero exit code for a failed foreground process', async () => {
    const fake = new FakeProcessService()
    fake.whenForeground(['claude', 'brainstorm']).respondWith({ exitCode: 130 })

    const handle = fake.spawnForeground({ argv: ['claude', 'brainstorm'], ...dummyOpts })
    const result = await handle.wait()

    expect(result.exitCode).toBe(130)
  })

  it('reports exitCode -1 when killed before wait resolves', async () => {
    const fake = new FakeProcessService()
    fake.whenForeground(['claude']).respondWith({ exitCode: 0 })

    const handle = fake.spawnForeground({ argv: ['claude'], ...dummyOpts })
    handle.kill()
    const result = await handle.wait()

    expect(result.exitCode).toBe(-1)
  })

  it('throws when no foreground response is scripted for the argv', () => {
    const fake = new FakeProcessService()

    expect(() => fake.spawnForeground({ argv: ['unknown'], ...dummyOpts })).toThrow(
      /no scripted foreground response/,
    )
  })

  it('consumes foreground scripts in FIFO order for the same argv', async () => {
    const fake = new FakeProcessService()
    fake.whenForeground(['claude']).respondWith({ exitCode: 0 })
    fake.whenForeground(['claude']).respondWith({ exitCode: 42 })

    const handle1 = fake.spawnForeground({ argv: ['claude'], ...dummyOpts })
    const result1 = await handle1.wait()

    const handle2 = fake.spawnForeground({ argv: ['claude'], ...dummyOpts })
    const result2 = await handle2.wait()

    expect(result1.exitCode).toBe(0)
    expect(result2.exitCode).toBe(42)
  })
})
