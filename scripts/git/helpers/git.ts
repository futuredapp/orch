#!/usr/bin/env bun
//
// git.ts — the git half of the release flow: thin, named wrappers over the git
// CLI (through ./shell) so the orchestrator reads as a sequence of intentions.
// Nothing here decides policy; it only reports state and performs single
// git actions.

import { capture, stream, tryRun } from './shell.ts'

export async function currentBranch(): Promise<string> {
  return capture(['git', 'rev-parse', '--abbrev-ref', 'HEAD'])
}

/** Porcelain status lines; empty string when the working tree is clean. */
export async function uncommittedChanges(): Promise<string> {
  return capture(['git', 'status', '--porcelain'])
}

export async function fetch(remote: string, ref: string): Promise<void> {
  await capture(['git', 'fetch', remote, ref])
}

export async function revParse(ref: string): Promise<string> {
  return capture(['git', 'rev-parse', ref])
}

/** Commit count in `base..ref` — i.e. how many commits `ref` is ahead of `base`. */
export async function countCommits(base: string, ref: string): Promise<number> {
  return Number(await capture(['git', 'rev-list', '--count', `${base}..${ref}`]))
}

/** All `v*` tags (lightweight + annotated), unsorted. */
export async function listVersionTags(): Promise<string[]> {
  const out = await capture(['git', 'tag', '--list', 'v*'])
  return out === '' ? [] : out.split('\n')
}

export async function tagExistsLocally(tag: string): Promise<boolean> {
  return (await tryRun(['git', 'rev-parse', '--verify', '--quiet', `refs/tags/${tag}`])).ok
}

export async function tagExistsOnRemote(remote: string, tag: string): Promise<boolean> {
  return (await capture(['git', 'ls-remote', '--tags', remote, tag])) !== ''
}

/** One-line log of `from..HEAD`; when `from` is null, the last 20 commits. */
export async function commitsSince(from: string | null): Promise<string> {
  const range = from === null ? ['-n', '20'] : [`${from}..HEAD`]
  return capture(['git', 'log', '--oneline', '--no-decorate', ...range])
}

export async function createAnnotatedTag(tag: string, message: string, sha: string): Promise<void> {
  await capture(['git', 'tag', '-a', tag, '-m', message, sha])
}

export async function stage(paths: readonly string[]): Promise<void> {
  await capture(['git', 'add', ...paths])
}

export async function hasStagedChanges(): Promise<boolean> {
  return !(await tryRun(['git', 'diff', '--cached', '--quiet'])).ok
}

export async function commit(message: string): Promise<void> {
  await capture(['git', 'commit', '-m', message])
}

/** Push a single ref (branch or tag), streaming git's progress to the terminal. */
export async function pushRef(remote: string, ref: string): Promise<void> {
  await stream(['git', 'push', remote, ref])
}
