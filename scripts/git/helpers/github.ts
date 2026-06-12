#!/usr/bin/env bun
//
// github.ts — the GitHub half of the release flow, over the `gh` CLI. Each
// function performs one operation and returns plain data; the orchestrator
// decides what to do with it. The develop→main PR can be self-merged because
// the release author holds a pull-request-review bypass on `main`; the required
// status checks (check / docs / commitlint) still gate the merge and cannot be
// skipped, which is exactly the safety we want.

import { capture, stream, tryRun } from './shell.ts'

export interface PullRequest {
  readonly number: number
  readonly url: string
  readonly state: string
}

interface MergeState {
  readonly state: string
  readonly mergedAt: string | null
}

/** The single open `head`→`base` PR, or null when none is open. */
export async function findOpenPr(base: string, head: string): Promise<PullRequest | null> {
  const out = await capture([
    'gh', 'pr', 'list', '--base', base, '--head', head, '--state', 'open',
    '--json', 'number,url,state',
  ])
  const list = JSON.parse(out) as PullRequest[]
  return list[0] ?? null
}

/** Resolve a PR (by number, URL, or branch) to structured data. */
export async function viewPr(ref: string): Promise<PullRequest> {
  const out = await capture(['gh', 'pr', 'view', ref, '--json', 'number,url,state'])
  return JSON.parse(out) as PullRequest
}

export async function createPr(
  base: string,
  head: string,
  title: string,
  body: string,
): Promise<PullRequest> {
  const url = await capture([
    'gh', 'pr', 'create', '--base', base, '--head', head, '--title', title, '--body', body,
  ])
  return viewPr(url.trim())
}

export async function isPrMerged(prNumber: number): Promise<boolean> {
  const out = await capture(['gh', 'pr', 'view', String(prNumber), '--json', 'state,mergedAt'])
  const data = JSON.parse(out) as MergeState
  return data.state === 'MERGED' || data.mergedAt !== null
}

const REGISTER_TIMEOUT_MS = 180_000
const REGISTER_INTERVAL_MS = 5_000

/**
 * Block until every required check on the PR has finished, streaming live
 * status to the terminal. Throws (non-zero `gh` exit) if any check fails, so
 * the caller never merges a red PR.
 *
 * `gh pr checks --watch` exits immediately with "no checks reported" when it is
 * called before the check runs register (the race right after opening a PR), so
 * we first poll until at least one check appears, then watch.
 */
export async function watchChecks(prNumber: number): Promise<void> {
  await waitForChecksToRegister(prNumber)
  await stream(['gh', 'pr', 'checks', String(prNumber), '--watch', '--fail-fast'])
}

async function waitForChecksToRegister(prNumber: number): Promise<void> {
  const deadline = Date.now() + REGISTER_TIMEOUT_MS
  while (true) {
    const result = await tryRun(['gh', 'pr', 'checks', String(prNumber)])
    if (!/no checks reported/i.test(`${result.stdout}\n${result.stderr}`)) return
    if (Date.now() >= deadline) {
      throw new Error(
        `no checks registered on PR #${prNumber} after ${REGISTER_TIMEOUT_MS / 1000}s — ` +
          'is a workflow configured to run on this PR?',
      )
    }
    await Bun.sleep(REGISTER_INTERVAL_MS)
  }
}

/** Merge with a merge commit (NOT squash — keeps main == develop content). */
export async function mergePr(prNumber: number): Promise<void> {
  await stream(['gh', 'pr', 'merge', String(prNumber), '--merge'])
}

/** Best-effort: stream the most recent release-workflow run to completion. */
export async function watchLatestReleaseRun(): Promise<void> {
  const list = await tryRun([
    'gh', 'run', 'list', '--workflow', 'release.yml', '--limit', '1', '--json', 'databaseId',
  ])
  if (!list.ok) return
  const runs = JSON.parse(list.stdout) as { databaseId: number }[]
  const id = runs[0]?.databaseId
  if (id === undefined) return
  await stream(['gh', 'run', 'watch', String(id), '--exit-status'])
}
