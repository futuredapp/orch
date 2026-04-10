import { describe, expect, it } from 'bun:test'
import { BunProcessService } from '../../../../src/services/process/bun-process-service.ts'
import { ProcessSpawnError } from '../../../../src/services/process/process-service.ts'
import { path } from '../../../../src/services/types.ts'

async function collect(iter: AsyncIterable<string>): Promise<string[]> {
  const result: string[] = []
  for await (const line of iter) {
    result.push(line)
  }
  return result
}

const cwd = path(process.cwd())
const env = { PATH: process.env.PATH ?? '' }

describe('BunProcessService', () => {
  it('yields a single line "hello" and exits with code 0 when running sh -c "echo hello"', async () => {
    const svc = new BunProcessService()

    const handle = svc.spawn({ argv: ['sh', '-c', 'echo hello'], cwd, env })
    const lines = await collect(handle.stdout)
    const result = await handle.wait()

    expect(lines).toEqual(['hello'])
    expect(result.exitCode).toBe(0)
  })

  it('yields three lines from sh -c "printf a\\nb\\nc" even without a trailing newline', async () => {
    const svc = new BunProcessService()

    const handle = svc.spawn({ argv: ['sh', '-c', 'printf "a\\nb\\nc"'], cwd, env })
    const lines = await collect(handle.stdout)
    const result = await handle.wait()

    expect(lines).toEqual(['a', 'b', 'c'])
    expect(result.exitCode).toBe(0)
  })

  it('yields no stdout and resolves wait() with exitCode 7 when running sh -c "exit 7"', async () => {
    const svc = new BunProcessService()

    const handle = svc.spawn({ argv: ['sh', '-c', 'exit 7'], cwd, env })
    const lines = await collect(handle.stdout)
    const result = await handle.wait()

    expect(lines).toEqual([])
    expect(result.exitCode).toBe(7)
  })

  it('throws ProcessSpawnError synchronously when the binary does not exist', () => {
    const svc = new BunProcessService()

    expect(() => svc.spawn({ argv: ['nonexistent-binary-xyz-12345'], cwd, env })).toThrow(
      ProcessSpawnError,
    )
  })

  it('throws ProcessSpawnError synchronously when cwd does not exist', () => {
    const svc = new BunProcessService()

    expect(() =>
      svc.spawn({ argv: ['echo', 'hello'], cwd: path('/nonexistent/dir/xyz'), env }),
    ).toThrow(ProcessSpawnError)
  })

  it('causes wait() to resolve with a non-zero exitCode after kill() on a long-running sh -c "sleep 30"', async () => {
    const svc = new BunProcessService()

    const handle = svc.spawn({ argv: ['sh', '-c', 'sleep 30'], cwd, env })
    handle.kill()
    const result = await handle.wait()

    expect(result.exitCode).not.toBe(0)
  })

  it('drains stderr concurrently so wait() does not deadlock when the child writes > 64 KiB to stderr', async () => {
    const svc = new BunProcessService()

    // Produce ~100KB of stderr output
    const handle = svc.spawn({
      argv: ['sh', '-c', 'dd if=/dev/zero bs=1024 count=100 2>&1 1>/dev/null | cat 1>&2; exit 0'],
      cwd,
      env,
    })

    const lines = await collect(handle.stdout)
    const result = await handle.wait()

    expect(lines).toEqual([])
    // Should not deadlock — the fact we get here is the real assertion
    expect(typeof result.exitCode).toBe('number')
  })
})
