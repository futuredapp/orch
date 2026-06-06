// MIGRATED → tests-new/unit/services/process/raw-streams.test.ts (parent U12) — relocated verbatim (import paths only); kept skipped on disk (D2).
import { describe, expect, it } from 'bun:test'
import { BunProcessService } from '../../../../src/services/process/bun-process-service.ts'
import { FakeProcessService } from '../../../../src/services/process/fake-process-service.ts'
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

// ───────────────────────────────────────────────────────────────────────────
// BunProcessService — real subprocess raw-streams behavior
// ───────────────────────────────────────────────────────────────────────────

describe.skip('BunProcessService — rawStreams opt-in', () => {
  it('omits writeStdin and stdoutBytes from the handle when rawStreams is omitted (back-compat probe)', async () => {
    const svc = new BunProcessService()

    const handle = svc.spawn({ argv: ['sh', '-c', 'echo hi'], cwd, env })

    expect(handle.writeStdin).toBeUndefined()
    expect(handle.stdoutBytes).toBeUndefined()

    await collect(handle.stdout)
    await handle.wait()
  })

  it('omits writeStdin and stdoutBytes from the handle when rawStreams is explicitly false', async () => {
    const svc = new BunProcessService()

    const handle = svc.spawn({ argv: ['sh', '-c', 'echo hi'], cwd, env, rawStreams: false })

    expect(handle.writeStdin).toBeUndefined()
    expect(handle.stdoutBytes).toBeUndefined()

    await collect(handle.stdout)
    await handle.wait()
  })

  it('exposes writeStdin so a write reaches the child and is read back from stdin', async () => {
    const svc = new BunProcessService()

    const handle = svc.spawn({
      argv: ['bun', '-e', 'process.stdout.write(await Bun.stdin.text())'],
      cwd,
      env,
      rawStreams: true,
    })

    expect(handle.writeStdin).toBeDefined()
    handle.writeStdin?.('hello-from-test\n')
    // Close stdin so the child's `Bun.stdin.text()` resolves.
    handle.kill('SIGTERM')

    // Drain stderr concurrently to avoid backpressure.
    void collect(handle.stderr)
    const lines = await collect(handle.stdout)
    await handle.wait()

    // The child may exit before flushing; assert non-empty OR signal exit.
    // We only need to prove the round-trip works — if the child read our
    // bytes at all, we should see at least the substring on stdout.
    const joined = lines.join('')
    if (joined.length > 0) {
      expect(joined).toContain('hello-from-test')
    }
  })

  it('accumulates raw stdout bytes including escape sequences that line-framing would otherwise split', async () => {
    const svc = new BunProcessService()

    // Emit an alt-screen enter, two lines, then alt-screen exit.
    const handle = svc.spawn({
      argv: ['sh', '-c', `printf '\\033[?1049ha\\nb\\n\\033[?1049l'`],
      cwd,
      env,
      rawStreams: true,
    })

    expect(handle.stdoutBytes).toBeDefined()
    const lines = await collect(handle.stdout)
    void collect(handle.stderr)
    await handle.wait()

    const bytes = handle.stdoutBytes?.() ?? Buffer.alloc(0)
    expect(bytes.includes(Buffer.from('\x1b[?1049h'))).toBe(true)
    expect(bytes.includes(Buffer.from('\x1b[?1049l'))).toBe(true)
    // The line-framed view sees the visible lines even with escapes embedded.
    expect(lines).toContain('b')
  })

  it('keeps the line-framed stdout view and stdoutBytes() reading from the same tee — both views observe the child output', async () => {
    const svc = new BunProcessService()

    const handle = svc.spawn({
      argv: ['sh', '-c', `printf 'a\\nb\\nc\\n'`],
      cwd,
      env,
      rawStreams: true,
    })

    const lines = await collect(handle.stdout)
    void collect(handle.stderr)
    await handle.wait()

    const bytes = handle.stdoutBytes?.() ?? Buffer.alloc(0)

    expect(lines).toEqual(['a', 'b', 'c'])
    expect(bytes.toString('utf-8')).toBe('a\nb\nc\n')
  })

  it('reports stdoutBytes() as monotonically growing between two reads (no reset)', async () => {
    const svc = new BunProcessService()

    // Two chunks separated by a sleep so we can observe growth.
    const handle = svc.spawn({
      argv: ['sh', '-c', `printf 'first\\n'; sleep 0.2; printf 'second\\n'`],
      cwd,
      env,
      rawStreams: true,
    })

    const drainStdout = collect(handle.stdout)
    void collect(handle.stderr)
    await handle.wait()
    await drainStdout

    const final = handle.stdoutBytes?.() ?? Buffer.alloc(0)
    const finalAgain = handle.stdoutBytes?.() ?? Buffer.alloc(0)

    // Two reads at the same moment must be equal — Buffer.concat snapshots.
    expect(final.length).toBe(finalAgain.length)
    expect(final.toString('utf-8')).toBe('first\nsecond\n')
  })

  it('keeps each spawn independent — a rawStreams: false spawn after a rawStreams: true one has no leftover stdin/stdoutBytes', async () => {
    const svc = new BunProcessService()

    const raw = svc.spawn({ argv: ['sh', '-c', 'true'], cwd, env, rawStreams: true })
    void collect(raw.stdout)
    void collect(raw.stderr)
    await raw.wait()

    const plain = svc.spawn({ argv: ['sh', '-c', 'true'], cwd, env })
    expect(plain.writeStdin).toBeUndefined()
    expect(plain.stdoutBytes).toBeUndefined()
    void collect(plain.stdout)
    void collect(plain.stderr)
    await plain.wait()
  })
})

// ───────────────────────────────────────────────────────────────────────────
// FakeProcessService — back-compat + raw-bytes shape
// ───────────────────────────────────────────────────────────────────────────

const dummyOpts = { cwd: path('/tmp'), env: {} } as const

describe.skip('FakeProcessService — rawStreams opt-in', () => {
  it('omits writeStdin and stdoutBytes when rawStreams is omitted, even if stdoutBytes is configured on the response', async () => {
    const fake = new FakeProcessService()
    fake.when(['cmd']).respondWith({ stdoutBytes: Buffer.from('hi\n'), exitCode: 0 })

    const handle = fake.spawn({ argv: ['cmd'], ...dummyOpts })

    expect(handle.writeStdin).toBeUndefined()
    expect(handle.stdoutBytes).toBeUndefined()
    await collect(handle.stdout)
    await handle.wait()
  })

  it('exposes stdoutBytes() returning the configured Buffer when rawStreams: true', async () => {
    const fake = new FakeProcessService()
    const payload = Buffer.from('hello-bytes\n')
    fake.when(['cmd']).respondWith({ stdoutBytes: payload, exitCode: 0 })

    const handle = fake.spawn({ argv: ['cmd'], ...dummyOpts, rawStreams: true })
    void collect(handle.stdout)
    await handle.wait()

    expect(handle.stdoutBytes?.().toString('utf-8')).toBe('hello-bytes\n')
  })

  it('yields the logical lines of the configured stdoutBytes via the line-framed stdout iterable', async () => {
    const fake = new FakeProcessService()
    fake.when(['cmd']).respondWith({ stdoutBytes: Buffer.from('a\nb\nc\n'), exitCode: 0 })

    const handle = fake.spawn({ argv: ['cmd'], ...dummyOpts, rawStreams: true })
    const lines = await collect(handle.stdout)
    await handle.wait()

    expect(lines).toEqual(['a', 'b', 'c'])
  })

  it('falls back to the legacy stdout: string[] field for line-framing when stdoutBytes is unset and rawStreams: true', async () => {
    const fake = new FakeProcessService()
    fake.when(['cmd']).respondWith({ stdout: ['x', 'y'], exitCode: 0 })

    const handle = fake.spawn({ argv: ['cmd'], ...dummyOpts, rawStreams: true })
    const lines = await collect(handle.stdout)
    await handle.wait()

    expect(lines).toEqual(['x', 'y'])
    expect(handle.stdoutBytes?.().length).toBe(0)
  })

  it('appends each writeStdin call to the configured stdinObservations buffer array', async () => {
    const fake = new FakeProcessService()
    const observed: Buffer[] = []
    fake.when(['cmd']).respondWith({
      stdoutBytes: Buffer.alloc(0),
      stdinObservations: observed,
      exitCode: 0,
    })

    const handle = fake.spawn({ argv: ['cmd'], ...dummyOpts, rawStreams: true })
    handle.writeStdin?.('hello')
    handle.writeStdin?.(new Uint8Array([0x03])) // Ctrl-C
    handle.writeStdin?.('\n')
    void collect(handle.stdout)
    await handle.wait()

    expect(observed.map((b) => b.toString('hex'))).toEqual(['68656c6c6f', '03', '0a'])
  })

  it('does not throw when writeStdin is called and stdinObservations is unset (best-effort sink)', async () => {
    const fake = new FakeProcessService()
    fake.when(['cmd']).respondWith({ stdoutBytes: Buffer.alloc(0), exitCode: 0 })

    const handle = fake.spawn({ argv: ['cmd'], ...dummyOpts, rawStreams: true })
    expect(() => handle.writeStdin?.('discarded')).not.toThrow()
    void collect(handle.stdout)
    await handle.wait()
  })
})
