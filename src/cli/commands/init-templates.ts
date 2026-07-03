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

export const STEPS_TEMPLATE = `import { claude, step, z } from 'orch'
// orch re-exports Zod as \`z\`, so \`returns:\` gets typed structured output
// without adding zod to this project's package.json.

// Step 1 — SUMMARIZE: an autonomous step whose \`returns:\` (a bare Zod schema)
// makes it hand back TYPED data. orch validates the agent's reply against the
// schema and types the result, so the next step receives a real
// \`{ topic, factCount }\` object rather than free-form text.
export const SUMMARIZE = step.define('summarize', {
  agent: claude({
    bare: false,
    permissions: 'bypass',
  }),
  prompt:
    'Pick a topic you find interesting and list exactly 3 facts about it. ' +
    'Return JSON matching the schema: { topic, factCount } with factCount = 3.',
  returns: z.object({
    topic: z.string(),
    factCount: z.number().int(),
  }),
})

// Step 2 — WRITE_SUMMARY: consumes step 1's typed output. See
// workflows/hello.ts, which threads \`summary.topic\` / \`summary.factCount\`
// into this step's prompt at run() time — that is the handoff orch exists for.
export const WRITE_SUMMARY = step.define('write-summary', {
  agent: claude({
    bare: false,
    permissions: 'bypass',
  }),
  prompt:
    'Create a file at ./hello.txt with a one-line summary of the topic and fact ' +
    'count you are given (no code fences, no extra explanation).',
})

// Add more reusable step definitions below. Full guide:
// docs/public/guide/4-writing-a-workflow.md
`

export const HELLO_WORKFLOW_TEMPLATE = `import { workflow } from 'orch'
import { SUMMARIZE, WRITE_SUMMARY } from '../steps.ts'

// A typed two-step handoff: SUMMARIZE returns structured data, and its typed
// result flows into WRITE_SUMMARY's prompt. See
// docs/public/guide/4-writing-a-workflow.md.
export default workflow('hello', async (run) => {
  const summary = await run(SUMMARIZE) // typed { topic, factCount }
  await run(WRITE_SUMMARY, {
    extraPrompt: \`Topic: \${summary.topic}. Fact count: \${summary.factCount}.\`,
  })
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
  // TODO: add steps. See \`.orch/steps.ts\` for the SUMMARIZE → WRITE_SUMMARY
  // typed-handoff example.
})
`
}
