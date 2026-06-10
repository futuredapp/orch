#!/usr/bin/env bun
//
// orch-binary.ts — build the standalone `orch` binary, then optionally run it.
//
// This is the "test it the way Homebrew users get it" wrapper. A `bun build
// --compile` binary behaves differently from a dev checkout (`process.execPath`
// is the binary itself, embedded modules live under `/$bunfs/...`), so launch
// bugs in that environment are invisible to `bun run` and to the unit suite.
// This script lets you exercise the real artifact in one step.
//
// Usage:
//   bun scripts/orch-binary.ts                      # build only → prints the path
//   bun scripts/orch-binary.ts run hello --mode=plain
//   bun scripts/orch-binary.ts __steps-view         # poke an internal subcommand
//   bun scripts/orch-binary.ts --no-build run hello # reuse an existing dist/orch
//
// Everything after the flags is forwarded verbatim to the binary, with stdio
// inherited — so when you run it from a real terminal the binary gets a TTY and
// two-pane mode works exactly as it would for an installed user.

const OUTFILE = 'dist/orch'

// We split our own flags from the binary's argv at the first non-flag token (or
// `--`). `parseArgs` with `strict:false` + `stopAtPositional`-style handling is
// awkward here because we WANT to stop consuming once the binary's command
// begins, so we scan manually.
const raw = Bun.argv.slice(2)

let noBuild = false
let i = 0
for (; i < raw.length; i++) {
  const tok = raw[i]
  if (tok === '--no-build') {
    noBuild = true
    continue
  }
  if (tok === '--') {
    i++
    break
  }
  // First token that isn't one of our flags is the start of the binary's argv.
  break
}
const binaryArgs = raw.slice(i)

async function build(): Promise<void> {
  const proc = Bun.spawn(['bun', 'scripts/build-binary.ts', '--outfile', OUTFILE], {
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const code = await proc.exited
  if (code !== 0) {
    process.stderr.write(`orch-binary: build failed (exit ${code})\n`)
    process.exit(code)
  }
}

if (!noBuild) {
  await build()
}

if (binaryArgs.length === 0) {
  // Build-only mode: hand back the absolute path so the caller can run it again.
  const abs = `${process.cwd()}/${OUTFILE}`
  process.stdout.write(`${abs}\n`)
  process.exit(0)
}

// Run mode: exec the freshly built binary with the forwarded argv, inheriting
// stdio so it owns the terminal (TTY → two-pane attaches just like a real run).
const run = Bun.spawn([OUTFILE, ...binaryArgs], {
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
})
process.exit(await run.exited)
