// ---------------------------------------------------------------------------
// run-mode — where views render and how the CLI picks that target.
// ---------------------------------------------------------------------------
//
// `RunMode` is an open literal union with three slots; v1 wires only `plain`
// and `two-pane`. `single-pane` is reserved so future v2 work lands without a
// breaking type change — autodetect never picks it and explicit selection
// exits with a deferral message at the CLI boundary.
//
// Resolution precedence:
//   1. --mode=<x>  (explicit flag)
//   2. CI=true     → plain
//   3. TTY + tmux ≥ 3.2 → two-pane
//   4. fallback    → plain
//
// Explicit selection fails fast on missing capability (tmux < 3.2 or missing
// binary) instead of silently demoting — explicit flags deserve loud errors.

export const RUN_MODES = ['plain', 'single-pane', 'two-pane'] as const
export type RunMode = (typeof RUN_MODES)[number]

export type RunModeSource = 'flag' | 'env' | 'auto'

export interface RunModeResolution {
  readonly mode: RunMode
  readonly source: RunModeSource
  /** Short human-readable reason. Feeds the first-run banner. */
  readonly reason: string
}

// v1 never picks this via autodetect; explicit selection errors out.
export const SINGLE_PANE_DEFERRED_MESSAGE =
  'single-pane mode deferred to v2 — use --mode=plain or --mode=two-pane'

export class RunModeError extends Error {
  readonly code = 'RUN_MODE_ERROR' as const
  constructor(message: string) {
    super(message)
    this.name = 'RunModeError'
  }
}

export interface RunModeInputs {
  readonly flag?: RunMode | undefined
  /**
   * `defaultMode` from an `orch.config.ts` discovered upward from cwd. Used
   * when no explicit flag is set and neither CI nor TTY+tmux lead the
   * resolver to a more specific mode. Lets users whose autodetect guesses
   * wrong (e.g. Codespaces without a TTY) opt into two-pane from config.
   */
  readonly configDefault?: RunMode | undefined
  readonly ci: boolean
  readonly tty: boolean
  readonly tmuxAvailable: boolean
  readonly tmuxVersionOk: boolean
  /**
   * When true, `--mode=two-pane` without a TTY is accepted (no attach spawn).
   * Set by the CLI when `--no-attach` is present so CI harnesses and
   * screenshot scripts can still run in two-pane without a real terminal.
   * When omitted/false, explicit `--mode=two-pane` without a TTY errors.
   */
  readonly allowHeadlessTwoPane?: boolean
}

export function isRunMode(value: string): value is RunMode {
  return (RUN_MODES as readonly string[]).includes(value)
}

export function resolveRunMode(inputs: RunModeInputs): RunModeResolution {
  if (inputs.flag !== undefined) {
    return resolveExplicitFlag(inputs)
  }

  if (inputs.configDefault !== undefined) {
    return resolveConfigDefault(inputs.configDefault, inputs)
  }

  if (inputs.ci) {
    return { mode: 'plain', source: 'env', reason: 'CI=true' }
  }

  if (inputs.tty && inputs.tmuxAvailable && inputs.tmuxVersionOk) {
    return { mode: 'two-pane', source: 'auto', reason: 'TTY + tmux ≥ 3.2' }
  }

  if (inputs.tty && inputs.tmuxAvailable && !inputs.tmuxVersionOk) {
    return { mode: 'plain', source: 'auto', reason: 'tmux < 3.2' }
  }

  if (inputs.tty) {
    return { mode: 'plain', source: 'auto', reason: 'no tmux in PATH' }
  }

  return { mode: 'plain', source: 'auto', reason: 'no TTY' }
}

function resolveConfigDefault(mode: RunMode, inputs: RunModeInputs): RunModeResolution {
  if (mode === 'single-pane') {
    throw new RunModeError(SINGLE_PANE_DEFERRED_MESSAGE)
  }
  if (mode === 'two-pane') {
    if (!inputs.tmuxAvailable) {
      throw new RunModeError(
        'orch.config.ts defaultMode=two-pane requires tmux in PATH, but none was found',
      )
    }
    if (!inputs.tmuxVersionOk) {
      throw new RunModeError('orch.config.ts defaultMode=two-pane requires tmux >= 3.2')
    }
    return { mode: 'two-pane', source: 'env', reason: 'orch.config.ts defaultMode' }
  }
  return { mode: 'plain', source: 'env', reason: 'orch.config.ts defaultMode' }
}

function resolveExplicitFlag(inputs: RunModeInputs): RunModeResolution {
  const flag = inputs.flag as RunMode

  if (flag === 'single-pane') {
    throw new RunModeError(SINGLE_PANE_DEFERRED_MESSAGE)
  }

  if (flag === 'two-pane') {
    if (!inputs.tmuxAvailable) {
      throw new RunModeError('--mode=two-pane requires tmux in PATH, but none was found')
    }
    if (!inputs.tmuxVersionOk) {
      throw new RunModeError('--mode=two-pane requires tmux >= 3.2')
    }
    if (!inputs.tty && inputs.allowHeadlessTwoPane !== true) {
      throw new RunModeError(
        '--mode=two-pane requires a TTY; add --no-attach for headless (CI, screenshot tests)',
      )
    }
    return { mode: 'two-pane', source: 'flag', reason: '--mode=two-pane' }
  }

  return { mode: 'plain', source: 'flag', reason: '--mode=plain' }
}

// ---------------------------------------------------------------------------
// detectCi — looks up the canonical CI envs plus the generic `CI=true`.
// Kept here so tests can drive with an explicit env map without importing the
// full detector table from the CLI entry point.
// ---------------------------------------------------------------------------

const CI_ENV_KEYS = [
  'GITHUB_ACTIONS',
  'GITLAB_CI',
  'CIRCLECI',
  'BUILDKITE',
  'TF_BUILD',
  'JENKINS_URL',
  'TRAVIS',
] as const

export function detectCi(env: Readonly<Record<string, string | undefined>>): boolean {
  if (env.CI === 'true') return true
  return CI_ENV_KEYS.some((k) => {
    const v = env[k]
    return typeof v === 'string' && v.length > 0
  })
}
