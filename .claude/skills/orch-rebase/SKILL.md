---
name: orch-rebase
description: >-
  Rebase one or more git worktree branches onto main and fast-forward merge them
  in, safely and in the right order. Use this whenever the user wants to land,
  integrate, ship, or "rebase and merge" finished worktree branches into main —
  e.g. "/orch-rebase let's merge feat/fake-runner and feat/test-cleanup-fix",
  "integrate my worktrees into main", "rebase these branches and merge them",
  "fold the feature worktrees back into main". Triggers even when the user only
  names branches/worktrees and the verb is vague ("get these into main",
  "wrap up these worktrees"). Handles backups, conflict prediction, merge
  ordering, per-branch verification with bun run check, and conflict reporting.
  Do NOT use for a single in-place feature branch with no worktree, for opening
  PRs, or for pushing to a remote — this is local worktree → main integration.
---

# orch-rebase — integrate worktree branches into main

This skill turns "rebase my finished worktrees onto main and merge them" into a
safe, ordered, observable pipeline. It exists because doing it by hand across
several worktrees is fiddly: you have to rebase each branch *inside its own
worktree*, merge in the right order so conflicts don't pile up, and re-verify
after every merge. The bundled scripts in `scripts/` do the git work; your job
is to drive them, decide order, resolve conflicts, and keep the user informed.

**Prefer the scripts over raw git.** Every git operation this workflow needs is
already a script in `scripts/`. Running long ad-hoc git pipelines is slow and
error-prone here; the scripts are tested, emit greppable `RESULT:` lines, and
refuse unsafe states. If you find yourself needing a git operation that isn't
covered, add a script for it rather than running it inline — that's the standing
convention for this skill.

## The one mechanic that shapes everything

A branch checked out in a worktree **cannot** be rebased or reset from another
worktree — git refuses. So:

- Rebasing `feat/x` happens **inside** `...--feat--x` (the scripts handle the
  `git -C <worktree>` for you).
- The fast-forward merge into `main` happens in the **main** worktree.
- Because each branch is rebased onto the *current* main right before it merges,
  `--ff-only` always applies and **order never affects correctness** — only how
  much conflict pain you hit. Land the least-entangled branch first.

Deeper git details, recovery procedures, and the conflict-prediction caveats are
in `references/git-mechanics.md` — read it before resolving a messy conflict or
if a script surprises you.

## The pipeline

Work through these phases in order. Announce each phase to the user as you go.

### 1. Resolve targets and confirm

Run `scripts/list-worktrees.sh` to see every main-based worktree branch with its
ahead/behind counts, changed-file count, and clean/DIRTY state.

- If the user named branches, match them to this list.
- If they were vague ("merge my worktrees"), propose the set of clean,
  ahead-of-main branches.
- **Refuse dirty worktrees up front.** If any target is `DIRTY`, stop and tell
  the user exactly which ones — they must commit or stash first. Do not stash or
  commit on their behalf; their in-progress work is theirs to resolve.
- Skip branches that are `0 commit(s) ahead` — there is nothing to merge.

Then **confirm explicitly** before touching anything, naming the set and the
base, e.g.:

> I'll rebase and merge these onto main: `feat/fake-runner`,
> `feat/test-cleanup-fix`. Both are based on main and clean. Proceed?

Wait for a clear yes. This is the gate that prevents merging unfinished work.

### 2. Back everything up

Pick a run slug: `<YYYYMMDD>-<HHMM>-<short-description>` (you'll reuse it for the
doc and the backup tags). Get the timestamp with `date '+%Y%m%d-%H%M'`.

Run `scripts/backup.sh <slug> <branch>...`. This tags every target branch **and**
main as `orch-backup/<slug>/<branch>`. If anything goes wrong later,
`scripts/restore-backup.sh <slug> <branch>...` puts them all back. Tell the user
the backup is in place and how to restore — that's the safety guarantee they
asked for.

### 3. Analyze each worktree (parallel subagents)

Spawn **one read-only subagent per target branch, all in the same turn** so they
run concurrently. Each subagent should:

- Run `scripts/analyze-worktree.sh <branch>` to get the commits, changed files,
  and full diff in one shot.
- Read enough of the actual changed code to explain, in plain language: **what
  the branch does**, **what it changes** (files/areas/behavior), and **anything
  that looks like it could alter behavior another branch depends on**.
- Return a tight summary (≤ ~200 words): purpose, key files, risk notes.

Use the `Explore` agent type or general-purpose; the prompt should be explicit
that the output is a summary returned to the orchestrator, not a message to a
human.

### 4. Predict conflicts and decide order (one subagent)

Run `scripts/conflict-matrix.sh <branch>...` yourself first — it prints, vs main
and pairwise: predicted textual conflicts (`git merge-tree`) and **shared files
between branches** (the behavioral-interaction signal).

Then spawn one subagent (or do it inline if the picture is simple) that takes the
per-worktree summaries + the conflict matrix and decides:

- **Merge order** — least-entangled branch first, so others rebase onto a main
  that already contains it.
- **Interaction warnings** — for every shared-file pair, an explicit note: "when
  B lands after A, watch <file>:<area> because A changed <behavior> that B
  relies on." This is the "if something changes another worktree's behavior,
  point it out" requirement — make it prominent.

Write the decision to `.orch/rebase/<slug>.md` using the template in
`references/doc-template.md`. This doc is the run's source of truth and running
log — update it as each branch lands. It lives under `.orch/` (gitignored) on
purpose: writing it into the tracked tree would dirty the main worktree and trip
the `merge-to-main.sh` clean-tree gate, so keep it out of `docs/`.

Present the plan (order + interaction warnings + backup location) to the user.
For a routine run you can proceed; if there are predicted conflicts or notable
interactions, surface them clearly first.

### 5. Integrate each branch, in order, one at a time

For each branch in the decided order, run this loop. **Never start the next
branch until the current one is fully merged and verified** — each must land on a
green main so the next rebases onto known-good code.

1. **Rebase** — `scripts/rebase.sh <branch>`.
   - `RESULT: CLEAN` → go to step 2.
   - `RESULT: CONFLICT` → the rebase is paused in the worktree with the
     conflicted files listed. Resolve them there (read both sides; preserve the
     intent of *both* features — see `references/git-mechanics.md`), then
     `git -C <worktree> add <files> && git -C <worktree> rebase --continue`.
     Repeat until the rebase finishes. If it's too messy to resolve safely, run
     `scripts/abort-rebase.sh <branch>`, log it as skipped, tell the user, and
     move on. Never force a resolution you're unsure of.
   - `RESULT: REFUSED` → fix the stated precondition (usually a newly-dirty
     worktree) and retry.

2. **Merge** — `scripts/merge-to-main.sh <branch>`.
   - `RESULT: MERGED` → go to step 3.
   - `RESULT: REFUSED` → something is off (not a fast-forward). Stop and
     investigate; do not improvise a merge commit.

3. **Verify** — `scripts/verify.sh` (runs `bun run check`: lint + typecheck +
   test).
   - `RESULT: PASS` → log success in the doc, move to the next branch.
   - `RESULT: FAIL` → read the log it points to. **Fix only breakage this
     integration introduced** — semantic conflicts where both branches compiled
     alone but collide together (duplicate symbols, a changed signature one
     branch didn't see, drifted imports, a test asserting old behavior). Use
     `bun run lint:fix` for formatting. Do **not** fix pre-existing failures or
     rewrite feature logic; if a failure isn't clearly caused by the
     integration, stop and report it to the user. After fixing, commit the fix
     on main and re-run `scripts/verify.sh` until green.

4. **Log** — update `.orch/rebase/<slug>.md`: branch, result, any conflicts
   resolved, any integration fixes, final main SHA.

### 6. Report

Summarize for the user: which branches merged, in what order, conflicts hit and
how resolved, integration fixes made, final main SHA, and the backup tag pattern
(`orch-backup/<slug>/*`) with the one-line restore command. Note that worktrees
and branches were left in place (cleanup is manual).

## If a run goes wrong

`scripts/restore-backup.sh <slug> <branch>...` resets main and every target
branch back to the backup tags — aborting any in-progress rebase/merge first.
Reach for it whenever you're unsure of the state. The backups are the reason this
is safe to run.

## Scripts reference

| Script | Purpose | Mutates? |
|---|---|---|
| `list-worktrees.sh` | candidate worktrees + dirty check | no |
| `analyze-worktree.sh <branch>` | commits/files/diff for a subagent | no |
| `conflict-matrix.sh <branch>...` | conflict + shared-file prediction | no |
| `backup.sh <slug> <branch>...` | tag all branches + main | tags only |
| `rebase.sh <branch>` | rebase branch onto main in its worktree | yes |
| `merge-to-main.sh <branch>` | `--ff-only` merge into main | yes |
| `verify.sh [log] [-- cmd]` | run `bun run check` (override-able) | no |
| `abort-rebase.sh <branch>` | abort an in-progress rebase | yes |
| `restore-backup.sh <slug> <branch>...` | reset everything to backups | yes |

All mutating scripts refuse unsafe states and print a `RESULT:` line. Read it
instead of re-running git to check what happened.
