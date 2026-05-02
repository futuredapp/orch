import type { Host } from '../hosts/index.ts'
import type { Clock } from '../services/index.ts'
import type { PromptResult, PromptService, PromptSpec } from '../services/prompt/index.ts'
import type { StepEntry } from '../state/index.ts'
import type { AskStepConfig } from './ask.ts'
import { AskNoDefaultError, AskParallelError } from './errors.ts'
import { currentParallelDepth } from './execution-context.ts'
import type { StepName } from './types.ts'

// ---------------------------------------------------------------------------
// AskExecutorDeps — minimal slice of WorkflowDeps the executor needs.
// ---------------------------------------------------------------------------

export interface AskExecutorDeps {
  readonly clock: Clock
  readonly host: Host
  readonly promptService: PromptService
  readonly interactivity: 'interactive' | 'noninteractive'
}

// ---------------------------------------------------------------------------
// runAskStep — invoked from src/core/workflow.ts
// ---------------------------------------------------------------------------

export interface AskOverrides {
  readonly prompt?: string
  readonly extraContext?: unknown
  readonly extraPrompt?: string
}

export async function runAskStep(
  deps: AskExecutorDeps,
  config: AskStepConfig,
  key: StepName,
  overrides: AskOverrides | undefined,
): Promise<{ value: PromptResult; entry: StepEntry }> {
  if (currentParallelDepth() > 0) {
    throw new AskParallelError(key)
  }
  rejectAgentOverrides(key, overrides)

  const startedAt = deps.clock.now()

  const value: PromptResult =
    deps.interactivity === 'noninteractive'
      ? resolveDefault(config, key)
      : await deps.promptService.ask(toPromptSpec(config), { stepName: key, host: deps.host })

  const entry: StepEntry = {
    name: key,
    value,
    startedAt,
    endedAt: deps.clock.now(),
    artifacts: [],
    validations: [],
    mode: 'interactive',
    transcriptEventCount: 0,
    transcriptTruncated: false,
  }
  return { value, entry }
}

function rejectAgentOverrides(key: StepName, overrides: AskOverrides | undefined): void {
  if (overrides?.prompt !== undefined) {
    throw new Error(`Ask step "${key}" does not accept prompt overrides`)
  }
  if (overrides?.extraContext !== undefined) {
    throw new Error(`Ask step "${key}" does not accept extraContext overrides`)
  }
  if (overrides?.extraPrompt !== undefined) {
    throw new Error(`Ask step "${key}" does not accept extraPrompt overrides`)
  }
}

// ---------------------------------------------------------------------------
// PromptSpec mapping — strips the AskStepConfig down to what the port needs.
// ---------------------------------------------------------------------------

export function toPromptSpec(config: AskStepConfig): PromptSpec {
  const fields = Object.entries(config.fields).map(([name, f]) => ({
    name,
    ...(f.placeholder !== undefined ? { placeholder: f.placeholder } : {}),
  }))
  return {
    question: config.question,
    fields,
    buttons: config.buttons,
  }
}

// ---------------------------------------------------------------------------
// resolveDefault — used when interactivity === 'noninteractive'.
// Throws AskNoDefaultError when nothing is declared.
// ---------------------------------------------------------------------------

function resolveDefault(config: AskStepConfig, key: StepName): PromptResult {
  const decl = config.defaultWhenNoninteractive
  if (decl === undefined || decl === null || typeof decl !== 'object') {
    throw new AskNoDefaultError(key, config)
  }
  if ((decl as { cancelled?: boolean }).cancelled === true) {
    return { cancelled: true, fields: zeroFillFields(config) }
  }
  const button = (decl as { button?: unknown }).button
  if (typeof button !== 'string' || !config.buttons.includes(button)) {
    throw new AskNoDefaultError(key, config)
  }
  // Merge the declared field values over the zero-filled baseline so missing
  // fields are auto-zeroed with `''` (matches the brainstorm's contract).
  const baseline = zeroFillFields(config)
  const declaredFields = extractDeclaredFields(decl, config)
  return { cancelled: false, button, fields: { ...baseline, ...declaredFields } }
}

function zeroFillFields(config: AskStepConfig): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of Object.keys(config.fields)) out[key] = ''
  return out
}

function extractDeclaredFields(decl: object, config: AskStepConfig): Record<string, string> {
  const out: Record<string, string> = {}
  const known = new Set(Object.keys(config.fields))
  for (const [k, v] of Object.entries(decl)) {
    if (k === 'cancelled' || k === 'button') continue
    if (!known.has(k)) continue
    if (typeof v === 'string') out[k] = v
  }
  return out
}

// ---------------------------------------------------------------------------
// isAskCacheValid — predicate used by `runStepOnce` BEFORE the cache-hit
// branch. Mismatch downgrades the hit to a miss without throwing. NOT
// exported to the public barrel — internal control-flow helper only.
// ---------------------------------------------------------------------------

export function isAskCacheValid(config: AskStepConfig, cachedValue: unknown): boolean {
  if (cachedValue === null || typeof cachedValue !== 'object') return false
  const v = cachedValue as Record<string, unknown>

  if (v.cancelled === true) return true

  if (v.cancelled !== false) return false
  if (typeof v.button !== 'string') return false
  if (!config.buttons.includes(v.button)) return false

  const fieldsRec = v.fields
  if (fieldsRec === null || typeof fieldsRec !== 'object') return false
  for (const key of Object.keys(config.fields)) {
    if (!(key in (fieldsRec as object))) return false
  }
  return true
}
