#!/usr/bin/env bun
//
// release.ts — cut a release. Opens the develop→main PR, waits for the required
// checks, merges, then tags the merge commit on main — and the v* tag push is
// what triggers the release pipeline (.github/workflows/release.yml fires on
// `push: tags: ['v*']`).
//
// Flow (Option A — one blocking script; see docs/brainstorms/…release-script):
//   preflight (local, cheap) → confirm dirty tree? → confirm release → check → remote
//
// Why this order:
//   - The tag MUST point at the merge commit on `main`, so it is created AFTER
//     the merge — never on `develop` (that would release pre-merge state).
//   - `main`'s required checks cannot be bypassed; they always gate the merge.
//     The release author's PR-review bypass only removes the second-approver
//     requirement, which is what lets one script run end-to-end.
//
// Usage:
//   bun scripts/git/release.ts --version 0.1.3
//   bun scripts/git/release.ts --version 0.1.3 --bump     # write+commit package.json
//   bun scripts/git/release.ts --version v0.1.3 --yes --watch
//   bun scripts/git/release.ts --version 0.1.3 --skip-check
//
// --bump writes --version into package.json and commits package.json +
// CHANGELOG.md to develop as `chore(release): vX.Y.Z` before pushing, so the
// version bump and the finalised changelog actually ship. Without --bump the
// script only validates that package.json already matches.
//
// Idempotent: a re-run reuses the open PR, skips the merge when the PR is
// already merged, and skips tag creation when the tag already exists — so an
// interrupted run resumes cleanly.

import { parseArgs } from 'node:util'
import { confirmDirtyTree, confirmRelease } from './helpers/confirm.ts'
import * as git from './helpers/git.ts'
import * as gh from './helpers/github.ts'
import { writePackageVersion } from './helpers/package-json.ts'
import { type ReleaseTopology, runPreflight } from './helpers/preflight.ts'
import { stream } from './helpers/shell.ts'
import { type Version, parseVersion } from './helpers/version.ts'

const TOPOLOGY: ReleaseTopology = { remote: 'origin', source: 'develop', target: 'main' }
const ACTIONS_URL = 'https://github.com/futuredapp/orch/actions/workflows/release.yml'
// Files the --bump commit owns; excluded from the "won't ship" dirty warning.
const RELEASE_FILES = ['package.json', 'CHANGELOG.md']

interface Options {
  readonly version: Version
  readonly autoYes: boolean
  readonly skipCheck: boolean
  readonly watch: boolean
  readonly bump: boolean
}

async function main(): Promise<void> {
  const opts = parseOptions(Bun.argv.slice(2))

  // 1. Cheap local gate (branch, sync, version↔package.json, tag, changelog).
  const pre = await runPreflight(TOPOLOGY, opts.version, { bump: opts.bump })

  // 2. If the tree is dirty, list the changes and confirm — they won't ship.
  //    Under --bump, package.json + CHANGELOG.md are committed below, so they
  //    are excluded from this "won't ship" warning.
  const dirt = opts.bump ? excludeReleaseFiles(pre.uncommitted) : pre.uncommitted
  if (dirt !== '' && !confirmDirtyTree(dirt, opts.autoYes)) {
    console.log('Aborted — commit or stash your changes first.')
    return
  }

  // 3. Human reviews version + the exact notes before anything leaves the box.
  const willBump = opts.bump && pre.packageVersion !== opts.version.version
  const proceed = confirmRelease(
    {
      previous: pre.previous,
      next: opts.version,
      packageVersion: pre.packageVersion,
      willBump,
      changelog: pre.changelog,
      commits: pre.commits,
    },
    opts.autoYes,
  )
  if (!proceed) {
    console.log('Aborted — nothing pushed.')
    return
  }

  // 4. Bump + commit package.json (and CHANGELOG.md) so the version ships.
  if (opts.bump) await bumpAndCommit(opts.version)

  // 5. Full suite locally (the remote re-runs it, but fail fast on this machine).
  if (opts.skipCheck) {
    console.log('Skipping `bun run check` (--skip-check) — relying on the remote required checks.')
  } else {
    console.log('Running `bun run check`…')
    await stream(['bun', 'run', 'check'])
  }

  // 6. Remote: push source, open/reuse PR, wait + merge, tag the merge commit.
  await git.pushRef(TOPOLOGY.remote, TOPOLOGY.source)
  const pr = await ensurePr(opts.version, pre.changelog)
  await mergeWhenGreen(pr)
  await tagRelease(opts.version)

  console.log(`\n✅ ${opts.version.tag} pushed — the release pipeline is running.`)
  console.log(`   ${ACTIONS_URL}`)
  if (opts.watch) {
    console.log('Watching the release run…')
    await gh.watchLatestReleaseRun()
  }
}

// — release phases —

/** Write the version into package.json and commit it (with CHANGELOG.md). */
async function bumpAndCommit(version: Version): Promise<void> {
  await writePackageVersion(version.version)
  await git.stage(RELEASE_FILES)
  if (await git.hasStagedChanges()) {
    await git.commit(`chore(release): ${version.tag}`)
    console.log(`Committed release prep: chore(release): ${version.tag}`)
  } else {
    console.log('package.json + CHANGELOG.md already committed — nothing to bump.')
  }
}

/** Reuse the open develop→main PR, or open one with the changelog as its body. */
async function ensurePr(version: Version, notes: string): Promise<gh.PullRequest> {
  const existing = await gh.findOpenPr(TOPOLOGY.target, TOPOLOGY.source)
  if (existing !== null) {
    console.log(`Reusing open PR #${existing.number} — ${existing.url}`)
    return existing
  }
  const created = await gh.createPr(TOPOLOGY.target, TOPOLOGY.source, `Release ${version.tag}`, notes)
  console.log(`Opened PR #${created.number} — ${created.url}`)
  return created
}

/** Wait for the required checks, then merge — unless the PR is already merged. */
async function mergeWhenGreen(pr: gh.PullRequest): Promise<void> {
  if (await gh.isPrMerged(pr.number)) {
    console.log(`PR #${pr.number} is already merged — skipping checks + merge`)
    return
  }
  console.log(`Waiting for required checks on PR #${pr.number}…`)
  await gh.watchChecks(pr.number)
  console.log(`Checks are green — merging PR #${pr.number}`)
  await gh.mergePr(pr.number)
}

/** Tag the merge commit on `target` and push it to trigger the release. */
async function tagRelease(version: Version): Promise<void> {
  if (await git.tagExistsOnRemote(TOPOLOGY.remote, version.tag)) {
    console.log(`Tag ${version.tag} is already on ${TOPOLOGY.remote} — release already triggered`)
    return
  }
  await git.fetch(TOPOLOGY.remote, TOPOLOGY.target)
  const sha = await git.revParse(`${TOPOLOGY.remote}/${TOPOLOGY.target}`)
  if (!(await git.tagExistsLocally(version.tag))) {
    await git.createAnnotatedTag(version.tag, `Release ${version.tag}`, sha)
  }
  console.log(`Tagging ${TOPOLOGY.target}@${sha.slice(0, 9)} as ${version.tag} and pushing…`)
  await git.pushRef(TOPOLOGY.remote, version.tag)
}

// — entrypoint plumbing —

/** Drop the release-owned files from a porcelain status block. */
function excludeReleaseFiles(porcelain: string): string {
  const owned = new Set(RELEASE_FILES)
  return porcelain
    .split('\n')
    .filter((line) => line !== '' && !owned.has(line.slice(3).trim()))
    .join('\n')
}

function parseOptions(argv: string[]): Options {
  const { values } = parseArgs({
    args: argv,
    options: {
      version: { type: 'string' },
      yes: { type: 'boolean', default: false },
      'skip-check': { type: 'boolean', default: false },
      watch: { type: 'boolean', default: false },
      bump: { type: 'boolean', default: false },
    },
    strict: true,
    allowPositionals: false,
  })
  if (values.version === undefined) fail('missing required --version <vM.M.P|M.M.P>')
  return {
    version: parseVersion(values.version),
    autoYes: values.yes,
    skipCheck: values['skip-check'],
    watch: values.watch,
    bump: values.bump,
  }
}

function fail(message: string): never {
  console.error(`release: ${message}`)
  process.exit(1)
}

if (import.meta.main) {
  try {
    await main()
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err))
  }
}
