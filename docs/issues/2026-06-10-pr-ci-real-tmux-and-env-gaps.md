---
date: 2026-06-10
status: resolved
area: .github/workflows, tests/integration/real-tmux, src/runners/codex
type: ci
severity: high
resolution: PR #2 (branch fix/ci-run) — codex seam fix + pr.yml git identity + tmux 3.6b build + ORCH_DISABLE_REAL_TMUX gate
---

# PR CI was red where local `bun run check` was green — four runner environment gaps

## Summary

PR CI (`.github/workflows/pr.yml`, `ubuntu-24.04`) failed while `bun run check`
passed on developer machines. The root cause in every case was **the runner
lacking tooling the dev machine happens to have** — not a code regression. The
`check → test → test:project` chain is `&&`-linked, so the **first** failing
level masked all later ones; PR CI had in fact **never been green on this repo**,
so the real integration levels had never run in CI before. Fixing each layer
exposed the next, in this order: `22 → 40 → 7 → 1 → 0` failures.

## The four gaps

1. **codex CLI absent (22 unit failures).** `checkCodexVersion` probed the real
   PATH with `Bun.which('codex')` **before** spawning through `ProcessService` —
   reaching around the seam the unit tests mock with `FakeProcessService`. With
   codex installed locally it passed; on CI `Bun.which` returned `null` and every
   `buildCommand` test threw `CodexVersionError('not found')`.
   - Fix: drop the `Bun.which` pre-check; rely on `ps.spawn(['codex','--version'])`
     and translate the synchronous `ProcessSpawnError` (binary missing) into the
     same `CodexVersionError('not found')`. Restores **rule #1** (subprocess
     isolation) and **rule #3** (mock only at the edge).
   - Reproduce locally by hiding the binary from PATH (a bun-only PATH), never by
     trusting the green local run.

2. **No git identity on the runner (1 real-git failure).** The real-git levels
   (`worktree-real`, `commit-real`) drive orch's own `commit()` step, which relies
   on **ambient** git identity — exactly like a developer's machine. The runner
   has none, so the commit failed with `Author identity unknown`.
   - Fix: a `git config --global user.{name,email}` step in `pr.yml` (mirrors
     `release.yml`).

3. **tmux 3.4 on the runner (~20 real-tmux service failures).** `ubuntu-24.04`
   ships **tmux 3.4**, which has an upstream regression: `split-window` on a
   **detached** session (no attached client) fails with `size missing`
   ([tmux/tmux#3060](https://github.com/tmux/tmux/issues/3060), fixed in 3.5). The
   real-tmux levels split detached sessions directly. The dev's tmux 3.6a was
   immune.
   - Fix: build a **checksum-pinned tmux 3.6b** from source in `pr.yml` so
     `/usr/local/bin/tmux` shadows apt's 3.4. **Real tmux requires ≥ 3.5.**

4. **Headless Ink/steps-view rendering (7 real-tmux host failures).** With panes
   finally spawning, the heavy host level (`tests/integration/real-tmux/` — the
   Ink/steps-view/PTY rendering tests) still failed: panes render blank on a
   headless runner and content capture times out (`waitForText`, `captureUntil`).
   This is exactly what the **AE3** design rule excludes ("no real tmux on PRs").
   - Fix: gate the whole real-tmux surface off PR CI via `ORCH_DISABLE_REAL_TMUX=1`
     (set in `pr.yml`), implemented as an opt-out inside `canRunRealTmux()`
     (matching the existing `ORCH_DISABLE_CMUX` convention). Release CI and local
     runs leave it unset and exercise everything.

## Files

- `src/runners/codex/codex-runner.ts` — `checkCodexVersion` seam fix
- `.github/workflows/pr.yml` — git identity step, tmux 3.6b build step,
  `ORCH_DISABLE_REAL_TMUX=1` on the `Run checks` step
- `tests/_support/real-tmux/fixture.ts` — `canRunRealTmux()` opt-out gate
- `tests/integration/real-tmux/steps-tui.test.ts`,
  `tests/integration/real-tmux/pane-map-source-session.test.ts` — switched from a
  raw `Bun.which('tmux')` predicate to `canRunRealTmux()` so the gate reaches them

## Gotchas worth remembering

- **`canRunRealTmux()` is the single PR-CI gate.** It backs both the
  `tests/integration/real-tmux/` integration level **and** the DSL `screen` /
  `full-host` / `lifecycle` drivers (their `skip()` calls it). A host-level test
  that gates on a raw `Bun.which('tmux')` instead will **silently keep running on
  PR CI** and fail headless — this is precisely how `steps-view-runner` slipped
  through the first gate attempt.
- **Low-level tmux-ops tests stay on PR CI.** The service-level `RealTmuxService`
  tests (`tests/integration/services/tmux/`), `windows`, and the fixture
  lifecycle use their own `Bun.which('tmux')` predicate and are *not* gated — they
  pass on tmux 3.6b and mirror the kept service tests. Only the **rendering/host**
  surface is excluded from PRs.
- **A green local `check` is not proof.** Dev machines carry codex, a modern tmux,
  and a git identity. Validate env-sensitive paths under the *absence* of each.

## References

- PR #2 / branch `fix/ci-run`
- [tmux/tmux#3060 — split-window pane-size not honored on detached sessions](https://github.com/tmux/tmux/issues/3060)
- `docs/testing-strategy.md` — "Running & gating" and the real-tmux gate note
- CLAUDE.md non-negotiable rules #1 (subprocess isolation) and #3 (mock at the edge)
