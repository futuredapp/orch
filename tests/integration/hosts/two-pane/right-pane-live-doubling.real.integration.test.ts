// Real-tmux reproducer for the "doubled live output" bug the user filed.
//
// In two-pane mode, every transcript line shows up twice in the right pane
// while a runner is live:
//
//     [work-0] ^[[2m○ thinking^[[0m   ← line-discipline echo of the bytes
//     [work-0] ○ thinking             ← cat's stdout copy (terminal-rendered)
//
// After the run ends, the right-pane controller respawns the pane with
// `cat <file>` (replay path) and the same content renders cleanly, once.
//
// The doubling is below TmuxService at the kernel pty layer:
//   1. `RealTmuxService.sendKeys` → `tmux send-keys -t <pane> -l <bytes>`
//      writes bytes to the pane's stdin (the pty master).
//   2. The pane runs `cat` over a pty whose line discipline has the default
//      ECHO + ECHOCTL flags. ESC bytes (0x1B) get echoed back as the
//      printable two-character sequence `^[`. That's the first copy.
//   3. `cat` then reads the line from stdin and writes it to stdout, where
//      tmux's terminal interprets the ANSI sequences correctly. That's the
//      second copy.
//
// This test reproduces (1)–(3) by driving real tmux through TmuxService and
// asserting on `capturePane` output.
//
// Expected to FAIL until the placeholder is changed to suppress pty echo
// (e.g. `sh -c 'stty -echo 2>/dev/null; exec cat'`). After the fix, the
// `not.toMatch(/\^\[\[/)` and the "exactly one copy" assertions both pass.
//
// **Run policy.** The bug-reproducing live test is skipped by default so
// `bun run check` stays green per CLAUDE.md rule #10. To run it:
//
//     ORCH_REPRO_BUG=1 bun test \
//       tests/integration/hosts/two-pane/right-pane-live-doubling.real.integration.test.ts
//
// Once the fix lands, drop the `ORCH_REPRO_BUG` skip-gate so the test runs
// in CI as a regression guard.
//
// The replay-path control test runs unconditionally — it passes today and
// pins the asymmetry the live path must match after the fix.
//
// Both tests are also gated on `Bun.which('tmux')` — auto-skip when tmux
// is unavailable.

import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BunFsService } from '../../../../src/services/fs/index.ts'
import { BunProcessService } from '../../../../src/services/process/index.ts'
import {
  initOrchSession,
  RealTmuxService,
  type SocketName,
  socketName,
  paneId as toPaneId,
} from '../../../../src/services/tmux/index.ts'

const canRun = Bun.which('tmux') !== null
// Gate the bug-reproducing test so `bun run check` stays green by default.
// Set `ORCH_REPRO_BUG=1` to actually run it; remove the gate once the fix
// lands so it serves as a regression guard.
const runReproducer = canRun && process.env.ORCH_REPRO_BUG === '1'

const killServer = async (socket: SocketName): Promise<void> => {
  const proc = Bun.spawn(['tmux', '-L', socket, 'kill-server'], {
    stdout: 'ignore',
    stderr: 'ignore',
  })
  await proc.exited
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

let sockets: SocketName[] = []
let dirsToClean: string[] = []

afterEach(async () => {
  for (const s of sockets) await killServer(s)
  sockets = []
  for (const d of dirsToClean) {
    await rm(d, { recursive: true, force: true }).catch(() => {})
  }
  dirsToClean = []
})

const newSocket = (tag: string): SocketName => {
  const s = socketName(`orch-doubling-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`)
  sockets.push(s)
  return s
}

const ESC = String.fromCharCode(0x1b)
const ANSI_LINE = `${ESC}[36m▸ Read${ESC}[0m hello\r\n`
// Multi-line payload — needed for the replay test because the appliance
// config sets `history-limit 0`, so a single line can scroll off when the
// pane respawns. Matches the real-world usage pattern (many transcript
// events accumulate before the user looks at the pane).
const ANSI_MULTI = Array.from(
  { length: 8 },
  (_, i) => `${ESC}[36m▸ Read${ESC}[0m line ${i + 1}\r\n`,
).join('')

describe.skipIf(!canRun)('two-pane right-pane live output (real tmux)', () => {
  it.skipIf(!runReproducer)(
    'does not double-render a line sent via send-keys -l into a `cat` pane (REPRODUCER, gated by ORCH_REPRO_BUG=1)',
    async () => {
      const baseTmp = await mkdtemp(join(tmpdir(), 'orch-doubling-'))
      dirsToClean.push(baseTmp)

      const tmux = new RealTmuxService({ processService: new BunProcessService() })
      const fs = new BunFsService()
      const socket = newSocket('basic')

      // Mirror the production session bootstrap so the appliance config (no
      // history-limit, mouse on, etc.) matches what tmux-host runs with.
      await initOrchSession(tmux, fs, {
        socket,
        session: 'orch',
        width: 200,
        height: 50,
        paneDiedCommand: `run-shell "tmux -L ${socket} wait-for -S pane-exit-#{hook_pane}"`,
      })

      // Split horizontally with cat as the placeholder — same shape as
      // tmux-host.ts (PLACEHOLDER_CMD = 'cat').
      const rightPaneId = await tmux.splitPane({
        socket,
        session: 'orch',
        orientation: 'h',
        percent: 70,
        command: 'cat',
      })

      // Give cat a moment to start so the first send-keys lands in its stdin.
      await wait(200)

      // The exact byte pattern from the bug report — a tool-call line.
      await tmux.sendKeys({
        socket,
        target: toPaneId(rightPaneId),
        keys: [ANSI_LINE],
      })

      // Round-trip: line discipline echo + cat read + cat stdout + tmux render.
      await wait(400)

      const captured = await tmux.capturePane({ socket, target: toPaneId(rightPaneId) })

      // Sanity: cat's output reached the pane buffer (terminal-rendered).
      expect(captured).toContain('▸ Read hello')

      // The bug surface: pty echo writes the ESC byte to the buffer as the
      // printable two-character sequence `^[` (the line discipline's caret
      // notation for an unprintable control byte). If this regex matches,
      // the bug is live; once the fix lands the assertion flips to passing.
      expect(captured).not.toMatch(/\^\[\[/)

      // And there should be exactly ONE rendered copy of the line — not two
      // (echo + cat). After the fix this will be 1; today it's 2.
      const matches = captured.match(/▸ Read hello/g) ?? []
      expect(matches.length).toBe(1)
    },
    10_000,
  )

  it('replay path (respawn-pane with argv ["cat", file]) renders the same bytes exactly once', async () => {
    // Control: write the same bytes to a file and respawn the pane with
    // argv-style ['cat', file] — the exact shape
    // `right-pane-controller.ts:respawnCatInline` uses. This path never
    // writes to the pane's stdin, so the kernel pty echo cannot double the
    // output. This passes today — it documents the asymmetry between the
    // two paths and pins the replay path as the reference behaviour the
    // live path must match after the fix.
    //
    // `remain-on-exit on` (set by initOrchSession) keeps the pane visible
    // after cat exits, so the buffer survives long enough to capture.
    const baseTmp = await mkdtemp(join(tmpdir(), 'orch-doubling-replay-'))
    dirsToClean.push(baseTmp)

    const tmux = new RealTmuxService({ processService: new BunProcessService() })
    const fs = new BunFsService()
    const socket = newSocket('replay')

    await initOrchSession(tmux, fs, {
      socket,
      session: 'orch',
      width: 200,
      height: 50,
      paneDiedCommand: `run-shell "tmux -L ${socket} wait-for -S pane-exit-#{hook_pane}"`,
    })

    const filePath = join(baseTmp, 'replay.txt')
    await Bun.write(filePath, ANSI_MULTI)

    // Bootstrap a right pane running `cat` (placeholder) just like the
    // production host does at startup, then respawn it with `cat <file>`
    // — the same two-step shape as right-pane-controller.respawnCatInline.
    const placeholderPaneId = await tmux.splitPane({
      socket,
      session: 'orch',
      orientation: 'h',
      percent: 70,
      command: 'cat',
    })
    await wait(150)

    await tmux.respawnPane({
      socket,
      target: toPaneId(placeholderPaneId),
      argv: ['cat', filePath],
      killRunning: true,
    })

    await wait(400)

    const captured = await tmux.capturePane({ socket, target: toPaneId(placeholderPaneId) })

    // At least one of the later lines must survive (early lines may scroll
    // off after the respawn-pane reset given `history-limit 0`).
    expect(captured).toContain('▸ Read line 8')
    // No caret-notation echo on the replay path — cat's stdout never
    // round-trips through the pty's stdin.
    expect(captured).not.toMatch(/\^\[\[/)
    // The last line appears exactly once (cat-stdout copy only, no echo).
    const matches = captured.match(/▸ Read line 8/g) ?? []
    expect(matches.length).toBe(1)
  }, 10_000)
})
