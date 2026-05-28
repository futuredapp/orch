---
date: 2026-05-26
status: open
area: src/core, src/runners/codex
type: architecture
recommendation: strong
dependency-category: in-process
---

# CaptureLock lives in the Codex runner but is owned by the core executor

## Problem

`src/core/workflow.ts:10` imports `createCaptureLock` from
`../runners/codex/capture-lock.ts`. This breaks **non-negotiable rule #2** in
CLAUDE.md:

> The core (`src/core/`) never imports a concrete runner.

The lock is a workflow-execution primitive — it serialises concurrent
`captureSessionId` windows that share the same backing filesystem — not a Codex
adapter concern. Its own header comment admits this and says "promote to
`src/services/` if a second runner ever needs it." That trigger is the wrong
one: the rule is already violated today, with one runner.

## Files

- `src/runners/codex/capture-lock.ts` — the misplaced module
- `src/core/workflow.ts:10` — the cross-layer import
- `src/core/workflow.ts:594` — `const captureLock = createCaptureLock()`, the sole caller
- `src/runners/codex/capture-thread-id.ts` — the in-runner consumer
- `src/runners/types.ts:204` — the `CaptureLock` interface (already in core-visible types)

## Solution

Move `capture-lock.ts` to `src/services/` and export it through the services
barrel. Both `src/core/workflow.ts` and `src/runners/codex/capture-thread-id.ts`
import from the shared edge.

## Wins

- Restores rule #2 — core stops importing a concrete runner
- Locality: the lock's home matches its (workflow) scope
- A second runner needing it pays no migration tax
- Lowest-risk change of the five — a move + two import rewrites

## Recommendation strength

**Strong.** Sharp, small, fixes a stated rule violation in one commit.
