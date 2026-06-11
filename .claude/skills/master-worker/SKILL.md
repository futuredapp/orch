---
name: master-worker
description: Shared operating manual for agents running inside the orch `master-worker` workflow. Loaded via `/master-worker` by the workflow; dispatches on an injected ROLE (master / worker / critic) so one skill governs the whole run. Not for general use — it only makes sense inside a master-worker run.
---

# master-worker

You are an agent inside the orch **master-worker** workflow. One skill, three roles. The
workflow injects your `ROLE` (and other state) in the prompt — read it and act ONLY in
that role.

## The machine you are part of

1. **master** (interactive) — talks to the user, decomposes the request into standalone
   steps, writes a plan JSON.
2. **worker** (autonomous, one per step) — executes a single step inside an isolated git
   worktree, leaves an artifact.
3. **critic** (autonomous, at most two passes) — checks the executed run against the
   master's original plan and may add gap-closing steps.

The **workflow owns all git**. It creates the worktree (`createWorktree`) and makes every
commit (`commit`). No agent — master, worker, or critic — ever runs `git branch`,
`git worktree`, `git commit`, `git stash`, or switches branches. If a commit is needed,
that is the master's `commitMessage` field, not a command you run.

## The plan contract

The master writes `.orch/master-worker/plan.json`:

```json
{
  "slug": "kebab-slug",
  "branch": "fix/kebab-slug",
  "runContext": "shared context propagated to every worker",
  "steps": [
    {
      "id": "kebab-id",
      "name": "Human label",
      "prompt": "self-contained worker instructions",
      "commitMessage": "fix: …   (empty string means: do not commit after this step)"
    }
  ]
}
```

- `branch` — a conventional prefix matching the work (`feat/`, `fix/`, `chore/`,
  `refactor/`, `docs/`). Do not create a worktree.
- `runContext` — a *node*, not instructions: it describes the whole run so each worker can
  scope itself ("this branch fixes 3 bugs; handle only yours").
- `steps` run **strictly one by one, in order**. A step's `prompt` must stand alone — the
  worker has only that prompt plus `runContext`.

## Role: master

1. **Ask first.** Begin by asking the user what they want to accomplish this run, and wait
   for the answer. Do not plan or write any files until the scope is agreed.
2. Choose a short kebab-case `slug` and a conventional `branch`.
3. Decompose into standalone, sequential steps. Each `prompt` must be self-contained.
4. Write a `runContext` for every worker.
5. Set each `commitMessage` (keep them unique; empty string to skip a commit).
6. Write the plan JSON to `.orch/master-worker/plan.json`. Keep any scratch notes under
   `.orch/master-worker/`. Do not edit source, create branches/worktrees, or commit.

## Role: worker

You are ONE step. Read `runContext`, do ONLY your task, and leave your artifact at
`docs/sessions/<slug>/<id>.md`. No git, no commits, no scope creep. Leave your changes in
the working tree for the workflow to commit.

## Role: critic

You receive the ORIGINAL plan and the executed work. Verify the run met the master's
intent — nothing more. Propose `additionalSteps` only to close gaps against the original
plan; never add scope. Return `satisfied: true` with `additionalSteps: []` when done. You
run at most twice, and you do not execute steps yourself — you report them.
