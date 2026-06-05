// Per-instance driver handle for the predictable fake (U5).
//
// `MountedHarness.agent(labelPath)` returns one of these. It resolves the
// control transport from the harness's run state dir + the author's label
// (the run-time key — flat `as:` label, or `sub>name` path) using the SAME
// `resolveControlPaths` the entry uses (U3), so the two sides cannot drift.
//
// The handle drives exactly one instance: `typeAndSend` / `finish` append a
// command to that instance's NDJSON control file and await its `.ack`;
// `waitForReady` waits for the instance's `.ready` marker. All assertions are
// gated on these durable on-disk signals (never a bare pane scrape), per the
// Tier-5 findings.

import { appendFile, mkdir, readFile, stat } from 'node:fs/promises'
import * as nodePath from 'node:path'
import { type ControlPaths, resolveControlPaths } from '../../../src/runners/scripted-fake/index.ts'

const DEFAULT_POLL_MS = 25
const DEFAULT_TIMEOUT_MS = 10_000

export interface AgentHandleOptions {
  readonly runStateDir: string
  /** The logical key the workflow author used (flat `as:` label or `sub>name`). */
  readonly key: string
  readonly pollMs?: number
  readonly timeoutMs?: number
}

export interface AgentHandle {
  /** The logical address (key) this handle targets. */
  readonly key: string
  /** The resolved control-file path (for assertions / cross-run isolation checks). */
  readonly controlPath: string
  /** The resolved `.ready` marker path. */
  readonly readyPath: string
  /** The resolved render-log path — the interactive durable render oracle. */
  readonly renderLogPath: string
  /**
   * Append a `type_and_send` line and await the instance's ack (R12).
   *
   * Empty / whitespace-only text is acked but renders nothing — a no-op by
   * design (R3), so headless (which drops empty info text) and interactive
   * (which would otherwise show a blank line) stay identical.
   */
  typeAndSend(text: string): Promise<void>
  /**
   * Append a `finish` (optional code) and await the instance's ack.
   *
   * WARNING: for an INTERACTIVE handle a non-zero `code` is NOT propagated —
   * the fake exits cleanly (0) regardless, because the host's `pane-died`
   * carries no exit code (interactive finish is clean-exit-only by design). A
   * non-zero code only takes effect for a headless instance.
   */
  finish(code?: number): Promise<void>
  /** Resolve once the instance's `.ready` marker exists (R13). */
  waitForReady(): Promise<void>
  /**
   * Resolve once the interactive render log contains `needle`, returning the
   * full log body. The durable oracle for interactive output (manual stdin has
   * no ack — best-effort per R12), so an R6 manual-typing assertion gates on
   * this on-disk signal rather than scraping the pane (Tier-5 findings). Only
   * the interactive entry writes this file; headless steps use the transcript
   * tee instead.
   */
  waitForRender(needle: string): Promise<string>
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

export function createAgentHandle(opts: AgentHandleOptions): AgentHandle {
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const paths: ControlPaths = resolveControlPaths({ runStateDir: opts.runStateDir, key: opts.key })
  let seq = 0
  // The entry creates the control dir at spawn, but a driver may append before
  // the first poll observed it — ensure it once on first append (not per call)
  // so the ordering hazard is covered without a mkdir syscall on every command.
  let dirEnsured: Promise<unknown> | undefined

  const append = async (cmd: Readonly<Record<string, unknown>>): Promise<void> => {
    if (dirEnsured === undefined) dirEnsured = mkdir(paths.controlDir, { recursive: true })
    await dirEnsured
    seq += 1
    const localSeq = seq
    await appendFile(paths.controlPath, `${JSON.stringify(cmd)}\n`, 'utf-8')
    await waitForAck(paths.ackDir, localSeq, pollMs, timeoutMs)
  }

  return {
    key: opts.key,
    controlPath: paths.controlPath,
    readyPath: paths.readyPath,
    renderLogPath: paths.renderLogPath,
    typeAndSend: (text: string) => append({ cmd: 'type_and_send', text }),
    finish: (code?: number) =>
      append(code !== undefined ? { cmd: 'finish', code } : { cmd: 'finish' }),
    waitForReady: () => waitForReady(paths.readyPath, pollMs, timeoutMs),
    waitForRender: (needle: string) =>
      waitForRender(paths.renderLogPath, needle, pollMs, timeoutMs),
  }
}

async function waitForAck(
  ackDir: string,
  seq: number,
  pollMs: number,
  timeoutMs: number,
): Promise<void> {
  const ackPath = nodePath.join(ackDir, `${seq}.ack`)
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await fileExists(ackPath)) return
    if (Date.now() >= deadline) {
      throw new Error(
        `waitForAck: instance did not ack command #${seq} within ${timeoutMs}ms (expected ${ackPath})`,
      )
    }
    await new Promise((r) => setTimeout(r, pollMs))
  }
}

// Resolve once the `.ready` marker simply EXISTS. The entry writes its pid into
// the marker, but this poll does NOT read or validate that token — the pid is
// currently informational only. Token validation is deliberately deferred (see
// the plan's Open Questions): in Phase 1 each run uses a fresh runId dir with a
// single attempt per key, so an existence check is sufficient. A future in-run
// retry/resume re-running the same key in the same dir would re-open a
// spawn-vs-poll race (this could resolve against the prior attempt's marker
// before the new instance rewrote it) — that limitation is unhandled here, so a
// future reader must not assume the race is closed.
async function waitForReady(readyPath: string, pollMs: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await fileExists(readyPath)) return
    if (Date.now() >= deadline) {
      throw new Error(`waitForReady: marker ${readyPath} did not appear within ${timeoutMs}ms`)
    }
    await new Promise((r) => setTimeout(r, pollMs))
  }
}

async function waitForRender(
  renderLogPath: string,
  needle: string,
  pollMs: number,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const body = await readFile(renderLogPath, 'utf-8').catch(() => '')
    if (body.includes(needle)) return body
    if (Date.now() >= deadline) {
      throw new Error(
        `waitForRender: ${renderLogPath} never contained ${JSON.stringify(needle)} within ${timeoutMs}ms`,
      )
    }
    await new Promise((r) => setTimeout(r, pollMs))
  }
}

// Free-function wrappers (R8): some call sites read better targeting an
// instance positionally — `typeAndSend(a, 'hi')` — than as a method.
export function typeAndSend(handle: AgentHandle, text: string): Promise<void> {
  return handle.typeAndSend(text)
}

export function finish(handle: AgentHandle, code?: number): Promise<void> {
  return handle.finish(code)
}
