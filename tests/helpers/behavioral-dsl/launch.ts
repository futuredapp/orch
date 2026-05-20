/**
 * Public DSL launcher. The only entry point tests use to boot orch as a
 * subprocess. The signature is final; implementation flows through
 * `internal/subprocess.ts`.
 */

import * as nodePath from 'node:path'
import { setCurrentOrchHandle } from './internal/current-handle.ts'
import type { OrchHandle } from './internal/lifecycle-handle.ts'
import { type SpawnOrchOptions, spawnOrch } from './internal/subprocess.ts'

/**
 * Boot orch under test, parse runId, derive socket, drive to `bringToState`.
 *
 * The returned `OrchHandle` is also registered as the implicit "current"
 * handle for `userAction(...)` so cells don't have to thread it through
 * every call. Multiple concurrent launches in one cell pin the last
 * launched handle as current — tests that need explicit handling can call
 * the lower-level harness functions directly.
 */
export const launchOrchWorkflow = async (
  fixtureName: string,
  opts: Omit<SpawnOrchOptions, 'workflowFixture'> = {},
): Promise<OrchHandle> => {
  const handle = await spawnOrch({ workflowFixture: fixtureName, ...opts })
  setCurrentOrchHandle(handle)
  return handle
}

/**
 * Returns a `StepScript` of shape `{ kind: 'wait-for-file', gatePath: ... }`.
 *
 * The gate file path is derived once per call; pair with `release(stepName)`
 * which writes the matching path. The pairing IS the cross-process control
 * channel — the launcher serializes this script entry into
 * `<stateBase>/script.json`, and the scripted-fake `__entry.ts` polls the
 * path. Plan §Key Technical Decisions.
 */
export interface HoldUntilReleasedScript {
  readonly kind: 'wait-for-file'
  /** Absolute path under the per-test stateBase. */
  readonly gatePath: string
}

let gateCounter = 0

export const holdUntilReleased = (): HoldUntilReleasedScript => {
  // The gate path is generated relative to the OS tmp dir so it is valid
  // before the launcher's stateBase exists. The path is unique per call —
  // even if a cell holds multiple steps, each gets its own gate.
  const ts = Date.now()
  const n = ++gateCounter
  const gatePath = nodePath.join(
    process.env.TMPDIR ?? '/tmp',
    `orch-tier5-gate-${ts}-${n}-${Math.random().toString(36).slice(2, 8)}`,
  )
  return { kind: 'wait-for-file', gatePath }
}

/**
 * Returns a `StepScript` of shape `{ kind: 'emit-then-hang', events: [...] }`.
 *
 * The runner emits the supplied text as a single `info`/`thinking` event
 * (rendered as an `assistant>` transcript line in the right pane), then
 * blocks forever — the parent process kills it at teardown. There is no
 * release hook; use `holdUntilReleased()` if the cell needs to advance the
 * step under test instead of just observing its mid-flight state.
 *
 * Intended for cells that need a visibly-active step (real text in the
 * right pane) before exercising a user gesture against the host — the §2.1
 * acceptance cell is the motivating use case.
 */
export interface EmitThenHangScript {
  readonly kind: 'emit-then-hang'
  readonly events: readonly {
    readonly kind: 'info'
    readonly type: string
    readonly payload: { readonly text: string }
  }[]
}

export const emitThenHang = (text: string): EmitThenHangScript => {
  if (text.length === 0) {
    throw new Error('emitThenHang(text): text cannot be empty — the point is to be observable')
  }
  return {
    kind: 'emit-then-hang',
    events: [{ kind: 'info', type: 'thinking', payload: { text } }],
  }
}
