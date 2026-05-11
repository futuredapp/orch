---
title: Handover — Pane-Map Implementation (after U1 + U3)
type: handover
date: 2026-05-11
plan: docs/plans/2026-05-11-001-feat-decouple-live-runner-unified-pane-map-plan.md
status: active
---

# Pane-map plan — handover after U1 + U3

This document hands the pane-map plan off to the next agent. **Two units are
shipped on `main`; eight remain.** Read the plan
([`docs/plans/2026-05-11-001-feat-decouple-live-runner-unified-pane-map-plan.md`](2026-05-11-001-feat-decouple-live-runner-unified-pane-map-plan.md))
end to end before starting — this handover only summarizes what changed,
deviations the implementer made vs. the plan text, and what to do next.

## Current state of `main`

Commits landed on `main`:

```
9f83526 feat(two-pane): pane-map module + per-run scratch session lifecycle (U3)
b6cc8b4 feat(tmux): add swapPane and argv-form splitPane with env/cwd     (U1)
```

`bun run check` is green at HEAD. 1423 tests pass, 9 skipped, 0 failing.
17 new tests landed across U1+U3.

## What U1 shipped

[`src/services/tmux/tmux-service.ts`](../../src/services/tmux/tmux-service.ts),
[`real-tmux-service.ts`](../../src/services/tmux/real-tmux-service.ts),
[`fake-tmux-service.ts`](../../src/services/tmux/fake-tmux-service.ts):

- `swapPane({socket, src, dst})` on the port + both adapters. Real adapter
  uses `tmux swap-pane -s <src> -t <dst>`. Pane ids are server-wide, so
  cross-session swaps work natively.
- `SplitPaneOptions` is now a discriminated union of two variants:
  - `SplitPaneWithCommandOptions` — the legacy `command?: string` shape
    (backward-compatible; every existing caller still works).
  - `SplitPaneWithArgvOptions` — `argv: readonly string[]` plus optional
    `env: Readonly<Record<string,string>>` and `cwd: Path`. Env/cwd are
    *only* valid in this branch (enforced at the type level via
    `env?: undefined`/`cwd?: undefined` on the command variant).
- Real adapter validates: env keys cannot contain `=` or newline; argv
  elements cannot contain `\0`. Helpers `appendEnvFlags` and
  `assertNoNullByteArgv` are shared between adapter call sites.
- Tests: 2 fake + 8 real-tmux integration tests cover the new shapes.
  All real-tmux tests are env-gated on `Bun.which('tmux')`.

## What U3 shipped

New directory [`src/hosts/two-pane/pane-map/`](../../src/hosts/two-pane/pane-map/):

- [`pane-spec.ts`](../../src/hosts/two-pane/pane-map/pane-spec.ts) —
  `PaneSpec` discriminated union (`file-tail` | `pty`), `SourceKey`
  discriminated union (`live` / `replay` / `rollup` / `interactive` /
  `placeholder`), and `sourceKeyToString(key)` deterministic serializer.
- [`scratch-session.ts`](../../src/hosts/two-pane/pane-map/scratch-session.ts) —
  `createScratchSession({tmux, socket, width, height})` returns a
  `ScratchSessionHandle`. Pins `destroy-unattached off` globally so a
  user's `~/.tmux.conf` cannot tear the session down (no client ever
  attaches). `teardownScratchSession(tmux, handle)` kills it; idempotent.
- [`right-pane-controller.ts`](../../src/hosts/two-pane/pane-map/right-pane-controller.ts) —
  the new controller body. Exposes the four pane-map methods plus the
  legacy `onIntent` dispatch path:
  - `registerSource(key, spec)` — splits a hidden pane in the scratch
    session; stores its pane id under `sourceKeyToString(key)` in the
    Map. Idempotent. `file-tail` → `tail -n 5000 -F <path>`; `pty` →
    runner argv with env/cwd forwarded.
  - `showSource(key)` — issues `swapPane` via sequential pane-queue
    enqueues; updates the controller's `visiblePaneId` after each swap
    (load-bearing invariant — `swap-pane` exchanges processes between
    positions, but pane ids stay attached to processes).
  - `unregisterSource(key)` — type-dispatched:
    - `live` → rekey to `replay`, no `killPane` (warm cache).
    - `interactive` / `rollup` / `replay` / `placeholder` → kill the
      hidden pane, after swapping to placeholder first if the source
      was current.
  - `followLive()` — prefers `rollup` if registered; otherwise the
    most-recently-registered `live` / `interactive` source; otherwise
    placeholder; otherwise no-op.
- [`index.ts`](../../src/hosts/two-pane/pane-map/index.ts) — barrel.

[`src/hosts/two-pane/index.ts`](../../src/hosts/two-pane/index.ts) re-exports
the pane-map surface. The OLD top-level
[`src/hosts/two-pane/right-pane-controller.ts`](../../src/hosts/two-pane/right-pane-controller.ts)
became a thin re-export shim (not deleted yet — see deviations below).

[`src/hosts/two-pane/tmux-host.ts`](../../src/hosts/two-pane/tmux-host.ts) wires:

- Scratch session is created BEFORE the visible right-pane `splitPane`
  (so creation failure doesn't orphan visible UI).
- Scratch session is torn down BEFORE the visible `orch` session at
  teardown (so hidden panes never outlive their swap target).
- The handle is threaded into the controller via the new
  `scratchSession` option.

## Deviations from the plan (U3)

The plan prescribed several behaviors the implementer deferred to keep U3 a
**true** structural refactor (i.e. no observable behavior change at the
right pane). All deferrals are flagged in code comments as `U3 status:` and
have specific units that will undo them.

1. **`onIntent` still uses the legacy respawnPane-based dispatch** (verbatim
   ported from the old controller). The plan's prescription that
   `onIntent('enter')` should call `registerSource(replayKey)` +
   `showSource(replayKey)` is **NOT** applied yet. Reason: switching
   `onIntent` in U3 would have broken several existing tests
   (`right-pane-replay.integration.test.ts`,
   `right-pane-busy-gate.test.ts`, etc.) that the plan only lists for
   migration in U8 — and would also have made enqueueRight-based
   autonomous live invisible until U5 lands. The pragmatic call was to
   land the new pane-map surface as dead-code first, then have U5/U6/U8
   each flip their own surfaces inline with their test migrations.
   **U8 will flip `onIntent` to the new methods alongside the
   `right-pane-replay.integration.test.ts` migrations the plan already
   lists there.**

2. **Placeholder source is NOT auto-registered at controller boot and NOT
   swapped in at boot.** The plan's "Decision 11" / U3 approach says the
   controller should `showSource({type:'placeholder'})` at construction.
   The implementer skipped this so the visible right pane stays as the
   original `cat` placeholder until U5 wires actual sources. Doing it
   now would mean `enqueueRight` (which still writes to
   `deps.rightPaneId`) would land on a hidden pane and the user would
   see a blank screen until U5. **U5 should register the placeholder
   (splitPane in scratch) at the moment it switches autonomous to
   `file-tail`, AND call `showSource(placeholder)` whenever the
   `unregisterSource` rule swaps to placeholder.** The new code already
   handles the placeholder-swap-on-unregister path correctly; U5 just
   needs to register it.

3. **`isRightPaneBusy` option is preserved on the controller.** The plan
   said to drop it in U3 because past-step Enter is "safe by
   construction" under the swap model. The implementer kept it because
   `onIntent('enter')` still respawns on `rightPaneId` (deferral #1
   above), so the gate is still load-bearing. **U5 should drop both the
   `isRightPaneBusy` option from `RightPaneControllerOptions` AND the
   `inFlight: Set<StepName>` from `tmux-host.ts` at the same time, when
   the new swap-based path lands.**

4. **`scratchSession` is OPTIONAL on `RightPaneControllerOptions`.** The
   plan implied it would be required, but several existing tests construct
   the controller without one. The new methods throw a clear runtime
   error (`scratchSession not configured`) if called without it; the
   legacy `onIntent` path doesn't need it and works without it. **U5+
   can flip this to required as part of test migrations, OR leave it
   optional indefinitely — the runtime guard catches misuse.**

5. **The old `src/hosts/two-pane/right-pane-controller.ts` file is a
   re-export shim, NOT deleted.** The plan said "delete." The shim is
   four import lines; deleting would require touching ~8 test files'
   imports in U3. **U10 should delete the shim and update those imports
   as part of the cleanup pass.**

The `onIntent('enter') → swap-pane` test scenarios listed under U3 (e.g.
"onIntent('enter', stepName) for a step with no prior replay registers a
fresh replay: source and swaps to it") **were NOT added** because the
behavior they test isn't wired yet. **U8 should add those tests when it
flips `onIntent`.**

## Test surface added by U3

- [`tests/unit/hosts/two-pane/pane-map/right-pane-controller.test.ts`](../../tests/unit/hosts/two-pane/pane-map/right-pane-controller.test.ts) —
  13 tests covering `registerSource` (file-tail + pty + idempotent),
  `showSource` (swap argv + currentKey no-op + miss-logging),
  `unregisterSource` (live transform, interactive kill, rollup kill),
  `followLive` (rollup preference, latest live, no-op), and the
  scratchSession guard.
- [`tests/integration/hosts/two-pane/pane-map-scratch-session.real.integration.test.ts`](../../tests/integration/hosts/two-pane/pane-map-scratch-session.real.integration.test.ts) —
  4 real-tmux tests covering scratch session create / teardown order /
  idempotent teardown / two-tail swap content verification.

Tests touched (not added) in U3:

- [`tests/unit/hosts/tmux-host.test.ts`](../../tests/unit/hosts/tmux-host.test.ts) —
  teardown tests now expect 2 `killSession` calls (`orch-scratch` then
  `orch`) instead of 1.
- [`tests/integration/cli/two-pane-auto-attach.test.ts`](../../tests/integration/cli/two-pane-auto-attach.test.ts) —
  same teardown count adjustment.
- [`tests/integration/hosts/two-pane/steps-tui-e2e.mocked.test.ts`](../../tests/integration/hosts/two-pane/steps-tui-e2e.mocked.test.ts) —
  asserts the `orch` kill (filters by session name).

## What's next — U4 through U10

The plan's ordering is preserved. Dependencies form a DAG:

- **U4** — banner + view-mode + dismiss-banner intent UI plumbing. Depends
  on U3 (controller owns the banner state slot). Mostly TS/Ink work in
  `src/hosts/two-pane/steps-view/`. Independent of U5/U6/U7.
- **U5** — wire autonomous + command-step live to `file-tail` sources.
  Depends on U3 + U4. **This is where deferrals #2, #3, #4 from above
  are resolved.** Migrates `right-pane-live-output.test.ts`,
  `right-pane-live-doubling.real.integration.test.ts` (ungate the
  ORCH_REPRO_BUG skip), and `two-pane-mocked.test.ts`.
- **U6** — interactive runners → `pty` archetype. Depends on U3 + U4.
  Migrates `two-pane-interactive.test.ts`,
  `two-pane-sequential-runs.test.ts`,
  `resume-launcher-mocked.integration.test.ts`,
  `resume-failure-mocked.integration.test.ts`.
- **U7** — rollup gets its own hidden pane + parallel-block lifecycle
  events. Depends on U3 + U4 + U5. Touches `src/core/workflow.ts` (new
  `step:parallel-start` / `step:parallel-complete` events).
- **U8** — past-step replay warm-cache + edge-case wiring. Depends on
  U3–U7. **Flips `onIntent('enter')` to the new swap-based path
  (resolves deferral #1)**, and migrates `right-pane-replay`,
  `right-pane-busy-gate`, `kind-details` tests.
- **U9** — right-pane-source invariant guard test. Cross-cutting
  regression guard. Depends on U3–U8.
- **U10** — cleanup, docs, prior-doc archival. **Deletes the shim
  (deferral #5)**, updates `docs/getting-started.md`,
  `docs/logging.md`, `docs/solutions/*`, marks prior brainstorms /
  plans as `status: superseded`.

The plan's "Each behavior-changing unit migrates its own previously-passing
tests in the same commit so `bun run check` stays green at every commit" rule
is non-negotiable. Migrate tests inline with the behavior change.

## Branch + commit policy

- Working directly on `main`. The user explicitly opted into this at the
  start of the work. Continue on `main` unless the user asks otherwise.
- Commits use Conventional Commits prefixed with `feat(scope)`,
  `refactor(scope)`, etc. No attribution footer for incremental commits.
- `bun run check` must be green before each commit. Lint baseline = 9
  warnings (all pre-existing complexity warnings in code outside this
  plan's scope). Do not introduce new warnings; `lint:fix` handles
  `organizeImports`.

## Project rules to keep in mind

These are codified in [`CLAUDE.md`](../../CLAUDE.md) and worth re-reading:

1. **Subprocess isolation** — all subprocess calls go through `ProcessService`.
   `tail` runs INSIDE a tmux pane (via `splitPane(... argv: ['tail', ...])`),
   not via a `Bun.spawn` call. This stays true under the pane-map plan.
2. **Mock only at the edge** — unit tests mock `*Service` ports only. The
   pane-map unit tests use `FakeTmuxService` directly. Don't mock
   `RightPaneController` itself — exercise it via its real methods.
3. **TypeScript strict** — no `any`, no `!`. The discriminated unions in
   `pane-spec.ts` are `readonly`-by-default; preserve that.
4. **File size ≤ 300 LOC** is a warning. `pane-map/right-pane-controller.ts`
   is currently around 530 lines because it ports the legacy onIntent
   path verbatim. U5/U6/U8 should bring it down to ≤ 300 as the legacy
   helpers (`dispatchByKind`, `respawnCatInline`, `respawnCatPath`,
   `dispatchAgentInteractive`) get replaced by the new methods. The
   plan's U10 accepts that `tmux-host.ts` stays above the warning cap
   (~650 LOC after U5–U7 trim).
5. **`bun run check` is the gate.** Green at every commit, including
   `bun run typecheck` (which the project's `check` runs).

## Quick orientation commands

```sh
# Re-read the plan
less docs/plans/2026-05-11-001-feat-decouple-live-runner-unified-pane-map-plan.md

# See what changed since main
git log --oneline -5

# Run the gate
bun run check

# Run only the pane-map tests
bun test tests/unit/hosts/two-pane/pane-map/
bun test tests/integration/hosts/two-pane/pane-map-scratch-session.real.integration.test.ts

# See the pane-map module
ls src/hosts/two-pane/pane-map/
```

## When stuck

- The plan is authoritative. If this handover conflicts with the plan,
  the plan wins.
- The user is reachable. Ask for direction on plan deviations rather
  than guessing.
- Don't try to "fix" the deferrals listed above by changing U3's already-
  committed code — handle them in the unit they're scheduled for (U5,
  U8, U10).
- If a test feels wrong, check what unit it belongs to (the plan lists
  test migrations per unit). Don't migrate a test in U-N if U-M+1 owns
  it — that bloats the diff and breaks the per-commit `bun run check`
  gate.
