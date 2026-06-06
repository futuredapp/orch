import { expect, it } from 'bun:test'

// Sentinel — NOT real coverage. `tests-new/e2e/` is the relocation home for the
// non-two-pane real-CLI e2e tests (parent U13: resume-real-claude, steps-tui-e2e,
// workflows, cli). It is empty until then, but `bun test` exits non-zero on a dir
// with no test files, which would turn the `test:new-e2e` gate bucket red. This
// passing assertion keeps it green during the migration window.
//
// DELETE this file the moment the first real e2e test relocates here.

it('tests-new/e2e is reserved for relocated non-two-pane e2e tests (parent U13)', () => {
  expect(true).toBe(true)
})
