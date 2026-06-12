#!/usr/bin/env bun
//
// preflight.ts — the cheap, local, fail-fast gate. Everything here runs BEFORE
// the confirmation prompts and before any remote mutation, so a misconfigured
// release dies on the operator's machine, not half-way through GitHub. The
// blocking assertions throw `PreflightError`; the working-tree state is reported
// (not thrown on) so the orchestrator can turn it into a "continue anyway?"
// prompt — uncommitted changes are a warning, not a hard failure.

import { extractSection } from '../../changelog-section.ts'
import * as git from './git.ts'
import { readPackageVersion } from './package-json.ts'
import { type Version, highestVersion } from './version.ts'

export class PreflightError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PreflightError'
  }
}

export interface ReleaseTopology {
  readonly remote: string
  /** Branch the release is cut from (e.g. `develop`). */
  readonly source: string
  /** Branch the release merges into and is tagged on (e.g. `main`). */
  readonly target: string
}

export interface PreflightOptions {
  /** When true, a version≠package.json mismatch is allowed — the orchestrator
   *  will bump + commit it — so the assertion is skipped here. */
  readonly bump: boolean
}

export interface PreflightResult {
  readonly previous: Version | null
  readonly changelog: string
  readonly commits: string
  /** Porcelain status of the working tree; empty string when clean. */
  readonly uncommitted: string
  /** Current package.json version (before any bump); undefined if unset. */
  readonly packageVersion: string | undefined
}

/** Run every cheap local gate in order, throwing on the first hard failure. */
export async function runPreflight(
  topo: ReleaseTopology,
  next: Version,
  options: PreflightOptions,
): Promise<PreflightResult> {
  await assertOnSourceBranch(topo)
  await assertSyncedWithRemote(topo)
  const packageVersion = await readPackageVersion()
  if (!options.bump) assertVersionMatchesPackage(packageVersion, next)
  await assertTagIsNew(topo, next)

  const changelog = await readChangelog(next)
  const previous = highestVersion(await git.listVersionTags())
  const commits = await git.commitsSince(previous?.tag ?? null)
  const uncommitted = await git.uncommittedChanges()

  return { previous, changelog, commits, uncommitted, packageVersion }
}

// — individual gates —

async function assertOnSourceBranch(topo: ReleaseTopology): Promise<void> {
  const branch = await git.currentBranch()
  if (branch !== topo.source) {
    throw new PreflightError(`must release from "${topo.source}", but HEAD is "${branch}"`)
  }
}

async function assertSyncedWithRemote(topo: ReleaseTopology): Promise<void> {
  await git.fetch(topo.remote, topo.source)
  const behind = await git.countCommits('HEAD', `${topo.remote}/${topo.source}`)
  if (behind > 0) {
    throw new PreflightError(
      `local ${topo.source} is ${behind} commit(s) behind ${topo.remote}/${topo.source} — pull first`,
    )
  }
}

function assertVersionMatchesPackage(packageVersion: string | undefined, next: Version): void {
  if (packageVersion !== next.version) {
    throw new PreflightError(
      `package.json is ${packageVersion ?? '(unset)'} but --version is ${next.version} — ` +
        'bump package.json (and finalise the CHANGELOG) first, or pass --bump',
    )
  }
}

async function assertTagIsNew(topo: ReleaseTopology, next: Version): Promise<void> {
  if (await git.tagExistsLocally(next.tag)) {
    throw new PreflightError(`tag ${next.tag} already exists locally`)
  }
  if (await git.tagExistsOnRemote(topo.remote, next.tag)) {
    throw new PreflightError(`tag ${next.tag} already exists on ${topo.remote}`)
  }
}

/** Heading + body for `next`; throws (via extractSection) if missing or a stub. */
async function readChangelog(next: Version): Promise<string> {
  const text = await Bun.file('CHANGELOG.md').text()
  const section = extractSection(text, next.version)
  return `${section.heading}\n\n${section.body}`
}
