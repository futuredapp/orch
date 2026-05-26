import { describe, expect, it } from 'bun:test'
import { codex } from '../../../../src/runners/codex/index.ts'
import type { RunnerContext } from '../../../../src/runners/index.ts'
import { FakeFsService, FakeProcessService } from '../../../../src/services/index.ts'
import { type Path, path } from '../../../../src/services/types.ts'

const REAL_HOME = path('/home/u/.codex')

async function seedRealCodexHome(fs: FakeFsService): Promise<void> {
  await fs.mkdir(REAL_HOME, { recursive: true })
  await fs.mkdir(path('/home/u/.codex/sessions'), { recursive: true })
  await fs.writeFile(path('/home/u/.codex/config.toml'), 'model = "o3"\n')
  await fs.writeFile(path('/home/u/.codex/auth.json'), '{"token":"secret"}')
}

function ctx(): RunnerContext {
  return {
    cwd: path('/work'),
    env: { CODEX_HOME: REAL_HOME },
    prompt: 'go',
    extraArgs: [],
    mode: 'interactive',
    autoStop: true,
  }
}

function makeCodex(fs: FakeFsService) {
  return codex({}, { fs, ps: new FakeProcessService() })
}

describe('codex().prepareAutoStop CODEX_HOME construction', () => {
  it('returns CODEX_HOME pointing at a fresh temp dir, not the real home', async () => {
    const fs = new FakeFsService()
    await seedRealCodexHome(fs)

    const prep = await makeCodex(fs).prepareAutoStop?.(ctx())

    expect(prep?.env.CODEX_HOME).toBeDefined()
    expect(prep?.env.CODEX_HOME).not.toBe(REAL_HOME as string)
  })

  it('symlinks every real-home entry except config.toml', async () => {
    const fs = new FakeFsService()
    await seedRealCodexHome(fs)

    const prep = await makeCodex(fs).prepareAutoStop?.(ctx())
    const runHome = path(prep?.env.CODEX_HOME as string)

    const entries = (await fs.readDir(runHome)).map((e) => e as string)
    expect(entries).toContain('auth.json')
    expect(entries).toContain('sessions')
    expect(entries).toContain('config.toml')
  })

  it('inherits auth.json as a symlink that resolves to the real credentials', async () => {
    const fs = new FakeFsService()
    await seedRealCodexHome(fs)

    const prep = await makeCodex(fs).prepareAutoStop?.(ctx())
    const runHome = path(prep?.env.CODEX_HOME as string)

    expect(await fs.readFile(path(`${runHome}/auth.json`))).toBe('{"token":"secret"}')
  })

  it('copies config.toml and appends a signal-only Stop hook referencing the orch channel', async () => {
    const fs = new FakeFsService()
    await seedRealCodexHome(fs)

    const prep = await makeCodex(fs).prepareAutoStop?.(ctx())
    const runHome = path(prep?.env.CODEX_HOME as string)

    const config = await fs.readFile(path(`${runHome}/config.toml`))
    expect(config).toContain('model = "o3"')
    expect(config).toContain('[[hooks.Stop]]')
    expect(config).toContain('[[hooks.Stop.hooks]]')
    expect(config).toContain('type = "command"')
    expect(config).toContain('$ORCH_SOCKET')
    expect(config).toContain('$ORCH_STOP_CHANNEL')
    expect(config).toContain('wait-for')
    expect(config).not.toMatch(/kill|exit/)
    expect(config).not.toMatch(/^\s*notify\s*=/m)
  })

  it('never writes back to the real ~/.codex/config.toml', async () => {
    const fs = new FakeFsService()
    await seedRealCodexHome(fs)

    await makeCodex(fs).prepareAutoStop?.(ctx())

    expect(await fs.readFile(path('/home/u/.codex/config.toml'))).toBe('model = "o3"\n')
  })

  it('preserves a user notify line while adding orch Stop hook config', async () => {
    const fs = new FakeFsService()
    await fs.mkdir(REAL_HOME, { recursive: true })
    await fs.writeFile(
      path('/home/u/.codex/config.toml'),
      'notify = ["my-notifier"]\nmodel = "o3"\n',
    )

    const prep = await makeCodex(fs).prepareAutoStop?.(ctx())
    const runHome = path(prep?.env.CODEX_HOME as string)

    const config = await fs.readFile(path(`${runHome}/config.toml`))
    expect(config.match(/^\s*notify\s*=/gm)?.length).toBe(1)
    expect(config).toContain('my-notifier')
    expect(config).toContain('[[hooks.Stop]]')
    expect(config).toContain('$ORCH_STOP_CHANNEL')
  })

  it('does not append duplicate orch Stop hooks when the copied config already contains one', async () => {
    const fs = new FakeFsService()
    await fs.mkdir(REAL_HOME, { recursive: true })
    await fs.writeFile(
      path('/home/u/.codex/config.toml'),
      'model = "o3"\n\n[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = \'tmux -L "$ORCH_SOCKET" wait-for -S "$ORCH_STOP_CHANNEL"\'\n',
    )

    const prep = await makeCodex(fs).prepareAutoStop?.(ctx())
    const runHome = path(prep?.env.CODEX_HOME as string)

    const config = await fs.readFile(path(`${runHome}/config.toml`))
    expect(config.match(/\$ORCH_STOP_CHANNEL/g)?.length).toBe(1)
  })
})

describe('codex().prepareAutoStop cleanup', () => {
  it('removes the temp home and only the temp home — the real entries remain', async () => {
    const fs = new FakeFsService()
    await seedRealCodexHome(fs)

    const prep = await makeCodex(fs).prepareAutoStop?.(ctx())
    const runHome: Path = path(prep?.env.CODEX_HOME as string)
    await prep?.cleanup()

    expect(await fs.exists(runHome)).toBe(false)
    expect(await fs.readFile(path('/home/u/.codex/config.toml'))).toBe('model = "o3"\n')
    expect(await fs.readFile(path('/home/u/.codex/auth.json'))).toBe('{"token":"secret"}')
  })
})
