# Step 001 — Reconcile `docs/plans/implementation-phases.md` roadmap

**Role:** worker · **Plan:** `plans/001-reconcile-implementation-phases-roadmap.md`
**Date:** 2026-06-11 · **Type:** documentation-only

## What was done

Reconciled the phased roadmap's status glyphs against the live codebase by
file-existence checks only. Flipped fully-shipped phases to `✓`, marked one
partial phase `◐`, updated the Reframe table cells, and added the
top-of-doc reconciliation note. Only `docs/plans/implementation-phases.md`
(content) and the `plans/README.md` status row were modified.

## Drift check

Command: `git diff --stat 832a56d..HEAD -- docs/plans/implementation-phases.md src/cli src/core/worktree.ts src/hosts`
Result: **exit 0, no output** → none of the in-scope files changed since the
plan was written. Legend line and Phase 12 block match the "Current state"
excerpts verbatim. **No drift; no STOP condition.**

## Verification table (Step 1)

Glyph checks done with `test -e`. "ALL" = every listed deliverable exists.

| Entry | Old glyph | Deliverables checked | Result | Action |
|---|---|---|---|---|
| Phase 12 — CLI | ☐ | `src/cli/index.ts` ✓, `src/cli/main.ts` ✓, `src/cli/commands/{run,resume,runs,status,dry-run}.ts` ✓, `bin.orch`→`./src/cli/main.ts` in package.json ✓ | **ALL** | → `✓` + Landed |
| Phase 14 — Claude escalation | ☐ | `src/escalation/request-human-input.ts`, `claude-defer-hook.ts`, `mcp-server.ts`, dir `src/escalation/` — all MISSING | **NONE** | leave `☐` |
| Phase 15 — Codex escalation | ☐ | `src/escalation/codex-short-run.ts` MISSING | **NONE** | leave `☐` |
| Phase 16 — Full compound e2e | ☐ | `src/runners/index.ts` ✓ (exports `defineRunner`); `tests/e2e/brainstorm-plan-work-review.{e2e,mocked}.test.ts` MISSING; `docs/runner-author.md` MISSING | **SOME** | → `◐` + missing-note |
| Phase 17 — `createWorktree()` | ☐ | `git-service.ts`, `bun-git-service.ts`, `fake-git-service.ts`, `execution-context.ts`, `parallel.ts`, `step.ts`, `worktree.ts`, `worktree-post-create.ts`, `workflow.ts`, `core/index.ts` — all ✓ | **ALL** | → `✓` + Landed |
| Reframe A — run-mode + plain host | ☐ cell | `src/core/run-mode.ts` ✓, `src/hosts/plain/plain-host.ts` ✓ | **ALL** | → `✓ landed` |
| Reframe B — view abstraction | ☐ cell | `src/core/view.ts` ✓ | **ALL** | → `✓ landed` |
| Reframe C — single-pane | ⊘ deferred | (deferred to v2) | n/a | left `⊘ deferred` |
| Reframe D — two-pane tmux host | ☐ cell | `src/hosts/two-pane/tmux-host.ts` ✓ | **ALL** | → `✓ landed` |
| Reframe E — plugin seam + logs | ☐ cell | `src/core/view-registry.ts` ✓, `src/hosts/host-registry.ts` ✓, `src/config/index.ts` ✓, `src/cli/commands/logs.ts` ✓ | **ALL** | → `✓ landed` |
| Codex runner parity | ◐ | behavioral (interactive argv + transcript rendering); no discrete file list in doc | unverifiable by file existence | left `◐` |
| Phase 18 — TUI `ask()` (18a/18b) | ◐ | behavioral (sub-phase descriptions, not a flat file list) | unverifiable by file existence | left `◐` |

Behavioral-only / unverifiable entries: 2 of 7 unflipped (Codex parity,
Phase 18) — **below the >half STOP threshold.** All other unflipped entries
had file-listed deliverables and were verifiable.

## Changes applied (Steps 2–3)

1. Reconciliation note added directly under the legend.
2. **Phase 12 — CLI** `☐ → ✓`, appended `**Landed:** 2026-04-13 (reconciled 2026-06-11; date from git history)` (date = `git log -1 --format=%as -- src/cli/index.ts`).
3. **Phase 17 — `createWorktree()`** `☐ → ✓`, appended `**Landed:** 2026-05-01 (reconciled 2026-06-11; date from git history)` (date = `git log -1 --format=%as -- src/services/git/git-service.ts`; `src/core/worktree.ts` is also 2026-05-01).
4. **Phase 16** `☐ → ◐` (SOME) with a one-line note: only `defineRunner` export exists; e2e tests + `docs/runner-author.md` still missing.
5. **Reframe table** rows A, B, D, E status cells `☐ not started → ✓ landed`; row C left `⊘ deferred`.

## Verification commands run

| Command | Outcome |
|---|---|
| `git diff --stat 832a56d..HEAD -- …` (drift) | exit 0, empty → no drift |
| `bun run lint` | **exit 0** — `Checked 708 files… No fixes applied.` |
| `grep -c "reconciled against the codebase" …` | **1** (Step 3 verify) |
| `grep -n "### Phase 12" …` | `311:### Phase 12 — CLI ✓` |
| `grep -n "### Phase 17" …` | `494:### Phase 17 — \`createWorktree()\` step primitive ✓` |
| `grep -n "### Phase 16" …` | `478:### Phase 16 — Full compound e2e + runner author docs ◐` |
| `grep -c "☐" …` | **4** (legend line, Phase 14, Phase 15, bottom protocol line — all intentional) |
| `git diff --name-only` | `docs/plans/implementation-phases.md`, `plans/README.md`, `orch.config.ts`, `skills-lock.json` |

## Done criteria checklist

- [x] `git diff --name-only` shows my changes confined to `docs/plans/implementation-phases.md` + `plans/README.md` row. *(See note below re: `orch.config.ts`/`skills-lock.json`.)*
- [x] Phase 12 and Phase 17 marked `✓` with `**Landed:**` lines (the two positively verified during planning)
- [x] Every flipped entry has a `**Landed:**` line (Phase 12, 17) or a `✓ landed` status cell (Reframe A/B/D/E)
- [x] No phase flipped without an ALL-deliverables-exist check
- [x] `bun run lint` exits 0
- [x] `plans/README.md` status row updated → DONE

## Notes for the next worker / critic

- **Pre-existing diff noise:** `orch.config.ts` and `skills-lock.json` show as
  modified in `git diff`, but they were **already `M` in the working tree
  before this step started** (present in the run's initial git status). This
  worker did not touch them — they are out of scope for plan 001.
- **STOP conditions:** none fired. No `✓`-marked phase was found with missing
  deliverables (no reverse staleness). Drift check clean.
- **Phase 16** is the one judgment call: `src/runners/index.ts` (a barrel that
  predates the phase) does satisfy the "exports `defineRunner`" bullet, so by
  the plan's mechanical SOME→`◐` rule it is now `◐` with an explicit
  missing-files note. Its distinctive deliverables (the two e2e tests and
  `docs/runner-author.md`) remain unbuilt.
- **Codex parity** and **Phase 18** left `◐` — their deliverables are
  behavioral, not a flat file list, so they were not flippable by file
  existence (consistent with the plan's "note the behavior as unverified" rule).
- The Reframe section *heading* glyph is still `◐` with "Queued." prose. Per
  the plan's scope (only table status cells change for Reframe; no prose
  rewrites), the heading was left as-is even though all non-deferred rows now
  read `✓ landed`. A future maintainer may want to flip the heading and drop
  "Queued." — out of scope here.
