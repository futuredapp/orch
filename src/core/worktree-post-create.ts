// ---------------------------------------------------------------------------
// runPostCreate — sugar (string[]) and callback forms.
// ---------------------------------------------------------------------------
//
// Extracted from worktree.ts on the 300-line guideline. The post-create runner
// is its own concept (subprocess wiring + ORIGIN/TARGET env contract) and
// shouldn't crowd the step factory's validation logic.

import { mergeEnv, type ProcessService } from '../services/index.ts'
import { type PostCreateCtx, PostCreateExecError, type PostCreateHook } from './step.ts'
import type { Path } from './types.ts'

interface PostCreateRuntime {
  readonly origin: Path
  readonly target: Path
  readonly processService: ProcessService
}

export async function runPostCreate(hook: PostCreateHook, ctx: PostCreateRuntime): Promise<void> {
  if (Array.isArray(hook)) {
    await runSugarLines(hook, ctx)
    return
  }
  const callback = hook as (ctx: PostCreateCtx) => Promise<void>
  await callback({ origin: ctx.origin, target: ctx.target, exec: makeExec(ctx) })
}

async function runSugarLines(lines: ReadonlyArray<string>, ctx: PostCreateRuntime): Promise<void> {
  const env = mergeEnv(process.env, { ORIGIN: ctx.origin, TARGET: ctx.target }, {})
  for (const line of lines) {
    const argv = ['/bin/sh', '-c', line]
    await runOne(argv, ctx.target, env, ctx.processService)
  }
}

function makeExec(ctx: PostCreateRuntime): PostCreateCtx['exec'] {
  return async (argv, opts) => {
    if (argv.length === 0) {
      throw new Error('postCreate exec: argv must not be empty')
    }
    const env = mergeEnv(process.env, { ORIGIN: ctx.origin, TARGET: ctx.target }, {})
    const cwd = opts?.cwd ?? ctx.target
    await runOne([...argv], cwd, env, ctx.processService)
  }
}

async function runOne(
  argv: readonly string[],
  cwd: Path,
  env: Readonly<Record<string, string>>,
  processService: ProcessService,
): Promise<void> {
  const handle = processService.spawn({ argv: [...argv], cwd, env })
  const stderrBuf: string[] = []
  const drainStdout = drain(handle.stdout)
  const drainStderr = (async () => {
    for await (const chunk of handle.stderr) stderrBuf.push(chunk)
  })()
  await Promise.all([drainStdout, drainStderr])
  const { exitCode } = await handle.wait()
  if (exitCode !== 0) {
    throw new PostCreateExecError(argv, exitCode, stderrBuf.join('\n'))
  }
}

/** Consume an async iterable to completion, discarding values. */
async function drain(it: AsyncIterable<unknown>): Promise<void> {
  const iterator = it[Symbol.asyncIterator]()
  let done = false
  while (!done) {
    const result = await iterator.next()
    done = result.done === true
  }
}
