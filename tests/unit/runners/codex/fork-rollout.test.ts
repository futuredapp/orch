import { describe, expect, it } from 'bun:test'
import { forkCodexRollout } from '../../../../src/runners/codex/fork-rollout.ts'
import { FakeFsService } from '../../../../src/services/fs/fake-fs-service.ts'
import { type Path, path } from '../../../../src/services/types.ts'

const SESSIONS_ROOT = path('/home/.codex/sessions')
const CHECKPOINT = 'parent-id-123'
// 2026-06-02T14:44:52Z → date dir 2026/06/02 (matches the source's day dir).
const NOW = Date.UTC(2026, 5, 2, 14, 44, 52)

function sessionMeta(id: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    timestamp: '2026-06-02T12:44:52.256Z',
    type: 'session_meta',
    payload: { id, cwd: '/work', originator: 'codex-exec', cli_version: '0.136.0', ...extra },
  })
}

async function seedRollout(fs: FakeFsService, content: string, fileId = CHECKPOINT): Promise<Path> {
  const dir = path(`${SESSIONS_ROOT}/2026/06/02`)
  await fs.mkdir(dir, { recursive: true })
  const file = path(`${dir}/rollout-2026-06-02T14-44-52-${fileId}.jsonl`)
  await fs.writeFile(file, content)
  return file
}

describe('forkCodexRollout', () => {
  it('copies + rewrites the session_meta id and records forked_from_id, leaving the original untouched', async () => {
    const fs = new FakeFsService()
    const original = `${sessionMeta(CHECKPOINT)}\n{"type":"event_msg","payload":{"type":"task_started"}}\n`
    const sourcePath = await seedRollout(fs, original)

    const result = await forkCodexRollout({
      fs,
      sessionsRoot: SESSIONS_ROOT,
      checkpointSessionId: CHECKPOINT,
      newSessionId: 'forked-id-999',
      now: NOW,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.newSessionId).toBe('forked-id-999')

    const written = await fs.readFile(result.path)
    const firstLine = JSON.parse(written.split('\n')[0] ?? '') as {
      payload: Record<string, unknown>
    }
    expect(firstLine.payload.id).toBe('forked-id-999')
    expect(firstLine.payload.forked_from_id).toBe(CHECKPOINT)
    // Trailing lines preserved verbatim.
    expect(written).toContain('task_started')

    // Original checkpoint rollout is byte-for-byte unchanged (R8 — never pollute
    // the parent).
    expect(await fs.readFile(sourcePath)).toBe(original)
  })

  it('returns not-found when no rollout matches the checkpoint id', async () => {
    const fs = new FakeFsService()
    await seedRollout(fs, sessionMeta('a-different-id'), 'a-different-id')

    const result = await forkCodexRollout({
      fs,
      sessionsRoot: SESSIONS_ROOT,
      checkpointSessionId: CHECKPOINT,
      newSessionId: 'forked-id-999',
      now: NOW,
    })

    expect(result).toEqual({ ok: false, reason: 'not-found' })
  })

  it('fails the sanity check when the first line is not a session_meta record', async () => {
    const fs = new FakeFsService()
    await seedRollout(fs, `{"type":"event_msg","payload":{}}\n`)

    const result = await forkCodexRollout({
      fs,
      sessionsRoot: SESSIONS_ROOT,
      checkpointSessionId: CHECKPOINT,
      newSessionId: 'forked-id-999',
      now: NOW,
    })

    expect(result).toEqual({ ok: false, reason: 'sanity' })
  })

  it('fails the sanity check when the session_meta id does not match the checkpoint', async () => {
    const fs = new FakeFsService()
    // Filename embeds CHECKPOINT (so it's located) but the metadata id differs.
    await seedRollout(fs, sessionMeta('mismatched-id'))

    const result = await forkCodexRollout({
      fs,
      sessionsRoot: SESSIONS_ROOT,
      checkpointSessionId: CHECKPOINT,
      newSessionId: 'forked-id-999',
      now: NOW,
    })

    expect(result).toEqual({ ok: false, reason: 'sanity' })
  })

  it('returns error when the sessions root is undefined', async () => {
    const result = await forkCodexRollout({
      fs: new FakeFsService(),
      sessionsRoot: undefined,
      checkpointSessionId: CHECKPOINT,
      newSessionId: 'forked-id-999',
      now: NOW,
    })

    expect(result).toEqual({ ok: false, reason: 'error' })
  })
})
