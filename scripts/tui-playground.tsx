// ---------------------------------------------------------------------------
// tui-playground — DEV-ONLY. Mount the real `<StepsView>` or `<AskApp>` in
// YOUR terminal (no tmux, no run) with hotkeys that mutate the state, so you
// can feel scrolling, banners, selection, and dialogs interactively.
//
//   bun run tui:playground                       # steps view, 8 steps
//   bun run tui:playground -- steps --steps 40   # long list (exercise scroll)
//   bun run tui:playground -- steps --actions    # failed view w/ retry actions
//   bun run tui:playground -- ask --fields 2 --buttons approve,reject,defer
//
// Steps-mode mutation hotkeys (digits — the steps-view keymap ignores them):
//   1 add step · 2 advance (complete current, start next) · 3 complete current
//   4 fail current · 5 info banner · 6 error banner · 7 finish run · 0 reset
// Everything else (↑/↓, ⏎, j/k, g/G, f, ?, q, Esc) is the real keymap; the
// playground answers intents the way the right-pane controller would (Enter
// pins replay view, f returns to live, q quits).

import { render, useApp, useInput } from 'ink'
import type React from 'react'
import { createElement, useEffect, useState } from 'react'
import type { StepsViewIntent } from '../src/hosts/two-pane/steps-view/index.ts'
import { StepsView } from '../src/hosts/two-pane/steps-view/index.ts'
import { AskApp } from '../src/services/prompt/ink-app.tsx'
import type { PromptResult } from '../src/services/prompt/prompt-service.ts'
import {
  initialWorld,
  mutateWorld,
  type PlaygroundWorld,
  worldToState,
} from './tui-playground-world.ts'

interface Args {
  readonly mode: 'steps' | 'ask'
  readonly steps: number
  readonly actions: boolean
  readonly fields: number
  readonly buttons: readonly string[]
}

function parseArgs(argv: readonly string[]): Args {
  let mode: 'steps' | 'ask' = 'steps'
  let steps = 8
  let actions = false
  let fields = 2
  let buttons = ['approve', 'reject', 'defer']
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === 'steps' || a === 'ask') mode = a
    else if (a === '--steps') steps = Number(argv[++i] ?? steps)
    else if (a === '--actions') actions = true
    else if (a === '--fields') fields = Number(argv[++i] ?? fields)
    else if (a === '--buttons') buttons = (argv[++i] ?? '').split(',').filter((b) => b.length > 0)
  }
  return { mode, steps, actions, fields, buttons }
}

// ---------------------------------------------------------------------------
// Steps playground
// ---------------------------------------------------------------------------

function PlaygroundSteps({ args }: { readonly args: Args }): React.ReactElement {
  const { exit } = useApp()
  const [world, setWorld] = useState<PlaygroundWorld>(() => initialWorld(args.steps))
  // 1s tick so live elapsed times advance like a real run.
  const [, setTick] = useState(0)
  useEffect(() => {
    const handle = setInterval(() => setTick((t) => t + 1), 1_000)
    return () => clearInterval(handle)
  }, [])

  useInput((input) => {
    if (input >= '0' && input <= '9') {
      setWorld((w) => mutateWorld(w, input))
    }
  })

  const onIntent = (intent: StepsViewIntent): void => {
    if (intent.type === 'quit') {
      exit()
      return
    }
    setWorld((w) => applyIntent(w, intent))
  }

  return createElement(StepsView, {
    state: worldToState(world),
    onIntent,
    actionsEnabled: args.actions,
  })
}

// Answer intents the way the right-pane controller would, so the committed
// highlight and footer behave exactly like a real run.
function applyIntent(world: PlaygroundWorld, intent: StepsViewIntent): PlaygroundWorld {
  switch (intent.type) {
    case 'enter':
      return { ...world, view: { mode: 'replay', stepName: intent.stepName } }
    case 'follow-live':
      return { ...world, view: { mode: 'live' } }
    case 'dismiss-banner':
      return { ...world, banner: undefined }
    case 'retry':
    case 'retry-continue':
      return {
        ...world,
        seq: world.seq + 1,
        banner: { kind: 'info', text: `intent: ${intent.type}`, seq: world.seq + 1 },
      }
    case 'quit':
      return world
  }
}

// ---------------------------------------------------------------------------
// Ask playground
// ---------------------------------------------------------------------------

function PlaygroundAsk({ args }: { readonly args: Args }): React.ReactElement {
  const { exit } = useApp()
  const spec = {
    question: 'Which approach should we take?',
    fields: Array.from({ length: args.fields }, (_, i) => ({
      name: i === 0 ? 'reason' : `field-${i + 1}`,
      placeholder: i === 0 ? 'why this approach…' : 'optional…',
    })),
    buttons: [...args.buttons],
  }
  const onResolve = (r: PromptResult): void => {
    process.stdout.write(`\nresult: ${JSON.stringify(r)}\n`)
    exit()
  }
  return createElement(AskApp, { spec, onResolve })
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2))
if (process.stdin.isTTY !== true) {
  process.stderr.write('tui-playground needs an interactive terminal (raw-mode stdin).\n')
  process.exit(1)
}
if (args.mode === 'steps') {
  process.stdout.write(
    'playground: 1 add · 2 advance · 3 complete · 4 fail · 5/6 banner · 7 finish · 0 reset · q quit\n',
  )
}
const app = render(
  args.mode === 'steps'
    ? createElement(PlaygroundSteps, { args })
    : createElement(PlaygroundAsk, { args }),
  { exitOnCtrlC: true },
)
await app.waitUntilExit()
