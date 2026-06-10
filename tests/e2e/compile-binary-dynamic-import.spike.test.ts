// Spike gate for binary packaging (R5–R10 prerequisite).
//
// Proves that a `bun build --compile` standalone binary preserves orch's
// runtime dynamic-import behavior: with no Bun and no node_modules on PATH, the
// embedded runtime can scaffold, load, and execute a TypeScript workflow whose
// files import from the bare `'orch'` specifier.
//
// SLOW: compiles a ~59 MB binary. Gated off the `bun run check` gate behind
// RUN_SPIKE=1 — same pattern as the real-CLI e2e tests. Run it with:
//   RUN_SPIKE=1 bun test tests/e2e/compile-binary-dynamic-import.spike.test.ts
//
// The heavy lifting lives in scripts/spike/run-spike.sh; this test asserts the
// script reaches its GREEN gate so the spike is repeatable in CI on demand.

import { describe, expect, it } from 'bun:test'

const canRun = process.env.RUN_SPIKE === '1' && Bun.which('bun') !== null

describe.skipIf(!canRun)('compiled binary dynamic-imports external TS workflows (spike)', () => {
  it('scaffolds and runs a bare-orch-importing workflow with no Bun on PATH', async () => {
    const proc = Bun.spawn(['bash', 'scripts/spike/run-spike.sh'], {
      cwd: new URL('../..', import.meta.url).pathname,
      stdout: 'pipe',
      stderr: 'pipe',
    })

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    const output = stdout + stderr

    expect(output, output).toContain('SPIKE GATE: GREEN')
    expect(output).toContain('never prompted to install Bun: ok')
    expect(exitCode).toBe(0)
  }, 120_000)
})
