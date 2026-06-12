#!/usr/bin/env bun
//
// shell.ts — the only subprocess seam for the release scripts. Wraps Bun.spawn
// in three shapes so the orchestrator reads as intentions, not argv plumbing:
//
//   - capture : run, return trimmed stdout, throw on non-zero  (queries)
//   - tryRun  : run, never throw, hand back the full result    (branch on it)
//   - stream  : run with the terminal attached, throw on non-zero
//               (long commands whose live output the operator should watch:
//                `gh pr checks --watch`, `bun run check`, `git push`)

export class CommandError extends Error {
  constructor(
    readonly command: readonly string[],
    readonly exitCode: number,
    readonly stderr: string,
  ) {
    const tail = stderr.trim() === '' ? '' : `: ${stderr.trim()}`
    super(`\`${command.join(' ')}\` exited ${exitCode}${tail}`)
    this.name = 'CommandError'
  }
}

export interface RunResult {
  readonly ok: boolean
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

async function collect(command: readonly string[]): Promise<RunResult> {
  const proc = Bun.spawn([...command], { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { ok: exitCode === 0, stdout: stdout.trim(), stderr: stderr.trim(), exitCode }
}

/** Run a command, return trimmed stdout, throw `CommandError` on non-zero. */
export async function capture(command: readonly string[]): Promise<string> {
  const result = await collect(command)
  if (!result.ok) throw new CommandError(command, result.exitCode, result.stderr)
  return result.stdout
}

/** Run a command without throwing; callers branch on the result. */
export async function tryRun(command: readonly string[]): Promise<RunResult> {
  return collect(command)
}

/** Run a command with the terminal attached (live output); throw on non-zero. */
export async function stream(command: readonly string[]): Promise<void> {
  const proc = Bun.spawn([...command], { stdout: 'inherit', stderr: 'inherit', stdin: 'inherit' })
  const exitCode = await proc.exited
  if (exitCode !== 0) throw new CommandError(command, exitCode, '')
}
