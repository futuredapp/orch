---
date: 2026-04-14
topic: interactive-mode-tty-colors
---

# Interactive Mode: Restore TTY Colors

## What We're Building

The interactive mode added in Phase 13a spawns the `claude` CLI via `Bun.spawn({ stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' })` in `BunProcessService.spawnForeground` (`src/services/process/bun-process-service.ts:63`). That gives the child inherited file descriptors but **not a pseudo-TTY**. Inside the spawned process, `process.stdout.isTTY === false`, so Claude Code's Ink/React renderer falls back to a plain, monochrome layout (no blue banner, no dim greys, no highlighted diff blocks) — visible in the user's screenshot.

The fix is to attach a real PTY so the child sees a terminal. Bun 1.3.5+ provides this natively via the `terminal: true` spawn option (POSIX only; macOS/Linux — matches our target).

## Why This Approach

- **A — Bun `terminal: true` (chosen):** One-flag change inside `BunProcessService`; no new deps; native PTY; fixes both colors and other TTY-sensitive behaviors (line editing, resize signals).
- **B — `FORCE_COLOR=1` / `COLORTERM=truecolor` only:** Rejected. Claude Code checks `isTTY` directly, not just env vars ([anthropics/claude-code#29706](https://github.com/anthropics/claude-code/issues/29706)). Even if colors appeared, arrow keys and REPL behavior would still be degraded.
- **C — `node-pty` adapter:** Rejected for now. Heavy native dep; broader surface area in the one module allowed to touch subprocesses; Bun's built-in PTY covers all current platforms.

## Key Decisions

- **PTY via `Bun.spawn({ terminal: true, ... })`:** cleanest seam, stays inside `BunProcessService`. Rationale: respects rule #1 (all subprocess calls through `ProcessService`) without introducing a new module or dep.
- **Scope limited to `spawnForeground`:** autonomous (`spawn`) path stays pipe-based so we can keep capturing stdout/stderr for transcripts. Rationale: PTY and piped capture are mutually exclusive; interactive is the only mode that needs a terminal.
- **Verification via `examples/riddle-solver`:** manual run to confirm the colored Claude banner returns and Ctrl-C still exits cleanly. Rationale: fastest feedback; matches how the bug was discovered.
- **Assume Bun ≥ 1.3.5:** no Windows fallback today; if we ever need Windows, revisit node-pty then. Rationale: YAGNI.

## Open Questions

- Does `terminal: true` interact with our existing `AbortSignal` / Ctrl-C propagation in `spawnForeground`? Worth a quick verification during implementation.
- Should we bump a minimum Bun version check somewhere (`package.json` engines or a runtime assertion) so this fails loudly on older Bun?

## Next Steps

→ `/workflows:plan` for implementation details (exact diff in `bun-process-service.ts`, engines bump, manual test script).
