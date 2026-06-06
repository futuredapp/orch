import { describe, expect, it } from 'bun:test'
import { claude } from '../../../../src/runners/claude/index.ts'
import type { RunnerContext } from '../../../../src/runners/index.ts'
import { FakeFsService } from '../../../../src/services/index.ts'
import { type Path, path } from '../../../../src/services/types.ts'

const CWD = path('/work')
const SETTINGS = path('/work/.claude/settings.local.json')
const HOME_SETTINGS = path('/home/user/.claude/settings.json')

function ctx(): RunnerContext {
  return { cwd: CWD, env: {}, prompt: 'go', extraArgs: [], mode: 'interactive', autoStop: true }
}

/** Pull the flattened list of command strings out of a Claude hooks block. */
function commandsFor(settings: Record<string, unknown>, event: string): string[] {
  const hooks = settings.hooks as Record<string, unknown> | undefined
  const groups = (hooks?.[event] as Array<{ hooks: Array<{ command: string }> }>) ?? []
  return groups.flatMap((g) => g.hooks.map((h) => h.command))
}

async function readJson(fs: FakeFsService, p: Path): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(p)) as Record<string, unknown>
}

describe('claude().prepareAutoStop with no pre-existing settings', () => {
  it('writes Stop and StopFailure hooks whose command is exactly the signal-only one-liner', async () => {
    const fs = new FakeFsService()
    const runner = claude({}, { fs })

    await runner.prepareAutoStop?.(ctx())

    const settings = await readJson(fs, SETTINGS)
    const expected = 'tmux -L "$ORCH_SOCKET" wait-for -S "$ORCH_STOP_CHANNEL"'
    expect(commandsFor(settings, 'Stop')).toEqual([expected])
    expect(commandsFor(settings, 'StopFailure')).toEqual([expected])
  })

  it('writes a signal-only command — no termination verb and no stdout side effect', async () => {
    const fs = new FakeFsService()
    const runner = claude({}, { fs })

    await runner.prepareAutoStop?.(ctx())

    const settings = await readJson(fs, SETTINGS)
    const command = commandsFor(settings, 'Stop')[0] ?? ''
    expect(command).toContain('wait-for')
    expect(command).not.toMatch(/kill|exit|\bkill-session\b|echo|tee|>>|>/)
  })

  it('has written the file by the time prepareAutoStop resolves (write-before-launch)', async () => {
    const fs = new FakeFsService()
    const runner = claude({}, { fs })

    await runner.prepareAutoStop?.(ctx())

    expect(await fs.exists(SETTINGS)).toBe(true)
  })
})

describe('claude().prepareAutoStop with a pre-existing user settings file', () => {
  it('preserves the user hooks and appends the two injected hooks (no clobber)', async () => {
    const fs = new FakeFsService()
    await fs.mkdir(path('/work/.claude'), { recursive: true })
    const userSettings = {
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo user-hook' }] }],
      },
    }
    await fs.writeFile(SETTINGS, JSON.stringify(userSettings, null, 2))
    const runner = claude({}, { fs })

    await runner.prepareAutoStop?.(ctx())

    const settings = await readJson(fs, SETTINGS)
    expect(commandsFor(settings, 'PreToolUse')).toEqual(['echo user-hook'])
    expect(commandsFor(settings, 'Stop')).toHaveLength(1)
    expect(commandsFor(settings, 'StopFailure')).toHaveLength(1)
  })
})

describe('claude().prepareAutoStop cleanup', () => {
  it('removes the file it wrote when no settings existed before', async () => {
    const fs = new FakeFsService()
    const runner = claude({}, { fs })

    const prep = await runner.prepareAutoStop?.(ctx())
    expect(await fs.exists(SETTINGS)).toBe(true)
    await prep?.cleanup()

    expect(await fs.exists(SETTINGS)).toBe(false)
  })

  it('restores the original bytes when a settings file existed before', async () => {
    const fs = new FakeFsService()
    await fs.mkdir(path('/work/.claude'), { recursive: true })
    const originalBytes = `${JSON.stringify({ hooks: { PreToolUse: [] } }, null, 2)}\n`
    await fs.writeFile(SETTINGS, originalBytes)
    const runner = claude({}, { fs })

    const prep = await runner.prepareAutoStop?.(ctx())
    await prep?.cleanup()

    expect(await fs.readFile(SETTINGS)).toBe(originalBytes)
  })

  it('never touches a ~/.claude path during prepare or cleanup', async () => {
    const fs = new FakeFsService()
    await fs.mkdir(path('/home/user/.claude'), { recursive: true })
    const homeBytes = JSON.stringify({ hooks: { Stop: [] } }, null, 2)
    await fs.writeFile(HOME_SETTINGS, homeBytes)
    const runner = claude({}, { fs })

    const prep = await runner.prepareAutoStop?.(ctx())
    await prep?.cleanup()

    expect(await fs.readFile(HOME_SETTINGS)).toBe(homeBytes)
  })
})
