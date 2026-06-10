---
date: 2026-06-10
topic: compiled-binary-tui-launch-contract
status: shipped
problem_type: distribution_bug
component: hosts
tags:
  - bun-compile
  - standalone-binary
  - homebrew
  - bunfs
  - import-time-side-effects
  - steps-view
  - ask-prompt
---

# A compiled binary can't exec its own embedded files — re-enter via a CLI subcommand

> Captured while diagnosing the first Homebrew install. The two-pane left pane
> died on launch with `Unknown command: /$bunfs/root/steps-view-runner.tsx`.
> The bug was invisible to the entire green test suite because it can only
> happen in a `bun build --compile` binary, never under `bun`.

## Symptom

Installed via Homebrew (the standalone binary), `orch run` came up with the
right pane working but the **left (steps) pane dead**:

```
Unknown command: /$bunfs/root/steps-view-runner.tsx
Usage: orch <command> [options]
...
Pane is dead (status 2)
```

A dev checkout (`bun link` / `bun run`) was completely unaffected. Reproduced
deterministically by handing the compiled binary the same argv the launcher
builds: `dist/orch /$bunfs/root/steps-view-runner.tsx --opts <b64>` → byte-for-byte
the same "Unknown command" + exit 2.

## Root cause

orch launches its two-pane TUI children (the steps-view left pane, and the
`ask()` prompt) by **re-invoking itself**. The argv was built as:

```ts
const argv = [process.execPath, runnerScript, '--opts', optsB64]
```

This silently assumes `process.execPath` is the **`bun` interpreter** and
`runnerScript` is a real on-disk file bun can run. Both assumptions break in a
`bun build --compile` standalone binary:

| | dev checkout (`bun`) | compiled binary (Homebrew) |
| --- | --- | --- |
| `process.execPath` | the `bun` interpreter | **the `orch` binary itself** (single entrypoint, not an interpreter) |
| `runnerScript` (from `import.meta.url`) | real path `…/steps-view-runner.tsx` | `/$bunfs/root/steps-view-runner.tsx` (Bun's embedded virtual FS) |
| `[execPath, runnerScript, …]` means | "bun, run this file" | "orch, run command `/$bunfs/...tsx`" → **Unknown command → exit 2** |

A compiled binary has exactly **one** entrypoint (`bin.ts`); it is not a
general-purpose interpreter you can hand a script path to. The same latent bug
lived in `ask()` via `ink-runner.ts`.

**Second trap, discovered mid-fix.** The runner files self-execute at import
time (`if (isDirect()) …`, and `ink-runner.ts` called `main()` *unconditionally*
at module top-level). As soon as `main.ts` `import`ed them to route the new
subcommands, that side effect fired on **every** binary startup and hijacked
`--help`, `runs`, everything — each command parsed its own argv as steps-view
opts. This is the project's "no side effects at module import" rule (CLAUDE.md
#8) biting in the one environment the tests don't cover.

## Fix

Re-enter through a **recognized internal subcommand** instead of a file path:

1. **One shared detection rule** — `src/services/process/embedded-child.ts`:
   `isEmbeddedRunnerPath(p)` is `p.includes('/$bunfs/')`; `embeddedChildArgv({…})`
   returns `[execPath, runnerScript, …trailing]` in dev and
   `[execPath, subcommand, …trailing]` in a binary. Both launchers
   (`start-steps-view.ts`, `ink-prompt-service.ts`) go through it.
2. **Dispatcher** — `src/cli/internal-subcommands.ts` maps `__steps-view` →
   `runStepsViewRunner` and `__ask` → `runAskRunner`. `main()` routes these
   **before** flag parsing / mode resolution / the `[orch] mode=…` banner (none
   of which apply to a child pane, and the banner would corrupt the pane's TTY).
3. **A single shared subcommand constant** is referenced by *both* the launcher
   (producer of argv) and the dispatcher (consumer), so the two halves of the
   contract cannot silently drift — the exact failure mode of the original bug.
4. **Guard the self-exec** so embedded modules never run at import:
   `if (import.meta.url.includes('/$bunfs/')) return false` at the top of each
   runner's `isDirect()`. Dev (`bun <file>`) still self-execs via
   `import.meta.main`; the binary routes explicitly through `main.ts`.

## Lesson

- **A `bun build --compile` binary is not a generic interpreter.** Anything that
  spawns `[process.execPath, <a script path>, …]` works in dev and breaks in the
  binary. Re-entry into your own embedded code must go through a CLI subcommand
  the single entrypoint recognizes.
- **`/$bunfs/` is the signal.** Any embedded module's `import.meta.url` lives
  under Bun's virtual FS; that one substring distinguishes "compiled binary"
  from "dev checkout" for both argv construction and self-exec guarding.
- **Import-time side effects are a distribution landmine.** A self-executing
  module is harmless until something imports it; in a single-entrypoint binary
  that turns into "every command runs the wrong code at startup." Keep modules
  side-effect-free on import (CLAUDE.md #8) and gate any self-exec on being the
  true entrypoint *and* not embedded.
- A test suite that runs only under `bun` **cannot** see any of this — see
  [`binary-smoke-testing.md`](binary-smoke-testing.md).

## References

- `src/services/process/embedded-child.ts` — shared detection + argv builder
- `src/cli/internal-subcommands.ts`, `src/cli/main.ts` — the dispatcher
- `src/hosts/two-pane/steps-view/start-steps-view.ts` + `steps-view-runner.tsx`
- `src/services/prompt/ink-prompt-service.ts` + `ink-runner.ts`
- `tests/binary-smoke/binary-launch.test.ts`, `scripts/orch-binary.ts`
