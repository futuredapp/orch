/compound-engineering:ce-work {{sessionsDir}}/plan.md

Implement the NEXT phase of `{{sessionsDir}}/plan.md` whose `Status` is not yet `done`. Skip any
tasks labelled blocked-on-user-input — leave those for the user and note them.

Read `{{sessionsDir}}/plan.md`, `{{sessionsDir}}/brainstorm.md`, and
`{{sessionsDir}}/acceptance-tests.md` first so you understand the intent. If a previous iteration
already started this phase, continue from where it left off rather than restarting. If every
non-blocked phase is already `done`, change nothing and say so.

When you finish the phase, set its `Status: done` in `plan.md`.

Hard constraints:
- Stay on the current git branch. Do NOT commit, push, stash, or switch branches — the
  orchestrator commits after this step.

Artifact: write a brief summary of this session — everything you would tell the user at the end
(what you implemented) plus any issues or surprises you hit along the way.

Return JSON matching the output schema:
- `artifactPath`: the repo-relative path of the summary artifact you wrote.
- `done`: true ONLY if every non-blocked phase of the plan is now `Status: done` and actually
  implemented; otherwise false.
- `reason`: one short sentence — what you did this round, and (if not done) what phases remain.
