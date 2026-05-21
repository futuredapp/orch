// orch — public barrel.
//
// Re-exports the module-level barrels so consumers can `import { ... } from 'orch'`.
// This file is re-exports only: no logic, no side effects at import time.

// Re-export Zod so workflows can author schemas without adding `zod` to the
// host project's package.json. Authors write `import { z, schema } from 'orch'`
// — the symlinked / installed orch package brings zod with it. Users who
// import directly `from 'zod'` still work as long as they install it
// themselves; `orch init` warns when it sees that pattern.
export { z } from 'zod'
export * from './config/index.ts'
export * from './core/index.ts'
export * from './runners/index.ts'
export * from './services/index.ts'
// Resolve ambiguous names produced by overlapping star exports.
// core/index re-exports Path/path from services and RunId/runId from state,
// so the star exports above collide. Explicit re-exports take precedence.
export { type Path, path } from './services/index.ts'
export * from './state/index.ts'
export { generateRunId, type RunId, runId } from './state/index.ts'
export * from './validators/index.ts'
