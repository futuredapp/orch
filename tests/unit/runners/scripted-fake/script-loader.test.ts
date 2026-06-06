// MIGRATED → tests-new/unit/runners/scripted-fake/script-loader.test.ts (parent U11) — relocated verbatim (import paths only); kept skipped on disk (D2).
import { describe, expect, it } from 'bun:test'
import {
  loadScriptedFakeScript,
  ORCH_LIFECYCLE_SCRIPT_ENV,
  resolveStepScript,
  type ScriptedFakeScriptFile,
  ScriptLoadError,
} from '../../../../src/runners/scripted-fake/index.ts'
import { FakeFsService } from '../../../../src/services/fs/fake-fs-service.ts'
import { path } from '../../../../src/services/types.ts'

const SCRIPT_PATH = '/tmp/script.json'

async function writeScript(fs: FakeFsService, body: unknown): Promise<void> {
  await fs.mkdir(path('/tmp'), { recursive: true })
  await fs.writeFile(path(SCRIPT_PATH), JSON.stringify(body))
}

describe.skip('loadScriptedFakeScript', () => {
  it('reads, parses, and validates a well-formed script file', async () => {
    const fs = new FakeFsService()
    const wanted: ScriptedFakeScriptFile = {
      steps: {
        plan: { kind: 'instant-ok' },
        execute: { kind: 'wait-for-file', gatePath: '/tmp/execute.gate' },
      },
    }
    await writeScript(fs, wanted)

    const got = await loadScriptedFakeScript({
      fs,
      env: { [ORCH_LIFECYCLE_SCRIPT_ENV]: SCRIPT_PATH },
    })

    expect(got).toEqual(wanted)
  })

  it('throws ScriptLoadError when the env var is unset', async () => {
    const fs = new FakeFsService()

    await expect(loadScriptedFakeScript({ fs, env: {} })).rejects.toBeInstanceOf(ScriptLoadError)
  })

  it('throws ScriptLoadError when the script file is missing', async () => {
    const fs = new FakeFsService()

    await expect(
      loadScriptedFakeScript({ fs, env: { [ORCH_LIFECYCLE_SCRIPT_ENV]: SCRIPT_PATH } }),
    ).rejects.toMatchObject({ name: 'ScriptLoadError' })
  })

  it('throws ScriptLoadError when the script file is not valid JSON', async () => {
    const fs = new FakeFsService()
    await fs.mkdir(path('/tmp'), { recursive: true })
    await fs.writeFile(path(SCRIPT_PATH), '{not-json')

    await expect(
      loadScriptedFakeScript({ fs, env: { [ORCH_LIFECYCLE_SCRIPT_ENV]: SCRIPT_PATH } }),
    ).rejects.toMatchObject({ name: 'ScriptLoadError' })
  })

  it('throws ScriptLoadError when an entry has an unknown kind', async () => {
    const fs = new FakeFsService()
    await writeScript(fs, { steps: { plan: { kind: 'instant-yolo' } } })

    await expect(
      loadScriptedFakeScript({ fs, env: { [ORCH_LIFECYCLE_SCRIPT_ENV]: SCRIPT_PATH } }),
    ).rejects.toMatchObject({ name: 'ScriptLoadError' })
  })

  it('throws ScriptLoadError when wait-for-file is missing the gatePath field', async () => {
    const fs = new FakeFsService()
    await writeScript(fs, { steps: { plan: { kind: 'wait-for-file' } } })

    await expect(
      loadScriptedFakeScript({ fs, env: { [ORCH_LIFECYCLE_SCRIPT_ENV]: SCRIPT_PATH } }),
    ).rejects.toMatchObject({ name: 'ScriptLoadError' })
  })

  it('throws ScriptLoadError when the top-level shape is not { steps: ... }', async () => {
    const fs = new FakeFsService()
    await writeScript(fs, { plan: { kind: 'instant-ok' } })

    await expect(
      loadScriptedFakeScript({ fs, env: { [ORCH_LIFECYCLE_SCRIPT_ENV]: SCRIPT_PATH } }),
    ).rejects.toMatchObject({ name: 'ScriptLoadError' })
  })
})

describe.skip('resolveStepScript', () => {
  it('returns the StepScript for the named step', () => {
    const file: ScriptedFakeScriptFile = {
      steps: {
        plan: { kind: 'instant-ok' },
        execute: { kind: 'instant-fail', message: 'oh no' },
      },
    }

    expect(resolveStepScript(file, 'execute')).toEqual({
      kind: 'instant-fail',
      message: 'oh no',
    })
  })

  it('throws ScriptLoadError when the step name is not in the script', () => {
    const file: ScriptedFakeScriptFile = { steps: { plan: { kind: 'instant-ok' } } }

    expect(() => resolveStepScript(file, 'execute')).toThrow(ScriptLoadError)
  })
})
