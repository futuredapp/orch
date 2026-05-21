/**
 * Async polling helpers. These are not `UserAction`s — they read state and
 * resolve when a condition is met (or throw on timeout). Use to bridge the
 * gap between "the test sent a command" and "the visible/persisted state
 * reflects the command's effect", so subsequent assertions don't race.
 */

import * as nodePath from 'node:path'
import { getCurrentOrchHandle, getCurrentProbe } from './internal/current-handle.ts'
import type { OrchHandle } from './internal/lifecycle-handle.ts'
import type { StateStatus, StepStatus } from './internal/snapshot.ts'

const DEFAULT_POLL_INTERVAL_MS = 50
const DEFAULT_AWAIT_TIMEOUT_MS = 10_000

export interface AwaitOptions {
  readonly timeoutMs?: number
  readonly pollIntervalMs?: number
}

/**
 * Polls the implicit current handle's `state.json` until the named step
 * reaches `targetStatus` (interpreted via `LifecycleSnapshot`'s `stepStatuses`
 * mapping — `completed` when the entry has `value`, `unknown` otherwise).
 */
export const awaitStepStatus = async (
  stepName: string,
  targetStatus: StepStatus,
  opts: AwaitOptions = {},
): Promise<void> => {
  const handle = getCurrentOrchHandle()
  const deadline = Date.now() + (opts.timeoutMs ?? DEFAULT_AWAIT_TIMEOUT_MS)
  const interval = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  for (;;) {
    const status = await readStepStatus(handle, stepName)
    if (status === targetStatus) return
    if (Date.now() >= deadline) {
      throw new Error(
        `awaitStepStatus("${stepName}", "${targetStatus}"): last observed status=${status ?? '(none)'} after ${opts.timeoutMs ?? DEFAULT_AWAIT_TIMEOUT_MS}ms`,
      )
    }
    await new Promise((r) => setTimeout(r, interval))
  }
}

export const awaitRunStatus = async (
  targetStatus: StateStatus,
  opts: AwaitOptions = {},
): Promise<void> => {
  const handle = getCurrentOrchHandle()
  const deadline = Date.now() + (opts.timeoutMs ?? DEFAULT_AWAIT_TIMEOUT_MS)
  const interval = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  for (;;) {
    const status = await readRunStatus(handle)
    if (status === targetStatus) return
    if (Date.now() >= deadline) {
      throw new Error(
        `awaitRunStatus("${targetStatus}"): last observed status=${status ?? '(none)'} after ${opts.timeoutMs ?? DEFAULT_AWAIT_TIMEOUT_MS}ms`,
      )
    }
    await new Promise((r) => setTimeout(r, interval))
  }
}

/**
 * Polls the named pane's capture until a step row matching `stepName` is
 * visible. Bridges launch races where the Ink projection takes a few hundred
 * milliseconds after the runId is parsed.
 */
export const awaitVisibleStep = async (
  pane: 'left' | 'right',
  stepName: string,
  opts: AwaitOptions = {},
): Promise<void> => {
  const probe = getCurrentProbe()
  const deadline = Date.now() + (opts.timeoutMs ?? DEFAULT_AWAIT_TIMEOUT_MS)
  const interval = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const escaped = stepName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`(^|\\s)${escaped}(\\s|$)`)
  for (;;) {
    try {
      const text = await probe.capturePaneText(pane)
      if (re.test(text)) return
    } catch {
      /* pane may not be ready yet */
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `awaitVisibleStep("${pane}", "${stepName}"): row not visible after ${opts.timeoutMs ?? DEFAULT_AWAIT_TIMEOUT_MS}ms`,
      )
    }
    await new Promise((r) => setTimeout(r, interval))
  }
}

async function readStepStatus(
  handle: OrchHandle,
  stepName: string,
): Promise<StepStatus | undefined> {
  const stateFile = nodePath.join(handle.stateDir, 'state.json')
  try {
    // state.json wins: if the step has been successfully recorded
    // (`endedAt` set), it is `completed` — even when a prior `step:failed`
    // line in `lifecycle.ndjson` exists from a crashed run before resume.
    const raw = await Bun.file(stateFile).text()
    let entry: { endedAt?: number; value?: unknown } | undefined
    if (raw.length > 0) {
      const parsed = JSON.parse(raw) as {
        steps?: Record<string, { endedAt?: number; value?: unknown }>
      }
      entry = parsed.steps?.[stepName]
    }
    if (entry !== undefined && entry.endedAt !== undefined) return 'completed'

    // No successful entry. If lifecycle.ndjson recorded a failure for this
    // step (and state did not subsequently overwrite it), report failed.
    if (await isStepFailed(handle, stepName)) return 'failed'
    return entry === undefined ? 'unknown' : 'unknown'
  } catch {
    return undefined
  }
}

async function isStepFailed(handle: OrchHandle, stepName: string): Promise<boolean> {
  const lifecycleFile = nodePath.join(handle.stateDir, 'logs', 'lifecycle.ndjson')
  try {
    const raw = await Bun.file(lifecycleFile).text()
    if (raw.length === 0) return false
    for (const line of raw.split('\n')) {
      if (line.length === 0) continue
      try {
        const parsed = JSON.parse(line) as { type?: string; stepName?: string }
        if (parsed.type === 'step:failed' && parsed.stepName === stepName) return true
      } catch {
        /* tolerate trailing partial */
      }
    }
    return false
  } catch {
    return false
  }
}

async function readRunStatus(handle: OrchHandle): Promise<StateStatus | undefined> {
  const stateFile = nodePath.join(handle.stateDir, 'state.json')
  try {
    const raw = await Bun.file(stateFile).text()
    if (raw.length === 0) return undefined
    const parsed = JSON.parse(raw) as { status?: string }
    if (
      parsed.status === 'running' ||
      parsed.status === 'completed' ||
      parsed.status === 'crashed' ||
      parsed.status === 'cancelled' ||
      parsed.status === 'failed'
    ) {
      return parsed.status
    }
    return 'unknown'
  } catch {
    return undefined
  }
}
