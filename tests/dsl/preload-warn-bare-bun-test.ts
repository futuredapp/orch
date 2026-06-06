// ---------------------------------------------------------------------------
// Bun preload: warn on a bare `bun test` (no path argument) — D7.
// ---------------------------------------------------------------------------
//
// Selection is by PATH only (D8): the filesystem is the manifest. A bare
// `bun test` ignores that discipline and runs BOTH trees unbounded (incl. the
// serial-only lifecycle level and the tmux levels at full concurrency), which is
// exactly the contention the §D6 ceiling exists to prevent. CLAUDE.md names
// `bun run test:two-pane:fast` as the default and bans bare `bun test`; this
// preload makes the ban visible at the moment it happens.
//
// It is cheap, honest, and NON-BLOCKING: it only prints to stderr and never
// exits non-zero (D7) — it must not break a deliberate one-off `bun test <path>`.
//
// Detection (resolved at implementation time, per the parent's deferred note):
// under `bun test`, the preload's own `Bun.argv` is rewritten to the individual
// test FILE — it carries no `test` subcommand — and bun exposes no env var with
// the original filter. The only honest source of the original invocation is the
// process's OS-level argv, read once via `ps`. POSIX-only; any failure is
// swallowed (the guard is best-effort, never load-bearing).

function originalCommand(): string | undefined {
  try {
    const ps = Bun.spawnSync(['ps', '-o', 'command=', '-p', String(process.pid)])
    if (!ps.success) return undefined
    return ps.stdout.toString().trim()
  } catch {
    return undefined
  }
}

// Flags that consume the following token as their value — that token is NOT a
// test path. `--max-concurrency=N` (this repo's form) is self-contained, so it
// needs no entry here.
const VALUE_FLAGS = new Set([
  '--preload',
  '-r',
  '--require',
  '--timeout',
  '--test-name-pattern',
  '-t',
])

function ranBareBunTest(command: string): boolean {
  const tokens = command.split(/\s+/).filter((t) => t.length > 0)
  const testIdx = tokens.indexOf('test')
  if (testIdx < 0) return false // not a `bun test` invocation at all

  for (let i = testIdx + 1; i < tokens.length; i++) {
    const token = tokens[i]
    if (token === undefined) continue
    if (token.startsWith('-')) continue // a flag, not a path
    const prev = tokens[i - 1]
    if (prev !== undefined && VALUE_FLAGS.has(prev)) continue // this token is a flag's value
    return false // a positional path argument is present → not bare
  }
  return true // nothing after `test` → bare
}

const command = originalCommand()
if (command !== undefined && ranBareBunTest(command)) {
  process.stderr.write(
    '\n⚠️  bare `bun test` runs BOTH trees unbounded (ignores the §D6 concurrency\n' +
      '   ceiling and the path-is-the-manifest rule, D8). Use a targeted script —\n' +
      '   default: `bun run test:two-pane:fast`. See CLAUDE.md → "How to write tests".\n\n',
  )
}
