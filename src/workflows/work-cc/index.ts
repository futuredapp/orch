// Entry module for the `orch::work-cc` built-in (U5).
//
// A thin binding: the shared phased-build pipeline (P2) parameterized with a
// Claude runner. All phase logic lives in `phased-build/pipeline.ts`; this file
// only pins the runner and the workflow name. `work-codex/index.ts` is the same
// binding against Codex — the two variants differ ONLY in the bound runner.
//
// Runner posture: `bare: false` (full agent, not headless) + the skip-permissions
// flag so the interactive autoStop phase loop can write files unattended without
// per-action approval prompts. Mirrors `examples/feature/index.ts:27` and the
// compound example's autonomous Claude construction.

import { claude } from '../../runners/index.ts'
import { buildPhasedWorkflow } from '../phased-build/pipeline.ts'

export default buildPhasedWorkflow(
  'work-cc',
  claude({ bare: false, flags: ['--dangerously-skip-permissions'] }),
)
