#!/usr/bin/env bun
// ---------------------------------------------------------------------------
// multi-task-demo.ts — Sequential task runner with observer panel in tmux
// ---------------------------------------------------------------------------
//
// Usage:
//   bun examples/multi-task-demo.ts
//
// Runs a queue of tasks sequentially in the right pane:
//   1. Claude Code session (interactive)
//   2. 5-second countdown
//   3. Another Claude Code session
//
// The left pane observes everything: current task, status, countdown between
// tasks, and output from the worker.
//
// When all tasks are done, the observer shows a summary.
// To exit:  Ctrl-b d  (detach from tmux)
// Cleanup:  tmux -L multi-task-demo kill-server
// ---------------------------------------------------------------------------

import { $ } from 'bun'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SESSION = 'multi-task'
const SOCKET = 'multi-task-demo'
const WIDTH = 180
const HEIGHT = 45
const OBSERVER_WIDTH = 38
const POLL_INTERVAL_MS = 500
const COUNTDOWN_SECONDS = 5

// ---------------------------------------------------------------------------
// Task definitions
// ---------------------------------------------------------------------------

interface Task {
  name: string
  command: string
}

const TASKS: Task[] = [
  {
    name: 'Claude Code #1',
    command: 'claude "What is 2 plus 2?"',
  },
  {
    name: 'Countdown Timer',
    command:
      'echo "=== COUNTDOWN ===" && ' +
      'echo "5..." && sleep 1 && ' +
      'echo "4..." && sleep 1 && ' +
      'echo "3..." && sleep 1 && ' +
      'echo "2..." && sleep 1 && ' +
      'echo "1..." && sleep 1 && ' +
      'echo "0 — Done!"',
  },
  {
    name: 'Claude Code #2',
    command: 'claude "Write a haiku about programming"',
  },
]

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

const sendText = async (paneId: string, text: string): Promise<void> => {
  await $`tmux -L ${SOCKET} send-keys -t ${paneId} -l ${text}`.quiet().nothrow()
}

const sendKey = async (paneId: string, key: string): Promise<void> => {
  await $`tmux -L ${SOCKET} send-keys -t ${paneId} ${key}`.quiet().nothrow()
}

const queryPane = async (paneId: string, format: string): Promise<string> => {
  return tmux('display-message', '-p', '-t', paneId, format)
}

const capturePane = async (paneId: string): Promise<string> => {
  return tmux('capture-pane', '-p', '-t', paneId)
}

/** Respawn a dead pane with a new command. */
const respawnPane = async (paneId: string, command: string): Promise<void> => {
  await $`tmux -L ${SOCKET} respawn-pane -t ${paneId} -k ${command}`.quiet()
}

// ---------------------------------------------------------------------------
// Observer drawing
// ---------------------------------------------------------------------------

interface ObserverState {
  status: 'WAITING' | 'RUNNING' | 'COUNTDOWN' | 'FINISHED' | 'ALL_DONE'
  currentTask: string
  taskIndex: number
  totalTasks: number
  workerPid: string
  elapsed: number
  lastOutput: string
  countdownRemaining: number
  completedTasks: string[]
}

const CLEAR_SCREEN = '\u001b[2J\u001b[H'

const drawObserver = async (paneId: string, state: ObserverState): Promise<void> => {
  const statusIcon: Record<ObserverState['status'], string> = {
    WAITING: '..',
    RUNNING: '>>',
    COUNTDOWN: '~~',
    FINISHED: 'OK',
    ALL_DONE: '**',
  }

  const icon = statusIcon[state.status]
  const elapsedStr = `${Math.floor(state.elapsed / 1000)}s`

  const lines: string[] = [
    '====================================',
    '       OBSERVER  PANEL',
    '====================================',
    '',
    ` Status:   [${icon}] ${state.status}`,
    ` Task:     ${state.taskIndex + 1}/${state.totalTasks}`,
    ` Name:     ${state.currentTask}`,
    ` PID:      ${state.workerPid || '-'}`,
    ` Elapsed:  ${elapsedStr}`,
    '',
  ]

  if (state.status === 'COUNTDOWN') {
    lines.push('------------------------------------')
    lines.push(` Next task in ${state.countdownRemaining}s...`)
    lines.push('------------------------------------')
    lines.push('')
  }

  if (state.status === 'RUNNING' || state.status === 'FINISHED') {
    lines.push('--- last output ---')
    lines.push(` ${state.lastOutput.slice(0, 34) || '(none)'}`)
    lines.push('')
  }

  if (state.completedTasks.length > 0) {
    lines.push('--- completed ---')
    for (const t of state.completedTasks) {
      lines.push(` [OK] ${t}`)
    }
    lines.push('')
  }

  if (state.status === 'ALL_DONE') {
    lines.push('====================================')
    lines.push(' All tasks completed!')
    lines.push('')
    lines.push(' Ctrl-b d to detach.')
    lines.push('====================================')
  }

  lines.push('')

  const payload = `${CLEAR_SCREEN}${lines.join('\r\n')}\r\n`
  await sendText(paneId, payload)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // 0. Clean up any leftover session
  await $`tmux -L ${SOCKET} kill-server`.quiet().nothrow()

  // 1. Create a detached tmux session (the left/observer pane)
  await tmuxOrThrow(
    '-f', '/dev/null',
    'new-session', '-d', '-s', SESSION,
    '-x', String(WIDTH), '-y', String(HEIGHT),
  )

  // 2. Keep dead panes visible
  await tmux('set-option', '-t', SESSION, 'remain-on-exit', 'on')

  // 2b. Enable mouse so users can drag pane borders to resize.
  // Hold Option (macOS) or Shift (Linux) for native terminal text selection.
  await tmux('set-option', '-g', 'mouse', 'on')

  // 3. Find the observer pane
  const observerPaneId = (
    await tmux('list-panes', '-t', SESSION, '-F', '#{pane_id}')
  ).split('\n')[0]
  if (!observerPaneId) throw new Error('No pane found after new-session')

  // 4. Replace the shell with `cat` for a clean drawing canvas
  await sendText(observerPaneId, 'exec cat')
  await sendKey(observerPaneId, 'Enter')
  await Bun.sleep(100)

  // 5. Split: right pane is the worker — start with first task
  const firstTask = TASKS[0]
  if (!firstTask) throw new Error('No tasks defined')

  const workerPaneId = (
    await tmuxOrThrow(
      'split-window', '-t', SESSION, '-h',
      '-p', '75',
      '-P', '-F', '#{pane_id}',
      firstTask.command,
    )
  ).trim()

  // 6. Resize observer to fixed width
  await tmux('resize-pane', '-t', observerPaneId, '-x', String(OBSERVER_WIDTH))

  // 7. Focus the worker pane
  await tmux('select-pane', '-t', workerPaneId)

  console.log(`[multi-task] Session created on socket: ${SOCKET}`)
  console.log(`[multi-task] Running ${TASKS.length} tasks sequentially`)
  console.log(`[multi-task] Attaching... (Ctrl-b d to detach)`)
  console.log()

  // 8. Observer loop — manages task lifecycle
  const startTime = Date.now()
  let running = true

  const observerLoop = async () => {
    const state: ObserverState = {
      status: 'RUNNING',
      currentTask: firstTask.name,
      taskIndex: 0,
      totalTasks: TASKS.length,
      workerPid: '',
      elapsed: 0,
      lastOutput: '',
      countdownRemaining: 0,
      completedTasks: [],
    }

    let taskIdx = 0

    while (running) {
      state.elapsed = Date.now() - startTime

      // Check if the worker pane's process has exited
      const isDead = await queryPane(workerPaneId, '#{pane_dead}')

      if (isDead === '1' && state.status === 'RUNNING') {
        // Task just finished
        state.status = 'FINISHED'
        state.workerPid = await queryPane(workerPaneId, '#{pane_pid}')

        // Capture final output
        const content = await capturePane(workerPaneId)
        const contentLines = content.split('\n').filter((l) => l.trim().length > 0)
        state.lastOutput = contentLines.at(-1) ?? ''

        await drawObserver(observerPaneId, state)

        // Mark as completed
        const currentTask = TASKS[taskIdx]
        if (currentTask) {
          state.completedTasks.push(currentTask.name)
        }

        // Move to next task or finish
        taskIdx++
        if (taskIdx >= TASKS.length) {
          state.status = 'ALL_DONE'
          state.currentTask = '(none)'
          await drawObserver(observerPaneId, state)
          // Keep polling so the display stays alive
          while (running) {
            state.elapsed = Date.now() - startTime
            await drawObserver(observerPaneId, state)
            await Bun.sleep(2000)
          }
          return
        }

        // Countdown before next task
        state.status = 'COUNTDOWN'
        const nextTask = TASKS[taskIdx]
        if (!nextTask) return
        state.currentTask = nextTask.name
        state.taskIndex = taskIdx

        for (let i = COUNTDOWN_SECONDS; i > 0; i--) {
          if (!running) return
          state.countdownRemaining = i
          state.elapsed = Date.now() - startTime
          await drawObserver(observerPaneId, state)
          await Bun.sleep(1000)
        }

        // Launch next task via respawn-pane
        state.status = 'RUNNING'
        state.lastOutput = ''
        state.countdownRemaining = 0
        await drawObserver(observerPaneId, state)

        await respawnPane(workerPaneId, nextTask.command)
        await Bun.sleep(200) // let the process start
      }

      // Normal polling: update PID + last output
      if (state.status === 'RUNNING') {
        state.workerPid = await queryPane(workerPaneId, '#{pane_pid}')

        const content = await capturePane(workerPaneId)
        const contentLines = content.split('\n').filter((l) => l.trim().length > 0)
        state.lastOutput = contentLines.at(-1) ?? ''
      }

      await drawObserver(observerPaneId, state)
      await Bun.sleep(POLL_INTERVAL_MS)
    }
  }

  const loopPromise = observerLoop()

  // 9. Attach interactively
  const proc = Bun.spawn(
    ['tmux', '-L', SOCKET, 'attach-session', '-t', SESSION],
    { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' },
  )
  await proc.exited

  // User detached — stop the observer
  running = false
  await loopPromise

  console.log(`[multi-task] Detached. Session still alive.`)
  console.log(`[multi-task] Re-attach: tmux -L ${SOCKET} attach -t ${SESSION}`)
  console.log(`[multi-task] Clean up:  tmux -L ${SOCKET} kill-server`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
