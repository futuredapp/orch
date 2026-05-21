import type { ZodError, ZodType, ZodTypeDef } from 'zod'
import zodToJsonSchema from 'zod-to-json-schema'
import type { StepName } from './types.ts'

// ---------------------------------------------------------------------------
// SchemaWrapper<T> — carries Zod schema + memoized JSON Schema string
// ---------------------------------------------------------------------------

export interface SchemaWrapper<T = unknown> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- input type may differ from output (z.transform)
  readonly zodSchema: ZodType<T, ZodTypeDef, unknown>
  readonly jsonSchema: string
}

/**
 * Wraps a Zod schema into a `SchemaWrapper<T>` that the executor uses for:
 * - CLI flags: `--json-schema '<jsonSchema>'`
 * - Runtime validation: `zodSchema.safeParse(rawValue)`
 *
 * JSON Schema conversion happens once at wrap time (frozen, stable reference).
 * Uses `$refStrategy: 'none'` for flat inline JSON and strips `$schema`.
 */
export function schema<T>(zodSchema: ZodType<T, ZodTypeDef, unknown>): SchemaWrapper<T> {
  const jsonSchemaObj = zodToJsonSchema(zodSchema, { $refStrategy: 'none' })
  const { $schema: _, ...rest } = jsonSchemaObj as Record<string, unknown>
  assertNonEmptyJsonSchema(rest)
  const jsonSchema = JSON.stringify(rest)
  return Object.freeze({ zodSchema, jsonSchema })
}

// Keys that signal `zod-to-json-schema` actually emitted a usable schema.
// `$schema` is intentionally NOT here — orch strips it above, and its
// presence alone does not constitute a valid input_schema for downstream
// CLIs (notably `claude --json-schema`, which forwards to the Anthropic
// API's `custom_tool.input_schema` field — that requires at minimum `type`).
const NON_EMPTY_SCHEMA_KEYS = ['type', 'anyOf', 'oneOf', 'allOf', 'enum', 'const', '$ref'] as const

// Why this exists: when the input Zod schema comes from a major version
// `zod-to-json-schema` doesn't understand (Zod v4 in the host project while
// orch is on v3 is the field-reported case), the converter silently returns
// only `{"$schema": "..."}`. Without this guard we would stringify `{}` and
// hand it to the runner; Claude CLI would then fail mid-run with an opaque
// `tools.<n>.custom.input_schema.type: Field required` 400 from the API.
// Fail at `schema()` call time (workflow load) with a message that names the
// likely cause and the canonical fix.
function assertNonEmptyJsonSchema(rest: Record<string, unknown>): void {
  for (const key of NON_EMPTY_SCHEMA_KEYS) {
    if (key in rest) return
  }
  throw new Error(
    'schema() produced an empty JSON Schema ' +
      `(no ${NON_EMPTY_SCHEMA_KEYS.join(' / ')}).\n` +
      '\n' +
      "This usually means the Zod schema was created with a Zod version that orch's " +
      '`zod-to-json-schema` does not recognise — most commonly Zod v4 in the host ' +
      'project while orch is on Zod v3.\n' +
      '\n' +
      'Fix one of these:\n' +
      '  • In workflows under `.orch/`, import zod from orch, not from the host package:\n' +
      "        import { z } from 'orch'   ✅\n" +
      "        import { z } from 'zod'    ❌  (resolves to the host project's zod)\n" +
      '  • Or align your host project to Zod v3: `bun add zod@^3`.\n',
  )
}

// ---------------------------------------------------------------------------
// SchemaValidationError — thrown when structured output fails Zod parse
// ---------------------------------------------------------------------------

export class SchemaValidationError extends Error {
  constructor(
    readonly stepName: StepName,
    readonly zodError: ZodError,
  ) {
    super(
      `Step "${stepName}" returned invalid structured output:\n` +
        zodError.issues.map((i) => `  • ${i.path.join('.')}: ${i.message}`).join('\n'),
    )
    this.name = 'SchemaValidationError'
    Object.setPrototypeOf(this, new.target.prototype)
  }
}
