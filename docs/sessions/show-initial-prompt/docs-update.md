---
date: 2026-06-19
topic: show-initial-prompt
step: docs-update
---

# Docs update — show the initial prompt in the right pane

## What shipped (grounded in the diff, not the brainstorm)

For every **autonomous** agent step, the two-pane right pane now opens with the
exact assembled prompt orch sent — a `prompt:` label, the control-escaped prompt,
and a separator — above the agent's streamed output, **live and on replay**.
Interactive steps are untouched (they echo their own prompt). Internals:
`src/hosts/two-pane/prompt-preamble.ts` (escaper + renderer),
`prompt-store.ts` (always-on per-step `<stateDir>/agents/<step>/prompt.txt` for
logger-independent replay), `lifecycle-choreographer.ts` (writes the preamble at
`step:start`), `right-pane-controller.ts` + `pane-spec.ts` (from-start tail,
replay-fallback prepend, R9 copy-mode pin), `step-lifecycle.ts` + `workflow.ts`
(carry the prompt on `step:start`, strip it from the structured record), and new
copy-mode methods on the tmux service.

**Public-API impact: none.** The public barrel `src/index.ts` and its re-exported
barrels (`src/core`, `src/runners`, `src/validators`, `src/config`) are unchanged
(sync-guard grep: no workflow-author export added/removed). The `TmuxService`
interface gained copy-mode methods and option types, but those are re-exported
only through `src/services/tmux/index.ts` — **not** through `src/services/index.ts`
— so they never reach the public `orch` barrel, and `reference/api.md` (which
documents no tmux service surface) needs no change.

## Documentation surfaces

| Surface | Status | Reason |
| --- | --- | --- |
| `docs/public/guide/5-running-workflows.md` | **updated** | Enriched the right-pane description under "Choosing how it renders": autonomous steps now open with the labelled `prompt:` preamble above output, live and on replay; interactive steps add none. This is the narrative "what you see" home for the feature. |
| `docs/public/guide/3-core-concepts.md` | not needed | The run-modes table cell ("right pane = the active step's transcript or interactive TUI") still holds — the preamble is part of that transcript stream. The detail lives once, in guide/5, to avoid duplicating the same fact across two pages. |
| `docs/public/guide/6-debugging.md` | not needed | The prompt is already documented as available per step via `agents/<step>/session.json`. The new `agents/<step>/prompt.txt` is internal replay-support plumbing rooted in `stateDir` (outside the `logs/` tree this page enumerates) — not a new debugging surface. |
| `docs/public/reference/api.md` | not needed | No public barrel export changed (sync-guard clean). |
| `docs/public/reference/runners.md` | not needed | Runner adapters unchanged; no runner env/flag added. |
| `docs/public/reference/cli.md` | not needed | No CLI command or flag added/changed. |
| `docs/public/reference/config.md` | not needed | No config field or env var added/changed. |
| `docs/public/reference/built-ins.md` | not needed | No built-in workflow changed. |
| `docs/public/examples.md` | not needed | No example added or removed. |
| `docs/public/guides/*.md` | not needed | No new user-facing *task* recipe — the feature is observe-only behavior, covered by the guide narrative. |
| `README.md` | not needed | Pane-content detail is not a headline capability; the README lists tmux as a dependency but does not describe pane internals. |
| `CLAUDE.md` | not needed | No new non-negotiable rule or moved seam. The feature follows existing rules — subprocess/tmux isolation (§1) for the new copy-mode methods, co-located Pane Object chrome constants for the test side — none of which changed. |
| `AGENTS.md` | not needed | Does not exist; no rule belongs outside `CLAUDE.md`. |
| `docs/issues/` | not needed | The 4 deferred findings are already captured by the workflow under `docs/sessions/show-initial-prompt/issues/` (replay-not-pinned-to-prompt-top, copy-mode partial-failure, fromStart-decoupling, prompt-store path convention). Not duplicated into the durable sink — see deferred note. |

## Solutions created (`docs/solutions/`)

Two genuine build-time learnings that emerged in code review (not in the
plan/brainstorm) and would otherwise re-bite a future developer:

- `docs/solutions/hoisted-prompt-assembly-drops-step-lifecycle.md` — hoisting
  `assemblePrompt` ahead of `withStepLifecycle` moved a user-reachable
  `{{var}}`-mismatch throw *outside* the lifecycle envelope, silently dropping the
  step's `step:start`/`step:failed` events (steps-view / failure pane / cmux pill)
  while every test stayed green. Takeaway + the regression-guard test shape.
- `docs/solutions/await-in-lifecycle-fifo-head-of-line-blocks.md` — `await`ing the
  always-on prompt-store write inside the single lifecycle FIFO head-of-line-blocks
  every later event across all steps on a slow filesystem. Fire-and-forget rule for
  best-effort persistence whose consumer reads after the step ends.

The plan's design decisions (escape-not-strip, code-points-not-bytes,
`stateDir`-not-`logsDir`, from-start tail, copy-mode across `swap-pane`) were
**not** promoted to solutions — they are already recorded in `plan.md`, and the
solutions sink is not for content the plan already encodes.

## Deferred doc work

- **`replay-not-pinned-to-prompt-top`** (a deliberate product-decision deferral:
  replay opens at the transcript tail, not the prompt top, unlike live R9/AT-9) is
  the one deferred item with durable cross-session value. It is recorded under
  `docs/sessions/show-initial-prompt/issues/`; I did not duplicate it into the
  durable `docs/issues/` sink, since the workflow owns that capture. If the team
  wants it tracked project-wide, promote that file to a dated `docs/issues/` entry
  — a one-file move, left to a human to avoid divergent copies.

## Verification

- `bun run docs:build` — clean (no dead internal links) after the guide/5 edit.
