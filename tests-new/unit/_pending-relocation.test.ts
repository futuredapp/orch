import { expect, it } from 'bun:test'

// Sentinel — NOT real coverage. `tests-new/unit/` is the relocation home for
// non-two-pane unit tests (parent U10–U13, a mechanical move from `tests/unit`).
// It is intentionally empty until then, but `bun test` exits non-zero on a dir
// with no test files, which would turn the `test:new-unit` gate bucket red. This
// one passing assertion keeps the bucket green during the migration window.
//
// DELETE this file the moment the first real unit test relocates here.

it('tests-new/unit is reserved for relocated non-two-pane unit tests (parent U10–U13)', () => {
  expect(true).toBe(true)
})
