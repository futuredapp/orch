import { describe, expect, it } from 'bun:test'
import { z } from 'zod'
import { SchemaValidationError, schema } from '../../../src/core/schema.ts'
import type { Step } from '../../../src/core/step.ts'
import { step } from '../../../src/core/step.ts'
import { stepName } from '../../../src/core/types.ts'
import { FakeRunner } from '../../../src/runners/fake/fake-runner.ts'
import { FakeProcessService } from '../../../src/services/process/fake-process-service.ts'
import type { Equal, Expect } from '../../helpers/type-assertions.ts'

const fps = new FakeProcessService()
const fakeRunner = new FakeRunner(fps)

describe('schema()', () => {
  it('produces a SchemaWrapper with valid JSON Schema string for z.object', () => {
    const wrapper = schema(z.object({ a: z.string(), b: z.number() }))

    const parsed = JSON.parse(wrapper.jsonSchema)
    expect(parsed.type).toBe('object')
    expect(parsed.properties.a.type).toBe('string')
    expect(parsed.properties.b.type).toBe('number')
    expect(parsed.required).toContain('a')
    expect(parsed.required).toContain('b')
  })

  it('returns a frozen wrapper', () => {
    const wrapper = schema(z.string())

    expect(Object.isFrozen(wrapper)).toBe(true)
  })

  it('produces stable jsonSchema string across reads', () => {
    const wrapper = schema(z.object({ x: z.boolean() }))

    expect(wrapper.jsonSchema).toBe(wrapper.jsonSchema)
  })

  it('does not include $schema key in JSON Schema output', () => {
    const wrapper = schema(z.object({ a: z.string() }))
    const parsed = JSON.parse(wrapper.jsonSchema)

    expect(parsed.$schema).toBeUndefined()
  })

  it('uses inline definitions with no $ref pointers', () => {
    const inner = z.object({ id: z.number() })
    const wrapper = schema(z.object({ items: z.array(inner) }))

    expect(wrapper.jsonSchema).not.toContain('$ref')
  })

  it('produces correct JSON Schema for z.array', () => {
    const wrapper = schema(z.array(z.string()))
    const parsed = JSON.parse(wrapper.jsonSchema)

    expect(parsed.type).toBe('array')
    expect(parsed.items.type).toBe('string')
  })

  it('produces correct JSON Schema for z.string', () => {
    const wrapper = schema(z.string())
    const parsed = JSON.parse(wrapper.jsonSchema)

    expect(parsed.type).toBe('string')
  })

  it('produces correct JSON Schema for z.number', () => {
    const wrapper = schema(z.number())
    const parsed = JSON.parse(wrapper.jsonSchema)

    expect(parsed.type).toBe('number')
  })

  it('produces correct JSON Schema for z.boolean', () => {
    const wrapper = schema(z.boolean())
    const parsed = JSON.parse(wrapper.jsonSchema)

    expect(parsed.type).toBe('boolean')
  })

  it('produces correct JSON Schema for z.enum', () => {
    const wrapper = schema(z.enum(['a', 'b', 'c']))
    const parsed = JSON.parse(wrapper.jsonSchema)

    expect(parsed.type).toBe('string')
    expect(parsed.enum).toEqual(['a', 'b', 'c'])
  })

  it('produces correct JSON Schema for z.optional', () => {
    const wrapper = schema(z.object({ req: z.string(), opt: z.number().optional() }))
    const parsed = JSON.parse(wrapper.jsonSchema)

    expect(parsed.required).toContain('req')
    expect(parsed.required).not.toContain('opt')
  })

  it('produces correct JSON Schema for z.nullable', () => {
    const wrapper = schema(z.string().nullable())
    const parsed = JSON.parse(wrapper.jsonSchema)

    expect(parsed.type).toContain('string')
    expect(parsed.type).toContain('null')
  })
})

// ---------------------------------------------------------------------------
// Regression: silent `{}` output when the Zod schema came from a major
// version that orch's `zod-to-json-schema` (v3.x) doesn't recognise — most
// commonly Zod v4 in the host project while orch is on Zod v3. The converter
// silently returns just `{"$schema": "..."}`; after stripping `$schema` we
// would have produced `{}` and passed `--json-schema "{}"` to the Claude CLI,
// which the Anthropic API rejects with a 400 about a missing input_schema.type.
//
// We simulate a v4-shaped schema with a v3-shaped `_def` whose `typeName`
// the v3 converter doesn't know — that reproduces the exact `{}` failure
// without requiring zod@4 as a dev-dependency.
// ---------------------------------------------------------------------------

describe('schema() — fails loudly when JSON Schema conversion produces nothing', () => {
  it('throws when the converter returns no usable shape (simulating a Zod v4 schema)', () => {
    const fakeV4Schema = {
      _def: { typeName: 'ZodSomethingV4Only' },
      // biome-ignore lint/suspicious/noExplicitAny: deliberately mis-typed input
    } as any

    expect(() => schema(fakeV4Schema)).toThrow()
  })

  it('error message names the failure mode and points at the fix', () => {
    const fakeV4Schema = {
      _def: { typeName: 'ZodSomethingV4Only' },
      // biome-ignore lint/suspicious/noExplicitAny: deliberately mis-typed input
    } as any

    let caught: unknown
    try {
      schema(fakeV4Schema)
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(Error)
    const msg = (caught as Error).message
    expect(msg).toContain('empty JSON Schema')
    expect(msg).toContain("import { z } from 'orch'")
    expect(msg).toContain('Zod v4')
  })

  it('does NOT throw for any normal v3 zod schema', () => {
    // Sanity guard: the validation must not produce false positives on the
    // common kinds of schemas the existing tests above already exercise.
    expect(() => schema(z.object({ a: z.string() }))).not.toThrow()
    expect(() => schema(z.string())).not.toThrow()
    expect(() => schema(z.number())).not.toThrow()
    expect(() => schema(z.array(z.string()))).not.toThrow()
    expect(() => schema(z.enum(['a', 'b']))).not.toThrow()
    expect(() => schema(z.string().nullable())).not.toThrow()
    expect(() => schema(z.union([z.string(), z.number()]))).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Compile-time type assertions — Step<T> inference
// ---------------------------------------------------------------------------

const TYPED = step.define('typed', {
  agent: fakeRunner,
  returns: schema(z.object({ a: z.string() })),
})
type _1 = Expect<Equal<typeof TYPED, Step<{ a: string }>>>

const PLAIN = step.define('plain', { agent: fakeRunner })
type _2 = Expect<Equal<typeof PLAIN, Step<unknown>>>

const SCALAR = step.define('scalar', {
  agent: fakeRunner,
  returns: schema(z.string()),
})
type _3 = Expect<Equal<typeof SCALAR, Step<string>>>

describe('step.define generic inference', () => {
  it('step with returns: schema(z.object) infers Step<{ a: string }>', () => {
    const { config } = TYPED
    if (config.kind !== 'agent') throw new Error('expected agent config')
    expect(config.returns).toBeDefined()
    expect(config.returns?.jsonSchema).toContain('"type":"object"')
  })

  it('step without returns infers Step<unknown>', () => {
    const { config } = PLAIN
    if (config.kind !== 'agent') throw new Error('expected agent config')
    expect(config.returns).toBeUndefined()
  })

  it('step with returns: schema(z.string()) infers Step<string>', () => {
    const { config } = SCALAR
    if (config.kind !== 'agent') throw new Error('expected agent config')
    expect(config.returns).toBeDefined()
    expect(config.returns?.jsonSchema).toContain('"type":"string"')
  })
})

describe('SchemaValidationError', () => {
  it('message includes step name and Zod path details', () => {
    const s = z.object({ name: z.string(), age: z.number() })
    const result = s.safeParse({ name: 123, age: 'wrong' })

    if (result.success) throw new Error('expected parse failure')

    const err = new SchemaValidationError(stepName('research'), result.error)

    expect(err.message).toContain('Step "research"')
    expect(err.message).toContain('name')
    expect(err.message).toContain('age')
    expect(err.stepName).toBe(stepName('research'))
    expect(err.zodError).toBe(result.error)
  })

  it('instanceof works cross-transpile via Object.setPrototypeOf', () => {
    const s = z.object({ x: z.string() })
    const result = s.safeParse({ x: 42 })

    if (result.success) throw new Error('expected parse failure')

    const err = new SchemaValidationError(stepName('step1'), result.error)

    expect(err).toBeInstanceOf(SchemaValidationError)
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('SchemaValidationError')
  })
})
