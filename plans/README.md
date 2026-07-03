# Implementation Plans

This index tracks two audit rounds. **Round 1 (001–006)** was generated
2026-06-11 at commit `832a56d` and is fully DONE. **Round 2 (007–026)** was
generated 2026-07-02 at commit `0265592` by the `improve` skill — a two-track
audit (code quality 007–016, developer experience 017–026) requested as
"10 code-quality + 10 DevEx improvements."

Each executor: read the whole plan file before starting, run every verification
command, honor the STOP conditions, and update your status row here when done.

Repo gate for every plan: `bun run check` (lint + typecheck + unit +
mocked-integration + two-pane lifecycle). Never run bare `bun test` — always
path-scoped. Plans contain no git instructions; branching/committing is the
operator's concern.

> **Round-2 heads-up on in-flight code:** at planning time the working tree had
> uncommitted changes to `src/core/recovery/*`, `src/runners/*/classify-error.ts`,
> and `src/runners/execute.ts`. Plans **009, 010, 013, 016** touch that seam and
> each carries a drift check — follow it if those files have moved on.

---

## Round 1 — status (2026-06-11, commit `832a56d`) — all DONE

| Plan | Title | Priority | Effort | Status |
|------|-------|----------|--------|--------|
| 001 | Reconcile `implementation-phases.md` with shipped code | P1 | S | DONE |
| 002 | Unit-test the embedded-binary launch contract | P1 | S | DONE |
| 003 | Replace fixed-sleep-then-assert test patterns with polling | P1 | S–M | DONE |
| 004 | Repo hygiene sweep | P2 | S | DONE |
| 005 | Test coverage: transcript sidecar + load-workflow/dry-run CLI seam | P2 | M | DONE |
| 006 | Spike: Zod v4 migration feasibility | P3 | M | DONE — verdict GO-WITH-CONDITIONS (`006-zod-v4-spike-findings.md`) |

> Round-1 plan 006 pointed at a future "plan 007" for the actual Zod-v4
> migration. That migration was never authored and is **not** in Round 2.
> If pursued, author it as a new plan at the next free number (027+) from
> `006-zod-v4-spike-findings.md`. The "007" label below is Round 2's, not that
> deferred migration.

---

## Round 2 — Code quality (007–016)

| Plan | Title | Priority | Effort | Depends on | Status |
|------|-------|----------|--------|------------|--------|
| 007 | Make `orch logs --follow` exit on a `failed` run | P1 | S | — | DONE (2026-07-02) |
| 008 | Make `orch status` show per-step outcome and the failure reason | P1 | M | — | DONE (2026-07-04) |
| 009 | Preserve the real error message on the recovery-declined path | P1 | S | — | DONE (2026-07-02) |
| 010 | Log and persist fast-fail classifications | P1 | S | 009 | DONE (2026-07-02) |
| 011 | Serialize `initRun`/`setArgs`/`setStatus` through the write-queue | P2 | M | — | DONE (2026-07-04) |
| 012 | Add exit-code regression tests for `mapResumeError` | P2 | S | — | DONE (2026-07-04) |
| 013 | Drain stderr before reading its tail on the abort path | P2 | S | — | DONE (2026-07-02) |
| 014 | Extract shared transcript-format helpers used by both runners | P2 | S | — | DONE (2026-07-02) |
| 015 | Extract the shared runner flag-denylist guard | P2 | S | — | DONE (2026-07-04) |
| 016 | Add regression tests for Codex `auth`/`billing` classification | P2 | S | — | DONE (2026-07-04) |

## Round 2 — DevEx (017–026)

| Plan | Title | Priority | Effort | Depends on | Status |
|------|-------|----------|--------|------------|--------|
| 017 | Per-command `--help` and a `--version` flag | P1 | M | — | DONE (2026-07-02) |
| 018 | Accept a runId prefix in `orch logs` | P1 | S | — | DONE (2026-07-04) |
| 019 | Reject unknown/typo'd keys in `orch.config.ts` | P1 | S | — | DONE (2026-07-02) |
| 020 | Throw on a duplicate step name in the same scope | P1 | M | — | DONE (2026-07-04) |
| 021 | Add a typed `permissions` option to `claude()`/`codex()` | P2 | S | — | DONE (2026-07-02, claude() only; codex has no equivalent mode) |
| 022 | Make `codex()` and `claude()` call shapes symmetric | P2 | S | — | DONE (2026-07-02) |
| 023 | Accept a bare Zod schema in `returns:` | P2 | M | — | DONE (2026-07-04) |
| 024 | Make `orch init` scaffold a typed two-step handoff | P2 | M | — | DONE (2026-07-04) |
| 025 | Add a troubleshooting guide page | P2 | M | — | DONE (2026-07-02) |
| 026 | Move the unshipped `triggers.md` draft out of the published docs | P3 | S | — | DONE (2026-07-02, moved to `docs/brainstorms/2026-07-02-triggers-design-draft.md`) |

## Dependency notes (Round 2)

- **010** edits the same `src/core/recovery/loop.ts` region as **009** — land 009
  first to avoid a merge conflict.
- **008** benefits from (but does not require) the failing-step read introduced in
  **007**; each is independently implementable.
- **014** and **015** both touch the two runner folders but different files; either
  order works.

## Round 2 — findings considered and NOT turned into a plan

Vetted and real, but excluded from this 10+10 batch. Recorded so they are not
re-audited as new:

- **CORRECTNESS-05 — watchdog `sleep().then()` has no `.catch`** (`loop.ts:240`).
  **Already rejected in Round 1** (see the rejected list below): `BunClock.sleep`
  is resolve-only by contract, so it is unreachable today. Not re-planned.
- **CORRECTNESS-02 — `isLaunchFailureSignal` over-broad** (`classified-error.ts:104`)
  can reclassify a transient first-turn failure as fail-fast. Real, but the fix
  needs a fast-exit duration threshold threaded into `ClassifyErrorSignal` (absent
  today) and the module is mid-rework. Defer until 009/010 land.
- **ARCH-01/02/03 — god-module splits** (`workflow.ts` 2400, `tmux-host.ts` 1618,
  `right-pane-controller.ts` 1423). High value, L-effort, MED-risk structural
  moves — do as human-led refactors after a characterization-test pass, not by a
  low-context executor.
- **ARCH-06 — 51 deep imports bypass module barrels.** Mechanical but large; do as
  one find-replace plus a `no-restricted-imports` lint rule.
- **TEST-01/04/05 — real-tmux suite self-disables inside tmux; `ask-executor`
  predicates untested; `test:two-pane:fast` runs no unit tests.** Valid
  test-hardening follow-ups; 012 and 016 are this batch's representative test
  plans.
- **CLI-05 / CLI-07 / DX-02 / DX-05 / DOCS-01 / DOCS-03 — DevEx polish**
  (documented `--latest` inconsistency; `open-failed` discoverability; per-call
  `agent` override; reject `prompt`+`vars` together; recovery guide; stale
  `examples/README.md`). Good follow-ups after 017–026.

## Round 2 — direction findings (maintainer's call)

- **Triggers / scheduled runs** — `docs/public/guides/triggers.md` is a fleshed-out
  design draft (`defineTrigger`, `cron()`, `webhook()`, `orch ps`, `orch attach`).
  Plan 026 only relocates it, but it is the strongest signal of the project's next
  frontier and the architecture is close to supporting it.

---

## Round 1 — findings considered and rejected (preserved)

- **"GitHub PAT committed in `.env`"** — false. `.env` is untracked, absent from
  all git history, covered by `.gitignore:41`. No rotation needed.
- **"Shell injection via `createWorktree` postCreate sugar lines"** — by-design;
  author-owned shell commands run via `ProcessService` argv arrays.
- **"CLI dispatcher missing / Phase 12 unstarted"** — false; stale roadmap doc
  (fixed in plan 001).
- **Steps-view TUI performance** — wrong or negligible (in-memory overlay, debounced
  read, once-defined Container).
- **`stdoutBytes()` accumulation race** — documented contract, no production
  consumers.
- **Missing `.catch` on the recovery watchdog sleep (`loop.ts:236`)** — unreachable:
  `BunClock.sleep` is resolve-only by contract, never rejects. (Re-surfaced in
  Round 2 as CORRECTNESS-05 and re-rejected on the same basis.)
- **Shutdown race on `workflowSettled`** — `finally` ordering makes the residual
  window benign.
- **Vulnerable transitive deps via vitepress** — installed versions above advisory
  thresholds; dev-only.
- **"Delete `dist-staging/`"** — committed Homebrew tap staging; intentional.
- **"Config reference docs missing"** — `docs/public/reference/config.md` exists.
- **ink v7 → v8 migration** — v8 stability unverifiable at audit time; monitor.
- **`BunClock` has no tests** — correct; wall-clock characterization would be flaky.
- **Branded-`Path` gaps** (`ink-runner.ts`, `interactive-core.ts`) — marginal;
  deferred note in plan 004.
- **Swallowed logging errors** — intentional fail-silent design.
- **CI/`bun run check` serialization** — modest payoff; below the cut.

## Round 1 — direction findings (preserved)

1. **Finish Codex interactive parity** — `docs/plans/2026-05-01-feat-codex-runner-parity-plan.md`.
2. **cmux awaiting-input notification (Phase 2)** — research-gated.
3. **Host plugin registry via `orch.config.ts`** — seam earmarked in
   `src/hosts/host-registry.ts:1-11`.
4. **Full compound e2e demo (Phase 16)** — roadmap-listed.
