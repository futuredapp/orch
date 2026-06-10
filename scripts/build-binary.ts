#!/usr/bin/env bun
//
// build-binary.ts — compile a self-contained `orch` binary for one platform.
//
// Usage:
//   bun scripts/build-binary.ts                 # host platform -> dist/orch
//   bun scripts/build-binary.ts --target bun-linux-x64 --outfile dist/orch-linux-x64
//
// This is the build half of R5 (`bun build --compile` standalone binaries).
// It exists as a script — not a raw `bun build` CLI call — for two reasons the
// spike (docs/issues/2026-06-06-spike-compile-dynamic-import.md) surfaced:
//
//   1. ink statically imports the optional `react-devtools-core` dev package
//      from `devtools.js`. Bun's bundler eagerly resolves the dynamic
//      `import('./devtools.js')` target even though it is gated behind
//      `process.env.DEV === 'true'` at runtime, so the compile fails with
//      "Could not resolve react-devtools-core". A build-time plugin stubs it
//      to an empty module; the devtools branch never executes in a release
//      binary anyway.
//
//   2. The entrypoint is `src/cli/bin.ts` (NOT `main.ts`) because the binary
//      needs the runtime bare-`'orch'` resolver registered before any user
//      workflow is dynamically imported.
//
// Bun build plugins can only be passed through the JS API, not the
// `bun build --compile` CLI — hence this script.
//
// Built-in workflows (`orch::work-cc`, `orch::work-codex`) are embedded via the
// static `BUILTIN_IMPORTS` thunk map in `src/workflows/registry.ts`, reachable
// from this entrypoint through `bin.ts → main.ts → load-workflow.ts`. The
// bundler traces those static `import('./work-cc/index.ts')` specifiers and
// bundles each built-in as a lazy chunk. Do NOT switch built-in loading back to
// a runtime path-join (resolveBuiltin's display path) for the *import* step:
// the bundler can't see a runtime-constructed path, so the built-in would
// ENOENT in the binary (the R-3 risk). Add a new built-in by extending that
// map; no change is needed here.

import { parseArgs } from 'node:util'
import type { BunPlugin } from 'bun'

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    target: { type: 'string' }, // e.g. bun-darwin-arm64, bun-darwin-x64, bun-linux-x64
    outfile: { type: 'string', default: 'dist/orch' },
  },
  strict: true,
  allowPositionals: false,
})

/**
 * Replace ink's optional `react-devtools-core` import with an empty module.
 * The devtools path is dev-only (`DEV=true`) and never runs in a release
 * binary, but the bundler still tries to resolve the static import.
 */
const stubReactDevtools: BunPlugin = {
  name: 'stub-react-devtools-core',
  setup(build) {
    build.onResolve({ filter: /^react-devtools-core$/ }, () => ({
      path: 'react-devtools-core',
      namespace: 'stub-devtools',
    }))
    build.onLoad({ filter: /.*/, namespace: 'stub-devtools' }, () => ({
      contents: 'export default {}',
      loader: 'js',
    }))
  },
}

const result = await Bun.build({
  entrypoints: ['src/cli/bin.ts'],
  plugins: [stubReactDevtools],
  compile: {
    outfile: values.outfile,
    ...(values.target ? { target: values.target as `bun-${string}` } : {}),
  },
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

console.log(`Built ${values.outfile}${values.target ? ` (${values.target})` : ''}`)
