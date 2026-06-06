/**
 * `orch.config.ts` for the Tier 5 lifecycle fixtures.
 *
 * `findConfigPath` walks up from the orch subprocess's cwd; when the
 * launcher sets `cwd = tests/fixtures/lifecycle/`, this is the first match
 * (no `.orch/orch.config.ts` sibling). The workflow names declared here are
 * the strings the launcher passes as `bun src/cli/main.ts run <name> ...`.
 *
 * Workflow paths are resolved relative to this config file's directory —
 * the project-root `orch.config.ts` is NOT consulted because the upward
 * walk stops at the first match.
 */

import { defineConfig } from '../../../../src/config/index.ts'

export const config = defineConfig({
  workflows: {
    'tier5-two-step-linear': 'two-step-linear.ts',
    'behavioral-single-agent-step': 'single-agent-step.ts',
    'behavioral-three-step-linear': 'three-step-linear.ts',
    'behavioral-worktree-then-agent': 'worktree-then-agent.ts',
    'behavioral-worktree-with-post-create': 'worktree-with-post-create.ts',
    'behavioral-agent-then-commit': 'agent-then-commit.ts',
    'behavioral-command-step-only': 'command-step-only.ts',
    'behavioral-ask-with-default': 'ask-with-default.ts',
    'behavioral-puppet-can-fail': 'puppet-can-fail.ts',
    'behavioral-resumable-crash': 'resumable-crash.ts',
  },
})
