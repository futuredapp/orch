/compound-engineering:ce-work {{sessionsDir}}/fix-plan.md

Implement the NEXT group of `{{sessionsDir}}/fix-plan.md` whose `Status` is not yet `done`.

Read `{{sessionsDir}}/fix-plan.md` first, plus `{{sessionsDir}}/brainstorm.md` and
`{{sessionsDir}}/acceptance-tests.md` so you stay inside the acceptance contract. Follow
`docs/testing-strategy.md` and add the tests the fix plan calls for. If a previous iteration
already started this group, continue from where it left off. If every group is already `done`,
change nothing and say so.

When you finish the group, set its `Status: done` in `fix-plan.md`.

Hard constraints:
- Stay on the current git branch. Do NOT commit, push, stash, or switch branches — the
  orchestrator commits after this step.

Artifact: write a brief summary — what you fixed and any issues you hit along the way.

Return JSON matching the output schema:
- `artifactPath`: the repo-relative path of the summary artifact you wrote.
- `done`: true ONLY if every group of the fix plan is now `Status: done` and actually
  implemented; otherwise false.
- `reason`: one short sentence — what you fixed this round, and (if not done) what groups remain.
