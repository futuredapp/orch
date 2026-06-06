/**
 * Per-test "current handle" + "current probe" slots for `userAction(...)`
 * and assertions.
 *
 * Dual-track isolation:
 *
 * - ALS path (scenario-based lifecycle tests via `app.wrapBody`): each test
 *   runs inside `als.run(slot, fn)` via `runWithHandleSlot`. Reads/writes go
 *   through the slot, so concurrent tests in the same file never clobber each
 *   other. This lifts the `--max-concurrency=1` constraint for scenario-based
 *   tests.
 *
 * - Module-global fallback (raw `it()` tests, side-effects, lifecycle-driver
 *   test direct calls): Bun runs each test FILE in its own worker thread with
 *   an isolated module registry, so the module-level variables are per-file-
 *   safe. Tests that never call `runWithHandleSlot` use this path unchanged.
 *
 * `setCurrentOrchHandle` writes to both. `getCurrentOrchHandle` reads the ALS
 * slot first (for intra-file concurrent isolation), then falls back to the
 * module global.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { createExternalTmuxProbe, type ExternalTmuxProbe } from './external-tmux-probe.ts'
import type { OrchHandle } from './lifecycle-handle.ts'

export interface HandleSlot {
  handle: OrchHandle | undefined
  probe: ExternalTmuxProbe | undefined
}

const als = new AsyncLocalStorage<HandleSlot>()

// Module-level fallback — safe because Bun runs each test file in its own
// worker thread (isolated module registry). Only one test runs at a time
// within a file, so there is no intra-file concurrency concern.
let moduleHandle: OrchHandle | undefined
let moduleProbe: ExternalTmuxProbe | undefined

/** Create a fresh slot to pass to `runWithHandleSlot`. */
export function createHandleSlot(): HandleSlot {
  return { handle: undefined, probe: undefined }
}

/**
 * Run `fn` inside an ALS context scoped to `slot`. All behavioral-dsl calls
 * within `fn` (including across `await` boundaries) read and write to `slot`,
 * not the module global. Used by the lifecycle driver so concurrent scenario
 * tests in the same file are isolated.
 */
export function runWithHandleSlot<T>(slot: HandleSlot, fn: () => T): T {
  return als.run(slot, fn)
}

export function setCurrentOrchHandle(handle: OrchHandle): void {
  // ALS path: update the slot so in-flight concurrent tests stay isolated.
  const slot = als.getStore()
  if (slot !== undefined) {
    slot.handle = handle
    slot.probe = undefined
  }
  // Module-global path: keep the fallback current so raw it() tests that are
  // not inside runWithHandleSlot also see the new handle.
  moduleHandle = handle
  moduleProbe = undefined
}

export function clearCurrentOrchHandle(): void {
  const slot = als.getStore()
  if (slot !== undefined) {
    slot.handle = undefined
    slot.probe = undefined
  }
  moduleHandle = undefined
  moduleProbe = undefined
}

export function getCurrentOrchHandle(): OrchHandle {
  // ALS slot takes precedence — present only inside runWithHandleSlot().
  const slot = als.getStore()
  if (slot?.handle !== undefined) return slot.handle
  // Fallback for raw it() tests (side-effects, lifecycle-driver test direct
  // calls). Safe because Bun workers isolate module state per file.
  if (moduleHandle !== undefined) return moduleHandle
  throw new Error('no current OrchHandle — call launchOrchWorkflow(...) before userAction(...)')
}

export function getCurrentProbe(): ExternalTmuxProbe {
  const slot = als.getStore()
  if (slot !== undefined && slot.handle !== undefined) {
    if (slot.probe === undefined) {
      slot.probe = createExternalTmuxProbe(slot.handle)
    }
    return slot.probe
  }
  if (moduleHandle === undefined) {
    throw new Error('no current OrchHandle — call launchOrchWorkflow(...) before probing tmux')
  }
  if (moduleProbe === undefined) {
    moduleProbe = createExternalTmuxProbe(moduleHandle)
  }
  return moduleProbe
}
