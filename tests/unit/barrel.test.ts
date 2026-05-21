// Guards the public barrel `src/index.ts`. Workflows authored against
// `import { ... } from 'orch'` rely on these names being exported. This
// file is intentionally small — it only asserts the names that are
// load-bearing for downstream authors.

import { describe, expect, it } from 'bun:test'
import * as orch from '../../src/index.ts'

describe('orch public barrel', () => {
  it('re-exports `z` so workflows can author schemas without installing zod in the host repo', () => {
    // Zod's `z` is an object namespace with the chainable schema constructors
    // hanging off it.
    expect(typeof orch.z).toBe('object')
    expect(typeof orch.z.object).toBe('function')
    expect(typeof orch.z.string).toBe('function')
  })

  it('re-exports the schema() wrapper alongside z so they can be imported together', () => {
    expect(typeof orch.schema).toBe('function')
  })

  it('re-exports the workflow primitives (workflow, step)', () => {
    expect(typeof orch.workflow).toBe('function')
    expect(typeof orch.step).toBe('object')
    expect(typeof orch.step.define).toBe('function')
  })
})
