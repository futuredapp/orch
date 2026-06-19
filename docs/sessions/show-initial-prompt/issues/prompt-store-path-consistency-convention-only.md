# Prompt-store write path and replay-fallback read path agree by convention only

**Source:** CE review "Coverage notes & residual risks" (not a numbered finding;
flagged as a residual risk).

**Status:** Not selected for fixing — no defect today. Recorded as a deferred
test-hardening follow-up.

## What it is

The always-on prompt store derives its path in two independent places:

- **Write:** `createPromptStore(stateDir).write` →
  `promptStorePathFor(stateDir, step)` = `<stateDir>/agents/<step>/prompt.txt`
  (`src/hosts/two-pane/prompt-store.ts:47-49,65-72`).
- **Read (replay fallback):** `readPersistedPrompt(stateDir, step)`, which calls
  the same `promptStorePathFor` (`prompt-store.ts:56-62`), invoked from
  `resolveAutonomousReplaySpec` in
  `src/hosts/two-pane/pane-map/right-pane-controller.ts:1242`.

They share `promptStorePathFor` today, so they agree. But the contract that the
choreographer writes where the controller's replay fallback reads is not pinned by
a round-trip test — a future refactor that re-roots one side (e.g. derives the
path inline, or changes the `agents/<step>` segment) could silently desynchronize
write and read, breaking R8/AT-7 replay on the logger-disabled path with no test
failing.

The step-name segment is pattern-validated (`/^[a-z0-9][a-z0-9:>-]*$/`), so there
is no path-traversal risk through the interpolated `<step>` — this is purely about
write/read path agreement.

## Where

- `src/hosts/two-pane/prompt-store.ts` (`promptStorePathFor`, `createPromptStore`,
  `readPersistedPrompt`).
- `src/hosts/two-pane/pane-map/right-pane-controller.ts:1242`
  (`resolveAutonomousReplaySpec` fallback read).

## Why it matters (low)

R8's always-on replay parity depends on this round-trip holding. The existing
`right-pane-replay-prompt-fallback.test.ts` writes via `createPromptStore` and
reads via the controller, so it *does* exercise the round-trip for the current
code — but it asserts rendered content, not that both sides resolve the **same
path**, so a path-derivation drift could still slip through if the test fixture
were updated in lockstep with a bad refactor.

## Suggested next step

Add a small round-trip test that writes a prompt for a step via
`createPromptStore(stateDir)` and asserts the controller's replay fallback reads
**that exact file** back (e.g. by asserting `readPersistedPrompt` returns it and
that the fallback replay file leads with its preamble) — locking the path contract
across the two modules so a future re-rooting fails loudly.
