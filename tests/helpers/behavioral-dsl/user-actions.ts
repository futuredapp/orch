/**
 * Public DSL user actions. Each constructor returns a `UserAction` token;
 * `userAction(token)` executes it against the implicit "current"
 * `OrchHandle` (the one returned by the most recent `launchOrchWorkflow`).
 *
 * U4 implements `release` (the gate-file companion to `holdUntilReleased`),
 * `wait` (a bounded sleep that is visible in the cell's narrative), and the
 * `userAction(...)` runner itself. Other constructors keep their U1 stubs
 * until the units that own them land (U7 — `signalOrch`; U8 — `clickOnPane`,
 * `pressKeyInPane`, `typeInAttachTty`; U10 — `closeStdin`).
 */

import { writeFile } from 'node:fs/promises'
import { getCurrentOrchHandle, getCurrentProbe } from './internal/current-handle.ts'
import type { ExternalTmuxProbe } from './internal/external-tmux-probe.ts'
import type { OrchHandle } from './internal/lifecycle-handle.ts'

/**
 * A user action is a closure that performs one gesture against the orch
 * subprocess and/or external tmux probe. Closures are required (not data
 * objects) so the gesture can compose multiple subprocess calls (e.g.
 * `clickOnPane` resolves pane geometry, then dispatches press + release).
 */
export type UserAction = (handle: OrchHandle, probe: ExternalTmuxProbe) => Promise<void>

/**
 * Executes a `UserAction` against the implicit current `OrchHandle`.
 *
 * The probe argument is supplied as `undefined as unknown as ExternalTmuxProbe`
 * because the probe-bearing actions (`clickOnPane`, `pressKeyInPane`,
 * `sendMouseEvent`) land in U5/U8. Once U5 ships, this helper composes a
 * probe from the handle's socket.
 */
export const userAction = async (action: UserAction): Promise<void> => {
  const handle = getCurrentOrchHandle()
  const probe = getCurrentProbe()
  await action(handle, probe)
}

// ─── Action constructors ───────────────────────────────────────────────────

export const signalOrch = (signal: 'SIGINT' | 'SIGTERM' | 'SIGHUP'): UserAction => {
  return async (handle: OrchHandle): Promise<void> => {
    // Direct kill via the subprocess handle — orch's signal handler at
    // `src/cli/commands/execute-with-attach.ts:64-78` is wired for SIGINT,
    // SIGTERM, and SIGHUP. Already-exited orch is tolerated; the next
    // assertion captures the exit state regardless.
    try {
      handle.subprocess.kill(signal)
    } catch {
      /* already exited */
    }
  }
}

export const clickOnPane = (pane: 'left' | 'right'): UserAction => {
  return async (_handle: OrchHandle, probe: ExternalTmuxProbe): Promise<void> => {
    await probe.sendMouseEvent({ pane, button: 'left' })
  }
}

export const pressKeyInPane = (pane: 'left' | 'right', key: string): UserAction => {
  if (key.length === 0) {
    throw new Error('pressKeyInPane: key cannot be empty')
  }
  return async (_handle: OrchHandle, probe: ExternalTmuxProbe): Promise<void> => {
    await probe.pressKeyInPane({ pane, key })
  }
}

export const typeIntoOrchStdin = (bytes: string | Uint8Array): UserAction => {
  return async (handle: OrchHandle): Promise<void> => {
    const writeStdin = handle.subprocess.writeStdin
    if (writeStdin === undefined) {
      throw new Error(
        'typeIntoOrchStdin: orch was spawned without rawStreams — no stdin writer available',
      )
    }
    writeStdin(bytes)
  }
}

/**
 * Bounded explicit sleep. Every wait is visible in the cell's narrative
 * (origin §5 — no implicit sleeps). Use only when there is genuinely no
 * polling-friendly observable; prefer `assertWorkflowState`/`assertLeftPane`
 * with `withinMs(...)` whenever an observable signal exists.
 */
export const wait = (ms: number): UserAction => {
  if (!Number.isFinite(ms) || ms < 0) {
    throw new Error(`wait(${ms}): expected a non-negative finite millisecond count`)
  }
  return async (): Promise<void> => {
    await new Promise((res) => setTimeout(res, ms))
  }
}

/**
 * Companion to `holdUntilReleased()`: writes the gate file that the
 * scripted-fake `__entry.ts` is polling for, unblocking the held step.
 *
 * The gate path is recovered from the script JSON the launcher serialized
 * to disk (the file path lives in `OrchHandle.env.ORCH_LIFECYCLE_SCRIPT`).
 */
export const release = (stepName: string): UserAction => {
  if (stepName.length === 0) {
    throw new Error('release(): stepName cannot be empty')
  }
  return async (handle: OrchHandle): Promise<void> => {
    const scriptPath = handle.env.ORCH_LIFECYCLE_SCRIPT
    if (scriptPath === undefined) {
      throw new Error(
        'release(): handle.env.ORCH_LIFECYCLE_SCRIPT is unset — release ' +
          'requires a script-driven cell',
      )
    }
    const raw = await Bun.file(scriptPath).text()
    const parsed = JSON.parse(raw) as {
      readonly steps?: Readonly<
        Record<string, { readonly kind?: string; readonly gatePath?: string }>
      >
    }
    const entry = parsed.steps?.[stepName]
    if (entry === undefined) {
      throw new Error(`release("${stepName}"): no script entry for that step`)
    }
    if (entry.kind !== 'wait-for-file' || typeof entry.gatePath !== 'string') {
      throw new Error(
        `release("${stepName}"): step is scripted as "${entry.kind ?? '(unknown)'}", ` +
          'not "wait-for-file" — nothing to release',
      )
    }
    await writeFile(entry.gatePath, '', 'utf-8')
  }
}

/**
 * Closes the orch subprocess's stdin (delivers stdin-EOF, NOT SIGHUP).
 * A piped-stdin child does NOT have a controlling TTY, so this exercises
 * the stdin-EOF path — distinct from `signalOrch('SIGHUP')`, which fires
 * the SIGHUP handler at `src/cli/commands/execute-with-attach.ts:64-78`.
 *
 * Idempotent — calling on an already-closed (or already-exited) stdin is
 * a no-op. The `close-stdin` §6.5 contract row is intentionally weaker
 * than the signal rows: orch may continue running (no handler for
 * stdin-EOF in the v1 CLI), so the matcher set documents observed
 * behavior rather than asserting full teardown.
 */
export const closeOrchStdin = (): UserAction => {
  return async (handle: OrchHandle): Promise<void> => {
    const close = handle.subprocess.closeStdin
    if (close === undefined) {
      throw new Error(
        'closeOrchStdin: orch was spawned without rawStreams — no stdin closer available',
      )
    }
    close()
  }
}

// ---------------------------------------------------------------------------
// Navigation sugar — composite gestures over `pressKeyInPane`. Each is
// intentionally a single observable change in the cell narrative.
// ---------------------------------------------------------------------------

const KEY_INTERVAL_MS = 60

export const snapToLive = (): UserAction => {
  return async (_handle, probe) => probe.pressKeyInPane({ pane: 'left', key: 'f' })
}

export const openHelp = (): UserAction => {
  return async (_handle, probe) => probe.pressKeyInPane({ pane: 'left', key: '?' })
}

export const closeHelp = (): UserAction => {
  return async (_handle, probe) => probe.pressKeyInPane({ pane: 'left', key: 'Escape' })
}

export const pressEnterOnSelected = (): UserAction => {
  return async (_handle, probe) => probe.pressKeyInPane({ pane: 'left', key: 'Enter' })
}

export const scrollRightPane = (direction: 'up' | 'down', amount = 1): UserAction => {
  const key = direction === 'up' ? 'PageUp' : 'PageDown'
  return async (_handle, probe) => {
    for (let i = 0; i < amount; i += 1) {
      await probe.pressKeyInPane({ pane: 'right', key })
      if (i + 1 < amount) await new Promise((r) => setTimeout(r, KEY_INTERVAL_MS))
    }
  }
}

/**
 * Press ↑ or ↓ until the left pane's selection lands on `stepName`. Reads the
 * left pane capture between keystrokes to detect highlight position. Bounded
 * by `maxAttempts` to avoid runaway loops when the row is not present.
 */
export const selectStep = (stepName: string, maxAttempts = 20): UserAction => {
  return async (_handle, probe) => {
    for (let i = 0; i < maxAttempts; i += 1) {
      const text = await probe.capturePaneText('left')
      const lineIdx = findStepLineIndex(text, stepName)
      if (lineIdx === undefined) {
        // step not visible yet — wait a tick and retry
        await new Promise((r) => setTimeout(r, KEY_INTERVAL_MS))
        continue
      }
      const selectedIdx = findSelectedLineIndex(text)
      if (selectedIdx === lineIdx) return
      const direction = selectedIdx === undefined || lineIdx > selectedIdx ? 'Down' : 'Up'
      await probe.pressKeyInPane({ pane: 'left', key: direction })
      await new Promise((r) => setTimeout(r, KEY_INTERVAL_MS))
    }
    throw new Error(
      `selectStep("${stepName}"): could not land selection within ${maxAttempts} attempts`,
    )
  }
}

export const viewStep = (stepName: string): UserAction => {
  // Composite: select the named step, then press Enter.
  const select = selectStep(stepName)
  const enter = pressEnterOnSelected()
  return async (handle, probe) => {
    await select(handle, probe)
    await enter(handle, probe)
  }
}

function findStepLineIndex(paneText: string, stepName: string): number | undefined {
  const escaped = stepName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`(^|\\s)${escaped}(\\s|$)`)
  const lines = paneText.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    if (re.test(line)) return i
  }
  return undefined
}

function findSelectedLineIndex(paneText: string): number | undefined {
  // The Ink steps view renders selection as `▌` on the row, but only when
  // `isUserDriven` is true. On initial render no cursor is visible — we kick
  // selection into user-driven mode by pressing Down then Up before testing.
  const HIGHLIGHT_MARKERS = ['▌']
  const lines = paneText.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    if (HIGHLIGHT_MARKERS.some((m) => line.includes(m))) return i
  }
  return undefined
}
