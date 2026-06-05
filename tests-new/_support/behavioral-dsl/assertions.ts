/**
 * Assertions — the top-level DSL verbs cells call against the implicit
 * "current" `OrchHandle`. Each assertion takes a list of matchers (and
 * optionally a `PollingBudget` from `withinMs(...)`) and either:
 *   - succeeds the first time every matcher passes, OR
 *   - throws with the failing snapshot inlined for diagnostic purposes.
 *
 * Polling cadence is bounded by the budget; without one, a single capture
 * is taken and asserted against (the snapshot doubles as the diagnostic on
 * failure).
 */

import type { FilesystemMatcher } from './filesystem-matchers.ts'
import { getCurrentOrchHandle, getCurrentProbe } from './internal/current-handle.ts'
import {
  type InvariantViolation,
  runInvariantContract,
  type ScenarioTag,
} from './internal/invariants.ts'
import {
  type LifecycleSnapshot,
  type Matcher,
  type PaneMatcherFactory,
  type PollingBudget,
  snapshot,
} from './internal/snapshot.ts'

export type AssertionArg = Matcher | PollingBudget
export type PaneAssertionArg = PaneMatcherFactory | PollingBudget

const DEFAULT_POLL_INTERVAL_MS = 75

interface SplitArgs {
  readonly matchers: readonly Matcher[]
  readonly budget: PollingBudget | undefined
}

function splitArgs(args: readonly AssertionArg[]): SplitArgs {
  const matchers: Matcher[] = []
  let budget: PollingBudget | undefined
  for (const a of args) {
    if (typeof a === 'function') matchers.push(a)
    else if (a !== undefined && typeof a === 'object' && 'timeoutMs' in a) budget = a
  }
  return { matchers, budget }
}

function splitPaneArgs(args: readonly PaneAssertionArg[]): {
  readonly factories: readonly PaneMatcherFactory[]
  readonly budget: PollingBudget | undefined
} {
  const factories: PaneMatcherFactory[] = []
  let budget: PollingBudget | undefined
  for (const a of args) {
    if (typeof a === 'function') factories.push(a)
    else if (a !== undefined && typeof a === 'object' && 'timeoutMs' in a) budget = a
  }
  return { factories, budget }
}

async function pollUntil(
  matchers: readonly Matcher[],
  budget: PollingBudget | undefined,
  label: string,
): Promise<void> {
  const handle = getCurrentOrchHandle()
  const probe = getCurrentProbe()
  const deadline = budget !== undefined ? Date.now() + budget.timeoutMs : 0
  let lastSnapshot: LifecycleSnapshot | undefined
  let lastFails: readonly { matcher: string; message: string }[] = []
  for (;;) {
    const snap = await snapshot(handle, probe)
    lastSnapshot = snap
    const fails: { matcher: string; message: string }[] = []
    for (const m of matchers) {
      const r = m(snap)
      if (!r.matched) fails.push({ matcher: extractMatcherName(r.message), message: r.message })
    }
    if (fails.length === 0) return
    lastFails = fails
    if (budget === undefined || Date.now() >= deadline) break
    await new Promise((r) => setTimeout(r, DEFAULT_POLL_INTERVAL_MS))
  }
  throw new AssertionFailure(label, lastFails, lastSnapshot)
}

function extractMatcherName(message: string): string {
  const idx = message.indexOf(':')
  return idx === -1 ? message : message.slice(0, idx).trim()
}

export const assertOrchExits = async (...args: readonly AssertionArg[]): Promise<void> => {
  const { matchers, budget } = splitArgs(args)
  await pollUntil(matchers, budget, 'assertOrchExits')
}

export const assertTmuxSession = async (...args: readonly AssertionArg[]): Promise<void> => {
  const { matchers, budget } = splitArgs(args)
  await pollUntil(matchers, budget, 'assertTmuxSession')
}

export const assertTerminalEscapeStream = async (
  ...args: readonly AssertionArg[]
): Promise<void> => {
  const { matchers, budget } = splitArgs(args)
  await pollUntil(matchers, budget, 'assertTerminalEscapeStream')
}

export const assertPersistedState = async (...args: readonly AssertionArg[]): Promise<void> => {
  const { matchers, budget } = splitArgs(args)
  await pollUntil(matchers, budget, 'assertPersistedState')
}

export const assertLeftPane = async (...args: readonly PaneAssertionArg[]): Promise<void> => {
  const { factories, budget } = splitPaneArgs(args)
  const matchers = factories.map((f) => f('left'))
  await pollUntil(matchers, budget, 'assertLeftPane')
}

export const assertRightPane = async (...args: readonly PaneAssertionArg[]): Promise<void> => {
  const { factories, budget } = splitPaneArgs(args)
  const matchers = factories.map((f) => f('right'))
  await pollUntil(matchers, budget, 'assertRightPane')
}

export type FilesystemAssertionArg = FilesystemMatcher | PollingBudget

function splitFsArgs(args: readonly FilesystemAssertionArg[]): {
  readonly matchers: readonly FilesystemMatcher[]
  readonly budget: PollingBudget | undefined
} {
  const matchers: FilesystemMatcher[] = []
  let budget: PollingBudget | undefined
  for (const a of args) {
    if (typeof a === 'function') matchers.push(a)
    else if (a !== undefined && typeof a === 'object' && 'timeoutMs' in a) budget = a
  }
  return { matchers, budget }
}

async function pollFs(
  matchers: readonly FilesystemMatcher[],
  budget: PollingBudget | undefined,
  label: string,
): Promise<void> {
  const handle = getCurrentOrchHandle()
  const deadline = budget !== undefined ? Date.now() + budget.timeoutMs : 0
  let lastFails: readonly { matcher: string; message: string }[] = []
  for (;;) {
    const fails: { matcher: string; message: string }[] = []
    for (const m of matchers) {
      const r = await m(handle)
      if (!r.matched) fails.push({ matcher: extractMatcherName(r.message), message: r.message })
    }
    if (fails.length === 0) return
    lastFails = fails
    if (budget === undefined || Date.now() >= deadline) break
    await new Promise((r) => setTimeout(r, DEFAULT_POLL_INTERVAL_MS))
  }
  throw new AssertionFailure(label, lastFails, undefined)
}

export const assertFilesystem = async (
  ...args: readonly FilesystemAssertionArg[]
): Promise<void> => {
  const { matchers, budget } = splitFsArgs(args)
  await pollFs(matchers, budget, 'assertFilesystem')
}

export const assertGit = async (...args: readonly FilesystemAssertionArg[]): Promise<void> => {
  // `assertGit` is an alias of `assertFilesystem` — they share the matcher
  // type (`FilesystemMatcher`). The two verbs exist so cells can read more
  // naturally; the engine is the same.
  const { matchers, budget } = splitFsArgs(args)
  await pollFs(matchers, budget, 'assertGit')
}

/**
 * Polls until the snapshot satisfies every matcher in the scenario's
 * contract row (see `internal/invariants.ts`). Throws
 * `InvariantAssertionFailure` if the budget expires with violations
 * outstanding. Use when a cell wants to assert "the appliance reached its
 * contracted final state" without itemising matchers.
 */
export const assertContractedOutcome = async (
  scenario: ScenarioTag,
  ...args: readonly AssertionArg[]
): Promise<void> => {
  const { budget } = splitArgs(args)
  const handle = getCurrentOrchHandle()
  const probe = getCurrentProbe()
  const deadline = budget !== undefined ? Date.now() + budget.timeoutMs : 0
  let lastSnap: LifecycleSnapshot | undefined
  let lastViolations: readonly InvariantViolation[] = []
  for (;;) {
    const snap = await snapshot(handle, probe)
    lastSnap = snap
    const violations = runInvariantContract(snap, scenario)
    if (violations.length === 0) return
    lastViolations = violations
    if (budget === undefined || Date.now() >= deadline) break
    await new Promise((r) => setTimeout(r, DEFAULT_POLL_INTERVAL_MS))
  }
  throw new InvariantAssertionFailure(scenario, lastViolations, lastSnap)
}

/**
 * Inverted assertion: PASSES when the snapshot violates the named contract
 * row AND continues to violate it throughout the polling budget. FAILS the
 * moment any snapshot's violation list becomes empty (i.e., orch was fixed
 * — the cell must be DELETED, not edited to invert the assertion). Plan
 * Risk R-D's programmatic defense.
 *
 * Without a polling budget, a single snapshot is taken and asserted —
 * violations must be present right then.
 *
 * With a polling budget, the assertion polls the snapshot stream until the
 * budget elapses. If any intermediate snapshot has an empty violation list,
 * the assertion throws immediately (orch reached the contracted clean
 * state, which means the bug is gone). If every snapshot through the full
 * budget has non-empty violations, the assertion returns success — the bug
 * is still present.
 */
export const assertContractViolatedThroughout = async (
  scenario: ScenarioTag,
  ...args: readonly AssertionArg[]
): Promise<void> => {
  const { budget } = splitArgs(args)
  const handle = getCurrentOrchHandle()
  const probe = getCurrentProbe()
  const deadline = budget !== undefined ? Date.now() + budget.timeoutMs : 0
  let lastSnap: LifecycleSnapshot | undefined
  let lastViolations: readonly InvariantViolation[] = []
  for (;;) {
    const snap = await snapshot(handle, probe)
    const violations = runInvariantContract(snap, scenario)
    if (violations.length === 0) {
      throw new Error(
        `assertContractViolatedThroughout("${scenario}"): violation list is empty — ` +
          'orch reached the contracted clean state; the bug appears fixed. ' +
          'DELETE this cell, do not invert the assertion. ' +
          `Snapshot: ${formatSnapshot(snap)}`,
      )
    }
    lastSnap = snap
    lastViolations = violations
    if (budget === undefined || Date.now() >= deadline) {
      await maybePersistViolationSnapshot(scenario, lastSnap, lastViolations)
      return
    }
    await new Promise((r) => setTimeout(r, DEFAULT_POLL_INTERVAL_MS))
  }
}

/**
 * When `LIFECYCLE_SNAPSHOT_DIR` is set, persist the captured violation
 * snapshot to `<dir>/<scenario>.last.json` as the durable bug-evidence
 * artifact (plan U11 — committed under `tests/integration/lifecycle/
 * __snapshots__/`). Refreshing the snapshots is an explicit opt-in run;
 * default invocations are pure (no on-disk side effects).
 */
async function maybePersistViolationSnapshot(
  scenario: ScenarioTag,
  snap: LifecycleSnapshot,
  violations: readonly InvariantViolation[],
): Promise<void> {
  const dir = process.env.LIFECYCLE_SNAPSHOT_DIR
  if (dir === undefined || dir.length === 0) return
  const fs = await import('node:fs/promises')
  const nodePath = await import('node:path')
  await fs.mkdir(dir, { recursive: true })
  const file = nodePath.join(dir, `${scenario}.last.json`)
  const body = {
    scenario,
    capturedAt: new Date().toISOString(),
    violations: violations.map((v) => ({ matcher: v.matcher, detail: v.detail })),
    snapshot: snap,
  }
  await fs.writeFile(file, `${JSON.stringify(body, null, 2)}\n`, 'utf-8')
}

export class AssertionFailure extends Error {
  readonly fails: readonly { matcher: string; message: string }[]
  readonly snapshotAtFailure: LifecycleSnapshot | undefined
  constructor(
    label: string,
    fails: readonly { matcher: string; message: string }[],
    snap: LifecycleSnapshot | undefined,
  ) {
    super(
      `${label} failed:\n${fails.map((f) => `  - ${f.message}`).join('\n')}\n\n${formatSnapshot(snap)}`,
    )
    this.name = 'AssertionFailure'
    this.fails = fails
    this.snapshotAtFailure = snap
  }
}

export class InvariantAssertionFailure extends Error {
  readonly violations: readonly InvariantViolation[]
  readonly snapshotAtFailure: LifecycleSnapshot | undefined
  constructor(
    scenario: ScenarioTag,
    violations: readonly InvariantViolation[],
    snap: LifecycleSnapshot | undefined,
  ) {
    super(
      `assertContractedOutcome("${scenario}") failed with ${violations.length} violation(s):\n` +
        `${violations.map((v) => `  - ${v.matcher}: ${v.detail}`).join('\n')}\n\n${formatSnapshot(snap)}`,
    )
    this.name = 'InvariantAssertionFailure'
    this.violations = violations
    this.snapshotAtFailure = snap
  }
}

function formatSnapshot(snap: LifecycleSnapshot | undefined): string {
  if (snap === undefined) return 'snapshot: (none captured)'
  return [
    'snapshot:',
    `  capturedAtMs=${snap.capturedAtMs}, orchAliveDurationMs=${snap.orchAliveDurationMs}`,
    `  orchAlive=${snap.orchAlive}, orchExit=${formatExit(snap)}`,
    `  tmuxServerExists=${snap.tmuxServerExists}, tmuxSessionExists=${snap.tmuxSessionExists}`,
    `  stateStatus=${snap.stateStatus}`,
    `  stepStatuses=${JSON.stringify(snap.stepStatuses)}`,
    `  altScreen=${snap.stdoutAltScreen.enters}/${snap.stdoutAltScreen.exits} mouse=${snap.stdoutMouseTracking.ons}/${snap.stdoutMouseTracking.offs}`,
    `  orphanChildren=${snap.orphanChildren.length}`,
    `  leftPaneFocused=${snap.leftPaneFocused}, rightPaneFocused=${snap.rightPaneFocused}`,
  ].join('\n')
}

function formatExit(snap: LifecycleSnapshot): string {
  if (snap.orchExit === null) return 'null'
  return `code=${snap.orchExit.code}, signal=${snap.orchExit.signal ?? 'null'}`
}
