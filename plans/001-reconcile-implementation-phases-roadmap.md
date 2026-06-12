# Plan 001: Reconcile `docs/plans/implementation-phases.md` with what is actually shipped

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 832a56d..HEAD -- docs/plans/implementation-phases.md src/cli src/core/worktree.ts src/hosts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: docs
- **Planned at**: commit `832a56d`, 2026-06-11

## Why this matters

`docs/plans/implementation-phases.md` is the repo's phased roadmap, and the
project's `CLAUDE.md` instructs every contributor — human or agent — to "Read
the active phase in `docs/plans/implementation-phases.md`" before starting
feature work. The document is severely stale: at least Phase 12 (CLI) and
Phase 17 (`createWorktree()`) are marked `☐ not started` while their
deliverables are fully shipped, tested, and released (v0.1.2 ships the CLI
via Homebrew). A stale roadmap actively misleads: during a codebase audit on
2026-06-11, an automated auditor read this doc and incorrectly reported "the
CLI dispatcher is missing" as a finding. Fixing the doc removes a recurring
source of wrong conclusions for every future agent session in this repo.

## Current state

- `docs/plans/implementation-phases.md` — the roadmap. Legend at line 34:
  `Legend: ☐ not started · ◐ in progress · ✓ landed`.
- The doc's own update protocol (around line 585):

  ```
  ## How to mark a phase as landed

  1. Update this document: flip the phase's status glyph from ☐ to ✓ and add a
     `**Landed:** YYYY-MM-DD` line at the end of the phase block.
  ```

- Stale entries verified against the code on 2026-06-11:

  | Doc entry | Claimed status | Reality (verified evidence) |
  |---|---|---|
  | `### Phase 12 — CLI ☐` (line ~307) | not started | `src/cli/main.ts` is a complete argv dispatcher importing `runCmd`, `resumeCmd`, `retryCmd`, `runsCmd`, `statusCmd`, `dryRunCmd`, `initCmd`, `newCmd`, `logsCmd`, `typesCmd`; tests exist at `tests/integration/cli/main-dispatch.test.ts`, `tests/unit/cli/argv.test.ts` |
  | `### Phase 17 — createWorktree() step primitive ☐` (line ~486) | not started | `src/core/worktree.ts` and `src/core/worktree-post-create.ts` exist; `src/services/git/bun-git-service.ts` exists |
  | Reframe table rows A, B, D, E (lines ~428–432) | not started | `src/core/run-mode.ts`, `src/core/view.ts`, `src/core/view-registry.ts`, `src/hosts/two-pane/`, `src/hosts/host-registry.ts`, `src/config/index.ts` (config discovery), `src/cli/commands/logs.ts` all exist |

  Other phases marked `☐` or `◐` (14, 15, 16, 18, Codex parity) were NOT
  verified during planning — the executor verifies each one individually
  (Step 1) and only flips entries with positive evidence.

- Excerpt of the Phase 12 block as it exists today (for drift detection):

  ```markdown
  ### Phase 12 — CLI ☐

  **Goal:** users can invoke the orchestrator from the terminal.

  **Deliverables:**
  - `src/cli/index.ts` — argv parser (tiny; no framework).
  - `orch run <file.ts>`, `orch resume <id>`, `orch runs`, `orch status <id>`, `orch dry-run <file.ts>`.
  ```

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Lint | `bun run lint` | exit 0 |
| Find a phase block | `grep -n "### Phase" docs/plans/implementation-phases.md` | line numbers per phase |
| Date a deliverable landed | `git log -1 --format=%as -- <primary deliverable path>` | a `YYYY-MM-DD` date |
| Count stale glyphs | `grep -c "☐" docs/plans/implementation-phases.md` | a number (compare before/after) |

## Scope

**In scope** (the only file you should modify):
- `docs/plans/implementation-phases.md`

**Out of scope** (do NOT touch):
- Any file under `src/` or `tests/` — this is a documentation-only plan.
- `docs/public/` — the published site; `implementation-phases.md` is internal.
- Other docs under `docs/plans/` — the per-phase plan files are historical
  records, not status trackers.
- Do NOT rewrite phase descriptions, goals, or deliverable lists — only the
  status glyph and the appended `**Landed:**` line change.

## Steps

### Step 1: Build the verification table

For every phase block whose heading glyph is `☐` or `◐` (and the
non-numbered sections like "Codex runner parity" and the Reframe table rows),
check whether each listed deliverable file exists in the repo
(`ls <path>` / `test -f <path>`). Record per phase: ALL deliverables exist /
SOME exist / NONE exist. Where a deliverable names a behavior rather than a
file ("interactive via respawn-pane"), check for the named file only and note
the behavior as unverified.

**Verify**: you have a written table (in your working notes) with one row per
`☐`/`◐` entry, each marked ALL / SOME / NONE with the paths you checked.

### Step 2: Flip fully-shipped phases to ✓

For each phase where ALL deliverables exist:

1. Change the heading glyph from `☐` (or `◐`) to `✓`.
2. Append at the end of that phase block:
   `**Landed:** <date>` where `<date>` is
   `git log -1 --format=%as -- <primary deliverable path>` (use the first
   deliverable file listed for the phase). If the doc protocol's exact landing
   date is unknowable, this last-commit date is the best available proxy —
   suffix it with ` (reconciled 2026-06-11; date from git history)`.

For the Reframe table rows (they use a `not started` text column, not a
heading glyph), change the status cell to `✓ landed` for rows whose
deliverables all exist.

For phases where only SOME deliverables exist, set the glyph to `◐` (if it
was `☐`) and append a one-line note naming what is still missing. Do not
guess — name only files you checked.

**Verify**: `grep -n "Phase 12" docs/plans/implementation-phases.md` shows
`### Phase 12 — CLI ✓` and a `**Landed:**` line exists in that block
(confirm with `sed -n '<block range>p'`).

### Step 3: Add a reconciliation note at the top

Directly under the legend line (line ~34), add:

```markdown
> Statuses reconciled against the codebase on 2026-06-11 (commit 832a56d).
> Several phases had shipped without their glyph being flipped; landed dates
> marked "(reconciled …)" are last-commit dates from git history, not PR dates.
```

**Verify**: `grep -n "reconciled against the codebase" docs/plans/implementation-phases.md` → 1 match.

### Step 4: Lint and review the diff

**Verify**: `bun run lint` → exit 0. `git diff --stat` → exactly one file
changed: `docs/plans/implementation-phases.md`.

## Test plan

No code tests — documentation-only. The verification is Step 1's
evidence table plus the done criteria below.

## Done criteria

- [ ] `git diff --name-only` shows only `docs/plans/implementation-phases.md`
- [ ] Phase 12 and Phase 17 are marked `✓` with `**Landed:**` lines (these two
      were positively verified during planning)
- [ ] Every flipped entry has a `**Landed:**` line (numbered phases) or a
      `✓ landed` status cell (Reframe table)
- [ ] No phase was flipped without an ALL-deliverables-exist check
- [ ] `bun run lint` exits 0
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `docs/plans/implementation-phases.md` no longer contains the
  `Legend: ☐ not started …` line or the Phase 12 block shown in "Current
  state" (doc was restructured since planning).
- You find a phase marked `✓ landed` whose deliverables do NOT exist (reverse
  staleness) — report it, don't un-flip it without instruction.
- The deliverable lists are too behavioral to verify by file existence for
  more than half the unflipped phases — report which, with your partial table.

## Maintenance notes

- The doc's own "How to mark a phase as landed" protocol exists but wasn't
  followed; a reviewer may want to add a PR-checklist item or CI grep that
  fails when a phase's primary deliverable exists but its glyph is `☐`.
- Deferred: `CLAUDE.md` says "Read the active phase" — once statuses are
  correct, consider adding a single "Active phase: N" pointer line at the top
  of the roadmap so agents don't have to scan.
