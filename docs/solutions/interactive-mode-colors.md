---
date: 2026-04-14
topic: interactive-mode-colors
status: superseded
superseded_by: docs/plans/2026-05-11-001-feat-decouple-live-runner-unified-pane-map-plan.md
---

# Interactive mode: restoring colors without a PTY

> **2026-05-11 — superseded for the two-pane right-pane case.** The unified
> pane-map design (U6) spawns interactive runners directly into a hidden
> tmux pane (`tmux split-window`) on a sibling scratch session, then
> `swap-pane`s it into the visible right slot. The hidden pane is a real
> PTY (`isTTY === true`), so arrow keys, Ctrl-C, Ctrl-R, resize reflow, and
> colors all flow natively without the `FORCE_COLOR=3` workaround. The env
> override is still applied via the runner's `mergeEnv` slot but is
> redundant inside the tmux pane.
>
> This doc remains authoritative for the **plain-host** interactive path,
> where `Bun.spawn(...)` with inherited stdio (no PTY) is still the
> mechanism and `FORCE_COLOR=3` is still the workaround. The two-pane
> "escalate to full PTY" follow-up named below is the design that landed
> in the pane-map plan.

## Symptom

Running an interactive Claude step through the orchestrator (e.g., `bun run examples/riddle-solver/index.ts`) produced a **completely black-and-white** Claude REPL — no blue banner, no dim greys, no colored diff blocks. Running `claude` directly from the same terminal rendered normally.

## Root cause

`BunProcessService.spawnForeground` (`src/services/process/bun-process-service.ts`) spawns the child with:

```ts
Bun.spawn({
  cmd: [...opts.argv],
  cwd: opts.cwd,
  env: opts.env,
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
})
```

`stdio: 'inherit'` shares the parent's file descriptors with the child but does **not** allocate a pseudo-terminal. Inside the Claude CLI:

- `process.stdout.isTTY === false`
- Ink's `supports-color` returns level 0
- chalk strips all ANSI escapes → the monochrome output we saw

Setting `TERM` and `COLORTERM` alone isn't enough because `supports-color` gates on `isTTY` first. `FORCE_COLOR`, however, **overrides the isTTY check** and directly selects an ANSI level.

## What we shipped (partial fix)

Under the [2026-04-27 env passthrough contract](../plans/2026-04-27-feat-env-passthrough-plan.md), the runner builds env via `mergeEnv(process.env, extras, ctx.env)`. `TERM` / `COLORTERM` flow through automatically — no explicit allowlist needed. The only env adjustment the Claude runner makes for interactive mode is `FORCE_COLOR=3`, passed via the `extras` slot of `mergeEnv`:

```ts
const extras = ctx.mode === 'interactive' ? { FORCE_COLOR: '3' } : {}
const env = mergeEnv(process.env, extras, ctx.env)
```

chalk level 3 = truecolor. `ctx.env` wins last by design, so a workflow author can disable the extra (e.g. `FORCE_COLOR=0`) per step. Autonomous mode is untouched — it pipes NDJSON and doesn't need colors.

## What this fix does NOT restore

`FORCE_COLOR=3` only brings back colors. The child still sees `isTTY === false`, which means Ink stays in its "static" (non-interactive) render mode. If you notice any of the following, escalate to a full PTY passthrough:

- Arrow-key line editing feels broken inside the REPL
- Ctrl-R / Ctrl-C handling inside the Claude UI misbehaves
- Terminal-resize doesn't reflow the Claude UI
- Spinner / progress animations render as static text

## Full fix (if needed later): Bun PTY passthrough

Bun 1.3.5+ exposes a `terminal` option on `Bun.spawn` that allocates a real PTY. It is **not** a boolean; it's a managed terminal where the parent must forward stdin and handle resize.

Rough sketch for `spawnForeground`:

```ts
const proc = Bun.spawn({
  cmd: [...opts.argv],
  cwd: opts.cwd,
  env: opts.env,
  terminal: {
    cols: process.stdout.columns ?? 80,
    rows: process.stdout.rows ?? 24,
    data: (_term, chunk) => {
      process.stdout.write(chunk)
    },
  },
})

// Forward parent stdin → child PTY
const wasRaw = process.stdin.isRaw
process.stdin.setRawMode?.(true)
const onData = (chunk: Buffer) => proc.terminal?.write(chunk)
process.stdin.on('data', onData)

// Resize
const onResize = () => {
  proc.terminal?.resize(process.stdout.columns ?? 80, process.stdout.rows ?? 24)
}
process.stdout.on('resize', onResize)

// Cleanup (wrap in the returned ForegroundHandle)
const cleanup = () => {
  process.stdin.off('data', onData)
  process.stdout.off('resize', onResize)
  process.stdin.setRawMode?.(wasRaw ?? false)
}
```

Notes before doing this:

- POSIX only — we'd need a fallback or a runtime guard for Windows.
- `proc.terminal.write`/`resize` return `undefined` when the PTY is closed; guard accordingly.
- `setRawMode` must be restored on ALL exit paths (normal exit, `kill()`, uncaught errors).
- This breaks the `stdio: 'inherit'` symmetry with the autonomous spawn — a clear seam is needed so autonomous mode keeps its piped stdout capture.

## Why we didn't ship the full PTY fix now

The brainstorm assumed `terminal: true` was a boolean flag (it isn't), so the initial one-line estimate was wrong. `FORCE_COLOR=3` covers the reported symptom with three lines and no new platform concerns. The PTY passthrough is a real feature worth a separate plan if users hit the gaps above.

## Related

- Brainstorm: [`docs/brainstorms/2026-04-14-interactive-mode-tty-colors-brainstorm.md`](../brainstorms/2026-04-14-interactive-mode-tty-colors-brainstorm.md)
- Upstream: [anthropics/claude-code#29706](https://github.com/anthropics/claude-code/issues/29706)
- Bun PTY docs: https://bun.com/reference/bun/Terminal
- chalk / supports-color FORCE_COLOR behavior: https://github.com/chalk/supports-color#info
