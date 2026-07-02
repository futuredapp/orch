<script setup lang="ts">
// Animated landing-page demo: a terminal types `orch run goal "..."`, then the
// window becomes the two-pane orch host - live step statuses on the left, the
// active agent's transcript streaming on the right - and loops forever.
// Everything runs client-side in onMounted, so the component is SSR-safe.
import { nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue'

const COMMAND = `orch run goal "let's do something great"`

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

type StepStatus = 'pending' | 'running' | 'done'

interface StepScript {
  name: string
  agent: string
  lines: string[]
}

const SCRIPT: StepScript[] = [
  {
    name: 'brainstorm',
    agent: 'claude',
    lines: [
      `prompt: let's do something great`,
      '──────────────────────────────',
      '● Exploring the repository…',
      '● Sketching three approaches',
      '● Writing feature/brainstorm.md',
      '✔ brainstorm.md produced',
    ],
  },
  {
    name: 'plan',
    agent: 'claude',
    lines: [
      '● Reading feature/brainstorm.md',
      '● Splitting the work into 2 phases',
      '✔ plan.md written · { phases: 2 }',
    ],
  },
  {
    name: 'work · phase-1',
    agent: 'codex',
    lines: [
      '● Implementing phase 1 only',
      '● edit src/exporter.ts  +118 −6',
      '● bun test → 12 passed',
      '✔ validated: gitDiffCreated()',
    ],
  },
  {
    name: 'work · phase-2',
    agent: 'codex',
    lines: [
      '● Implementing phase 2 only',
      '● edit src/report.ts  +64 −11',
      '● bun test → 19 passed',
      '✔ validated: gitDiffCreated()',
    ],
  },
  {
    name: 'review',
    agent: 'claude',
    lines: [
      '● Reviewing the combined diff',
      '● 1 nit fixed · 0 blockers',
      '✔ approved',
    ],
  },
  {
    name: 'commit',
    agent: 'git',
    lines: ['✔ 3f2a91c  feat: do something great'],
  },
]

type Phase = 'typing' | 'boot' | 'panes' | 'complete'

const phase = ref<Phase>('typing')
const typed = ref('')
const bootLines = ref<string[]>([])
const steps = reactive(
  SCRIPT.map((s) => ({ name: s.name, status: 'pending' as StepStatus })),
)
const activeStep = ref(0)
const transcript = ref<string[]>([])
const spinnerFrame = ref(0)
const agentPane = ref<HTMLElement | null>(null)

let generation = 0
let timer: ReturnType<typeof setTimeout> | undefined
let spinnerTimer: ReturnType<typeof setInterval> | undefined

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    timer = setTimeout(resolve, ms)
  })
}

function resetState(): void {
  phase.value = 'typing'
  typed.value = ''
  bootLines.value = []
  transcript.value = []
  activeStep.value = 0
  for (const s of steps) s.status = 'pending'
}

async function scrollTranscript(): Promise<void> {
  await nextTick()
  const el = agentPane.value
  if (el) el.scrollTop = el.scrollHeight
}

async function play(): Promise<void> {
  const gen = ++generation
  const alive = () => gen === generation

  while (alive()) {
    resetState()
    await sleep(1000)
    if (!alive()) return

    // 1. Type the command, character by character.
    for (const ch of COMMAND) {
      typed.value += ch
      await sleep(ch === ' ' ? 70 : 34)
      if (!alive()) return
    }
    await sleep(550)
    if (!alive()) return

    // 2. "Enter" - orch boots and picks a mode.
    phase.value = 'boot'
    const boot = [
      '',
      '◆ orch · run r-2026-07-02-1015-3f',
      '  mode: two-pane (tty + tmux detected)',
    ]
    for (const line of boot) {
      bootLines.value = [...bootLines.value, line]
      await sleep(260)
      if (!alive()) return
    }
    await sleep(750)
    if (!alive()) return

    // 3. The two-pane host: steps advance, transcripts stream.
    phase.value = 'panes'
    for (let i = 0; i < SCRIPT.length; i++) {
      const script = SCRIPT[i]
      const step = steps[i]
      if (script === undefined || step === undefined) continue
      activeStep.value = i
      step.status = 'running'
      transcript.value = []
      await sleep(360)
      if (!alive()) return
      for (const line of script.lines) {
        transcript.value = [...transcript.value, line]
        void scrollTranscript()
        await sleep(430)
        if (!alive()) return
      }
      step.status = 'done'
      await sleep(240)
      if (!alive()) return
    }

    // 4. Done - hold the finished run on screen, then loop.
    phase.value = 'complete'
    void scrollTranscript()
    await sleep(5200)
    if (!alive()) return
  }
}

function showFinishedRun(): void {
  // Reduced motion: render the completed run as a still image, no loop.
  phase.value = 'complete'
  typed.value = COMMAND
  for (const s of steps) s.status = 'done'
  const last = SCRIPT[SCRIPT.length - 1]
  activeStep.value = SCRIPT.length - 1
  transcript.value = last === undefined ? [] : last.lines
}

function glyph(status: StepStatus): string {
  if (status === 'done') return '✔'
  if (status === 'running') return SPINNER[spinnerFrame.value] ?? '⠋'
  return '○'
}

onMounted(() => {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  if (reduced) {
    showFinishedRun()
    return
  }
  spinnerTimer = setInterval(() => {
    spinnerFrame.value = (spinnerFrame.value + 1) % SPINNER.length
  }, 85)
  void play()
})

onBeforeUnmount(() => {
  generation++
  if (timer !== undefined) clearTimeout(timer)
  if (spinnerTimer !== undefined) clearInterval(spinnerTimer)
})
</script>

<template>
  <div class="term-wrap">
    <div
      class="term"
      role="img"
      aria-label="Terminal demo: orch run launches a workflow and drives it in a live two-pane view"
    >
      <div class="term-bar">
        <span class="dot dot-red" />
        <span class="dot dot-yellow" />
        <span class="dot dot-green" />
        <span class="term-title">~/my-project</span>
      </div>

      <div class="term-body">
        <template v-if="phase === 'typing' || phase === 'boot'">
          <div class="line">
            <span class="prompt">❯</span>
            <span class="cmd">{{ typed }}</span>
            <span v-if="phase === 'typing'" class="cursor" />
          </div>
          <div v-for="(l, i) in bootLines" :key="i" class="line boot-line">
            {{ l }}&nbsp;
          </div>
        </template>

        <template v-else>
          <div class="panes">
            <div class="pane pane-steps">
              <div class="pane-title">goal · r-2026-07-02</div>
              <div
                v-for="s in steps"
                :key="s.name"
                class="step"
                :class="`step-${s.status}`"
              >
                <span class="glyph">{{ glyph(s.status) }}</span>
                <span class="step-name">{{ s.name }}</span>
              </div>
              <div v-if="phase === 'complete'" class="run-done">run complete</div>
            </div>

            <div ref="agentPane" class="pane pane-agent">
              <div class="pane-title">
                {{ SCRIPT[activeStep]?.agent }} · {{ SCRIPT[activeStep]?.name }}
              </div>
              <div v-for="(l, i) in transcript" :key="i" class="tline">
                {{ l }}
              </div>
              <div v-if="phase === 'complete'" class="tline resume-hint">
                crashed halfway? <span class="accent">orch resume --latest</span>
                replays finished steps from cache
              </div>
            </div>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.term-wrap {
  max-width: 860px;
  margin: 8px auto 0;
  padding: 0 24px;
}

.term {
  border-radius: 12px;
  overflow: hidden;
  background: #0d1117;
  border: 1px solid rgba(140, 149, 159, 0.25);
  box-shadow:
    0 0 0 1px rgba(0, 0, 0, 0.2),
    0 18px 48px rgba(0, 0, 0, 0.35),
    0 0 64px rgba(100, 108, 255, 0.12);
  font-family: var(--vp-font-family-mono);
  font-size: 13px;
  line-height: 1.65;
}

.term-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  background: #161b22;
  border-bottom: 1px solid rgba(140, 149, 159, 0.2);
}

.dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
}
.dot-red {
  background: #ff5f57;
}
.dot-yellow {
  background: #febc2e;
}
.dot-green {
  background: #28c840;
}

.term-title {
  margin-left: 8px;
  color: #8b949e;
  font-size: 12px;
}

.term-body {
  height: 300px;
  padding: 14px 16px;
  color: #c9d1d9;
  text-align: left;
}

.line {
  white-space: pre-wrap;
  word-break: break-word;
}

.prompt {
  color: #7ee787;
  margin-right: 8px;
  font-weight: 700;
}

.cmd {
  color: #e6edf3;
}

.boot-line {
  color: #8b949e;
}

.cursor {
  display: inline-block;
  width: 8px;
  height: 16px;
  margin-left: 2px;
  vertical-align: text-bottom;
  background: #e6edf3;
  animation: blink 1s steps(1) infinite;
}

@keyframes blink {
  50% {
    opacity: 0;
  }
}

.panes {
  display: flex;
  gap: 0;
  height: 100%;
}

.pane {
  min-width: 0;
}

.pane-steps {
  flex: 0 0 44%;
  padding-right: 14px;
  border-right: 1px solid rgba(140, 149, 159, 0.25);
}

.pane-agent {
  flex: 1 1 auto;
  padding-left: 14px;
  overflow: hidden;
}

.pane-title {
  color: #8b949e;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  margin-bottom: 8px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.step {
  display: flex;
  align-items: baseline;
  gap: 8px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.glyph {
  display: inline-block;
  width: 1.2em;
  flex: none;
}

.step-pending {
  color: #6e7681;
}

.step-running {
  color: #e6edf3;
}
.step-running .glyph {
  color: #79c0ff;
}

.step-done {
  color: #8b949e;
}
.step-done .glyph {
  color: #56d364;
}

.run-done {
  margin-top: 10px;
  color: #56d364;
  font-weight: 700;
}

.tline {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: #c9d1d9;
  animation: rise 0.25s ease-out;
}

@keyframes rise {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

.resume-hint {
  margin-top: 8px;
  color: #8b949e;
  white-space: normal;
}

.accent {
  color: #79c0ff;
}

@media (max-width: 640px) {
  .term {
    font-size: 11.5px;
  }
  .term-body {
    height: 320px;
    padding: 12px;
  }
  .pane-steps {
    flex-basis: 40%;
    padding-right: 10px;
  }
  .pane-agent {
    padding-left: 10px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .cursor {
    animation: none;
  }
  .tline {
    animation: none;
  }
}
</style>
