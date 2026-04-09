import { describe, expect, it } from 'bun:test'

describe('project scaffold', () => {
  it('runs bun test successfully on an empty project', () => {
    expect(true).toBe(true)
  })

  it('imports the public barrel without side effects', async () => {
    const barrel = await import('../../src/index.ts')
    expect(barrel).toBeDefined()
  })
})
