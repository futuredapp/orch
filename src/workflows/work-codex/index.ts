// Entry module for the `orch::work-codex` built-in (U5).
//
// The Codex twin of `work-cc`: the same shared phased-build pipeline (P2),
// bound to a Codex runner instead. Phase logic lives entirely in
// `phased-build/pipeline.ts`; the two variants differ ONLY in the bound runner.
//
// Runner posture (R-6): `codex` is NOT option-symmetric with `claude` — there is
// no `bare`, and the autonomy/permission posture is the `sandbox` field, not a
// `--dangerously-skip-permissions` flag (which the Codex flag denylist would
// reject anyway). `sandbox: 'full-auto'` is the unattended-write posture: it
// grants workspace write access and auto-approves so the interactive autoStop
// phase loop runs without approval prompts — the closest Codex analog to
// work-cc's skip-permissions. (It is also Codex's default; pinned explicitly
// here to document the autonomy decision rather than inherit it silently.)

import { codex } from '../../runners/index.ts'
import { buildPhasedWorkflow } from '../phased-build/pipeline.ts'

export default buildPhasedWorkflow('work-codex', codex({ sandbox: 'full-auto' }))
