# orch — domain glossary

Shared vocabulary for the orchestrator. Names here are the load-bearing
concepts; use them exactly in code, plans, and reviews. Architecture-level terms
(module, interface, seam, depth, adapter) live in the
`improve-codebase-architecture` skill's `LANGUAGE.md`.

## Core

- **Workflow** — a plain async TypeScript function the orchestrator runs top to
  bottom. Resume = re-execute, with finished `run()` names returning cached values.
- **Step** — a reusable named unit (`step.define`). Kinds: `agent`, `interactive`,
  `command`, `ask`, `commit`, `worktree`. The name is the memoization key.
- **Runner** — an adapter wrapping a coding-agent CLI (Claude, Codex, …) behind the
  `Runner` interface. The core never imports a concrete runner.
- **Host** — the observability seam the workflow executor talks to. Two adapters:
  `plain` (line-prefixed stdout/NDJSON) and `two-pane` (tmux).
- **Step lifecycle event** — `step:start` / `step:complete` / `step:failed` /
  `step:cached` plus the `step:parallel-*` family. The executor emits these to the
  host; `Host.onLifecycleEvent` returns `void` (fire-and-forget by contract).

## Two-pane (tmux) host

- **Pane** — `left` = status rollup; `right` = the active step's view.
- **Source** — one swappable origin of right-pane bytes, keyed by `SourceKey`
  (`live` per step, `rollup` for a parallel block). Each source owns its own tmux
  session/pane; the **right-pane controller** swaps the visible pane between them.
- **Live vs replay** — a `live` source tails an open tee; on step end it transforms
  to a frozen `replay` the user can scroll back to.
- **Tee (`PerStepTee`)** — per-step sink that fans transcript bytes to on-disk
  `formatted_output.*` files; the live source tails the tee file. Opened on
  `step:start`, closed on `step:complete`/`step:failed`.
- **Rollup (`RollupAggregator`)** — aggregates parallel-branch status into a single
  snapshot rendered on the `_rollup` source during a parallel block.
- **Banner** — a transient overlay message on the right pane (info/error), emitted
  through the controller; last-write-wins.
- **Interactive completion wait (`awaitInteractivePaneExit`)** — how an
  interactive step learns its pane has exited. Races the unbounded `pane-died`
  hook channel against a slow `#{pane_dead}` liveness poll. The hook is the fast
  path; the poll is a backstop for a lost/delayed hook signal under host
  contention. Invariant: the poll **never fails a live pane** (a human may pause
  the agent arbitrarily long), so it only short-circuits a pane that already
  died. A backstop hit logs `interactive-wait-hook-missed`. Added 2026-05-26 to
  kill the two-pane-sequential-runs flake (a lost hook used to hang until the
  caller's timeout with no diagnosis).
- **Lifecycle choreographer (`LifecycleChoreographer`)** — translates one step
  lifecycle event into the ordered right-pane side effects (tee open/write/close,
  source register/unregister, banners, rollup apply/reset). Owns the ordering
  invariants ("unregister before close", "summary before freeze") and serializes
  events FIFO so they hold across events even though the host fires them without
  awaiting. Introduced 2026-05-26 (extracted from `tmux-host.onLifecycleEvent`);
  see `docs/issues/2026-05-26-arch-lifecycle-router-in-tmux-host.md`.
