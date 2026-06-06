/**
 * Module-level "current handle" + "current probe" slots for `userAction(...)`
 * and assertions.
 *
 * Cells don't pass an `OrchHandle` / probe through every assertion — the
 * launcher registers the handle here, and the harness materializes a probe
 * lazily off the handle's socket on first read. The slots are private to
 * the DSL barrel; tests MUST NOT poke them directly.
 *
 * If a cell needs to interleave actions against multiple orch handles, it
 * can stash references explicitly and call the low-level harness verbs.
 */

import { createExternalTmuxProbe, type ExternalTmuxProbe } from './external-tmux-probe.ts'
import type { OrchHandle } from './lifecycle-handle.ts'

let currentHandle: OrchHandle | undefined
let currentProbe: ExternalTmuxProbe | undefined

export function setCurrentOrchHandle(handle: OrchHandle): void {
  // New handle ⇒ invalidate the cached probe so the next read materializes
  // one pointed at the new socket. Multiple concurrent launches in a single
  // cell pin the last as current; explicit handling needs the low-level
  // verbs.
  currentHandle = handle
  currentProbe = undefined
}

export function clearCurrentOrchHandle(): void {
  currentHandle = undefined
  currentProbe = undefined
}

export function getCurrentOrchHandle(): OrchHandle {
  if (currentHandle === undefined) {
    throw new Error('no current OrchHandle — call launchOrchWorkflow(...) before userAction(...)')
  }
  return currentHandle
}

export function getCurrentProbe(): ExternalTmuxProbe {
  if (currentHandle === undefined) {
    throw new Error('no current OrchHandle — call launchOrchWorkflow(...) before probing tmux')
  }
  if (currentProbe === undefined) {
    currentProbe = createExternalTmuxProbe(currentHandle)
  }
  return currentProbe
}

/** Test-only override. Used by snapshot-unit tests that bypass real spawn. */
export function setCurrentProbeForTest(probe: ExternalTmuxProbe): void {
  currentProbe = probe
}
