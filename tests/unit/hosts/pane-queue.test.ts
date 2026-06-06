import { describe, expect, it } from 'bun:test'
import { createPaneQueue } from '../../../src/hosts/two-pane/pane-queue.ts'
import { paneId } from '../../../src/services/tmux/index.ts'

describe('PaneQueue', () => {
  it('preserves submission order for a single pane even when ops resolve out of order', async () => {
    const queue = createPaneQueue()
    const pane = paneId('%1')
    const sequence: number[] = []

    // First op takes "long"; second op is instant. Without serialization,
    // second would land before first. With the chain, first runs to completion.
    const first = queue.enqueue(pane, async () => {
      await new Promise((r) => setTimeout(r, 10))
      sequence.push(1)
    })
    const second = queue.enqueue(pane, async () => {
      sequence.push(2)
    })

    await Promise.all([first, second])
    expect(sequence).toEqual([1, 2])
  })

  it('keeps separate panes independent — ordering within a pane, concurrent across panes', async () => {
    const queue = createPaneQueue()
    const left = paneId('%1')
    const right = paneId('%2')
    const events: string[] = []

    const leftSlow = queue.enqueue(left, async () => {
      await new Promise((r) => setTimeout(r, 20))
      events.push('left-slow')
    })
    const rightFast = queue.enqueue(right, async () => {
      events.push('right-fast')
    })
    const leftFast = queue.enqueue(left, async () => {
      events.push('left-fast')
    })

    await Promise.all([leftSlow, rightFast, leftFast])
    // right pane isn't blocked by left pane's slow op
    expect(events.indexOf('right-fast')).toBeLessThan(events.indexOf('left-slow'))
    // left pane's own order survives
    expect(events.indexOf('left-slow')).toBeLessThan(events.indexOf('left-fast'))
  })

  it('continues the chain after a rejection so a failing send does not block respawn-pane', async () => {
    const queue = createPaneQueue()
    const pane = paneId('%1')
    let ran = false

    const failing = queue.enqueue(pane, async () => {
      throw new Error('sendKeys failed')
    })
    const afterward = queue.enqueue(pane, async () => {
      ran = true
    })

    await expect(failing).rejects.toThrow('sendKeys failed')
    await afterward
    expect(ran).toBe(true)
  })

  it('drain() waits for every pending op across every pane', async () => {
    const queue = createPaneQueue()
    const left = paneId('%1')
    const right = paneId('%2')
    let leftDone = false
    let rightDone = false

    void queue.enqueue(left, async () => {
      await new Promise((r) => setTimeout(r, 5))
      leftDone = true
    })
    void queue.enqueue(right, async () => {
      await new Promise((r) => setTimeout(r, 10))
      rightDone = true
    })

    await queue.drain()
    expect(leftDone).toBe(true)
    expect(rightDone).toBe(true)
  })
})
