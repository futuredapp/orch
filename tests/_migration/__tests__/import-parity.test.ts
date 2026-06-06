import { describe, expect, it } from 'bun:test'
import {
  checkMap,
  checkParity,
  parseImports,
  type RelocationPair,
  resolveSpecifier,
  srcSymbolSet,
} from '../import-parity.ts'

// A fixture disk: every path here "exists". Anything else is unresolved.
const FIXTURE_DISK = new Set<string>([
  'src/core/step.ts',
  'src/core/types.ts',
  'src/core/workflow.ts',
  'tests/_support/fake-host.ts',
  'tests/helpers/fake-host.ts',
])
const existsOnFixtureDisk = (p: string): boolean => FIXTURE_DISK.has(p)

describe('parseImports + srcSymbolSet', () => {
  it('keeps only src/ specifiers and excludes bun:test, node:, and npm packages', () => {
    const source = [
      "import { describe, it } from 'bun:test'",
      "import * as fs from 'node:fs/promises'",
      "import { partition } from 'lodash'",
      "import { step } from '../../../src/core/step.ts'",
      "import type { StepName } from '../../../src/core/types.ts'",
      "import { createFakeHost } from '@orch/test/fake-host.ts'",
    ].join('\n')

    const bindings = parseImports(source, 'tests-new/unit/core/x.test.ts', 'tests-new/unit/core')
    const srcSet = srcSymbolSet(bindings)

    expect(srcSet).toEqual(new Set(['src/core/step.ts#step', 'src/core/types.ts#StepName']))
  })
})

describe('resolveSpecifier', () => {
  it('maps the @orch/test alias to tests/_support', () => {
    expect(resolveSpecifier('@orch/test/fake-host.ts', 'tests/unit/core')).toBe(
      'tests/_support/fake-host.ts',
    )
  })

  it('resolves a relative specifier against the importing file directory', () => {
    expect(resolveSpecifier('../../../src/core/step.ts', 'tests-new/unit/core')).toBe(
      'src/core/step.ts',
    )
  })

  it('returns undefined for bare/builtin specifiers', () => {
    expect(resolveSpecifier('bun:test', 'tests-new/unit/core')).toBeUndefined()
    expect(resolveSpecifier('node:fs', 'tests-new/unit/core')).toBeUndefined()
  })
})

describe('checkParity — the core relocation case', () => {
  it('passes when old and new import the same src symbols, differing only in the helper specifier', () => {
    const oldFile = {
      path: 'tests/unit/core/x.test.ts',
      source: [
        "import { step } from '../../../src/core/step.ts'",
        "import { createFakeHost } from '../../helpers/fake-host.ts'",
      ].join('\n'),
    }
    const newFile = {
      path: 'tests-new/unit/core/x.test.ts',
      source: [
        "import { step } from '../../../src/core/step.ts'",
        "import { createFakeHost } from '@orch/test/fake-host.ts'",
      ].join('\n'),
    }

    const violations = checkParity(oldFile, newFile, existsOnFixtureDisk)

    expect(violations).toEqual([])
  })
})

describe('checkParity — R10: a wrong ../ count', () => {
  it('flags a parity violation when the new file resolves to a different module', () => {
    const oldFile = {
      path: 'tests/unit/core/x.test.ts',
      source: "import { step } from '../../../src/core/step.ts'",
    }
    const newFile = {
      // one ../ too few: resolves to src/core/workflow.ts's sibling-but-wrong path
      path: 'tests-new/unit/core/x.test.ts',
      source: "import { step } from '../../src/core/step.ts'",
    }

    const violations = checkParity(oldFile, newFile, existsOnFixtureDisk)

    expect(violations.some((v) => v.kind === 'parity')).toBe(true)
  })

  it('flags a resolution violation when the new import resolves to nothing on disk', () => {
    const oldFile = {
      path: 'tests/unit/core/x.test.ts',
      source: "import { step } from '../../../src/core/step.ts'",
    }
    const newFile = {
      path: 'tests-new/unit/core/x.test.ts',
      source: "import { step } from '../../../src/core/does-not-exist.ts'",
    }

    const violations = checkParity(oldFile, newFile, existsOnFixtureDisk)

    expect(violations.some((v) => v.kind === 'resolution')).toBe(true)
  })
})

describe('checkParity — D13: the cross-tree ban (removed post-migration)', () => {
  it('no longer flags imports from tests/ since both trees are now tests/', () => {
    const oldFile = {
      path: 'tests/unit/core/x.test.ts',
      source: "import { createFakeHost } from '../../helpers/fake-host.ts'",
    }
    const newFile = {
      path: 'tests/unit/core/x.test.ts',
      source: "import { createFakeHost } from '../../helpers/fake-host.ts'",
    }

    const violations = checkParity(oldFile, newFile, existsOnFixtureDisk)

    expect(violations.some((v) => v.kind === 'cross-tree')).toBe(false)
  })
})

describe('checkMap', () => {
  it('runs clean over an empty relocation map', () => {
    const pairs: readonly RelocationPair[] = []

    const violations = checkMap(pairs, existsOnFixtureDisk, () => '')

    expect(violations).toEqual([])
  })
})
