/compound-engineering:ce-doc-review {{sessionsDir}}/brainstorm.md

Review the brainstorm AND the acceptance tests together (`{{sessionsDir}}/brainstorm.md` and
`{{sessionsDir}}/acceptance-tests.md`).

How to apply findings:
- Auto-apply minor, clearly-correct fixes in place (typos, ambiguous wording, obviously missing
  edge cases, small inconsistencies).
- For anything that changes scope, alters the intended workflow, or needs more than a minor
  edit — STOP and discuss it with the user before changing anything. Do not unilaterally make
  scope-affecting decisions.

When done, write a summary of what you auto-fixed and what you flagged/discussed to
`{{sessionsDir}}/doc-review.md`.
