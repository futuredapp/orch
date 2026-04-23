#!/usr/bin/env bun
// ---------------------------------------------------------------------------
// two-pane-demo.ts — Minimal 2-pane CLI app using tmux
// ---------------------------------------------------------------------------
//
// Usage:
//   bun examples/two-pane-demo.ts                    # runs a demo echo+sleep
//   bun examples/two-pane-demo.ts claude -p "hi"     # runs claude in right pane
//   bun examples/two-pane-demo.ts -- claude -p "hi"  # same (Bun strips --)
//
// Architecture:
//   Left pane  = Observer. Runs `cat`; this script draws status into it via
//                `tmux send-keys`. Polling loop checks if the worker is alive.
//   Right pane = Worker. Runs the external command in a real PTY.
//
// When the worker exits, the observer updates to show "FINISHED" and the
// worker pane stays visible (remain-on-exit) so you can read the output.
//
// To exit:  Ctrl-b d  (detach from tmux)
// Cleanup:  tmux -L two-pane-demo kill-server
// ---------------------------------------------------------------------------

import { $ } from 'bun'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SESSION = 'two-pane'
const SOCKET = 'two-pane-demo'
const WIDTH = 160
const HEIGHT = 40
const OBSERVER_WIDTH = 35 // columns for the left pane
const POLL_INTERVAL_MS = 500

// The command to run in the right pane. Default: a slow demo command.
// Bun strips `--` from process.argv, so everything after argv[1] (the script
// path) is the worker command. Example: `bun demo.ts claude -p "hi"`
//
// Since tmux runs the command via `/bin/sh -c`, we must re-quote each arg.
// The outer shell already stripped the user's quotes, so `process.argv` has
// bare strings like `What is 2 plus 2?` — the `?` would be glob-expanded
// without quoting.
const shellQuote = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`
const extraArgs = process.argv.slice(2) // skip [bun, script.ts]
const workerCommand =
  extraArgs.length > 0
    ? extraArgs.map(shellQuote).join(' ')
    : 'echo "Starting work..." && sleep 2 && echo "Phase 1 done." && sleep 2 && echo "Phase 2 done." && sleep 2 && echo "All done!"'

// ---------------------------------------------------------------------------
// Helpers — thin wrappers over `tmux -L <socket> <command>`
// ---------------------------------------------------------------------------

const tmux = async (...args: string[]): Promise<string> => {
  const result = await $`tmux -L ${SOCKET} ${args}`.quiet().nothrow()
  return result.stdout.toString().trim()
}

const tmuxOrThrow = async (...args: string[]): Promise<string> => {
  const result = await $`tmux -L ${SOCKET} ${args}`.quiet()
  return result.stdout.toString().trim()
}

/** Send visible text into a pane. Uses `-l` so tmux treats it as literal. */
const sendText = async (paneId: string, text: string): Promise<void> => {
  await $`tmux -L ${SOCKET} send-keys -t ${paneId} -l ${text}`.quiet().nothrow()
}

/** Send a key name (e.g. `Enter`, `C-l`) to a pane. */
const sendKey = async (paneId: string, key: string): Promise<void> => {
  await $`tmux -L ${SOCKET} send-keys -t ${paneId} ${key}`.quiet().nothrow()
}

/** Query a tmux format string for a pane (e.g. `#{pane_dead}`). */
const queryPane = async (paneId: string, format: string): Promise<string> => {
  return tmux('display-message', '-p', '-t', paneId, format)
}

/** Read the visible content of a pane. */
const capturePane = async (paneId: string): Promise<string> => {
  return tmux('capture-pane', '-p', '-t', paneId)
}

// ---------------------------------------------------------------------------
// Draw the observer pane
// ---------------------------------------------------------------------------

interface ObserverState {
  status: 'STARTING' | 'RUNNING' | 'FINISHED'
  workerPid: string
  elapsed: number
  lastOutput: string
}

// ANSI clear screen + cursor home. The terminal emulator interprets these
// escape codes even though `cat` is running — `cat` just passes them through
// to the PTY. This redraws cleanly without the ghost-line duplication that
// `Ctrl-L` causes (cat doesn't handle Ctrl-L, it just echoes `^L`).
const CLEAR_SCREEN = '\u001b[2J\u001b[H'

const drawObserver = async (paneId: string, state: ObserverState): Promise<void> => {
  const statusIcon =
    state.status === 'RUNNING' ? '>' : state.status === 'FINISHED' ? '*' : '...'

  const elapsedStr = `${Math.floor(state.elapsed / 1000)}s`

  const lines = [
    '=========================',
    '    OBSERVER PANEL',
    '=========================',
    '',
    ` Status:  [${statusIcon}] ${state.status}`,
    ` PID:     ${state.workerPid || '-'}`,
    ` Elapsed: ${elapsedStr}`,
    '',
    '--- last line of output ---',
    ` ${state.lastOutput.slice(0, 30) || '(none)'}`,
    '',
    '=========================',
  ]

  if (state.status === 'FINISHED') {
    lines.push('')
    lines.push(' Worker process exited.')
    lines.push(' Waiting for next task...')
    lines.push('')
    lines.push(' Ctrl-b d to detach.')
  }

  // Send the entire frame as ONE payload: clear screen + all lines joined by
  // \r\n. This is a single `send-keys -l` call — no per-line `Enter` needed.
  // This is the same technique the orch status-loop uses.
  const payload = `${CLEAR_SCREEN}${lines.join('\r\n')}\r\n`
  await sendText(paneId, payload)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // 0. Clean up any leftover session from a previous run
  await $`tmux -L ${SOCKET} kill-server`.quiet().nothrow()

  // 1. Create a detached tmux session (the left/observer pane)
  //    `-f /dev/null` ignores user's .tmux.conf for predictable layout
  await tmuxOrThrow(
    '-f', '/dev/null',
    'new-session', '-d', '-s', SESSION,
    '-x', String(WIDTH), '-y', String(HEIGHT),
  )

  // 2. Configure the session: keep dead panes visible so we can read output
  await tmux('set-option', '-t', SESSION, 'remain-on-exit', 'on')

  // 3. Find the initial pane (this becomes the observer)
  const observerPaneId = (await tmux('list-panes', '-t', SESSION, '-F', '#{pane_id}')).split('\n')[0]
  if (!observerPaneId) throw new Error('No pane found after new-session')

  // 4. Replace the shell with `cat` so we have a clean canvas to draw on.
  //    `exec cat` replaces the bash process — no prompt pollution.
  await sendText(observerPaneId, 'exec cat')
  await sendKey(observerPaneId, 'Enter')
  await Bun.sleep(100) // let cat start

  // 5. Split horizontally: the new (right) pane is the worker
  const workerPaneId = (
    await tmuxOrThrow(
      'split-window', '-t', SESSION, '-h',
      '-p', '70',           // right pane gets 70% width
      '-P', '-F', '#{pane_id}',
      workerCommand,        // run the command directly
    )
  ).trim()

  // 6. Resize the observer pane to a fixed width
  await tmux('resize-pane', '-t', observerPaneId, '-x', String(OBSERVER_WIDTH))

  // 7. Focus the worker pane (so the user interacts with it)
  await tmux('select-pane', '-t', workerPaneId)

  console.log(`[two-pane] Session created on socket: ${SOCKET}`)
  console.log(`[two-pane] Attaching... (Ctrl-b d to detach)`)
  console.log()

  // 8. Start the observer polling loop — runs in background while user is
  //    attached. The loop keeps going until the user detaches (we set
  //    `running = false` after attach exits).
  const startTime = Date.now()
  let running = true

  const observerLoop = async () => {
    const state: ObserverState = {
      status: 'STARTING',
      workerPid: '',
      elapsed: 0,
      lastOutput: '',
    }

    while (running) {
      state.elapsed = Date.now() - startTime

      // Check if the worker pane's process is dead
      const isDead = await queryPane(workerPaneId, '#{pane_dead}')

      if (isDead === '1') {
        state.status = 'FINISHED'
      } else if (state.status === 'STARTING') {
        state.status = 'RUNNING'
      }

      // Get the worker's PID
      state.workerPid = await queryPane(workerPaneId, '#{pane_pid}')

      // Capture the last non-empty line from the worker
      const content = await capturePane(workerPaneId)
      const lines = content.split('\n').filter((l) => l.trim().length > 0)
      state.lastOutput = lines.at(-1) ?? ''

      // Draw the observer
      await drawObserver(observerPaneId, state)

      // Keep polling even after FINISHED — don't auto-exit.
      // The user controls when to leave via Ctrl-b d.
      await Bun.sleep(state.status === 'FINISHED' ? 2000 : POLL_INTERVAL_MS)
    }
  }

  const loopPromise = observerLoop()

  // 9. Attach interactively. CRITICAL: use Bun.spawn with stdio: "inherit"
  //    so tmux gets the real terminal (TTY). Bun.$ pipes stdout/stderr to
  //    internal buffers — tmux can't draw its UI to a pipe and exits instantly.
  const proc = Bun.spawn(['tmux', '-L', SOCKET, 'attach-session', '-t', SESSION], {
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  })
  await proc.exited

  // User detached (Ctrl-b d) or session was killed — stop the observer loop
  running = false
  await loopPromise

  console.log(`[two-pane] Detached. Session still alive.`)
  console.log(`[two-pane] Re-attach: tmux -L ${SOCKET} attach -t ${SESSION}`)
  console.log(`[two-pane] Clean up:  tmux -L ${SOCKET} kill-server`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
