// Named-key vocabulary for the harness `sendKeys` API.
//
// tmux's send-keys argument is either a literal text payload (with -l) or a
// named-key token like `Enter`, `Up`, `Escape`. The production
// `RealTmuxService.sendKeys` only emits the literal form (every char goes
// through `-l`). Tier 1 tests need the named form too: pressing `Enter`
// must inject a real keystroke, not the seven characters `E n t e r`. The
// harness routes named keys through tmux directly via the per-test socket;
// literal strings still go through the service for parity with production.

import type { PaneId, SocketName, TmuxService } from '../../../src/services/tmux/index.ts'

/** Named-key tokens accepted by tmux's `send-keys` without `-l`. */
export type NamedKey =
  | 'Enter'
  | 'Up'
  | 'Down'
  | 'Left'
  | 'Right'
  | 'Escape'
  | 'Tab'
  | 'BTab'
  | 'BSpace'
  | 'Space'
  | 'PageUp'
  | 'PageDown'
  | 'Home'
  | 'End'

const NAMED_KEYS: ReadonlySet<string> = new Set<NamedKey>([
  'Enter',
  'Up',
  'Down',
  'Left',
  'Right',
  'Escape',
  'Tab',
  'BTab',
  'BSpace',
  'Space',
  'PageUp',
  'PageDown',
  'Home',
  'End',
])

export interface SendKeysDeps {
  readonly tmux: TmuxService
  readonly socket: SocketName
  readonly target: PaneId
}

/**
 * Dispatches a single input to the pane. Named keys (e.g. `Enter`, `Up`)
 * are sent via tmux's named-key form so they are interpreted as real key
 * events; everything else is passed verbatim via the literal form so a
 * multi-character payload like `hello` types five characters in order.
 *
 * Uppercase single letters like `F` are literal — they map to the
 * shifted-letter keystroke the steps-view keymap reads.
 */
export async function sendKeysToPane(deps: SendKeysDeps, input: NamedKey | string): Promise<void> {
  if (NAMED_KEYS.has(input)) {
    await sendNamedKey(deps, input)
    return
  }
  await deps.tmux.sendKeys({
    socket: deps.socket,
    target: deps.target,
    keys: [input],
  })
}

async function sendNamedKey(deps: SendKeysDeps, name: string): Promise<void> {
  // The production TmuxService passes every key with `-l` (literal); to send
  // a real named keystroke we shell out to tmux directly. The socket and
  // pane id are branded types, so they can't carry shell metacharacters.
  const proc = Bun.spawn(['tmux', '-L', deps.socket, 'send-keys', '-t', deps.target, name], {
    stdout: 'ignore',
    stderr: 'pipe',
  })
  const exitCode = await proc.exited
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text()
    throw new Error(`sendKeys(${name}): tmux send-keys exited ${exitCode}: ${stderr.trim()}`)
  }
}

/** Returns true when the input must be sent as a named key, not literal text. */
export function isNamedKey(input: string): input is NamedKey {
  return NAMED_KEYS.has(input)
}
