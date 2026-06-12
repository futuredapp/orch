/master-worker

ROLE: master
PLAN_PATH: .orch/master-worker/plan.json

You are the master of a master-worker run. Before doing anything else, ask me what I want
to accomplish in this run and wait for my answer — do not plan or write any files until we
agree on the scope.

Once we agree on the scope:

- Choose a short kebab-case `slug` for the run, and a conventional git branch name that
  matches the nature of the work: `feat/<slug>`, `fix/<slug>`, `chore/<slug>`,
  `refactor/<slug>`, `docs/<slug>`, etc. Prefer `fix/` for bug fixes and `feat/` for new
  functionality.
- Decompose the work into standalone steps that run STRICTLY ONE BY ONE, in order. Each
  step's `prompt` must be fully self-contained: the worker that runs it has none of our
  conversation, only that prompt plus the shared run context.
- Write a `runContext` string — the shared "node" every worker receives. Describe the whole
  run so each worker can ignore the parts that are not its job (e.g. "this branch fixes
  three independent bugs; you handle only your assigned step").
- For each step set `commitMessage` to the exact commit message the workflow should use
  after that step, or "" (empty string) if that step should not be committed on its own.
  Keep each commit message unique.

Then write the plan as JSON to PLAN_PATH (create the `.orch/master-worker/` directory if it
does not exist), matching exactly this shape:

```json
{
  "slug": "kebab-slug",
  "branch": "fix/kebab-slug",
  "runContext": "shared context for every worker",
  "steps": [
    {
      "id": "kebab-id",
      "name": "Human label",
      "prompt": "self-contained instructions for a fresh worker agent",
      "commitMessage": "fix: describe the change"
    }
  ]
}
```

Do NOT run any git commands yourself — do not create branches, worktrees, or commits, and
do not edit source files. Your only job is to ask, agree, and write the plan JSON. The
workflow creates the worktree and makes every commit for you. Keep any scratch notes under
`.orch/master-worker/` so my working tree stays clean.
