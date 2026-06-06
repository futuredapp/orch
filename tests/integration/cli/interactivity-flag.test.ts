// Tests the --interactive / --noninteractive flag parser via parseArgv. The
// flag itself is parsed early, before any host wiring, so a unit-style import
// of the parser is the right shape.

import { describe, expect, it } from 'bun:test'
import { ArgvError, parseArgv } from '../../../src/cli/main.ts'

describe('parseArgv interactivity flags', () => {
  it('defaults to interactive when no flag is supplied', () => {
    const { interactivity } = parseArgv(['run', 'name'])

    expect(interactivity).toBe('interactive')
  })

  it('--interactive is the explicit form of the default', () => {
    const { interactivity } = parseArgv(['run', 'name', '--interactive'])

    expect(interactivity).toBe('interactive')
  })

  it('--noninteractive switches to noninteractive', () => {
    const { interactivity } = parseArgv(['run', 'name', '--noninteractive'])

    expect(interactivity).toBe('noninteractive')
  })

  it('rejects both flags as mutually exclusive', () => {
    expect(() => parseArgv(['run', 'name', '--interactive', '--noninteractive'])).toThrow(ArgvError)
  })

  it('reads ORCH_NONINTERACTIVE=1 when no flag is supplied', () => {
    const previous = process.env.ORCH_NONINTERACTIVE
    process.env.ORCH_NONINTERACTIVE = '1'
    try {
      const { interactivity } = parseArgv(['run', 'name'])
      expect(interactivity).toBe('noninteractive')
    } finally {
      if (previous === undefined) {
        delete process.env.ORCH_NONINTERACTIVE
      } else {
        process.env.ORCH_NONINTERACTIVE = previous
      }
    }
  })

  it('--interactive overrides ORCH_NONINTERACTIVE=1', () => {
    const previous = process.env.ORCH_NONINTERACTIVE
    process.env.ORCH_NONINTERACTIVE = '1'
    try {
      const { interactivity } = parseArgv(['run', 'name', '--interactive'])
      expect(interactivity).toBe('interactive')
    } finally {
      if (previous === undefined) {
        delete process.env.ORCH_NONINTERACTIVE
      } else {
        process.env.ORCH_NONINTERACTIVE = previous
      }
    }
  })
})
