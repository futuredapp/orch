# `lifecycle/side-effects/` — plain `it()`, not `scenario()`

These tests drive a real `orch` subprocess (the behavioral-dsl engine the
`lifecycle` driver wraps) and assert **git / filesystem / persisted-state side
effects** — a real commit on a branch, a materialized worktree, a `postCreate`
shell file, a non-interactive `ask` resolving to its default, and the
graceful-failure persistence bucket (run `failed`, not `crashed`).

They are **not** `scenario()` tests, on purpose:

- **One fidelity, no twin.** Each runs at exactly one fidelity (a real
  subprocess) and has no `model`/`screen`/`full-host` counterpart to share an
  `overlapGroup` with. The pane-centric `scenario(app)` shape buys nothing here.
- **Triage rule says yes.** Every one answers *"would this still pass if the pane
  were empty / wrong / unformatted?"* with **yes** — their risk is a durable side
  effect, not what the panes render. The decision rule (parent §6) therefore
  routes them to a non-`scenario()` category.
- **Precedent.** This mirrors the `tmux-argv` and `model/controller` non-scenario
  categories: behaviour that is real but not pane-shaped is a plain `it()` test
  importing the behavioral-dsl helpers directly from `@orch/test/*`, rather than
  forcing a shared-DSL extension that would touch every driver (a risk Phase 7
  deliberately avoided).

The four `failure.*` files live here — including the two whose *names* mention the
✗ glyph / right-pane summary — because at Tier 5 the pane is torn down sub-100ms
when the workflow throws, so the old cells already assert the **durable on-disk**
failure signals (lifecycle.ndjson / persisted state / the per-step tee file), not
pane content. The failure *rendering* (failed glyph + colour) is covered by the
`model`/`screen` `failure-glyph` twin (parent U8 / KD3); the error-banner render
by the U5b `banner--info-and-error-paint` twins.

Shared subprocess teardown lives in `_support.ts` (`withOrchHandle`).
