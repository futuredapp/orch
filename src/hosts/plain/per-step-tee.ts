// ---------------------------------------------------------------------------
// Per-step render tee — captures verbatim host bytes per autonomous step.
// ---------------------------------------------------------------------------
//
// Both hosts (plain and tmux) emit rendered bytes for autonomous steps and
// should also persist them so post-mortem readers can replay the run without
// re-rendering. The tee opens two sinks per step on `step:start`:
//
//   - logs/agents/<step>/formatted_output.ansi  (verbatim — `cat` replays)
//   - logs/agents/<step>/formatted_output.txt   (ANSI-stripped — `grep` target)
//
// Closes both on `step:complete` / `step:failed`. Truncates on first write so
// resumed steps land only the latest attempt.
//
// Why a host-side tee (not workflow-level): the bytes a host actually emits
// depend on host policy — plain uses `\n`, tmux uses `\r\n`; plain gates color
// on TTY, tmux always colors. A workflow-level capture would re-render and
// lose those nuances. See plan § "Host-side render tee".

import type { StepName } from '../../core/types.ts'
import type { RawSink, SessionLogger } from '../../observability/index.ts'
import { stripAnsi } from './strip-ansi.ts'

interface StepSinks {
  readonly ansi: RawSink
  readonly txt: RawSink
}

export interface PerStepTee {
  /** Open ansi + txt sinks for the step. Idempotent — repeated calls reuse
   *  the existing sinks (resume re-enters the same step). */
  open(step: StepName): void
  /** Write the verbatim ANSI bytes the host just emitted to the primary
   *  sink, plus the stripped form to the txt sink. No-op if `open` was not
   *  called for the step (silent or interactive steps). */
  write(step: StepName, ansi: string): void
  /** Close both sinks for the step. No-op if `open` was not called. */
  close(step: StepName): void
  /** Drain every pending write across all open sinks. Called from the host's
   *  teardown so a SIGINT mid-step still flushes what the host emitted. */
  drain(): Promise<void>
}

/** No-op tee. Returned when the host has no logger (tests, null adapter). */
export const NULL_PER_STEP_TEE: PerStepTee = {
  open(): void {
    /* no-op */
  },
  write(): void {
    /* no-op */
  },
  close(): void {
    /* no-op */
  },
  async drain(): Promise<void> {
    /* no-op */
  },
}

export function createPerStepTee(logger: SessionLogger | undefined): PerStepTee {
  if (logger === undefined) return NULL_PER_STEP_TEE

  const open = new Map<StepName, StepSinks>()

  return {
    open(step: StepName): void {
      if (open.has(step)) return
      const ansi = logger.streamSink(`agents/${step}/formatted_output.ansi`, {
        truncateOnOpen: true,
      })
      const txt = logger.streamSink(`agents/${step}/formatted_output.txt`, {
        truncateOnOpen: true,
      })
      open.set(step, { ansi, txt })
    },
    write(step: StepName, ansi: string): void {
      const sinks = open.get(step)
      if (sinks === undefined || ansi.length === 0) return
      void sinks.ansi.write(ansi).catch(() => {})
      void sinks.txt.write(stripAnsi(ansi)).catch(() => {})
    },
    close(step: StepName): void {
      const sinks = open.get(step)
      if (sinks === undefined) return
      open.delete(step)
      void sinks.ansi.close().catch(() => {})
      void sinks.txt.close().catch(() => {})
    },
    async drain(): Promise<void> {
      const all: Array<Promise<void>> = []
      for (const sinks of open.values()) {
        all.push(sinks.ansi.close().catch(() => {}))
        all.push(sinks.txt.close().catch(() => {}))
      }
      open.clear()
      await Promise.all(all)
    },
  }
}
