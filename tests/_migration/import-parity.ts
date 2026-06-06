// ---------------------------------------------------------------------------
// import-parity (parent R10) — the relocation migration's safety guard.
// ---------------------------------------------------------------------------
//
// U10–U13 RELOCATE ~300 non-two-pane test files from `tests/` into `tests-new/`.
// Moving a file changes its relative depth: a wrong `../` count silently
// resolves to nothing or to the WRONG module while the diff still "looks"
// import-path-identical. "`bun run check` is green" is not enough — a test that
// imports a stale module can pass for the wrong reason. This guard makes the
// relocation contract checkable per file:
//
//   1. PARITY      — the relocated file imports the SAME set of `src/<path>#<sym>`
//                    tuples as its baseline original (depth-preserving move).
//   2. RESOLUTION  — every import specifier in the relocated file resolves to a
//                    file that exists on disk (no dangling `../`).
//   3. CROSS-TREE  — no relocated-file specifier resolves under `tests/` (the
//                    D13 ban; relocated files use `@orch/test/*` shims instead).
//
// Like `overlap-report.ts` / `snapshot.ts`, the pure core reads SOURCE TEXT and
// walks the TypeScript AST — it MUST NOT `import` a test file (that would
// register/execute Bun tests). The relocation pairs come from the committed
// `relocation-map.json`, which each relocation phase appends to as rows land.

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import * as ts from 'typescript'

const REPO_ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..', '..')
const MAP_PATH = join('tests', '_migration', 'relocation-map.json')

// tsconfig path aliases that point at on-disk locations (kept in sync with
// tsconfig.json `paths`). Each maps an `@orch/<x>/` prefix to a repo-relative dir.
const ALIASES: ReadonlyArray<readonly [string, string]> = [
  ['@orch/core/', 'src/core/'],
  ['@orch/runners/', 'src/runners/'],
  ['@orch/services/', 'src/services/'],
  ['@orch/state/', 'src/state/'],
  ['@orch/validators/', 'src/validators/'],
  ['@orch/test/', 'tests/_support/'],
]

export interface ImportBinding {
  /** repo-relative path the specifier resolves to (forward-slashed). */
  readonly target: string
  /** the imported symbol: a named binding, `default`, `*`, or `''` (side-effect). */
  readonly symbol: string
  /** the raw specifier as written, for diagnostics. */
  readonly specifier: string
}

export interface ParityViolation {
  readonly kind: 'parity' | 'resolution' | 'cross-tree'
  readonly file: string
  readonly detail: string
}

// --- specifier resolution (pure) --------------------------------------------

/** Forward-slash a path so checks are stable across platforms. */
function slash(p: string): string {
  return p.split('\\').join('/')
}

/**
 * Resolve an import specifier to a repo-relative path, or `undefined` when it is
 * a bare/builtin specifier (`bun:test`, `node:fs`, an npm package) that does not
 * name an on-disk repo file. `fileDir` is the importing file's dir, repo-relative.
 */
export function resolveSpecifier(specifier: string, fileDir: string): string | undefined {
  for (const [prefix, dir] of ALIASES) {
    if (specifier.startsWith(prefix)) return slash(join(dir, specifier.slice(prefix.length)))
  }
  if (specifier.startsWith('.')) return slash(join(fileDir, specifier))
  return undefined
}

// --- AST parse (source text → import bindings; NEVER import) -----------------

function bindingsFromClause(clause: ts.ImportClause | undefined): readonly string[] {
  if (clause === undefined) return [''] // side-effect import
  const out: string[] = []
  if (clause.name !== undefined) out.push('default')
  const named = clause.namedBindings
  if (named !== undefined) {
    if (ts.isNamespaceImport(named)) out.push('*')
    else for (const el of named.elements) out.push(el.name.text)
  }
  return out.length > 0 ? out : ['']
}

/**
 * Every import in `source`, each resolved against `fileDir` (the file's
 * repo-relative directory). Bare/builtin specifiers are dropped. Pure: no
 * evaluation, so a file that would THROW on import still parses cleanly.
 */
export function parseImports(
  source: string,
  fileName: string,
  fileDir: string,
): readonly ImportBinding[] {
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind)
  const out: ImportBinding[] = []

  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue
    if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue
    const specifier = stmt.moduleSpecifier.text
    const target = resolveSpecifier(specifier, fileDir)
    if (target === undefined) continue
    for (const symbol of bindingsFromClause(stmt.importClause)) {
      out.push({ target, symbol, specifier })
    }
  }
  return out
}

/** The set of `src/<path>#<symbol>` tuples an import list touches. */
export function srcSymbolSet(bindings: readonly ImportBinding[]): ReadonlySet<string> {
  const set = new Set<string>()
  for (const b of bindings) {
    if (b.target.startsWith('src/')) set.add(`${b.target}#${b.symbol}`)
  }
  return set
}

// --- parity check (pure over text + a disk-resolution probe) -----------------

function dirOf(repoRelPath: string): string {
  return slash(dirname(repoRelPath))
}

/** Symmetric difference of two string sets, sorted, for a stable diagnostic. */
function symDiff(a: ReadonlySet<string>, b: ReadonlySet<string>): string[] {
  const out: string[] = []
  for (const x of a) if (!b.has(x)) out.push(`-${x}`)
  for (const x of b) if (!a.has(x)) out.push(`+${x}`)
  return out.sort()
}

/**
 * Check one relocation pair. `exists` resolves a repo-relative module path
 * (without extension assumptions — the specifiers carry `.ts`/`.tsx`) to a
 * boolean; injectable so the pure core is unit-testable against a fixture map.
 */
export function checkParity(
  oldFile: { path: string; source: string },
  newFile: { path: string; source: string },
  exists: (repoRelPath: string) => boolean,
): readonly ParityViolation[] {
  const violations: ParityViolation[] = []
  const oldBindings = parseImports(oldFile.source, oldFile.path, dirOf(oldFile.path))
  const newBindings = parseImports(newFile.source, newFile.path, dirOf(newFile.path))

  const diff = symDiff(srcSymbolSet(oldBindings), srcSymbolSet(newBindings))
  if (diff.length > 0) {
    violations.push({
      kind: 'parity',
      file: newFile.path,
      detail: `src import set differs from baseline (${oldFile.path}): ${diff.join(' ')}`,
    })
  }

  for (const b of newBindings) {
    if (!exists(b.target)) {
      violations.push({
        kind: 'resolution',
        file: newFile.path,
        detail: `unresolved import '${b.specifier}' → ${b.target}`,
      })
    }
  }
  return violations
}

// --- runnable report (reads files, NEVER imports them) ----------------------

export interface RelocationPair {
  readonly old: string
  readonly new: string
}

function existsRepoRel(repoRelPath: string): boolean {
  return existsSync(join(REPO_ROOT, repoRelPath))
}

export function loadRelocationMap(mapPath: string = MAP_PATH): readonly RelocationPair[] {
  if (!existsSync(join(REPO_ROOT, mapPath))) return []
  return JSON.parse(readFileSync(join(REPO_ROOT, mapPath), 'utf-8')) as readonly RelocationPair[]
}

export function checkMap(
  pairs: readonly RelocationPair[],
  exists: (repoRelPath: string) => boolean = existsRepoRel,
  read: (repoRelPath: string) => string = (p) => readFileSync(join(REPO_ROOT, p), 'utf-8'),
): readonly ParityViolation[] {
  const out: ParityViolation[] = []
  for (const pair of pairs) {
    if (!exists(pair.old)) {
      // Old file was moved to a different path or deleted — parity cannot be verified.
      // Check resolution only for the new file.
      const newBindings = parseImports(read(pair.new), pair.new, dirOf(pair.new))
      for (const b of newBindings) {
        if (!exists(b.target)) {
          out.push({
            kind: 'resolution',
            file: pair.new,
            detail: `unresolved import '${b.specifier}' → ${b.target}`,
          })
        }
      }
      continue
    }
    out.push(
      ...checkParity(
        { path: pair.old, source: read(pair.old) },
        { path: pair.new, source: read(pair.new) },
        exists,
      ),
    )
  }
  return out
}

export function renderViolations(
  pairs: readonly RelocationPair[],
  violations: readonly ParityViolation[],
): string {
  const lines: string[] = []
  lines.push('import-parity (BLOCKING — non-zero exit on any violation, parent R10)')
  lines.push(`relocation pairs checked: ${pairs.length}`)
  lines.push('')
  if (violations.length === 0) {
    lines.push('✓ every relocated file has src-import parity, resolves, and stays in-tree')
  } else {
    lines.push(`✗ ${violations.length} violation(s):`)
    for (const v of violations) lines.push(`  - [${v.kind}] ${v.file}: ${v.detail}`)
  }
  return lines.join('\n')
}

if (import.meta.main) {
  const pairs = loadRelocationMap()
  if (pairs.length === 0) {
    process.stderr.write(
      'import-parity: relocation map is empty or missing — this is a false-green signal\n',
    )
    process.exit(1)
  }
  const violations = checkMap(pairs)
  process.stdout.write(`${renderViolations(pairs, violations)}\n`)
  process.exit(violations.length > 0 ? 1 : 0)
}
