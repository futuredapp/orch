import {
  ParallelError,
  SchemaValidationError,
  StepError,
  ViewResolutionError,
} from '../../core/index.ts'
import type { WorkflowArgs, WorkflowDeps } from '../../core/workflow.ts'
import { HostCreationError } from '../../hosts/index.ts'
import {
  buildRunMeta,
  instrumentProcessService,
  orchVersion,
  renderRunReadme,
  type SessionLogger,
} from '../../observability/index.ts'
import { createTranscriptSidecar, generateRunId } from '../../state/index.ts'
import type { CliDeps } from '../deps.ts'
import { type CliOpts, EXIT, type HostFactory } from '../main.ts'
import { executeWithAttach } from './execute-with-attach.ts'
import { isLoadError, loadWorkflow } from './load-workflow.ts'
import { relativeRunDir } from './relative-run-dir.ts'

const PROMPT_PREVIEW_MAX = 80

function formatPromptPreview(prompt: string): string {
  const normalized = prompt.replace(/\s+/g, ' ').trim()
  if (normalized.length <= PROMPT_PREVIEW_MAX) return normalized
  return `${normalized.slice(0, PROMPT_PREVIEW_MAX - 1)}…`
}

function mapRunError(err: unknown): { code: number; reason: string } | undefined {
  if (err instanceof ViewResolutionError) {
    return { code: EXIT.CONFIG_ERROR, reason: err.message }
  }
  if (
    err instanceof StepError ||
    err instanceof SchemaValidationError ||
    err instanceof ParallelError
  ) {
    return { code: EXIT.STEP_FAILURE, reason: err.message }
  }
  return undefined
}

async function writeRunPreamble(
  logger: SessionLogger,
  ctx: {
    readonly runId: string
    readonly workflowName: string
    readonly mode: string
    readonly debug: boolean
    readonly argv: readonly string[]
    readonly env: Readonly<Record<string, string | undefined>>
    readonly startedAtIso: string
    readonly emitEnvValues: boolean
  },
): Promise<void> {
  const version = await orchVersion()
  const meta = buildRunMeta({
    runId: ctx.runId,
    workflowName: ctx.workflowName,
    argv: ctx.argv,
    env: ctx.env,
    mode: ctx.mode,
    debug: ctx.debug,
    orchVersion: version,
    os: process.platform,
    startedAtIso: ctx.startedAtIso,
    emitEnvValues: ctx.emitEnvValues,
  })
  await logger.writeFile('run.meta.json', `${JSON.stringify(meta, null, 2)}\n`)
  await logger.writeFile(
    'README.md',
    renderRunReadme({
      runId: ctx.runId,
      workflowName: ctx.workflowName,
      mode: ctx.mode,
      debug: ctx.debug,
      startedAt: ctx.startedAtIso,
      orchVersion: version,
    }),
  )
}

export async function runCmd(
  deps: CliDeps,
  name: string,
  args: WorkflowArgs,
  opts: CliOpts,
  hostFactory: HostFactory,
): Promise<number> {
  if (!name) {
    process.stderr.write('Usage: orch run <name> [prompt]\n')
    return EXIT.CONFIG_ERROR
  }

  const result = await loadWorkflow(deps.cwd, name)
  if (isLoadError(result)) return result.code

  const runId = generateRunId({ clock: deps.clock })
  const promptSuffix =
    args.prompt !== undefined ? ` with prompt: "${formatPromptPreview(args.prompt)}"` : ''
  process.stderr.write(`Running workflow "${name}" (${runId})${promptSuffix}...\n`)

  const logger = deps.sessionLoggerFor(runId)
  const startedAtIso = new Date(deps.clock.now()).toISOString()

  try {
    await writeRunPreamble(logger, {
      runId,
      workflowName: name,
      mode: opts.mode ?? 'plain',
      debug: deps.debug,
      argv: process.argv,
      env: process.env,
      startedAtIso,
      emitEnvValues: process.env.ORCH_LOG_ENV_VALUES === '1',
    })

    const instrumentedProcess = instrumentProcessService(deps.processService, {
      logger,
      clock: deps.clock,
    })

    let host: Awaited<ReturnType<HostFactory>>
    try {
      host = await hostFactory({
        runId,
        workflowName: name,
        stdout: process.stdout,
        stderr: process.stderr,
        clock: deps.clock,
        logger,
        processService: instrumentedProcess,
        fs: deps.fsService,
        stateStore: deps.stateStore,
      })
    } catch (err) {
      if (err instanceof HostCreationError) {
        process.stderr.write(`${err.message}\n`)
        return EXIT.CONFIG_ERROR
      }
      throw err
    }

    const transcriptSidecar = createTranscriptSidecar({
      fs: deps.fsService,
      runId,
      basePath: deps.statePath,
    })

    const wfDeps: WorkflowDeps = {
      stateStore: deps.stateStore,
      processService: instrumentedProcess,
      clock: deps.clock,
      runId,
      cwd: deps.cwd,
      fsService: deps.fsService,
      gitService: deps.gitService,
      workflowName: name,
      args,
      host,
      transcriptSidecar,
      logger,
      promptService: deps.promptServiceFor(host.mode),
      interactivity: opts.interactivity,
    }

    return await executeWithAttach({
      host,
      workflow: result.executor.execute(wfDeps),
      runId,
      stderr: process.stderr,
      mapError: mapRunError,
      summary: { workflowName: name, runDir: relativeRunDir(deps.cwd, deps.statePath, runId) },
      logger,
    })
  } finally {
    await logger.close()
  }
}
