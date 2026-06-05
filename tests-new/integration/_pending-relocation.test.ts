import { expect, it } from 'bun:test'

// Sentinel — NOT real coverage. `tests-new/integration/` is the relocation home
// for non-two-pane mocked-edge integration tests (parent U10–U13). It is empty
// until then, but `bun test` exits non-zero on a dir with no test files, which
// would turn the `test:new-int` gate bucket red. This passing assertion keeps it
// green during the migration window.
//
// DELETE this file the moment the first real integration test relocates here.

it('tests-new/integration is reserved for relocated non-two-pane integration tests (parent U10–U13)', () => {
  expect(true).toBe(true)
})
