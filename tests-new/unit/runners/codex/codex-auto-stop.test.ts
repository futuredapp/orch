import { describe, expect, it } from 'bun:test'
import { codex } from '../../../../src/runners/codex/index.ts'
import type { RunnerContext } from '../../../../src/runners/index.ts'
import { FakeFsService, FakeProcessService } from '../../../../src/services/index.ts'
import { path } from '../../../../src/services/types.ts'

const REAL_HOME = path('/home/u/.codex')
const ORCH_HOME = path('/home/u/.codex-orch')

const PLANNOTATOR_HOOKS_JSON = JSON.stringify({
  hooks: {
    Stop: [
      { hooks: [{ type: 'command', command: '/usr/local/bin/plannotator', timeout: 345600 }] },
    ],
  },
})

async function seedRealCodexHome(fs: FakeFsService): Promise<void> {
  await fs.mkdir(REAL_HOME, { recursive: true })
  await fs.mkdir(path('/home/u/.codex/sessions'), { recursive: true })
  await fs.writeFile(path('/home/u/.codex/config.toml'), 'model = "o3"\n[features]\nhooks = true\n')
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

describe('codex().prepareAutoStop reuses a stable CODEX_HOME', () => {
  it('points CODEX_HOME at a stable sibling of the real home, not a fresh temp dir', async () => {
    const fs = new FakeFsService()
    await seedRealCodexHome(fs)

    const prep = await makeCodex(fs).prepareAutoStop?.(ctx())

    expect(prep?.env.CODEX_HOME).toBe(ORCH_HOME as string)
  })

  it('returns the same home on a second run so Codex trusts the hook only once', async () => {
    const fs = new FakeFsService()
    await seedRealCodexHome(fs)
    const runner = makeCodex(fs)

    const first = await runner.prepareAutoStop?.(ctx())
    const second = await runner.prepareAutoStop?.(ctx())

    expect(second?.env.CODEX_HOME).toBe(first?.env.CODEX_HOME)
  })

  it('does not throw on the second run when the inherited symlinks already exist', async () => {
    const fs = new FakeFsService()
    await seedRealCodexHome(fs)
    const runner = makeCodex(fs)

    await runner.prepareAutoStop?.(ctx())

    expect(runner.prepareAutoStop?.(ctx())).resolves.toBeDefined()
  })

  it('keeps the orch home in place after cleanup so trust state survives', async () => {
    const fs = new FakeFsService()
    await seedRealCodexHome(fs)

    const prep = await makeCodex(fs).prepareAutoStop?.(ctx())
    await prep?.cleanup()

    expect(await fs.exists(ORCH_HOME)).toBe(true)
  })
})

describe('codex().prepareAutoStop inherits the real home without copying credentials', () => {
  it('symlinks every real-home entry except config.toml and hooks.json', async () => {
    const fs = new FakeFsService()
    await seedRealCodexHome(fs)
    await fs.writeFile(path('/home/u/.codex/hooks.json'), PLANNOTATOR_HOOKS_JSON)

    await makeCodex(fs).prepareAutoStop?.(ctx())

    const entries = (await fs.readDir(ORCH_HOME)).map((e) => e as string)
    expect(entries).toContain('auth.json')
    expect(entries).toContain('sessions')
    expect(entries).toContain('config.toml')
    expect(entries).toContain('hooks.json')
  })

  it('inherits auth.json as a symlink that resolves to the real credentials', async () => {
    const fs = new FakeFsService()
    await seedRealCodexHome(fs)

    await makeCodex(fs).prepareAutoStop?.(ctx())

    expect(await fs.readFile(path(`${ORCH_HOME}/auth.json`))).toBe('{"token":"secret"}')
  })
})

describe('codex().prepareAutoStop writes the Stop hook as a single representation', () => {
  it('registers the signal-only Stop hook in hooks.json, not config.toml', async () => {
    const fs = new FakeFsService()
    await seedRealCodexHome(fs)

    await makeCodex(fs).prepareAutoStop?.(ctx())

    const hooks = await fs.readFile(path(`${ORCH_HOME}/hooks.json`))
    expect(hooks).toContain('$ORCH_SOCKET')
    expect(hooks).toContain('$ORCH_STOP_CHANNEL')
    expect(hooks).toContain('wait-for')
    expect(hooks).not.toMatch(/kill|exit/)
  })

  it('leaves the orch config.toml free of any inline hook block so Codex loads hooks one way', async () => {
    const fs = new FakeFsService()
    await seedRealCodexHome(fs)

    await makeCodex(fs).prepareAutoStop?.(ctx())

    const config = await fs.readFile(path(`${ORCH_HOME}/config.toml`))
    expect(config).not.toContain('[[hooks.Stop]]')
    expect(config).not.toContain('$ORCH_STOP_CHANNEL')
  })

  it("folds the user's existing hooks.json hooks alongside the orch hook", async () => {
    const fs = new FakeFsService()
    await seedRealCodexHome(fs)
    await fs.writeFile(path('/home/u/.codex/hooks.json'), PLANNOTATOR_HOOKS_JSON)

    await makeCodex(fs).prepareAutoStop?.(ctx())

    const hooks = await fs.readFile(path(`${ORCH_HOME}/hooks.json`))
    expect(hooks).toContain('plannotator')
    expect(hooks).toContain('$ORCH_STOP_CHANNEL')
  })

  it('refreshes the orch hook every run so an updated command propagates', async () => {
    const fs = new FakeFsService()
    await seedRealCodexHome(fs)
    // A prior orch version left a stale hook command in the reused home.
    await fs.mkdir(ORCH_HOME, { recursive: true })
    await fs.writeFile(
      path(`${ORCH_HOME}/hooks.json`),
      JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'OLD_ORCH_COMMAND' }] }] },
      }),
    )

    await makeCodex(fs).prepareAutoStop?.(ctx())

    const hooks = await fs.readFile(path(`${ORCH_HOME}/hooks.json`))
    expect(hooks).not.toContain('OLD_ORCH_COMMAND')
    expect(hooks).toContain('$ORCH_STOP_CHANNEL')
  })

  it('does not duplicate the orch hook when the real hooks.json already declares it', async () => {
    const fs = new FakeFsService()
    await seedRealCodexHome(fs)
    await fs.writeFile(
      path('/home/u/.codex/hooks.json'),
      JSON.stringify({
        hooks: {
          Stop: [
            {
              hooks: [
                {
                  type: 'command',
                  command: 'tmux -L "$ORCH_SOCKET" wait-for -S "$ORCH_STOP_CHANNEL"',
                },
              ],
            },
          ],
        },
      }),
    )

    await makeCodex(fs).prepareAutoStop?.(ctx())

    const hooks = await fs.readFile(path(`${ORCH_HOME}/hooks.json`))
    expect(hooks.match(/\$ORCH_STOP_CHANNEL/g)?.length).toBe(1)
  })
})

describe('codex().prepareAutoStop config.toml handling', () => {
  it('enables the hooks feature and disables the startup update check', async () => {
    const fs = new FakeFsService()
    await fs.mkdir(REAL_HOME, { recursive: true })
    await fs.writeFile(path('/home/u/.codex/config.toml'), 'model = "o3"\n')

    await makeCodex(fs).prepareAutoStop?.(ctx())

    const config = await fs.readFile(path(`${ORCH_HOME}/config.toml`))
    expect(config).toMatch(/^\s*check_for_update_on_startup\s*=\s*false/m)
    expect(config).toMatch(/^\s*hooks\s*=\s*true/m)
  })

  it('never writes back to the real ~/.codex config.toml or hooks.json', async () => {
    const fs = new FakeFsService()
    await seedRealCodexHome(fs)
    await fs.writeFile(path('/home/u/.codex/hooks.json'), PLANNOTATOR_HOOKS_JSON)

    await makeCodex(fs).prepareAutoStop?.(ctx())

    expect(await fs.readFile(path('/home/u/.codex/config.toml'))).toBe(
      'model = "o3"\n[features]\nhooks = true\n',
    )
    expect(await fs.readFile(path('/home/u/.codex/hooks.json'))).toBe(PLANNOTATOR_HOOKS_JSON)
  })

  it('preserves an existing orch config.toml so Codex-written trust state is not clobbered', async () => {
    const fs = new FakeFsService()
    await seedRealCodexHome(fs)
    // Simulate a prior run where Codex recorded hook-trust into the orch config.
    const trusted =
      'model = "o3"\n[features]\nhooks = true\n[hooks.state]\n[hooks.state."x:stop:0:0"]\n'
    await fs.mkdir(ORCH_HOME, { recursive: true })
    await fs.writeFile(path(`${ORCH_HOME}/config.toml`), trusted)

    await makeCodex(fs).prepareAutoStop?.(ctx())

    expect(await fs.readFile(path(`${ORCH_HOME}/config.toml`))).toBe(trusted)
  })
})
