/**
 * codex-and-claude — the smallest two-runner workflow, both steps interactive
 * with auto-stop.
 *
 * One step per agent, chained through a shared file so you can see both
 * runners cooperate:
 *
 *   1. draft  (Codex)        — write a one-line topic sentence to ./note.txt
 *   2. expand (Claude Code)  — read that line, expand it into a short paragraph
 *
 * Both steps are `mode: 'interactive'` with `autoStop: true`: they run the real
 * agent TUI inside a tmux pane (watchable, scrollable), and when the agent
 * finishes its turn orch's injected Stop/notify hook signals completion and the
 * pane closes on its own — no human keystroke needed. This is the
 * "interactive UI, autonomous behavior" pattern.
 *
 * Usage (auto-stop requires the two-pane host, i.e. a TTY + tmux ≥ 3.2):
 *   bunx orch run codex-and-claude                       # auto → two-pane
 *   bunx orch run codex-and-claude "about tide pools"    # → args.prompt
 *
 * Requires `codex` (>= 0.118.0) and `claude` on PATH, a TTY, and tmux ≥ 3.2.
 */

import { BunFsService, BunProcessService, ask, claude, codex, fileProduced, step, workflow } from 'orch'

const bunFs = new BunFsService()
const processService = new BunProcessService()

const NOTE_FILE = 'note.txt'

// `sandbox: 'workspace-write'` lets Codex write into the workflow cwd without
// prompting; the factory takes its own deps for schema temp files + version
// preflight.
const codexAgent = codex({ sandbox: 'workspace-write' }, { fs: bunFs, ps: processService })

// Interactive Claude: real TUI in the pane. Skip permission prompts so the
// agent can finish its turn unattended — auto-stop only fires once the turn
// completes, so a blocking prompt would stall the pane.
const claudeAgent = claude({ bare: false, flags: ['--dangerously-skip-permissions'] })

const DRAFT = step.define('draft', {
  agent: codexAgent,
  mode: 'interactive',
  autoStop: true,
  prompt:
    `Write a single plain sentence stating an interesting topic and save it to ./${NOTE_FILE}. ` +
    'Write only the sentence — no title, no preamble, no code fences, no trailing newline.',
  validate: [fileProduced(NOTE_FILE)],
})

const EXPAND = step.define('expand', {
  agent: claudeAgent,
  mode: 'interactive',
  autoStop: true,
  prompt:
    `Read ./${NOTE_FILE} and append a short paragraph (3-4 sentences) expanding on that ` +
    'sentence. Keep the original first line intact; add the paragraph below it.',
  validate: [fileProduced(NOTE_FILE)],
})

const SUMMARY1 = ask({
  name: 'summary1',
  question: 'Is this summary correct?',
  fields: {
    name: { placeholder: 'your name' },
    color: { placeholder: 'favorite color' },
  },
  buttons: ['save', 'skip'],
  defaultWhenNoninteractive: { button: 'skip' },
})

const SUMMARY2 = ask({
  name: 'summary2',
  question: 'Is this summary correct?',
  fields: {
    name: { placeholder: 'your name' },
    color: { placeholder: 'favorite color' },
  },
  buttons: ['save', 'skip'],
  defaultWhenNoninteractive: { button: 'skip' },
})

export default workflow('codex-and-claude', async (run) => {
  await run(DRAFT)
  await run(SUMMARY1)
  await run(EXPAND)
  await run(SUMMARY2)
})
