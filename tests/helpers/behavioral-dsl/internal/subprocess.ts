/**
 * Internal subprocess helpers — spawn orch via `BunProcessService` with
 * `rawStreams: true`, parse `runId` from stderr, derive the tmux socket.
 *
 * Consumed by `launch.ts`'s `launchOrchWorkflow`. Tests MUST NOT import this
 * file directly — go through `tests/helpers/behavioral-dsl/index.ts`.
 */

import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as nodePath from 'node:path'
import {
  BunProcessService,
  mergeEnv,
  type SpawnHandle,
} from '../../../../src/services/process/index.ts'
import { path as toPath } from '../../../../src/services/types.ts'
import type {
  AgentControl,
  BringToStateRequest,
  OrchHandle,
  RunId,
  Socket,
} from './lifecycle-handle.ts'
import { resolveFixture } from './workflow-fixtures.ts'

// Anchor the runId line that `src/cli/commands/run.ts:104` writes to stderr:
//   Running workflow "<name>" (r-YYYY-MM-DD-HHMMSS-xx)[ with prompt: …]...
// On resume, `src/cli/commands/resume.ts:172` writes:
//   Resuming run r-YYYY-MM-DD-HHMMSS-xx...
const RUNID_LINE_RE =
  /(?:Running workflow "[^"]+" \(|Resuming run )(r-\d{4}-\d{2}-\d{2}-\d{6}-[a-z0-9]{2})/

const DEFAULT_SPAWN_TO_RUNID_TIMEOUT_MS = 10_000
const DEFAULT_BRING_TO_STATE_TIMEOUT_MS = 15_000
const DEFAULT_STATE_POLL_INTERVAL_MS = 50

const ORCH_LIFECYCLE_SCRIPT_ENV = 'ORCH_LIFECYCLE_SCRIPT'
const ORCH_STATE_BASE_ENV = 'ORCH_STATE_BASE'

export interface SpawnOrchOptions {
  readonly workflowFixture: string
  /**
   * Per-step script keyed by step name. Serialized to
   * `<stateBase>/script.json` and passed via `ORCH_LIFECYCLE_SCRIPT`. Each
   * value is a `StepScript` from `src/runners/scripted-fake/types.ts`. Shape
   * kept loose here so this file does not import the runner module across
   * the harness/runner seam at type-position.
   */
  readonly script?: Readonly<Record<string, unknown>>
  readonly mode?: 'two-pane'
  readonly bringToState?: BringToStateRequest
  readonly env?: Readonly<Record<string, string>>
  readonly spawnToRunIdTimeoutMs?: number
  readonly bringToStateTimeoutMs?: number
  /**
   * When true, the launcher creates a temp git repository (`git init` +
   * initial empty commit) and runs orch against it. The temp repo path is
   * exposed on the handle as `repoRoot`. Workflow steps that exercise git
   * (worktree, commit) need this set.
   */
  readonly initGitRepo?: boolean
  /**
   * Extra CLI arguments appended after the canonical `run <workflow>
   * --mode=two-pane --no-attach` argv. Use for one-off flags a cell needs
   * (e.g. `--noninteractive` for ask-step coverage). Empty by default.
   */
  readonly cliArgs?: readonly string[]
  /**
   * When set, the launcher invokes `orch resume <runId>` against the
   * existing state base of the given handle instead of `orch run <name>`.
   * The fresh `script` map applies to the resumed invocation only — cached
   * steps replay from `state.json` and ignore the runner adapter entirely.
   * Teardown of the second handle deliberately does NOT remove the state
   * base; the original handle still owns it.
   */
  readonly resumeFrom?: OrchHandle
}

export const spawnOrch = async (opts: SpawnOrchOptions): Promise<OrchHandle> => {
  const fixture = resolveFixture(opts.workflowFixture)
  const isResume = opts.resumeFrom !== undefined
  const stateBaseRaw = isResume
    ? (opts.resumeFrom as OrchHandle).stateBase
    : await mkdtemp(nodePath.join(tmpdir(), 'orch-tier5-'))
  const stateBase = toPath(stateBaseRaw)

  // Puppet steps get a per-step control NDJSON file. On a fresh launch this
  // is `<stateBase>/test-control/`; on resume we use a unique suffix so the
  // resumed agent's control file does not collide with leftover data from
  // the original run.
  const controlSegment = isResume ? `test-control-resume-${Date.now()}` : 'test-control'
  const controlDir = nodePath.join(stateBaseRaw, controlSegment)
  await mkdir(controlDir, { recursive: true })
  const resolvedSteps = resolvePuppetPaths(opts.script ?? {}, controlDir)

  const scriptFilename = isResume ? `script-resume-${Date.now()}.json` : 'script.json'
  const scriptPath = nodePath.join(stateBaseRaw, scriptFilename)
  const scriptBody = { steps: resolvedSteps }
  await writeFile(scriptPath, JSON.stringify(scriptBody), 'utf-8')

  // When `initGitRepo: true` we create a fresh repo under <stateBase>/repo
  // and use it as the subprocess's cwd (orch is launched there). Otherwise
  // the orch cwd stays at the fixture dir (existing behavior). On resume,
  // the repo already exists at the prior handle's `repoRoot`.
  let subprocessCwd = fixture.cwd
  let resolvedRepoRoot = fixture.cwd
  if (isResume) {
    resolvedRepoRoot = (opts.resumeFrom as OrchHandle).repoRoot
    subprocessCwd = (opts.resumeFrom as OrchHandle).workflowCwd
  } else if (opts.initGitRepo === true) {
    const repoPath = await initTempGitRepo(stateBaseRaw, fixture.cwd)
    resolvedRepoRoot = toPath(repoPath)
    subprocessCwd = resolvedRepoRoot
  }

  const env = mergeEnv(
    process.env,
    {
      [ORCH_LIFECYCLE_SCRIPT_ENV]: scriptPath,
      [ORCH_STATE_BASE_ENV]: stateBaseRaw,
    },
    opts.env ?? {},
  )

  // Resolve `src/cli/main.ts` against the repo root (this file is at
  // `tests/helpers/behavioral-dsl/internal/`), not the orch subprocess's
  // cwd (which is the fixture directory).
  const repoRoot = nodePath.resolve(import.meta.dir, '../../../..')
  const orchEntry = nodePath.join(repoRoot, 'src/cli/main.ts')
  const argv: readonly string[] = isResume
    ? [
        'bun',
        orchEntry,
        'resume',
        (opts.resumeFrom as OrchHandle).runId,
        '--mode=two-pane',
        '--no-attach',
        ...(opts.cliArgs ?? []),
      ]
    : [
        'bun',
        orchEntry,
        'run',
        fixture.workflowName,
        '--mode=two-pane',
        '--no-attach',
        ...(opts.cliArgs ?? []),
      ]

  // The workflow fixture is loaded by walking up from `fixture.cwd`, so we
  // set the subprocess cwd to the fixture root and rely on `findConfigPath`.
  // When initGitRepo is true, the temp repo's cwd takes precedence — but
  // we still copy orch.config.ts there (see initTempGitRepo).
  const processService = new BunProcessService()
  const subprocess: SpawnHandle = processService.spawn({
    argv,
    env,
    cwd: subprocessCwd,
    rawStreams: true,
  })

  // Background pumps for both streams. Without these, orch's stderr/stdout
  // buffers fill (banner + tmux hints + status messages) and the subprocess
  // backpressures forever. The pumps run for the lifetime of the
  // subprocess; both are surfaced for diagnostics-on-failure.
  const stderrCollector = collectLines(subprocess.stderr)
  const stdoutCollector = collectLines(subprocess.stdout)

  let teardownCalled = false
  const teardown = async (): Promise<void> => {
    if (teardownCalled) return
    teardownCalled = true
    await killSubprocess(subprocess)
    await stderrCollector.done.catch(() => undefined)
    await stdoutCollector.done.catch(() => undefined)
    // On resume, the original handle still owns the state base — let its
    // teardown remove it. Removing here would race with the original
    // handle's teardown and could leak partial state.
    if (!isResume) {
      await rm(stateBaseRaw, { recursive: true, force: true }).catch(() => {})
    }
  }

  let runId: RunId
  try {
    runId = await waitForRunIdLine(subprocess, stderrCollector, {
      timeoutMs: opts.spawnToRunIdTimeoutMs ?? DEFAULT_SPAWN_TO_RUNID_TIMEOUT_MS,
    })
  } catch (err) {
    await teardown()
    throw err
  }

  const socket = `orch-${runId}` as Socket
  const stateDir = toPath(`${stateBaseRaw}/${runId}`)

  const agent = (stepName: string): AgentControl => {
    return createAgentControl({
      stepName,
      script: resolvedSteps,
      controlDir,
    })
  }

  const handle: OrchHandle = {
    runId,
    socket,
    stateBase,
    stateDir,
    workflowCwd: subprocessCwd,
    repoRoot: resolvedRepoRoot,
    env,
    subprocess,
    agent,
    teardown,
  }

  if (opts.bringToState !== undefined) {
    try {
      await bringToState(handle, opts.bringToState, {
        timeoutMs: opts.bringToStateTimeoutMs ?? DEFAULT_BRING_TO_STATE_TIMEOUT_MS,
      })
    } catch (err) {
      await teardown()
      throw err
    }
  }

  return handle
}

interface LineCollector {
  /** All lines seen so far, in order. Mutated by the background pump. */
  readonly lines: string[]
  /** Listener for each new line. One listener per collector. */
  onLine: (line: string) => void
  /** Resolves when the underlying stream ends. */
  readonly done: Promise<void>
}

function collectLines(stream: AsyncIterable<string>): LineCollector {
  const collector: LineCollector = {
    lines: [],
    onLine: () => {
      /* default no-op */
    },
    done: Promise.resolve(),
  }
  const done = (async () => {
    for await (const line of stream) {
      collector.lines.push(line)
      try {
        collector.onLine(line)
      } catch {
        /* listener errors must not stop the pump */
      }
    }
  })().catch(() => undefined)
  // Reassign via `as` — the field is `readonly` to consumers but writable
  // here at construction time before any await.
  ;(collector as { done: Promise<void> }).done = done
  return collector
}

interface WaitForRunIdOptions {
  readonly timeoutMs: number
}

async function waitForRunIdLine(
  subprocess: SpawnHandle,
  collector: LineCollector,
  opts: WaitForRunIdOptions,
): Promise<RunId> {
  // Match against any already-collected lines (race-safe — the pump may
  // have already passed the runId before we attached a listener).
  for (const line of collector.lines) {
    const match = RUNID_LINE_RE.exec(line)
    if (match?.[1]) return match[1] as RunId
  }

  return new Promise<RunId>((resolve, reject) => {
    let settled = false
    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      fn()
    }

    const timer = setTimeout(() => {
      settle(() =>
        reject(
          new RunIdParseError(
            `did not see "Running workflow" line within ${opts.timeoutMs}ms. ` +
              `Stderr tail:\n${collector.lines.slice(-20).join('\n')}`,
          ),
        ),
      )
    }, opts.timeoutMs)
    timer.unref()

    collector.onLine = (line: string): void => {
      const match = RUNID_LINE_RE.exec(line)
      if (match?.[1]) {
        clearTimeout(timer)
        settle(() => resolve(match[1] as RunId))
      }
    }

    void subprocess.wait().then(({ exitCode }) => {
      // Wait for the pump to drain trailing buffered lines before deciding
      // — orch may have written the runId moments before exiting.
      void collector.done.then(() => {
        if (settled) return
        clearTimeout(timer)
        settle(() =>
          reject(
            new RunIdParseError(
              `orch exited (code=${exitCode}) before emitting the runId line. ` +
                `Stderr tail:\n${collector.lines.slice(-20).join('\n')}`,
            ),
          ),
        )
      })
    })
  })
}

interface BringToStateOptions {
  readonly timeoutMs: number
  readonly pollIntervalMs?: number
}

async function bringToState(
  handle: OrchHandle,
  request: BringToStateRequest,
  opts: BringToStateOptions,
): Promise<void> {
  if (request.kind === 'pre-run') return

  const stateFile = nodePath.join(handle.stateDir, 'state.json')
  const pollMs = opts.pollIntervalMs ?? DEFAULT_STATE_POLL_INTERVAL_MS
  const deadline = Date.now() + opts.timeoutMs
  let lastError: string | undefined

  while (Date.now() < deadline) {
    const snapshot = await readStateSnapshot(stateFile)
    if (snapshot.kind === 'ok') {
      if (matchesRequest(snapshot.value, request)) return
      lastError = describeMismatch(snapshot.value, request)
    } else {
      lastError = snapshot.reason
    }
    await new Promise((res) => setTimeout(res, pollMs))
  }

  throw new BringToStateTimeoutError(
    `bringToState(${describeRequest(request)}) did not reach the target ` +
      `within ${opts.timeoutMs}ms. Last observation: ${lastError ?? '(none)'}`,
  )
}

interface StateSnapshot {
  readonly status: string
  readonly steps: Readonly<Record<string, { readonly value?: unknown }>>
}

type ReadResult =
  | { readonly kind: 'ok'; readonly value: StateSnapshot }
  | { readonly kind: 'missing' | 'parse-error'; readonly reason: string }

async function readStateSnapshot(stateFile: string): Promise<ReadResult> {
  try {
    const raw = await Bun.file(stateFile).text()
    if (raw.length === 0) {
      return { kind: 'parse-error', reason: 'empty state.json (mid-write)' }
    }
    const parsed = JSON.parse(raw) as StateSnapshot
    return { kind: 'ok', value: parsed }
  } catch (err) {
    if (err instanceof SyntaxError) {
      // Two-phase visibility on filesystem-backed state.json — treat parse
      // failure as "not yet ready" and continue polling (plan Risk R-H).
      return { kind: 'parse-error', reason: 'state.json mid-write (SyntaxError)' }
    }
    return { kind: 'missing', reason: 'state.json not yet visible' }
  }
}

function matchesRequest(state: StateSnapshot, request: BringToStateRequest): boolean {
  switch (request.kind) {
    case 'pre-run':
      return true
    case 'mid-step': {
      const entry = state.steps[request.name]
      // A step is "running" while it has an in-progress entry or no entry
      // yet that has produced a value. Tolerate both shapes: the executor
      // writes the entry once it has a value (completed) — so "running"
      // shows up either as missing or as present-without-value mid-flight.
      // Concretely, when the runner is held by `wait-for-file`, the step
      // entry has not yet been finalized.
      if (state.status !== 'running') return false
      const stepStarted = entry !== undefined || hasInProgressMarker(state, request.name)
      return stepStarted && entry?.value === undefined
    }
    case 'between-steps': {
      const after = state.steps[request.after]
      return after !== undefined && state.status === 'running'
    }
    case 'completed':
      return state.status === 'completed'
    case 'failed':
      return state.status === 'crashed'
    case 'awaiting-ask':
      // Heuristic: an ask step is mounted when state.json carries a step
      // entry with no value and a `kind: 'ask'`-like marker. Refined when
      // U8/U10 actually exercise this — for now mid-step naming is enough.
      return Object.values(state.steps).some((s) => s.value === undefined)
  }
}

function hasInProgressMarker(state: StateSnapshot, stepName: string): boolean {
  // Best-effort: when the executor has emitted lifecycle but not written a
  // value yet, the step entry is absent. We use that absence + status=running
  // as the "mid-step before first event" signal.
  return state.steps[stepName] === undefined && state.status === 'running'
}

function describeRequest(req: BringToStateRequest): string {
  switch (req.kind) {
    case 'pre-run':
      return 'pre-run'
    case 'mid-step':
      return `mid-step("${req.name}")`
    case 'between-steps':
      return `between-steps(after="${req.after}")`
    case 'completed':
      return 'completed'
    case 'failed':
      return 'failed'
    case 'awaiting-ask':
      return 'awaiting-ask'
  }
}

function describeMismatch(state: StateSnapshot, req: BringToStateRequest): string {
  return `status=${state.status}, steps=[${Object.keys(state.steps).join(', ')}] vs ${describeRequest(req)}`
}

async function killSubprocess(subprocess: SpawnHandle): Promise<void> {
  try {
    subprocess.kill('SIGTERM')
  } catch {
    // Already exited — no-op.
  }
  const gracefulDeadline = Date.now() + 1_000
  while (Date.now() < gracefulDeadline) {
    const exited = await Promise.race([
      subprocess.wait().then(() => true),
      new Promise<boolean>((res) => setTimeout(() => res(false), 50)),
    ])
    if (exited) return
  }
  try {
    subprocess.kill('SIGKILL')
  } catch {
    /* already gone */
  }
  await subprocess.wait().catch(() => undefined)
}

export class RunIdParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RunIdParseError'
  }
}

// ---------------------------------------------------------------------------
// Puppet support — resolve placeholder controlPath, construct AgentControl,
// and provide a temp-git-repo init for fixtures that need real git side-effects.
// ---------------------------------------------------------------------------

function resolvePuppetPaths(
  rawScript: Readonly<Record<string, unknown>>,
  controlDir: string,
): Readonly<Record<string, unknown>> {
  const resolved: Record<string, unknown> = {}
  for (const [stepName, entry] of Object.entries(rawScript)) {
    if (
      entry !== null &&
      typeof entry === 'object' &&
      (entry as { kind?: unknown }).kind === 'puppet'
    ) {
      const controlPath = nodePath.join(controlDir, `${stepName}.ndjson`)
      resolved[stepName] = { ...entry, controlPath }
    } else {
      resolved[stepName] = entry
    }
  }
  return resolved
}

interface AgentControlDeps {
  readonly stepName: string
  readonly script: Readonly<Record<string, unknown>>
  readonly controlDir: string
}

function createAgentControl(deps: AgentControlDeps): AgentControl {
  const entry = deps.script[deps.stepName]
  if (
    entry === null ||
    typeof entry !== 'object' ||
    (entry as { kind?: unknown }).kind !== 'puppet'
  ) {
    return makeMisconfiguredAgentControl(deps.stepName)
  }
  const controlPath = (entry as { controlPath: string }).controlPath
  const ackDir = `${controlPath}.acks`
  let seq = 0
  const append = async (cmd: unknown): Promise<void> => {
    seq += 1
    const localSeq = seq
    await appendFile(controlPath, `${JSON.stringify(cmd)}\n`, 'utf-8')
    await waitForAck(ackDir, localSeq)
  }
  return {
    emit: async (event) => append({ cmd: 'emit', event }),
    writeFile: async (path, content) => append({ cmd: 'write-file', path, content }),
    runShell: async (command) => append({ cmd: 'run-shell', command }),
    complete: async (opts) =>
      append(
        opts?.structuredOutput !== undefined
          ? { cmd: 'complete', structuredOutput: opts.structuredOutput }
          : { cmd: 'complete' },
      ),
    fail: async (opts) =>
      append(
        opts.exitCode !== undefined
          ? { cmd: 'fail', message: opts.message, exitCode: opts.exitCode }
          : { cmd: 'fail', message: opts.message },
      ),
    wait: async (ms) => append({ cmd: 'wait', ms }),
  }
}

function makeMisconfiguredAgentControl(stepName: string): AgentControl {
  const bail = (method: string) => async (): Promise<void> => {
    throw new Error(
      `handle.agent("${stepName}").${method}(): step "${stepName}" is not configured ` +
        "with puppet() in the launcher's script map",
    )
  }
  return {
    emit: bail('emit'),
    writeFile: bail('writeFile'),
    runShell: bail('runShell'),
    complete: bail('complete'),
    fail: bail('fail'),
    wait: bail('wait'),
  }
}

const ACK_POLL_INTERVAL_MS = 25
const ACK_TIMEOUT_MS = 10_000

async function waitForAck(ackDir: string, seq: number): Promise<void> {
  const ackPath = nodePath.join(ackDir, `${seq}.ack`)
  const deadline = Date.now() + ACK_TIMEOUT_MS
  for (;;) {
    try {
      await stat(ackPath)
      return
    } catch {
      /* not present yet */
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `waitForAck: runner did not ack puppet command #${seq} within ${ACK_TIMEOUT_MS}ms ` +
          `(expected ${ackPath})`,
      )
    }
    await new Promise((res) => setTimeout(res, ACK_POLL_INTERVAL_MS))
  }
}

async function initTempGitRepo(stateBaseRaw: string, fixtureCwd: string): Promise<string> {
  const repoRoot = nodePath.join(stateBaseRaw, 'repo')
  await mkdir(repoRoot, { recursive: true })

  // Synthesize an orch.config.ts in the temp repo that points back at the
  // fixture's workflow files via absolute paths. We DO NOT copy the fixture's
  // orch.config.ts because its relative imports (../../../src/config) and
  // relative workflow paths break when the file is relocated. Generating a
  // fresh config keeps the temp repo self-contained and the fixture dir
  // untouched.
  await synthesizeRepoConfig(repoRoot, fixtureCwd)

  // git init + minimal config + empty initial commit. We use spawnSync via Bun
  // for portability — git is a hard dep for these fixtures.
  const run = async (argv: readonly string[]): Promise<void> => {
    const proc = Bun.spawn(argv as string[], {
      cwd: repoRoot,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'orch-test',
        GIT_AUTHOR_EMAIL: 'test@orch.local',
        GIT_COMMITTER_NAME: 'orch-test',
        GIT_COMMITTER_EMAIL: 'test@orch.local',
      },
    })
    const code = await proc.exited
    if (code !== 0) {
      const err = await new Response(proc.stderr).text()
      throw new Error(`initTempGitRepo: ${argv.join(' ')} failed (exit=${code}): ${err}`)
    }
  }
  await run(['git', 'init', '-q', '-b', 'main'])
  await run(['git', 'commit', '-q', '--allow-empty', '-m', 'initial'])
  return repoRoot
}

/**
 * Build an `orch.config.ts` inside `repoRoot` whose workflow map points at
 * each fixture file by absolute path. We parse the fixture's existing
 * `orch.config.ts` to recover the workflow-name → filename mapping; if the
 * file is not present or unparseable, we fall back to an empty workflow map
 * (the cell will then fail with a clearer "no fixture" error when it tries
 * to invoke a workflow). Imports route through the source tree's
 * `src/config/index.ts` via absolute path so module resolution is invariant
 * to where the file lives.
 */
async function synthesizeRepoConfig(repoRoot: string, fixtureCwd: string): Promise<void> {
  const repoSrcRoot = nodePath.resolve(import.meta.dir, '../../../..')
  const defineConfigImport = nodePath.join(repoSrcRoot, 'src/config/index.ts')
  const fixtureConfig = nodePath.join(fixtureCwd, 'orch.config.ts')
  const workflows = await parseFixtureWorkflows(fixtureConfig, fixtureCwd)
  const entries = Object.entries(workflows)
    .map(([name, absPath]) => `    ${JSON.stringify(name)}: ${JSON.stringify(absPath)},`)
    .join('\n')
  const body = [
    `import { defineConfig } from ${JSON.stringify(defineConfigImport)}`,
    '',
    'export const config = defineConfig({',
    '  workflows: {',
    entries,
    '  },',
    '})',
    '',
  ].join('\n')
  await writeFile(nodePath.join(repoRoot, 'orch.config.ts'), body, 'utf-8')
}

async function parseFixtureWorkflows(
  fixtureConfigPath: string,
  fixtureCwd: string,
): Promise<Record<string, string>> {
  try {
    const raw = await readFile(fixtureConfigPath, 'utf-8')
    // Permissive regex: tolerates trailing commas, single/double quotes, and
    // whitespace. The fixture's config is hand-written so we don't need a
    // full JS parser here.
    const out: Record<string, string> = {}
    const re = /['"]([^'"]+)['"]\s*:\s*['"]([^'"]+)['"]/g
    let m: RegExpExecArray | null = re.exec(raw)
    while (m !== null) {
      const [, name, file] = m
      if (name !== undefined && file !== undefined && file.endsWith('.ts')) {
        out[name] = nodePath.join(fixtureCwd, file)
      }
      m = re.exec(raw)
    }
    return out
  } catch {
    return {}
  }
}

// readFile is referenced in the import list above for symmetry but not used yet;
// keep the import to avoid churn when puppet-aware diagnostics need it.
void readFile

export class BringToStateTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BringToStateTimeoutError'
  }
}
