// triage: keep — U1 self-test for the real-tmux harness lifecycle.
//
// Pins the contracts U2/U3 build on: unique sockets per fixture, hard-stop on
// nested tmux, the `canRunRealTmux()` skip predicate, and idempotent
// teardown (kill-server + rm stateBase). Every later tier inherits these
// guarantees, so a regression here would mask every downstream harness bug.

import { afterEach, describe, expect, it } from 'bun:test'
import { stat } from 'node:fs/promises'
import {
  allocateSocketName,
  assertNoNestedTmux,
  canRunRealTmux,
  createRealTmuxFixture,
  pidFromTestSocket,
  type RealTmuxFixture,
} from '@orch/test/real-tmux/index.ts'

const tmuxAvailable = Bun.which('tmux') !== null && !process.env.TMUX

let fixturesToDispose: RealTmuxFixture[] = []

afterEach(async () => {
  for (const f of fixturesToDispose) await f.dispose()
  fixturesToDispose = []
})

describe('allocateSocketName', () => {
  it('returns a reserved orch-test-<pid>-<nonce> name embedding this process pid', () => {
    const name = allocateSocketName()

    expect(name).toMatch(/^orch-test-\d+-[0-9a-f]+$/)
    expect(pidFromTestSocket(name)).toBe(process.pid)
  })

  it('returns a fresh, distinct name on every call', () => {
    const a = allocateSocketName()
    const b = allocateSocketName()

    expect(a).not.toEqual(b)
  })

  it('never produces a production-shaped or bare orch- socket name', () => {
    const name = String(allocateSocketName())

    expect(name).not.toMatch(/^orch-r-/)
    expect(name.startsWith('orch-test-')).toBe(true)
  })
})

describe('reserved-prefix audit guard (success criterion)', () => {
  // Encodes "no bare orch- / orch-r- socket is ever created by test code".
  // PROD_OR_BARE matches a production orch-r- socket OR any orch- name whose
  // first segment is not `test` — exactly the shapes the stale-socket preload
  // must never name. A reserved orch-test- socket starts with `orch-t`, so it
  // fails both alternatives.
  const PROD_OR_BARE = /^orch-(r-|[^t])/

  it('allocateSocketName() never yields a production-shaped or bare socket name', () => {
    const name = String(allocateSocketName())

    expect(name).not.toMatch(PROD_OR_BARE)
    expect(name).toMatch(/^orch-test-/)
  })

  it('a created fixture socket never yields a production-shaped or bare socket name', async () => {
    const fixture = await createRealTmuxFixture({ env: {} })
    fixturesToDispose.push(fixture)

    expect(String(fixture.socket)).not.toMatch(PROD_OR_BARE)
    expect(String(fixture.socket)).toMatch(/^orch-test-/)
  })
})

describe('pidFromTestSocket', () => {
  it('parses the pid from a reserved orch-test- socket name', () => {
    expect(pidFromTestSocket('orch-test-12345-ab12cd')).toBe(12345)
  })

  it('returns undefined for a production-shaped orch-r- socket name', () => {
    expect(pidFromTestSocket('orch-r-2026-06-01-151213-4s')).toBeUndefined()
  })

  it('returns undefined when the first segment after the prefix is not numeric', () => {
    expect(pidFromTestSocket('orch-test-notapid-xx')).toBeUndefined()
  })

  it('round-trips with allocateSocketName back to this process pid', () => {
    expect(pidFromTestSocket(allocateSocketName())).toBe(process.pid)
  })
})

describe('assertNoNestedTmux', () => {
  it('returns silently when TMUX is unset or empty', () => {
    expect(() => assertNoNestedTmux({})).not.toThrow()
    expect(() => assertNoNestedTmux({ TMUX: '' })).not.toThrow()
    expect(() => assertNoNestedTmux({ TMUX: undefined })).not.toThrow()
  })

  it('throws a clear error naming TMUX when running inside a tmux session', () => {
    expect(() => assertNoNestedTmux({ TMUX: '/tmp/tmux-1000/default,1234,0' })).toThrow(/TMUX/)
  })
})

describe('canRunRealTmux', () => {
  it('returns false when TMUX is set even if tmux is on PATH', () => {
    expect(canRunRealTmux({ TMUX: '/tmp/tmux-x/default,1,0', PATH: process.env.PATH })).toBe(false)
  })

  it('mirrors Bun.which(tmux) presence when TMUX is unset', () => {
    expect(canRunRealTmux({ PATH: process.env.PATH })).toBe(tmuxAvailable)
  })

  it('returns false when ORCH_DISABLE_REAL_TMUX is set, even with tmux on PATH and no nesting', () => {
    expect(canRunRealTmux({ PATH: process.env.PATH, ORCH_DISABLE_REAL_TMUX: '1' })).toBe(false)
  })
})

describe('createRealTmuxFixture lifecycle', () => {
  it('exposes services, a reserved orch-test- socket decoupled from runId, and an existing state-base directory', async () => {
    const fixture = await createRealTmuxFixture({ env: {} })
    fixturesToDispose.push(fixture)

    expect(fixture.runId).toMatch(/^r-\d{4}-\d{2}-\d{2}-\d{6}-[a-z0-9]{2}$/)
    expect(String(fixture.socket)).toMatch(/^orch-test-\d+-[0-9a-f]+$/)
    expect(String(fixture.socket)).not.toBe(`orch-${fixture.runId}`)
    expect(pidFromTestSocket(fixture.socket)).toBe(process.pid)
    const stateBaseStat = await stat(fixture.stateBase)
    expect(stateBaseStat.isDirectory()).toBe(true)
    expect(fixture.width).toBe(200)
    expect(fixture.height).toBe(50)
  })

  it('allocates a distinct runId, socket, and state base for two concurrent fixtures', async () => {
    const a = await createRealTmuxFixture({ env: {} })
    fixturesToDispose.push(a)
    const b = await createRealTmuxFixture({ env: {} })
    fixturesToDispose.push(b)

    expect(a.runId).not.toEqual(b.runId)
    expect(a.socket).not.toEqual(b.socket)
    expect(a.stateBase).not.toEqual(b.stateBase)
  })

  it('removes the state base on dispose and tolerates being called twice', async () => {
    const fixture = await createRealTmuxFixture({ env: {} })
    const { stateBase } = fixture

    await fixture.dispose()
    await fixture.dispose()

    await expect(stat(stateBase)).rejects.toThrow()
  })

  it('throws the nested-tmux guard error before allocating anything when TMUX is set', async () => {
    await expect(
      createRealTmuxFixture({ env: { TMUX: '/tmp/tmux-1000/default,1,0' } }),
    ).rejects.toThrow(/TMUX/)
  })
})

describe.skipIf(!tmuxAvailable)('createRealTmuxFixture real-tmux teardown', () => {
  it('kills a tmux server booted on its socket so list-sessions exits non-zero after dispose', async () => {
    const fixture = await createRealTmuxFixture({ env: {} })
    const { socket } = fixture

    // Boot a minimal session on the fixture's socket so we can prove dispose
    // tears it down. Production code paths (U2's createTmuxHost) will do the
    // same on this socket; the fixture is responsible for cleanup either way.
    const boot = Bun.spawn(['tmux', '-L', socket, 'new-session', '-d', '-s', 'probe', 'cat'], {
      stdout: 'ignore',
      stderr: 'ignore',
    })
    expect(await boot.exited).toBe(0)

    await fixture.dispose()

    const list = Bun.spawn(['tmux', '-L', socket, 'list-sessions'], {
      stdout: 'ignore',
      stderr: 'ignore',
    })
    expect(await list.exited).not.toBe(0)
  })
})
