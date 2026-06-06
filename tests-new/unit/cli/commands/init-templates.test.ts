import { describe, expect, it } from 'bun:test'
import {
  CONFIG_TEMPLATE,
  HELLO_WORKFLOW_TEMPLATE,
  newWorkflowTemplate,
  STEPS_TEMPLATE,
} from '../../../../src/cli/commands/init-templates.ts'

// Sanity check that every template parses as valid TypeScript. We pipe each
// through `Bun.Transpiler` — a syntax error here would otherwise only surface
// when the user opens the scaffolded file in their editor.
function isSyntacticallyValid(source: string, loader: 'ts' = 'ts'): boolean {
  try {
    new Bun.Transpiler({ loader }).transformSync(source)
    return true
  } catch {
    return false
  }
}

describe('init templates', () => {
  it('all four templates parse as valid TypeScript', () => {
    expect(isSyntacticallyValid(CONFIG_TEMPLATE)).toBe(true)
    expect(isSyntacticallyValid(STEPS_TEMPLATE)).toBe(true)
    expect(isSyntacticallyValid(HELLO_WORKFLOW_TEMPLATE)).toBe(true)
    expect(isSyntacticallyValid(newWorkflowTemplate('my-flow'))).toBe(true)
  })

  it('HELLO_WORKFLOW_TEMPLATE imports workflow from "orch" and default-exports workflow(...)', () => {
    expect(HELLO_WORKFLOW_TEMPLATE).toContain("import { workflow } from 'orch'")
    expect(HELLO_WORKFLOW_TEMPLATE).toContain("export default workflow('hello'")
  })

  it('STEPS_TEMPLATE imports claude and step from "orch" and exports HELLO', () => {
    expect(STEPS_TEMPLATE).toContain("import { claude, step } from 'orch'")
    expect(STEPS_TEMPLATE).toContain('export const HELLO = step.define')
  })

  it('CONFIG_TEMPLATE uses `export const config` (preferred over default export)', () => {
    expect(CONFIG_TEMPLATE).toContain('export const config = defineConfig')
    expect(CONFIG_TEMPLATE).not.toContain('export default')
  })

  it('CONFIG_TEMPLATE registers hello → workflows/hello.ts', () => {
    expect(CONFIG_TEMPLATE).toContain("hello: 'workflows/hello.ts'")
  })

  it('newWorkflowTemplate interpolates name into the workflow() call only', () => {
    const t = newWorkflowTemplate('my-workflow')
    expect(t).toContain("workflow('my-workflow'")
    // The name appears once, in the workflow(...) call.
    const occurrences = t.split('my-workflow').length - 1
    expect(occurrences).toBe(1)
  })

  it('newWorkflowTemplate does not blow up on awkward inputs (regression for unvalidated names)', () => {
    // Names are validated upstream by `orch new`, but the template itself
    // should not crash on odd characters. We just verify it returns a string
    // and the name lands inside the workflow(...) call.
    const t = newWorkflowTemplate("bad'name")
    expect(typeof t).toBe('string')
    expect(t).toContain("bad'name")
  })
})
