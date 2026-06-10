// ---------------------------------------------------------------------------
// embedded-child — argv construction for re-launching an embedded TUI child.
// ---------------------------------------------------------------------------
//
// orch spawns its interactive TUI children (the steps-view left pane, the
// `ask()` prompt) by re-invoking itself. HOW it re-invokes depends on whether
// orch is a dev checkout or a `bun build --compile` standalone binary:
//
//   • Dev checkout: `process.execPath` is the `bun` interpreter and the runner
//     resolves to a real on-disk `.tsx`/`.ts` file. We launch
//     `[bun, <runner>, ...args]` and bun runs the file directly.
//
//   • Compiled binary (Homebrew): `process.execPath` IS the orch binary — a
//     single-entrypoint executable, not a generic interpreter — and the runner
//     resolves under Bun's embedded FS (`/$bunfs/...`). Launching
//     `[orch, /$bunfs/.../runner.tsx, ...]` makes the CLI treat that path as a
//     command → "Unknown command" → exit 2 → the pane dies. Instead we
//     re-invoke `[orch, <subcommand>, ...args]` and the CLI dispatcher
//     (`main.ts`) routes the subcommand straight to the runner.
//
// Both call sites share this one detection so the launcher and dispatcher
// halves of the contract are derived from a single rule.

/**
 * True when a runner path resolves under Bun's embedded filesystem — i.e. orch
 * is running as a compiled standalone binary rather than a dev checkout.
 */
export function isEmbeddedRunnerPath(runnerScript: string): boolean {
  return runnerScript.includes('/$bunfs/')
}

/**
 * Build the argv that re-launches an embedded TUI child.
 *
 * Returns `[execPath, <runner>, ...trailing]` in a dev checkout and
 * `[execPath, <subcommand>, ...trailing]` in a compiled binary. The trailing
 * args (e.g. `--opts <b64>` or `--spec <b64> --result <path>`) are identical in
 * both modes — only the head token the binary receives as `positionals[0]`
 * changes.
 */
export function embeddedChildArgv(opts: {
  readonly execPath: string
  readonly runnerScript: string
  readonly subcommand: string
  readonly trailing: readonly string[]
}): string[] {
  const head = isEmbeddedRunnerPath(opts.runnerScript) ? opts.subcommand : opts.runnerScript
  return [opts.execPath, head, ...opts.trailing]
}
