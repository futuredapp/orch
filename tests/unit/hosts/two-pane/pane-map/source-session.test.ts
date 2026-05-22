// Unit coverage for the source-session helper module — the per-source tmux
// session substrate that replaces the historical single `orch-scratch`
// session. Pinned behaviors:
//
//   - `sanitizeSessionName` is a pure function with a deterministic mapping
//     from SourceKey strings to tmux session names.
//   - `createSourceSession` issues exactly one `createSession` call with
//     the expected shape; no `splitPane` ever fires.
//   - `teardownSourceSession` issues exactly one `killSession` and tolerates
//     the canonical "session not found" idempotent shape via the underlying
//     TmuxService contract.

import { describe, expect, it } from 'bun:test'
import {
  createSourceSession,
  MAX_SESSION_NAME_LENGTH,
  SOURCE_HOLDER_ARGV,
  SOURCE_SESSION_PREFIX,
  sanitizeSessionName,
  teardownSourceSession,
} from '../../../../../src/hosts/two-pane/pane-map/source-session.ts'
import {
  FakeTmuxService,
  paneId,
  socketName,
  TmuxCommandError,
} from '../../../../../src/services/tmux/index.ts'

const SOCKET = socketName('orch-test')

describe('sanitizeSessionName', () => {
  it('maps the colon separator in a live source key to a dash and prefixes orch-src-', () => {
    expect(sanitizeSessionName('live:command:assign-roles-1')).toBe(
      'orch-src-live-command-assign-roles-1',
    )
  })

  it('replaces dots inside step names with dashes so tmux accepts the session name', () => {
    expect(sanitizeSessionName('replay:step.with.dots')).toBe('orch-src-replay-step-with-dots')
  })

  it('replaces whitespace (space and tab) with dashes — defensive against malformed step names', () => {
    expect(sanitizeSessionName('interactive:has space and\ttab')).toBe(
      'orch-src-interactive-has-space-and-tab',
    )
  })

  it('maps the singleton placeholder key to a stable session name (idempotent calls)', () => {
    const a = sanitizeSessionName('placeholder')
    const b = sanitizeSessionName('placeholder')

    expect(a).toBe('orch-src-placeholder')
    expect(b).toBe(a)
  })

  it('maps the singleton rollup key to a stable session name', () => {
    expect(sanitizeSessionName('rollup')).toBe('orch-src-rollup')
  })

  it('truncates over-long inputs and appends an 8-char hex hash for collision safety', () => {
    const longInput = `live:${'x'.repeat(200)}`

    const sanitized = sanitizeSessionName(longInput)

    expect(sanitized.length).toBeLessThanOrEqual(MAX_SESSION_NAME_LENGTH)
    expect(sanitized.startsWith(SOURCE_SESSION_PREFIX)).toBe(true)
    // Last 8 chars (after the `-` separator) must be hex.
    expect(sanitized).toMatch(/-[0-9a-f]{8}$/)
  })

  it('distinguishes two inputs that share their first 56 chars via the hash suffix', () => {
    // Two distinct long inputs whose sanitized forms share their first
    // (MAX - prefix - hash - 1) chars must produce distinct session names.
    const sharedPrefix = `live:${'x'.repeat(200)}`
    const a = `${sharedPrefix}-a`
    const b = `${sharedPrefix}-b`

    const sanitizedA = sanitizeSessionName(a)
    const sanitizedB = sanitizeSessionName(b)

    expect(sanitizedA).not.toBe(sanitizedB)
  })
})

describe('createSourceSession', () => {
  it('records exactly one createSession call with the expected session name, command, width, and height', async () => {
    const tmux = new FakeTmuxService()
    tmux.nextCreateSessionPaneId(paneId('%101'))

    await createSourceSession({
      tmux,
      socket: SOCKET,
      sessionName: 'orch-src-live-step1',
      width: 120,
      height: 30,
      command: ['tail', '-n', '5000', '-F', '/tmp/step1.ansi'],
    })

    const createCalls = tmux.recordedCalls.filter((c) => c.method === 'createSession')
    expect(createCalls).toHaveLength(1)
    const call = createCalls[0]
    if (call?.method !== 'createSession') throw new Error('expected createSession call')
    expect(call.opts.session).toBe('orch-src-live-step1')
    expect(call.opts.width).toBe(120)
    expect(call.opts.height).toBe(30)
    expect(call.opts.command).toEqual(['tail', '-n', '5000', '-F', '/tmp/step1.ansi'])
  })

  it('returns the source session handle with the pane id scripted on the fake', async () => {
    const tmux = new FakeTmuxService()
    tmux.nextCreateSessionPaneId(paneId('%202'))

    const handle = await createSourceSession({
      tmux,
      socket: SOCKET,
      sessionName: 'orch-src-replay-x',
      width: 80,
      height: 24,
      command: SOURCE_HOLDER_ARGV,
    })

    expect(handle.session).toBe('orch-src-replay-x')
    expect(handle.socket).toBe(SOCKET)
    expect(handle.paneId).toBe(paneId('%202'))
  })

  it('never calls splitPane — the per-source design removes split-window from the spawn path', async () => {
    const tmux = new FakeTmuxService()

    await createSourceSession({
      tmux,
      socket: SOCKET,
      sessionName: 'orch-src-placeholder',
      width: 80,
      height: 24,
      command: SOURCE_HOLDER_ARGV,
    })

    const splitCalls = tmux.recordedCalls.filter((c) => c.method === 'splitPane')
    expect(splitCalls).toHaveLength(0)
  })

  it('propagates TmuxCommandError from createSession unchanged (no retry, no rotation)', async () => {
    const tmux = new FakeTmuxService()
    tmux.nextCreateSessionError(
      new TmuxCommandError(1, 'duplicate session', 'tmux new-session failed'),
    )

    await expect(
      createSourceSession({
        tmux,
        socket: SOCKET,
        sessionName: 'orch-src-live-a',
        width: 80,
        height: 24,
        command: ['cat'],
      }),
    ).rejects.toBeInstanceOf(TmuxCommandError)

    // No retry, no rotation: exactly one createSession recorded; no newWindow.
    expect(tmux.recordedCalls.filter((c) => c.method === 'createSession')).toHaveLength(1)
    expect(tmux.recordedCalls.filter((c) => c.method === 'newWindow')).toHaveLength(0)
    expect(tmux.recordedCalls.filter((c) => c.method === 'splitPane')).toHaveLength(0)
  })
})

describe('teardownSourceSession', () => {
  it('issues exactly one killSession against the handled session', async () => {
    const tmux = new FakeTmuxService()
    tmux.nextCreateSessionPaneId(paneId('%300'))
    const handle = await createSourceSession({
      tmux,
      socket: SOCKET,
      sessionName: 'orch-src-interactive-y',
      width: 80,
      height: 24,
      command: ['cat'],
    })

    await teardownSourceSession(tmux, handle)

    const kills = tmux.recordedCalls.filter((c) => c.method === 'killSession')
    expect(kills).toHaveLength(1)
    const kill = kills[0]
    if (kill?.method !== 'killSession') throw new Error('expected killSession')
    expect(kill.opts.session).toBe('orch-src-interactive-y')
    expect(kill.opts.socket).toBe(SOCKET)
  })

  it('clears the fake pane-ownership table for the torn-down session', async () => {
    const tmux = new FakeTmuxService()
    tmux.nextCreateSessionPaneId(paneId('%310'))
    const handle = await createSourceSession({
      tmux,
      socket: SOCKET,
      sessionName: 'orch-src-z',
      width: 80,
      height: 24,
      command: ['cat'],
    })
    expect(tmux.paneIdsForSession(SOCKET, 'orch-src-z')).toEqual([paneId('%310')])

    await teardownSourceSession(tmux, handle)

    expect(tmux.paneIdsForSession(SOCKET, 'orch-src-z')).toEqual([])
  })
})
