---
date: 2026-06-10
topic: binary-smoke-testing
status: shipped
problem_type: testing_gap
component: tooling
tags:
  - bun-compile
  - standalone-binary
  - smoke-test
  - test-seams
  - bunfs
  - check-release
---

# Testing the compiled binary — the suite runs under `bun`, so binary-only bugs are invisible

> Captured alongside [`compiled-binary-tui-launch-contract.md`](compiled-binary-tui-launch-contract.md).
> That bug shipped with a fully green `bun run check`. This is *why*, and the
> testing layer added so it can't happen again.

## Symptom

A launch bug that crashed the Homebrew binary's left pane on every run passed
**every** unit and integration test. Nothing in the suite went red. Worse: a
regression introduced *while fixing it* (an embedded runner self-executing at
import and hijacking `--help`/`runs`) was also green under `bun` — it only
surfaced when the real binary was rebuilt and run by hand.

## Root cause

The whole suite runs under the `bun` interpreter. In that environment the two
facts a compiled binary changes simply don't hold:

- `process.execPath` is a real interpreter (so `[execPath, script, …]` "works").
- `import.meta.url` is a real file path — **never** under `/$bunfs/` — so any
  "am I embedded?" / "should I self-exec?" branch always takes the dev arm.

So an entire **class** of bugs — anything keyed off `process.execPath` being the
binary, or a module's path being embedded — is structurally unreachable by a
`bun`-run test. The existing launcher test even asserted `argv[0]` contains
`process.execPath` while encoding the *wrong* contract, and stayed green.

## Fix / takeaway

Three complementary layers, cheapest first:

1. **Faithfully simulate at unit speed by injecting the binary's two strings.**
   The launchers already expose `bunExecPath` / `runnerScript` override seams.
   A unit test passes the captured values
   (`bunExecPath: '/opt/homebrew/bin/orch'`, `runnerScript: '/$bunfs/root/…'`)
   and asserts the **round-trip**: `argv[1]` is a command the dispatcher
   recognizes — *not* a literal argv snapshot (a snapshot just re-encodes the
   fix). Tie producer and consumer through one shared constant so the assertion
   is meaningful. This catches the launch-contract half on the fast gate.

2. **A binary smoke layer that builds the real artifact.**
   `tests/binary-smoke/binary-launch.test.ts` runs `bun build --compile`, then
   asserts headlessly (no tmux, no agent): `--help` prints usage (catches the
   import-time self-exec regression), and `__steps-view` / `__ask` route instead
   of "Unknown command" (catches the launch contract end-to-end against Bun's
   real compiled-binary argv handling — the one thing the unit seam takes on
   faith). It lives in its own directory so the path-based selection never pulls
   it into the fast loop, and is gated via `bun run test:binary-smoke` inside
   `check:release` (the build adds seconds — it does **not** belong on
   `bun run check`).

3. **A build-and-run helper for manual exercise** — `scripts/orch-binary.ts`
   (`bun run orch:binary`). No args → build `dist/orch`, print the path. With
   args → build, then exec the binary with that argv and inherited stdio (a real
   terminal gives it a TTY, so two-pane attaches exactly like an installed
   user's). This is "run it the way Homebrew users get it" in one command, and
   is the substrate the smoke test is built on.

**What the smoke does NOT cover:** it is headless, so it proves the *launch
contract*, not that the pane visually renders. The full build → tmux →
screenshot path needs a TTY and lives in the real-tmux harness / the
`orch-qa-engineer` skill.

## Lesson

- **If an artifact is built differently from how it's tested, it is untested.**
  A green suite under `bun` says nothing about the `--compile` binary. Any
  release that ships a different artifact needs at least one smoke test that
  exercises *that* artifact.
- **Assert the round-trip, not a snapshot.** A regression test that pins the new
  argv literally would pass for the wrong reasons. Asserting "the produced
  command is one the consumer recognizes" is what actually locks the contract.
- **Keep the heavy artifact test off the hot loop.** Build-and-run belongs in a
  release gate; the fast gate stays fast by simulating the binary's inputs via
  injection seams.

## References

- `tests/binary-smoke/binary-launch.test.ts` — the smoke layer
- `scripts/orch-binary.ts` — build-and-run helper (`bun run orch:binary`)
- `package.json` — `test:binary-smoke`, wired into `check:release`
- `tests/unit/hosts/two-pane/steps-view/start-steps-view.test.ts`,
  `tests/integration/services/prompt/ink-prompt-service.test.ts`,
  `tests/integration/cli/main-dispatch.test.ts` — the injected-string unit/dispatch seams
- [`compiled-binary-tui-launch-contract.md`](compiled-binary-tui-launch-contract.md) — the bug this guards
