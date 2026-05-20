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
