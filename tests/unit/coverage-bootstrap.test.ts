import { test } from 'bun:test'
import { Glob } from 'bun'

// Forces all src/ files to be loaded so files with no direct test coverage
// still appear in the report (rather than being silently omitted).
// Safe because rule 8 prohibits side effects at module import time.
// Entry-point files (ink-runner, scripted-fake entries) are excluded because
// they intentionally call main() at module level as subprocess entry points.
const ENTRY_POINT_SUFFIXES = ['ink-runner.ts', 'interactive-entry.ts', '__entry.ts']

test('loads all source modules so they appear in the coverage report', async () => {
  const glob = new Glob('src/**/*.ts')
  for await (const file of glob.scan({ cwd: process.cwd(), absolute: true })) {
    if (
      !file.includes('.test.') &&
      !file.endsWith('.d.ts') &&
      !ENTRY_POINT_SUFFIXES.some((suffix) => file.endsWith(suffix))
    ) {
      await import(file)
    }
  }
})
