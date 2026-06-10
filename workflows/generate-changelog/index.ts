/**
 * generate-changelog — draft/update CHANGELOG.md from the commit history since
 * the last version tag. A real, shipped dogfooding example of orch (R17).
 *
 * Pipeline (one step):
 *   1. changelog   autonomous claude, reads commits via its own git bash and
 *                  rewrites CHANGELOG.md per workflows/generate-changelog/
 *                  changelog.prompt.md. Does NOT commit.
 *
 * ⚠️  PERMISSION MODEL — read before running. This launches a FULLY AUTONOMOUS
 * Claude Code session with `--dangerously-skip-permissions`: it has unrestricted
 * read/write access to your filesystem and can run arbitrary shell commands in
 * this repository with no per-action approval. `IS_SANDBOX=1` (set below) is NOT
 * a sandbox or a guard — it is only the marker the Claude CLI checks before it
 * will accept `--dangerously-skip-permissions`. Run this only in a repo checkout
 * you trust, as the maintainer, at release time.
 *
 * This is a MAINTAINER-ONLY, run-from-source workflow: like new-feature/do-work
 * it imports orch via relative `../../src/...` paths, so it is not bundled into
 * (or runnable from) the brew binary — and does not need to be.
 *
 * Usage:
 *   bunx orch run generate-changelog
 *   bunx orch run generate-changelog "v0.1.0..HEAD as v0.2.0"
 */

import { step, workflow } from '../../src/core/index.ts'
import { claude } from '../../src/runners/index.ts'

export default workflow('generate-changelog', async (run, args) => {
  // Set inside the body (not at module import) so importing this workflow in a
  // test does not mutate the global process.env. The Claude runner builds its
  // subprocess env via mergeEnv(process.env, …), so setting it here — before
  // the step spawns — propagates IS_SANDBOX to the spawned CLI, which it needs
  // to accept --dangerously-skip-permissions.
  process.env.IS_SANDBOX = '1'

  // args.prompt optionally carries an explicit commit range and/or target
  // version; when absent the prompt instructs the agent to derive the range as
  // "commits since the most recent v* tag" itself.
  const request = args.prompt?.trim() ?? ''

  const changelogStep = step.define('changelog', {
    agent: claude({ bare: false, flags: ['--dangerously-skip-permissions', '--name', 'changelog'] }),
    promptFile: 'changelog.prompt.md',
  })

  await run(changelogStep, {
    vars: { request: request === '' ? '(none given — derive the range yourself)' : request },
  })
})
