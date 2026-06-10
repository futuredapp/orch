// Compiled-binary entry point.
//
// This file exists ONLY to be the entrypoint of `bun build --compile`. It is
// NOT used by `bunx orch` / `bun link` (that path keeps using `main.ts`, which
// resolves the bare `'orch'` specifier from the host project's node_modules).
//
// Why a separate entry: a standalone binary installed from Homebrew has no
// `node_modules/orch` on disk, so when the embedded Bun runtime dynamically
// imports a user's `.orch/workflows/*.ts` (which do `import { workflow } from
// 'orch'`), the bare specifier has nothing to resolve against. We register a
// runtime module resolver that maps `'orch'` to the API we embed at compile
// time, so user workflows, steps files, and `orch.config.ts` all resolve the
// same public surface they would in a dev checkout.
//
// See `docs/issues/2026-06-06-spike-compile-dynamic-import.md` for the spike
// that validated this approach.

import * as orchApi from '../index.ts'
import { main } from './main.ts'

/**
 * Register the bare-`'orch'` resolver before any command runs. `build.module`
 * with `loader: 'object'` hands the embedded namespace straight back, so
 * `import { workflow, step, claude, z } from 'orch'` inside a dynamically
 * imported user file resolves to exactly the same objects the binary shipped.
 */
function registerOrchResolver(): void {
  Bun.plugin({
    name: 'orch-bare-resolver',
    setup(build) {
      build.module('orch', () => ({ exports: orchApi, loader: 'object' }))
    },
  })
}

if (import.meta.main) {
  registerOrchResolver()
  main()
}
