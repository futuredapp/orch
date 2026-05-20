// Templates rendered by `orch init` and `orch new`. Kept as exported string
// constants — not files on disk — so the scaffolder is self-contained and
// `bun link` doesn't need to ship template assets alongside the source.

export const CONFIG_TEMPLATE = `import { defineConfig } from 'orch'

export const config = defineConfig({
  workflows: {
    hello: 'workflows/hello.ts',
  },
})
`

export const STEPS_TEMPLATE = `import { claude, step } from 'orch'

// Add more reusable step definitions below.
export const HELLO = step.define('write-hello', {
  agent: claude({
    bare: false,
    flags: ['--permission-mode', 'bypassPermissions'],
  }),
  prompt:
    'Create a file at ./hello.txt containing exactly the text "hello from orch" ' +
    '(no trailing newline, no code fences, no extra explanation).',
})
`

export const HELLO_WORKFLOW_TEMPLATE = `import { workflow } from 'orch'
import { HELLO } from '../steps.ts'

export default workflow('hello', async (run) => {
  await run(HELLO)
})
`

/**
 * Skeleton for a workflow created by `orch new <name>`. The caller is
 * responsible for validating that `name` is kebab-case — we interpolate it
 * verbatim into the `workflow('<name>', ...)` call.
 */
export function newWorkflowTemplate(name: string): string {
  return `import { workflow } from 'orch'

export default workflow('${name}', async (_run) => {
  // TODO: add steps. See \`.orch/steps.ts\` for the HELLO example.
})
`
}
