#!/usr/bin/env bun
//
// fetch-workflow.ts — gather every agent session an orch workflow run produced
// into one folder for analysis: a "how it executed" overview plus each step's
// full transcript as Markdown.
//
//   bun scripts/fetch-workflow.ts <runId>          # by full or prefix id
//   bun scripts/fetch-workflow.ts --latest         # the most recent run
//   bun scripts/fetch-workflow.ts <runId> --print  # also echo the overview
//   bun scripts/fetch-workflow.ts --list           # list runs, newest first
//
// Output lands under the run's own state dir (idempotent — already-written
// transcripts are skipped unless --force):
//
//   .orch/state/<runId>/analysis/
//     _overview.md            workflow summary + step table + error callouts
//     NN-<step>-<tool>.md     one transcript per agent step
//
// The point: point an agent at .orch/state/<runId>/analysis/ and ask
// "what errors were there, what could we improve" — every agent's work and the
// run's execution shape are right there, fetched once.
//
// A workflow step links to its underlying session via state.json's
// steps.<name>.sessionId (the Claude/Codex UUID orch captured at spawn). We
// reuse fetch-session.ts to turn each UUID into Markdown.

import { parseArgs } from 'node:util'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { fetchSession, toMarkdown, type Tool } from './fetch-session.ts'

// ---------------------------------------------------------------------------
// Run-state roots & loose readers (state.json is external data — parse defensively)
// ---------------------------------------------------------------------------

const STATE_ROOT = join(
  process.env.ORCH_HOME ?? join(process.cwd(), '.orch'),
  'state',
)

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
}
function asStr(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}
function asNum(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined
}

// ---------------------------------------------------------------------------
// Per-step view, merged from state.json + logs/spawns.ndjson
// ---------------------------------------------------------------------------

interface StepView {
  readonly name: string
  readonly mode?: string
  readonly runner?: string // 'claude' | 'codex' | 'command' | …
  readonly sessionId?: string
  readonly sessionIdCaptureError?: string
  readonly startedAt?: number
  readonly endedAt?: number
  readonly exitCode?: number
  readonly attempts: number
  readonly validations: { name?: string; ok?: boolean }[]
}

interface SpawnView {
  exitCode?: number
  runner?: string
  sessionId?: string
  attempts: number
}

async function readLatestSpawnsByStep(runDir: string): Promise<Map<string, SpawnView>> {
  const byStep = new Map<string, SpawnView>()
  const file = Bun.file(join(runDir, 'logs', 'spawns.ndjson'))
  if (!(await file.exists())) return byStep
  const raw = await file.text()
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t) continue
    let o: Record<string, unknown>
    try {
      o = asObj(JSON.parse(t))
    } catch {
      continue
    }
    const name = asStr(o.stepName)
    if (!name) continue
    const prev = byStep.get(name)
    // Keep the last spawn's outcome, but count every attempt (retries/recovery).
    byStep.set(name, {
      exitCode: asNum(o.exitCode),
      runner: asStr(o.runnerName) ?? prev?.runner,
      sessionId: asStr(o.sessionId) ?? prev?.sessionId,
      attempts: (prev?.attempts ?? 0) + 1,
    })
  }
  return byStep
}

async function loadRun(runDir: string): Promise<{
  id: string
  workflowName?: string
  status?: string
  args: Record<string, unknown>
  startedAt?: number
  endedAt?: number
  steps: StepView[]
}> {
  const stateFile = Bun.file(join(runDir, 'state.json'))
  if (!(await stateFile.exists())) {
    throw new Error(`No state.json in ${runDir} — not an orch run directory.`)
  }
  const state = asObj(JSON.parse(await stateFile.text()))
  const spawns = await readLatestSpawnsByStep(runDir)

  const steps: StepView[] = []
  for (const [name, raw] of Object.entries(asObj(state.steps))) {
    const s = asObj(raw)
    const spawn = spawns.get(name)
    const validations = (Array.isArray(s.validations) ? s.validations : []).map((v) => {
      const vo = asObj(v)
      return { name: asStr(vo.name), ok: typeof vo.ok === 'boolean' ? vo.ok : undefined }
    })
    steps.push({
      name,
      mode: asStr(s.mode),
      runner: asStr(s.runnerName) ?? spawn?.runner,
      sessionId: asStr(s.sessionId) ?? spawn?.sessionId,
      sessionIdCaptureError: asStr(s.sessionIdCaptureError),
      startedAt: asNum(s.startedAt),
      endedAt: asNum(s.endedAt),
      exitCode: spawn?.exitCode,
      attempts: spawn?.attempts ?? 0,
      validations,
    })
  }

  return {
    id: asStr(state.id) ?? '?',
    workflowName: asStr(state.workflowName),
    status: asStr(state.status),
    args: asObj(state.args),
    startedAt: asNum(state.startedAt),
    endedAt: asNum(state.endedAt),
    steps,
  }
}

// ---------------------------------------------------------------------------
// Run discovery
// ---------------------------------------------------------------------------

interface RunDir {
  id: string
  dir: string
  mtime: number
}

async function listRuns(): Promise<RunDir[]> {
  const glob = new Bun.Glob('*/state.json')
  const runs: RunDir[] = []
  for await (const rel of glob.scan({ cwd: STATE_ROOT })) {
    const id = rel.slice(0, rel.indexOf('/'))
    const dir = join(STATE_ROOT, id)
    const mtime = (await Bun.file(join(dir, 'state.json')).stat()).mtimeMs
    runs.push({ id, dir, mtime })
  }
  runs.sort((a, b) => b.mtime - a.mtime)
  return runs
}

async function resolveRun(idOrPrefix: string | undefined, latest: boolean): Promise<RunDir> {
  const runs = await listRuns()
  if (runs.length === 0) throw new Error(`No runs found under ${STATE_ROOT}.`)
  if (latest) return runs[0]!
  if (!idOrPrefix) throw new Error('Provide a runId (or --latest / --list).')

  const exact = runs.filter((r) => r.id === idOrPrefix)
  const matches = exact.length > 0 ? exact : runs.filter((r) => r.id.startsWith(idOrPrefix))
  if (matches.length === 0) throw new Error(`No run matches "${idOrPrefix}".`)
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous run "${idOrPrefix}" — ${matches.length} match:\n` +
        matches.slice(0, 10).map((r) => `  ${r.id}`).join('\n'),
    )
  }
  return matches[0]!
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function fmtDuration(start?: number, end?: number): string {
  if (start === undefined || end === undefined) return '—'
  const ms = end - start
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`
}

function fmtTs(ms?: number): string {
  if (ms === undefined) return '—'
  return new Date(ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z')
}

/** A step ran an agent iff it has a session UUID we can fetch. */
function isAgentStep(s: StepView): boolean {
  return typeof s.sessionId === 'string'
}

/** Filesystem-safe, stable per-step slug for the transcript filename. */
function stepSlug(s: StepView, index: number): string {
  const clean = s.name.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
  const n = String(index + 1).padStart(2, '0')
  return `${n}-${clean}`
}

function statusCell(s: StepView): string {
  if (s.sessionIdCaptureError) return `⚠️ sid:${s.sessionIdCaptureError}`
  if (s.exitCode !== undefined && s.exitCode !== 0) return `❌ exit ${s.exitCode}`
  const failed = s.validations.filter((v) => v.ok === false).length
  if (failed > 0) return `❌ ${failed} check${failed > 1 ? 's' : ''} failed`
  if (s.endedAt === undefined) return '⏳ running'
  return '✅ ok'
}

interface FetchOutcome {
  readonly slug: string
  readonly status: 'fetched' | 'skipped' | 'missing'
}

function buildOverview(
  run: Awaited<ReturnType<typeof loadRun>>,
  outcomes: Map<string, FetchOutcome>,
): string {
  const o: string[] = []
  o.push(`# Workflow run \`${run.id}\``)
  o.push('')
  o.push(`- **Workflow:** ${run.workflowName ?? '(unnamed)'}`)
  o.push(`- **Status:** ${run.status ?? '?'}`)
  o.push(`- **Started:** ${fmtTs(run.startedAt)}`)
  o.push(`- **Duration:** ${fmtDuration(run.startedAt, run.endedAt)}`)
  const argKeys = Object.keys(run.args)
  if (argKeys.length > 0) o.push(`- **Args:** \`${JSON.stringify(run.args)}\``)
  const agentSteps = run.steps.filter(isAgentStep)
  o.push(`- **Steps:** ${run.steps.length} total, ${agentSteps.length} with an agent session`)
  o.push('')

  // --- Error / attention callout ---
  const problems: string[] = []
  if (run.status === 'crashed' || run.status === 'failed') {
    problems.push(`- Run ended **${run.status}**.`)
  }
  for (const s of run.steps) {
    if (s.exitCode !== undefined && s.exitCode !== 0) {
      problems.push(`- \`${s.name}\` exited with code **${s.exitCode}**.`)
    }
    if (s.sessionIdCaptureError) {
      problems.push(`- \`${s.name}\` could not capture a session id (${s.sessionIdCaptureError}).`)
    }
    if (s.attempts > 1) {
      problems.push(`- \`${s.name}\` took **${s.attempts} attempts** (retries/recovery).`)
    }
    for (const v of s.validations.filter((v) => v.ok === false)) {
      problems.push(`- \`${s.name}\` failed validation${v.name ? ` \`${v.name}\`` : ''}.`)
    }
  }
  if (problems.length > 0) {
    o.push('## ⚠️ Needs attention')
    o.push('')
    o.push(...problems)
    o.push('')
  }

  // --- Step table ---
  o.push('## Steps')
  o.push('')
  o.push('| # | Step | Runner | Mode | Status | Duration | Transcript |')
  o.push('| - | ---- | ------ | ---- | ------ | -------- | ---------- |')
  run.steps.forEach((s, i) => {
    const out = outcomes.get(s.name)
    const link =
      out && out.status !== 'missing'
        ? `[${out.slug}.md](./${out.slug}.md)`
        : isAgentStep(s)
          ? '_(unavailable)_'
          : '—'
    o.push(
      `| ${i + 1} | \`${s.name}\` | ${s.runner ?? '—'} | ${s.mode ?? '—'} | ${statusCell(s)} | ` +
        `${fmtDuration(s.startedAt, s.endedAt)} | ${link} |`,
    )
  })
  o.push('')

  // --- Transcript index ---
  const fetched = run.steps
    .map((s) => ({ s, out: outcomes.get(s.name) }))
    .filter((x) => x.out && x.out.status !== 'missing')
  if (fetched.length > 0) {
    o.push('## Transcripts')
    o.push('')
    for (const { s, out } of fetched) {
      o.push(`- [\`${s.name}\`](./${out!.slug}.md) — ${s.runner ?? '?'} · session \`${s.sessionId}\``)
    }
    o.push('')
  }

  o.push('---')
  o.push('')
  o.push(`_Generated by scripts/fetch-workflow.ts from \`${run.id}\`._`)
  return o.join('\n')
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const HELP = `fetch-workflow — gather an orch run's agent sessions for analysis

Usage:
  bun scripts/fetch-workflow.ts <runId> [options]
  bun scripts/fetch-workflow.ts --latest [options]
  bun scripts/fetch-workflow.ts --list

Options:
  --latest      analyze the most recent run
  --list        list runs (newest first) and exit
  --force       re-fetch transcripts even if already stored
  --out <dir>   output dir (default: <run>/analysis)
  --print       echo the overview to stdout when done
  -h, --help    show this help

Output (idempotent):
  .orch/state/<runId>/analysis/_overview.md   + one NN-<step>-<tool>.md per agent step`

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    allowPositionals: true,
    options: {
      latest: { type: 'boolean', default: false },
      list: { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
      out: { type: 'string' },
      print: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  })

  if (values.help) {
    console.log(HELP)
    return
  }

  if (values.list) {
    const runs = await listRuns()
    if (runs.length === 0) {
      console.error(`No runs under ${STATE_ROOT}.`)
      process.exitCode = 1
      return
    }
    for (const r of runs) {
      const run = await loadRun(r.dir).catch(() => null)
      const meta = run ? `${run.workflowName ?? '(unnamed)'} · ${run.status ?? '?'} · ${run.steps.filter(isAgentStep).length} agent steps` : '(unreadable)'
      console.log(`${r.id}  ${meta}`)
    }
    return
  }

  const target = await resolveRun(positionals[0], values.latest)
  const run = await loadRun(target.dir)

  const outDir = values.out ?? join(target.dir, 'analysis')

  // Fetch each agent step's transcript, once.
  const outcomes = new Map<string, FetchOutcome>()
  let fetched = 0
  let skipped = 0
  let missing = 0

  await Promise.all(
    run.steps.map(async (s, i) => {
      if (!isAgentStep(s)) return
      const slug = stepSlug(s, i)
      const tool = (s.runner === 'claude' || s.runner === 'codex' ? s.runner : 'auto') as Tool | 'auto'
      const dest = join(outDir, `${slug}.md`)

      if (!values.force && (await Bun.file(dest).exists())) {
        outcomes.set(s.name, { slug, status: 'skipped' })
        skipped++
        return
      }

      const session = await fetchSession(s.sessionId!, tool)
      if (!session) {
        outcomes.set(s.name, { slug, status: 'missing' })
        missing++
        return
      }
      await Bun.write(dest, `<!-- step: ${s.name} -->\n\n${toMarkdown(session)}`)
      outcomes.set(s.name, { slug, status: 'fetched' })
      fetched++
    }),
  )

  const overview = buildOverview(run, outcomes)
  const overviewPath = join(outDir, '_overview.md')
  await Bun.write(overviewPath, overview)

  console.error(
    `Run ${run.id} (${run.workflowName ?? 'unnamed'}, ${run.status ?? '?'}): ` +
      `${fetched} fetched, ${skipped} already stored, ${missing} unavailable.`,
  )
  console.error(`→ ${overviewPath.replace(homedir(), '~')}`)
  if (missing > 0) {
    console.error(`  (${missing} session(s) not found on disk — they may have been deleted or run on another machine.)`)
  }

  if (values.print) console.log(overview)
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = 1
  })
}
