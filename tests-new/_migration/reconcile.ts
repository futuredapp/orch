// ---------------------------------------------------------------------------
// Reconciliation scanner (parent §7 "Phase group D", assertions #1–#3).
// ---------------------------------------------------------------------------
//
// The falsifiable "is the migration gap closed?" oracle. It asserts, ALWAYS
// against the FROZEN U1 baseline (`baseline.json`, D12) — never a live re-scan of
// the mutating tree — that every old `test` case is accounted for:
//
//   #1 skip-completeness — every baseline `test` case's owning file is, on disk,
//      unconditionally `.skip` (resolving `describe.skip` ANCESTRY and nesting),
//      OR the case is `drop`-ledgered. `skipIf(...)` capability gating is NOT
//      `.skip` (R13) and is reported as unaccounted — a regex over `it(`/`test(`
//      is explicitly insufficient (parent §7), so this walks the TS AST.
//   #2 ledger-completeness — every baseline case appears in `ledger.md` with a
//      disposition (zero unaccounted). Best-effort over the prose ledger this
//      phase; promoted to strict in Phase 15.
//   #3 marker-target existence — every `// MIGRATED → <path>` / `// COVERED BY →`
//      marker in the old tree points at a file that exists on disk.
//
// Phase 14 (P14-D3) ships this NON-BLOCKING (a `bun run reconcile` script, not on
// `check`) and scopes the load-bearing finding to the group-B gap, while computing
// over the WHOLE frozen baseline so Phase 15 can promote it unchanged.
//
// It must NOT `import` a test/scenario file — that would register/execute Bun
// tests (parent §5.3). It reads source text and parses the AST instead.
//
// Run: `bun run tests-new/_migration/reconcile.ts` (exits non-zero on findings).

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as ts from 'typescript'
import type { Baseline, BaselineEntry } from './snapshot.ts'

const BASELINE_PATH = join('tests-new', '_migration', 'baseline.json')
const LEDGER_PATH = join('tests-new', '_migration', 'ledger.md')

// --- group-B surface (the Phase-14 closeout scope) --------------------------
// Computed over the WHOLE baseline; this predicate only labels which findings are
// the load-bearing closeout gap vs. an incidental whole-tree finding.

const GROUP_B_PATTERNS: readonly RegExp[] = [
  /\/hosts\/two-pane\//,
  /\/hosts\/two-pane-[^/]+\.test\.tsx?$/,
  /\/lifecycle\//,
  /\/steps-view\//,
  /\/pane-map\//,
]

export function isGroupB(path: string): boolean {
  return GROUP_B_PATTERNS.some((re) => re.test(path))
}

// --- skip-state AST resolution (never a regex — parent §7) ------------------

export type SkipState = 'live' | 'skipped' | 'skipIf'

interface CaseHit {
  readonly name: string
  readonly line: number
  readonly state: SkipState
}

/** The head identifier of a (possibly chained / parenthesised) call target. */
function headIdentifier(expr: ts.Expression): string | undefined {
  if (ts.isIdentifier(expr)) return expr.text
  if (ts.isPropertyAccessExpression(expr)) return headIdentifier(expr.expression)
  if (ts.isCallExpression(expr)) return headIdentifier(expr.expression)
  if (ts.isParenthesizedExpression(expr)) return headIdentifier(expr.expression)
  return undefined
}

/** Collect every `.prop` / `.skipIf` modifier on a call target, in any order. */
function modifiers(expr: ts.Expression): Set<string> {
  const out = new Set<string>()
  let node: ts.Expression = expr
  // Walk down the property-access / call chain collecting property names.
  for (;;) {
    if (ts.isCallExpression(node)) {
      node = node.expression
      continue
    }
    if (ts.isPropertyAccessExpression(node)) {
      out.add(node.name.text)
      node = node.expression
      continue
    }
    if (ts.isParenthesizedExpression(node)) {
      node = node.expression
      continue
    }
    break
  }
  return out
}

function stringArgText(arg: ts.Expression): string | undefined {
  if (ts.isStringLiteralLike(arg)) return arg.text
  if (ts.isTemplateExpression(arg)) return arg.getText()
  return undefined
}

/**
 * Resolve the skip-state of every `it()`/`test()` case in a source file,
 * honouring `describe.skip` ancestry. `skipIf` (capability gating) is reported
 * distinctly from unconditional `.skip` (migration) — they must not be conflated.
 */
export function resolveCases(source: string, fileName: string): readonly CaseHit[] {
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind)
  const hits: CaseHit[] = []

  // ancestrySkipped tracks whether we are lexically inside a `describe.skip(...)`.
  const visit = (node: ts.Node, ancestrySkipped: boolean): void => {
    if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const head = headIdentifier(node.expression)
      const mods = modifiers(node.expression)

      if (head === 'describe') {
        const childSkipped = ancestrySkipped || mods.has('skip')
        // A `describe.skipIf` does NOT mark descendants as migrated.
        node.forEachChild((c) => visit(c, childSkipped))
        return
      }

      if (head === 'it' || head === 'test') {
        const firstArg = node.arguments[0]
        const name = firstArg === undefined ? undefined : stringArgText(firstArg)
        if (name !== undefined) {
          const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
          const state: SkipState =
            ancestrySkipped || mods.has('skip') || mods.has('todo')
              ? 'skipped'
              : mods.has('skipIf')
                ? 'skipIf'
                : 'live'
          hits.push({ name, line, state })
        }
        // still descend (nested it inside it is unusual but harmless)
      }
    }
    node.forEachChild((c) => visit(c, ancestrySkipped))
  }
  visit(sf, false)
  return hits
}

// --- ledger parsing (drop-set + dispositioned cases) ------------------------

/** Lower-cased ledger text, for substring disposition lookups. */
function loadLedger(): string {
  return existsSync(LEDGER_PATH) ? readFileSync(LEDGER_PATH, 'utf-8') : ''
}

/**
 * A baseline case is `drop`-accounted when a ledger row names its case text and
 * carries the `drop` disposition on the same row. The ledger is a Markdown table
 * (`| old file | old case | new | disposition | reason |`); we match on the case
 * name appearing in a row whose disposition cell is exactly `drop`.
 */
export function dropLedgeredCases(ledger: string): Set<string> {
  const out = new Set<string>()
  for (const raw of ledger.split('\n')) {
    if (!raw.startsWith('|')) continue
    const cells = raw.split('|').map((c) => c.trim())
    // cells[0] is '' (leading pipe); columns are cells[1..]
    const oldCase = cells[2]
    const disposition = cells[4]
    if (oldCase === undefined || disposition === undefined) continue
    if (disposition === 'drop' && oldCase.length > 0 && oldCase !== '—') {
      out.add(oldCase)
    }
  }
  return out
}

// --- assertion #3 — marker-target paths -------------------------------------

/** A concrete twin path the marker promises exists (not a prose disposition). */
export function isConcretePathTarget(target: string): boolean {
  return /^tests(-new)?\/[^ {}]+\.tsx?$/.test(target)
}

/** Expand a single `prefix-{a,b}.suffix` brace shorthand into its members. */
export function expandBraceTargets(target: string): readonly string[] {
  const m = target.match(/^(.*)\{([^}]+)\}(.*)$/)
  if (m === null) return [target]
  const [, prefix = '', body = '', suffix = ''] = m
  return body.split(',').map((part) => `${prefix}${part}${suffix}`)
}

// --- assertion #1 — skip-completeness ---------------------------------------

export interface UnaccountedCase {
  readonly path: string
  readonly name: string
  readonly line: number
  readonly state: SkipState
  readonly groupB: boolean
}

export interface ReconcileFinding {
  readonly missingFiles: readonly string[]
  readonly unaccounted: readonly UnaccountedCase[]
  readonly danglingMarkers: readonly { readonly path: string; readonly target: string }[]
  /**
   * #2 (ledger-completeness) — baseline cases whose name appears nowhere in the
   * ledger. Reported but NON-BLOCKING this phase (P14-D3): the prose ledger
   * abbreviates some paths, so a strict over-the-whole-tree assertion would be
   * noisy. Phase 15 normalises the ledger and promotes this to blocking.
   */
  readonly unledgered: readonly { readonly path: string; readonly name: string }[]
}

function testEntries(baseline: Baseline): readonly BaselineEntry[] {
  return baseline.files.filter(
    (e) => e.classification === 'test' || e.classification === 'type-test',
  )
}

export function reconcile(baseline: Baseline): ReconcileFinding {
  const ledger = loadLedger()
  const drops = dropLedgeredCases(ledger)

  const missingFiles: string[] = []
  const unaccounted: UnaccountedCase[] = []
  const danglingMarkers: { path: string; target: string }[] = []
  const unledgered: { path: string; name: string }[] = []

  for (const entry of testEntries(baseline)) {
    if (!existsSync(entry.path)) {
      // A deleted baseline file fails reconciliation — it was never skipped (D2).
      missingFiles.push(entry.path)
      continue
    }
    const source = readFileSync(entry.path, 'utf-8')

    // #3 — marker targets must exist (checked on every old file). Only concrete
    // path targets are validated; the convention also writes prose targets
    // (`→ split across …`, `→ (dropped)`, `→ never executed …`) which carry no
    // single file to check. A `{a,b}` brace shorthand naming two twins expands.
    for (const m of source.matchAll(/\/\/ (?:MIGRATED|COVERED BY|DROPPED) → (\S+)/g)) {
      const raw = m[1]
      if (raw === undefined) continue
      for (const target of expandBraceTargets(raw)) {
        if (!isConcretePathTarget(target)) continue
        if (!existsSync(target)) danglingMarkers.push({ path: entry.path, target })
      }
    }

    // type-test files have no runtime cases; the marker-only convention accounts
    // for them (parent U13). Existence above is the whole check.
    if (entry.classification === 'type-test') continue

    const hits = resolveCases(source, entry.path)
    for (const hit of hits) {
      // #2 — ledger-completeness (non-blocking): the baseline case name should
      // appear somewhere in the ledger. Computed for every case; only reported.
      if (!ledger.includes(hit.name)) unledgered.push({ path: entry.path, name: hit.name })

      if (hit.state === 'skipped') continue
      if (drops.has(hit.name)) continue
      unaccounted.push({
        path: entry.path,
        name: hit.name,
        line: hit.line,
        state: hit.state,
        groupB: isGroupB(entry.path),
      })
    }
  }

  return { missingFiles, unaccounted, danglingMarkers, unledgered }
}

// --- reporting --------------------------------------------------------------

function loadBaseline(): Baseline {
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf-8')) as Baseline
}

if (import.meta.main) {
  const finding = reconcile(loadBaseline())
  const groupB = finding.unaccounted.filter((u) => u.groupB)
  const other = finding.unaccounted.filter((u) => !u.groupB)

  const byFile = new Map<string, UnaccountedCase[]>()
  for (const u of finding.unaccounted) {
    const list = byFile.get(u.path) ?? []
    list.push(u)
    byFile.set(u.path, list)
  }

  process.stdout.write('# Reconciliation (frozen baseline, assertions #1–#3)\n\n')
  process.stdout.write(`Group-B unaccounted cases:  ${groupB.length}\n`)
  process.stdout.write(`Other unaccounted cases:    ${other.length}\n`)
  process.stdout.write(`Missing (deleted) files:    ${finding.missingFiles.length}\n`)
  process.stdout.write(`Dangling marker targets:    ${finding.danglingMarkers.length}\n`)
  process.stdout.write(
    `Unledgered cases (#2, non-blocking): ${finding.unledgered.length}\n\n`,
  )

  if (byFile.size > 0) {
    process.stdout.write('## Unaccounted cases (by file)\n\n')
    for (const [path, cases] of [...byFile.entries()].sort()) {
      const tag = cases[0]?.groupB ? 'group-B' : 'other'
      process.stdout.write(`### ${path} (${cases.length}, ${tag})\n`)
      for (const c of cases) {
        process.stdout.write(`- L${c.line} [${c.state}] ${c.name}\n`)
      }
      process.stdout.write('\n')
    }
  }
  if (finding.missingFiles.length > 0) {
    process.stdout.write('## Missing files (must be on disk + skipped, D2)\n\n')
    for (const p of finding.missingFiles) process.stdout.write(`- ${p}\n`)
    process.stdout.write('\n')
  }
  if (finding.danglingMarkers.length > 0) {
    process.stdout.write('## Dangling marker targets\n\n')
    for (const d of finding.danglingMarkers) {
      process.stdout.write(`- ${d.path} → ${d.target}\n`)
    }
    process.stdout.write('\n')
  }

  const total =
    finding.unaccounted.length + finding.missingFiles.length + finding.danglingMarkers.length
  process.exit(total === 0 ? 0 : 1)
}
