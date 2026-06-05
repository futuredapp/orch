/**
 * Workflow-fixture registry — maps a fixture name (e.g. `'two-step-linear'`)
 * to the on-disk fixture directory containing its `orch.config.ts` and the
 * workflow name `bun src/cli/main.ts run <name>` should invoke.
 *
 * The launcher (U4) reads `cwd` and `workflowName` off the resolved
 * `FixtureLocation` to spawn orch correctly.
 */

import * as nodePath from 'node:path'
import { type Path, path as toPath } from '../../../../src/services/types.ts'

export interface FixtureLocation {
  /** Directory containing `orch.config.ts` for the fixture. Passed as orch's `cwd`. */
  readonly cwd: Path
  /** Workflow name the orch CLI resolves against `orch.config.ts`. */
  readonly workflowName: string
}

const FIXTURES_DIR = nodePath.resolve(import.meta.dir, '../../../../tests/fixtures/lifecycle')

const REGISTRY: Readonly<Record<string, FixtureLocation>> = {
  'two-step-linear': {
    cwd: toPath(FIXTURES_DIR),
    workflowName: 'tier5-two-step-linear',
  },
  'single-agent-step': {
    cwd: toPath(FIXTURES_DIR),
    workflowName: 'behavioral-single-agent-step',
  },
  'three-step-linear': {
    cwd: toPath(FIXTURES_DIR),
    workflowName: 'behavioral-three-step-linear',
  },
  'worktree-then-agent': {
    cwd: toPath(FIXTURES_DIR),
    workflowName: 'behavioral-worktree-then-agent',
  },
  'worktree-with-post-create': {
    cwd: toPath(FIXTURES_DIR),
    workflowName: 'behavioral-worktree-with-post-create',
  },
  'agent-then-commit': {
    cwd: toPath(FIXTURES_DIR),
    workflowName: 'behavioral-agent-then-commit',
  },
  'command-step-only': {
    cwd: toPath(FIXTURES_DIR),
    workflowName: 'behavioral-command-step-only',
  },
  'ask-with-default': {
    cwd: toPath(FIXTURES_DIR),
    workflowName: 'behavioral-ask-with-default',
  },
  'puppet-can-fail': {
    cwd: toPath(FIXTURES_DIR),
    workflowName: 'behavioral-puppet-can-fail',
  },
  'resumable-crash': {
    cwd: toPath(FIXTURES_DIR),
    workflowName: 'behavioral-resumable-crash',
  },
}

export const resolveFixture = (fixtureName: string): FixtureLocation => {
  const entry = REGISTRY[fixtureName]
  if (entry === undefined) {
    const available = Object.keys(REGISTRY).join(', ')
    throw new Error(
      `resolveFixture: no fixture named "${fixtureName}" (available: ${available || '(none)'})`,
    )
  }
  return entry
}
