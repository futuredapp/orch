// Adapter-level pinning of `isSessionLostError` / `TMUX_SESSION_LOST_PATTERN`
// against the full set of "tmux server is gone" stderr shapes observed in the
// wild.
//
// Why this matters: the host translates any `TmuxCommandError` matching this
// pattern into `HostUnavailableError`, which `mapRunError` renders as a clean
// failure summary instead of crashing Bun with an uncaught rejection. If a
// future tmux/macOS upstream tweaks the error prefix (the "error connecting
// to" wording, the path layout, the "(No such file or directory)" suffix
// emitted by the C library), this test fails loudly — preventing a silent
// regression where the classification quietly stops working.
//
// Positive cases are the strings actually seen in production stderr; the
// macOS-style "error connecting to /private/tmp/tmux-501/..." is the one we
// hit in incident r-2026-05-22-093650-j0. Negative cases pin against
// over-classification: a normal "no space for new pane" or "duplicate
// session" must NOT route through `HostUnavailableError`.

import { describe, expect, it } from 'bun:test'
import { isSessionLostError } from '../../../../src/hosts/two-pane/index.ts'
import { TmuxCommandError } from '../../../../src/services/tmux/index.ts'

const mk = (stderr: string): TmuxCommandError =>
  new TmuxCommandError(1, stderr, `tmux command failed (exit 1): ${stderr}`)

describe('isSessionLostError — wild stderr shapes', () => {
  it('classifies the macOS "error connecting to ... (No such file or directory)" shape as session-lost', () => {
    // The exact shape from incident r-2026-05-22-093650-j0.
    const err = mk(
      'error connecting to /private/tmp/tmux-501/orch-r-2026-05-22-093650-j0 (No such file or directory)',
    )
    expect(isSessionLostError(err)).toBe(true)
  })

  it('classifies the Linux-style "no server running on ..." shape as session-lost', () => {
    const err = mk('no server running on /tmp/tmux-501/orch-r-2026-05-22-093650-j0')
    expect(isSessionLostError(err)).toBe(true)
  })

  it('classifies "session not found" with a session name as session-lost', () => {
    const err = mk('session not found: orch')
    expect(isSessionLostError(err)).toBe(true)
  })

  it('classifies "can\'t find session" as session-lost', () => {
    const err = mk("can't find session orch")
    expect(isSessionLostError(err)).toBe(true)
  })

  it('classifies "lost server" as session-lost', () => {
    const err = mk('lost server')
    expect(isSessionLostError(err)).toBe(true)
  })

  it('matches case-insensitively (tmux/macOS sometimes capitalize "No such file")', () => {
    const err = mk('error connecting to /tmp/foo (No Such File Or Directory)')
    expect(isSessionLostError(err)).toBe(true)
  })

  it('handles a bare "No such file or directory" in stderr (the canonical macOS connect-time variant)', () => {
    // The macOS connect path can surface just this without the "error connecting to"
    // prefix when libc reports it through tmux's syscall wrapper.
    const err = mk('No such file or directory')
    expect(isSessionLostError(err)).toBe(true)
  })
})

describe('isSessionLostError — negative cases (must NOT be classified)', () => {
  it('does NOT classify "no space for new pane" — this is in-server, not server-lost', () => {
    const err = mk('no space for new pane')
    expect(isSessionLostError(err)).toBe(false)
  })

  it('does NOT classify "duplicate session" — server is alive, name collision', () => {
    const err = mk('duplicate session: orch')
    expect(isSessionLostError(err)).toBe(false)
  })

  it('does NOT classify "can\'t find pane: %99" — pane-level lookup, server alive', () => {
    const err = mk("can't find pane: %99")
    expect(isSessionLostError(err)).toBe(false)
  })

  it('does NOT classify a generic "tmux: unknown command" error', () => {
    const err = mk('unknown command: bogus-cmd')
    expect(isSessionLostError(err)).toBe(false)
  })

  it('returns false for non-TmuxCommandError instances (plain Error, string, undefined, null)', () => {
    expect(isSessionLostError(new Error('No such file or directory'))).toBe(false)
    expect(isSessionLostError('No such file or directory')).toBe(false)
    expect(isSessionLostError(undefined)).toBe(false)
    expect(isSessionLostError(null)).toBe(false)
  })

  it('returns false for a TmuxCommandError with empty stderr', () => {
    const err = mk('')
    expect(isSessionLostError(err)).toBe(false)
  })
})
