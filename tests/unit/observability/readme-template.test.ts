import { describe, expect, it } from 'bun:test'
import { renderRunReadme } from '../../../src/observability/readme-template.ts'

const BASE_CTX = {
  runId: 'r-2026-04-24-950814-ei',
  workflowName: 'demo',
  mode: 'plain' as const,
  debug: false,
  startedAt: '2026-04-24T12:00:00Z',
  orchVersion: '0.0.0',
}

describe('renderRunReadme', () => {
  it('includes the runId in the top-level heading', () => {
    const md = renderRunReadme(BASE_CTX)
    expect(md).toContain('# Run r-2026-04-24-950814-ei')
  })

  it('includes workflow name, mode, started-at, and orch version', () => {
    const md = renderRunReadme(BASE_CTX)
    expect(md).toContain('**Workflow:** demo')
    expect(md).toContain('**Mode:** plain')
    expect(md).toContain('**Started:** 2026-04-24T12:00:00Z')
    expect(md).toContain('**orch version:** 0.0.0')
  })

  it('reports debug off when debug is false and prompts the reader to re-run with --debug', () => {
    const md = renderRunReadme({ ...BASE_CTX, debug: false })
    expect(md).toContain('**Debug captures:** off')
    expect(md).toContain('Re-run with `--debug`')
  })

  it('lists debug-only file types when debug is true', () => {
    const md = renderRunReadme({ ...BASE_CTX, debug: true })
    expect(md).toContain('**Debug captures:** on')
    expect(md).toContain('subprocesses.ndjson')
    expect(md).toContain('tmux/<paneId>.log')
    expect(md).toContain('orch.log')
  })

  it('includes a grep recipes section with a stepSpanId example', () => {
    const md = renderRunReadme(BASE_CTX)
    expect(md).toContain('## Grep recipes')
    expect(md).toContain("grep '<stepSpanId>'")
  })
})
