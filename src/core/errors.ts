import type { RunState } from '../state/index.ts'
import type { AskStepConfig } from './ask.ts'
import type { RunId, StepName } from './types.ts'

export class StepError extends Error {
  constructor(
    readonly stepName: StepName,
    readonly exitCode: number,
    message: string,
  ) {
    super(`Step "${stepName}" failed (exit ${exitCode}): ${message}`)
    this.name = 'StepError'
  }
}

export class RunNotFoundError extends Error {
  constructor(readonly runId: RunId) {
    super(`Cannot resume: run "${runId}" not found`)
    this.name = 'RunNotFoundError'
  }
}

export class ResumeError extends Error {
  constructor(
    readonly runId: RunId,
    readonly status: RunState['status'],
  ) {
    super(`Cannot resume run "${runId}": run already completed`)
    this.name = 'ResumeError'
  }
}

export class InteractiveParallelError extends Error {
  constructor(readonly stepName: StepName) {
    super(
      `Interactive step "${stepName}" cannot run inside parallel() — ` +
        'interactive steps are inherently sequential',
    )
    this.name = 'InteractiveParallelError'
  }
}

export class RunnerCapabilityError extends Error {
  constructor(
    readonly stepName: StepName,
    readonly runnerName: string,
  ) {
    super(
      `Runner "${runnerName}" does not support interactive mode; ` +
        `step "${stepName}" requires a runner with supports.interactive = true`,
    )
    this.name = 'RunnerCapabilityError'
  }
}

/**
 * Thrown when an interactive step sets `autoStop: true` but its runner does
 * not implement the `prepareAutoStop` capability. Fail-fast at the executor
 * before any pane is spawned. The message names the step and runner and points
 * at the two runners that DO support auto-stop, so the fix is obvious without
 * reading the docs.
 */
export class AutoStopUnsupportedError extends Error {
  constructor(
    readonly stepName: StepName,
    readonly runnerName: string,
  ) {
    super(
      `Step "${stepName}" sets \`autoStop: true\`, but runner "${runnerName}" ` +
        `does not support auto-stop — it has no \`prepareAutoStop\` capability.\n` +
        `Auto-stop injects a per-run, signal-only stop hook so orch can close a ` +
        `finished interactive turn without a human keystroke. Today the built-in ` +
        `claude() and codex() runners support it; a custom runner must implement ` +
        `\`prepareAutoStop(ctx)\` to opt in.\n` +
        `Either switch this step to a runner that supports auto-stop, or remove ` +
        `\`autoStop: true\` from step "${stepName}".`,
    )
    this.name = 'AutoStopUnsupportedError'
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

export class AskParallelError extends Error {
  constructor(readonly stepName: StepName) {
    super(
      `Ask step "${stepName}" cannot run inside parallel() — ` +
        'UI/stdin is single-tenant. Hoist the ask above the parallel block ' +
        '(collect input once, then fan out), or move it below (fan-in, then ask).',
    )
    this.name = 'AskParallelError'
  }
}

/**
 * Thrown when an `ask()` step runs under `--noninteractive` and has no
 * `defaultWhenNoninteractive` declared. The message synthesizes a paste-ready
 * suggestion from the actual config (button list + field keys) — turns a
 * "go read the docs" error into an actionable one.
 */
export class AskNoDefaultError extends Error {
  constructor(
    readonly stepName: StepName,
    readonly config: AskStepConfig,
  ) {
    const buttons = config.buttons.map((b) => `'${b}'`).join(' | ')
    const fieldKeys = Object.keys(config.fields)
    const firstButton = config.buttons[0]
    const buttonHint = firstButton !== undefined ? `'${firstButton}'` : "'…'"
    const fieldsHint =
      fieldKeys.length === 0 ? '' : `, ${fieldKeys.map((k) => `${k}: ''`).join(', ')}`
    const fieldKeysSuffix =
      fieldKeys.length > 0 ? `; field keys: ${fieldKeys.map((k) => `'${k}'`).join(', ')}` : ''
    super(
      `Ask step "${stepName}" has no \`defaultWhenNoninteractive\` and the run is in noninteractive mode.\n` +
        `Add a default to the ask() config, e.g.:\n` +
        `  defaultWhenNoninteractive: { button: ${buttonHint}${fieldsHint} }\n` +
        `(buttons available: ${buttons}${fieldKeysSuffix})`,
    )
    this.name = 'AskNoDefaultError'
  }
}
