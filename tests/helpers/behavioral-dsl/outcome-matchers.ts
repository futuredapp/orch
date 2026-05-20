/**
 * Outcome matchers. Each constructor returns a `Matcher` that projects over
 * a `LifecycleSnapshot`. Matchers MUST NOT touch I/O — they read from the
 * snapshot only.
 *
 * `withinMs(ms)` is the one meta-matcher: it bounds the polling window the
 * assertion waits over before capturing the final snapshot.
 */

import type { LifecycleSnapshot, Matcher, PollingBudget } from './internal/snapshot.ts'

export const withinMs = (ms: number): PollingBudget => {
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new Error(`withinMs: expected a positive finite millisecond count, got ${ms}`)
  }
  return { timeoutMs: ms }
}

/**
 * Matches when the orch process is dead AND exited via code 0 OR a
 * documented POSIX signal (SIGINT → 130, SIGTERM → 143, SIGHUP → 129,
 * SIGQUIT). Fails on (a) orch still alive, (b) exit code is non-zero and
 * doesn't correspond to a documented signal exit.
 */
export const exitedNormally = (): Matcher => {
  return (snapshot: LifecycleSnapshot) => {
    if (snapshot.orchAlive) {
      return {
        matched: false,
        message: `exitedNormally: orch is still alive (capturedAt=${snapshot.capturedAtMs})`,
      }
    }
    const exit = snapshot.orchExit
    if (exit === null) {
      return {
        matched: false,
        message: 'exitedNormally: orch reported no exit info even though orchAlive=false',
      }
    }
    if (exit.code === 0) {
      return { matched: true, message: 'exitedNormally: orch exited with code 0' }
    }
    if (exit.signal !== null && DOCUMENTED_SIGNALS.has(exit.signal)) {
      return {
        matched: true,
        message: `exitedNormally: orch exited via documented signal ${exit.signal} (code=${exit.code})`,
      }
    }
    return {
      matched: false,
      message: `exitedNormally: orch exited with undocumented code=${exit.code} signal=${exit.signal ?? 'null'}`,
    }
  }
}

const DOCUMENTED_SIGNALS = new Set<NodeJS.Signals>(['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'])

/**
 * Matches when neither the tmux session NOR the tmux server is reachable on
 * the orch socket — the appliance tore itself down. If orch stopped using
 * tmux but the server is still up, this fails.
 */
export const tmuxIsTornDown = (): Matcher => {
  return (snapshot: LifecycleSnapshot) => {
    if (!snapshot.tmuxSessionExists && !snapshot.tmuxServerExists) {
      return { matched: true, message: 'tmuxIsTornDown: tmux server and session are both gone' }
    }
    return {
      matched: false,
      message: `tmuxIsTornDown: tmuxServerExists=${snapshot.tmuxServerExists} tmuxSessionExists=${snapshot.tmuxSessionExists}`,
    }
  }
}

/**
 * Matches when every alt-screen `\x1b[?1049h` enter is paired with a
 * matching `\x1b[?1049l` exit AND every mouse-tracking enter has a matching
 * disable. Detects "host didn't restore the terminal" classes of bugs.
 */
export const terminalRestoredCleanly = (): Matcher => {
  return (snapshot: LifecycleSnapshot) => {
    const alt = snapshot.stdoutAltScreen
    const mouse = snapshot.stdoutMouseTracking
    const altOk = alt.enters === alt.exits
    const mouseOk = mouse.ons === mouse.offs
    if (altOk && mouseOk) {
      return {
        matched: true,
        message: `terminalRestoredCleanly: alt=${alt.enters}/${alt.exits} mouse=${mouse.ons}/${mouse.offs}`,
      }
    }
    return {
      matched: false,
      message: `terminalRestoredCleanly: alt enters=${alt.enters} exits=${alt.exits}, mouse ons=${mouse.ons} offs=${mouse.offs}`,
    }
  }
}

/** Matches when the orphan-children sweep returned an empty list. */
export const noOrphanChildren = (): Matcher => {
  return (snapshot: LifecycleSnapshot) => {
    if (snapshot.orphanChildren.length === 0) {
      return { matched: true, message: 'noOrphanChildren: orphan list is empty' }
    }
    const summary = snapshot.orphanChildren.map((c) => `${c.pid} (${c.command})`).join(', ')
    return {
      matched: false,
      message: `noOrphanChildren: ${snapshot.orphanChildren.length} orphan(s): ${summary}`,
    }
  }
}

/**
 * Matches when every per-step artefact file in the snapshot ends with `\n`
 * (the integrity invariant — truncation suggests an interrupted write).
 */
export const stepArtifactsIntact = (): Matcher => {
  return (snapshot: LifecycleSnapshot) => {
    const broken: string[] = []
    for (const [name, intact] of Object.entries(snapshot.perStepFilesIntact)) {
      if (!intact) broken.push(name)
    }
    if (broken.length === 0) {
      return { matched: true, message: 'stepArtifactsIntact: every per-step file is intact' }
    }
    return {
      matched: false,
      message: `stepArtifactsIntact: truncated step(s): ${broken.join(', ')}`,
    }
  }
}
