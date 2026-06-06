// ---------------------------------------------------------------------------
// overlap-report (parent §5.5 / §5.3) — the migration's queryable coverage map.
// ---------------------------------------------------------------------------
//
// AST-parses the literal `scenario({...})` first argument across `tests-new/**`
// and reports two classes of gap:
//   (a) MISSING TWIN — an `overlapGroup` with a `model` member but no `screen`/
//       `full-host` twin (the deliberate model↔screen contract is broken).
//   (b) UNKNOWN OLD REF — a scenario `oldTestRefs` entry absent from the FROZEN
//       `baseline.json` (D12) — i.e. it points at no real migrated case.
//
// It MUST NOT `import` a scenario file: `scenario()` calls `it()` at module-eval
// time, so importing would register/execute Bun tests (parent §5.3). Like
// `snapshot.ts`, it reads SOURCE TEXT and walks the TypeScript AST instead — the
// pure `parseScenarios(text)` core never touches the module system.
//
// As of U4 this is BLOCKING: `bun run overlap-report` prints findings and exits
// NON-ZERO when any exist, so a broken model↔screen contract or an oldTestRefs
// entry that points at no real baseline case fails the gate (parent §U3/§U4; the
// first real ledger rows landed in U4, so the flip is safe). It is on the `check`
// gate and the `test:two-pane:fast` tight loop.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import * as ts from 'typescript'

const TESTS_NEW_ROOT = 'tests-new'
const BASELINE_PATH = join('tests-new', '_migration', 'baseline.json')

export interface ScenarioRef {
  readonly file: string
  readonly name: string
  readonly drivers: readonly string[]
  readonly overlapGroup?: string
  readonly oldTestRefs: readonly string[]
}

export interface MissingTwinFinding {
  readonly kind: 'missing-twin'
  readonly overlapGroup: string
  readonly drivers: readonly string[]
}

export interface UnknownOldRefFinding {
  readonly kind: 'unknown-old-ref'
  readonly file: string
  readonly scenario: string
  readonly ref: string
}

export interface Findings {
  readonly missingTwins: readonly MissingTwinFinding[]
  readonly unknownOldRefs: readonly UnknownOldRefFinding[]
}

// --- AST parse (source text → scenario refs; NEVER import) -------------------

function headIdentifier(expr: ts.Expression): string | undefined {
  if (ts.isIdentifier(expr)) return expr.text
  if (ts.isPropertyAccessExpression(expr)) return headIdentifier(expr.expression)
  if (ts.isCallExpression(expr)) return headIdentifier(expr.expression)
  if (ts.isParenthesizedExpression(expr)) return headIdentifier(expr.expression)
  return undefined
}

function stringLiteral(node: ts.Expression | undefined): string | undefined {
  return node !== undefined && ts.isStringLiteralLike(node) ? node.text : undefined
}

function stringArray(node: ts.Expression | undefined): readonly string[] {
  if (node === undefined || !ts.isArrayLiteralExpression(node)) return []
  const out: string[] = []
  for (const el of node.elements) {
    const s = stringLiteral(el)
    if (s !== undefined) out.push(s)
  }
  return out
}

function property(obj: ts.ObjectLiteralExpression, key: string): ts.Expression | undefined {
  for (const prop of obj.properties) {
    if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === key) {
      return prop.initializer
    }
  }
  return undefined
}

/** Parse every `scenario({...})` call in a source string. Pure — no imports,
 *  no evaluation: a file that would THROW on import still parses cleanly. */
export function parseScenarios(source: string, fileName: string): readonly ScenarioRef[] {
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind)
  const refs: ScenarioRef[] = []

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      headIdentifier(node.expression) === 'scenario' &&
      node.arguments.length > 0
    ) {
      const arg = node.arguments[0]
      if (arg !== undefined && ts.isObjectLiteralExpression(arg)) {
        const name = stringLiteral(property(arg, 'name'))
        if (name !== undefined) {
          refs.push({
            file: fileName,
            name,
            drivers: stringArray(property(arg, 'drivers')),
            overlapGroup: stringLiteral(property(arg, 'overlapGroup')),
            oldTestRefs: stringArray(property(arg, 'oldTestRefs')),
          })
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return refs
}

// --- analysis ---------------------------------------------------------------

function isRealTmuxDriver(driver: string): boolean {
  return driver === 'screen' || driver.startsWith('full-host:')
}

/** Is `ref` an exact baseline path or a directory prefix of one? */
function refPresent(ref: string, baselinePaths: ReadonlySet<string>): boolean {
  if (baselinePaths.has(ref)) return true
  const prefix = `${ref}/`
  for (const p of baselinePaths) {
    if (p.startsWith(prefix)) return true
  }
  return false
}

export function analyze(
  scenarios: readonly ScenarioRef[],
  baselinePaths: ReadonlySet<string>,
): Findings {
  // Missing-twin: gather every driver per overlapGroup; flag a group that has a
  // `model` member but no real-tmux (`screen`/`full-host`) twin.
  const byGroup = new Map<string, Set<string>>()
  for (const s of scenarios) {
    if (s.overlapGroup === undefined) continue
    const set = byGroup.get(s.overlapGroup) ?? new Set<string>()
    for (const d of s.drivers) set.add(d)
    byGroup.set(s.overlapGroup, set)
  }
  const missingTwins: MissingTwinFinding[] = []
  for (const [overlapGroup, drivers] of byGroup) {
    const hasModel = drivers.has('model')
    const hasRealTmuxTwin = [...drivers].some(isRealTmuxDriver)
    if (hasModel && !hasRealTmuxTwin) {
      missingTwins.push({ kind: 'missing-twin', overlapGroup, drivers: [...drivers].sort() })
    }
  }

  // Unknown-old-ref: every oldTestRefs entry must resolve in the frozen baseline.
  const unknownOldRefs: UnknownOldRefFinding[] = []
  for (const s of scenarios) {
    for (const ref of s.oldTestRefs) {
      if (!refPresent(ref, baselinePaths)) {
        unknownOldRefs.push({ kind: 'unknown-old-ref', file: s.file, scenario: s.name, ref })
      }
    }
  }

  return { missingTwins, unknownOldRefs }
}

// --- runnable report (reads files, NEVER imports them) ----------------------

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (full.endsWith('.ts') || full.endsWith('.tsx')) out.push(full)
  }
  return out
}

export function collectScenarios(root: string = TESTS_NEW_ROOT): readonly ScenarioRef[] {
  const refs: ScenarioRef[] = []
  for (const file of walk(root)) {
    const rel = file.split('\\').join('/')
    refs.push(...parseScenarios(readFileSync(file, 'utf-8'), rel))
  }
  return refs
}

export function loadBaselinePaths(baselinePath: string = BASELINE_PATH): ReadonlySet<string> {
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf-8')) as {
    files: ReadonlyArray<{ path: string }>
  }
  return new Set(baseline.files.map((f) => f.path))
}

/**
 * The blocking gate decision (U4+): non-zero when any finding exists. Pure, so
 * the exit-code contract is unit-testable without spawning the report or
 * importing a scenario file.
 */
export function exitCodeForFindings(findings: Findings): number {
  return findings.missingTwins.length + findings.unknownOldRefs.length > 0 ? 1 : 0
}

export function renderFindings(scenarios: readonly ScenarioRef[], findings: Findings): string {
  const lines: string[] = []
  lines.push('overlap-report (BLOCKING — non-zero exit on any finding, U4+)')
  lines.push(`scenarios parsed: ${scenarios.length}`)
  lines.push('')
  if (findings.missingTwins.length === 0) {
    lines.push('✓ no missing model↔screen/full-host overlap twins')
  } else {
    lines.push(`✗ ${findings.missingTwins.length} overlap group(s) missing a real-tmux twin:`)
    for (const f of findings.missingTwins) {
      lines.push(`  - ${f.overlapGroup} [${f.drivers.join(', ')}]`)
    }
  }
  if (findings.unknownOldRefs.length === 0) {
    lines.push('✓ every oldTestRefs entry resolves in the frozen baseline')
  } else {
    lines.push(`✗ ${findings.unknownOldRefs.length} oldTestRefs entry/entries not in baseline:`)
    for (const f of findings.unknownOldRefs) {
      lines.push(`  - ${f.ref}  (${f.scenario} @ ${f.file})`)
    }
  }
  return lines.join('\n')
}

if (import.meta.main) {
  const scenarios = collectScenarios()
  const findings = analyze(scenarios, loadBaselinePaths())
  process.stdout.write(`${renderFindings(scenarios, findings)}\n`)
  // BLOCKING (U4+): a missing twin or an unresolved old-ref fails the gate.
  process.exit(exitCodeForFindings(findings))
}
