#!/usr/bin/env bun
//
// THROWAWAY Phase 0 experiment rig for the "text not copyable from any pane"
// bug (docs/plans/2026-06-11-fix-not-copyable-text-plan.md). It launches the
// appliance-mode tmux session under four config variants, each on its own
// isolated socket, with a plain-text "steps" pane on the left and a real
// agent (claude/codex) on the right — so a human can attach, drag-select, and
// check `pbpaste` to discover which settings restore copy in each pane.
//
// Why a script and not ad-hoc tmux commands: rule #1 (subprocess isolation) —
// every tmux call goes through RealTmuxService + BunProcessService. The only
// raw process I/O here is reading the script's OWN stdin to know when to tear
// down (not a managed subprocess). It is throwaway: delete after Phase 0, or
// keep under scripts/ if useful.
//
// Usage:
//   bun scripts/copy-experiment.ts                       # all variants, claude
//   bun scripts/copy-experiment.ts --agent codex
//   bun scripts/copy-experiment.ts --variants v0,v2
//   bun scripts/copy-experiment.ts --size 220x60
//   bun scripts/copy-experiment.ts --cleanup             # kill leftover sockets

import { parseArgs } from 'node:util'
import { BunFsService, path } from '../src/services/index.ts'
import { BunProcessService } from '../src/services/process/index.ts'
import type { BindKeyOptions, SocketName } from '../src/services/tmux/index.ts'
import { initOrchSession, paneId, RealTmuxService, socketName } from '../src/services/tmux/index.ts'

const processService = new BunProcessService()
const fs = new BunFsService()
const tmux = new RealTmuxService({ processService })

const SESSION = 'exp'
const ALL_VARIANTS = ['v0', 'v1', 'v2', 'v3'] as const
type Variant = (typeof ALL_VARIANTS)[number]

const socketFor = (variant: Variant): SocketName => socketName(`orch-copy-exp-${variant}`)

const VARIANT_PURPOSE: Readonly<Record<Variant, string>> = {
  v0: 'appliance config verbatim — reproduce the bug; does Shift/Option-drag already work?',
  v1: 'mouse off — does unmodified native selection return everywhere? (drag-resize is lost)',
  v2: 'mouse on + set-clipboard on + allow-passthrough on — does the agent /copy (OSC 52) land?',
  v3: 'v2 + default-tmux mouse-copy (drag-end in copy-mode) + blue mode-style — steps pane: plain drag copies, no shift; agent panes: agent owns the mouse, so Shift-drag or the agent /copy',
}

// V3 drag-to-copy — mirrors DEFAULT tmux's mouse-copy bindings, which is the
// behavior the user confirmed works with `tmux new-session 'claude'`.
//
// Begin: bound in `root`. Guarded SMART_WHEEL-style — agent panes
// (mouse_any_flag = yes) forward the drag to the agent (`send -M`); plain
// panes (the steps pane) enter copy-mode at the mouse (`copy-mode -M`).
const V3_DRAG_BEGIN: Omit<BindKeyOptions, 'socket'> = {
  table: 'root',
  key: 'MouseDrag1Pane',
  command: ['if-shell', '-F', '#{?mouse_any_flag,1,0}', 'send-keys -M', 'copy-mode -M'],
}

// End: bound in the COPY-MODE tables, NOT root. Once `copy-mode -M` runs the
// pane is in copy-mode, so the drag-END event routes through the copy-mode
// table — binding it in root (as the first cut did) means the yank never
// fires and the selection is lost. This matches default tmux, which binds
// MouseDragEnd1Pane under copy-mode/copy-mode-vi. `copy-selection-and-cancel`
// + `set-clipboard on` (from V2) emits OSC 52 to the host clipboard.
const V3_DRAG_END_TABLES = ['copy-mode', 'copy-mode-vi'] as const
const V3_DRAG_END_COMMAND = ['send-keys', '-X', 'copy-selection-and-cancel'] as const

// Make the copy-mode selection read like a native selection instead of the
// default yellow `mode-style` ("weird color"). A muted blue background with
// the text's own foreground feels closest to a macOS terminal selection.
const V3_MODE_STYLE = 'bg=#214283,fg=#ffffff'

// Seed the left pane with labeled plain text and hold it open with `cat` so it
// stays a non-alt-screen pane — native terminal selection only applies to a
// plain pane, so this is what a user would drag-select in the steps pane.
const STEPS_SEED = "clear; printf 'STEPS PANE\\n  1. plan\\n  2. work\\n  3. review\\n'; cat"

/**
 * Bring one variant up: appliance lockdown via initOrchSession (so V0 is
 * faithful), then layer the per-variant option/binding deltas, seed the left
 * steps pane, and split a right agent pane.
 *
 * NOTE: Phase 1 will put `set-clipboard`/`allow-passthrough` in the generated
 * `-f` config (a bad option line there only warns; a post-create setOption
 * throws on older tmux). This rig uses setOption because it's simpler and
 * behaviorally identical on our 3.3 floor — it's the measurement rig, not the
 * shipped config.
 */
const bringUp = async (variant: Variant, agentBin: string, width: number, height: number) => {
  const socket = socketFor(variant)

  // Idempotent: clear any leftover server on this socket first.
  await tmux.killServer({ socket })

  await initOrchSession(tmux, fs, {
    socket,
    session: SESSION,
    width,
    height,
    // The pane-died hook value is a tmux command, not a shell command. We
    // don't care about pane-death signalling in this rig, so use a harmless
    // no-op tmux command (`run-shell true`).
    paneDiedCommand: 'run-shell true',
  })

  if (variant === 'v1') {
    await tmux.setOption({ socket, target: SESSION, name: 'mouse', value: 'off', global: true })
  }

  if (variant === 'v2' || variant === 'v3') {
    await tmux.setOption({ socket, target: SESSION, name: 'set-clipboard', value: 'on', global: true })
    await tmux.setOption({ socket, target: SESSION, name: 'allow-passthrough', value: 'on', global: true })
  }

  if (variant === 'v3') {
    await tmux.setOption({ socket, target: SESSION, name: 'mode-style', value: V3_MODE_STYLE, global: true })
    await tmux.bindKey({ socket, ...V3_DRAG_BEGIN })
    for (const table of V3_DRAG_END_TABLES) {
      await tmux.bindKey({ socket, table, key: 'MouseDragEnd1Pane', command: V3_DRAG_END_COMMAND })
    }
  }

  // initOrchSession's initial pane becomes the LEFT steps pane.
  const stepsPaneRaw = (await tmux.listPanes({ socket, session: SESSION, format: '#{pane_id}' }))[0]
  if (stepsPaneRaw === undefined) throw new Error(`${variant}: no initial pane found`)
  await tmux.sendKeys({ socket, target: paneId(stepsPaneRaw), keys: [STEPS_SEED], enter: true })

  // Right agent pane.
  await tmux.splitPane({
    socket,
    session: SESSION,
    orientation: 'h',
    percent: 50,
    argv: [agentBin],
    cwd: path(process.cwd()),
  })
}

const printChecklist = (variants: readonly Variant[]) => {
  console.log('\n' + '='.repeat(72))
  console.log('COPY EXPERIMENT — attach to each variant and run the 4-step checklist')
  console.log('='.repeat(72))
  for (const v of variants) {
    console.log(`\n[${v.toUpperCase()}] ${VARIANT_PURPOSE[v]}`)
    console.log(`  attach:  tmux -L ${socketFor(v)} attach -t ${SESSION}`)
  }
  console.log('\nPer-pane checklist (left steps pane, right agent pane):')
  console.log('  1. Plain mouse drag-select → paste elsewhere; run `pbpaste`.')
  console.log('  2. Shift-drag (Option-drag on Terminal.app) → paste / `pbpaste`.')
  console.log('  3. In the agent pane, trigger its own copy (e.g. /copy) → `pbpaste` (V2/V3).')
  console.log('  4. Confirm drag-to-resize (border) + click-to-focus still work (esp. V1/V3).')
  console.log('\nRecord results in docs/plans/2026-06-11-fix-not-copyable-text-plan.md (Phase 0).')
  console.log('Detach from a session with the host terminal (no prefix bound): close its window/tab.')
  console.log('='.repeat(72))
}

const teardown = async (variants: readonly Variant[]) => {
  for (const v of variants) {
    await tmux.killServer({ socket: socketFor(v) })
  }
}

const parseSize = (raw: string): { width: number; height: number } => {
  const match = /^(\d+)x(\d+)$/.exec(raw)
  if (match === null) throw new Error(`--size must be WxH (e.g. 200x50), got ${JSON.stringify(raw)}`)
  return { width: Number(match[1]), height: Number(match[2]) }
}

const parseVariants = (raw: string | undefined): readonly Variant[] => {
  if (raw === undefined) return ALL_VARIANTS
  const requested = raw.split(',').map((s) => s.trim().toLowerCase())
  const out: Variant[] = []
  for (const r of requested) {
    const found = ALL_VARIANTS.find((v) => v === r)
    if (found === undefined) throw new Error(`unknown variant ${JSON.stringify(r)} (pick from ${ALL_VARIANTS.join(',')})`)
    out.push(found)
  }
  return out
}

const main = async (): Promise<void> => {
  const { values } = parseArgs({
    options: {
      agent: { type: 'string', default: 'claude' },
      variants: { type: 'string' },
      size: { type: 'string', default: '200x50' },
      cleanup: { type: 'boolean', default: false },
    },
  })

  if (values.cleanup === true) {
    console.log('Tearing down all orch-copy-exp-* sockets…')
    await teardown(ALL_VARIANTS)
    console.log('Done.')
    return
  }

  const agentBin = values.agent === 'codex' ? 'codex' : 'claude'
  const variants = parseVariants(values.variants)
  const { width, height } = parseSize(values.size ?? '200x50')

  // Always tear down on Ctrl-C so we never leak tmux daemons (leaked
  // scripted-fake/puppet daemons are the known cause of suite slowdown).
  let tearingDown = false
  const onSignal = () => {
    if (tearingDown) return
    tearingDown = true
    console.log('\nSignal received — tearing down…')
    teardown(variants).finally(() => process.exit(130))
  }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)

  try {
    for (const v of variants) {
      console.log(`Bringing up ${v.toUpperCase()} (agent: ${agentBin})…`)
      await bringUp(v, agentBin, width, height)
    }
  } catch (err) {
    console.error('Bring-up failed — tearing down partial state…')
    await teardown(variants)
    throw err
  }

  printChecklist(variants)

  console.log('\nPress Enter to tear everything down… ')
  for await (const _line of console) break

  await teardown(variants)
  console.log('Torn down. Bye.')
}

await main()
