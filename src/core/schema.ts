import type { ZodError, ZodType } from 'zod'
import zodToJsonSchema from 'zod-to-json-schema'
import type { StepName } from './types.ts'

// ---------------------------------------------------------------------------
// SchemaWrapper<T> — carries Zod schema + memoized JSON Schema string
// ---------------------------------------------------------------------------

export interface SchemaWrapper<T = unknown> {
  readonly zodSchema: ZodType<T>
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
export function schema<T>(zodSchema: ZodType<T>): SchemaWrapper<T> {
  const jsonSchemaObj = zodToJsonSchema(zodSchema, { $refStrategy: 'none' })
  const { $schema: _, ...rest } = jsonSchemaObj as Record<string, unknown>
  const jsonSchema = JSON.stringify(rest)
  return Object.freeze({ zodSchema, jsonSchema })
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
