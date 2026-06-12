/master-worker

ROLE: worker
STEP_ID: {{stepId}}
STEP_NAME: {{stepName}}
ARTIFACT: {{sessionsDir}}/{{stepId}}.md

Shared run context (applies to the whole run — read it, then ignore the parts that are not
your job):

{{runContext}}

You are executing ONE step of a larger master-worker plan. Do only the task described below
— nothing from other steps, and no extra scope. When you finish, write a short artifact to
`{{sessionsDir}}/{{stepId}}.md` (create the directory if it does not exist) summarizing what
you changed and anything the next worker or the critic needs to know.

Do NOT run any git commands: do not create, switch, or delete branches, do not create
worktrees, and do not commit or stash. The workflow handles all git and will commit your
changes for you after this step. Leave your changes in the working tree.

Your task:
