/compound-engineering:ce-code-review

Review the changes on the current branch (working tree + commits made during this feature).
Inspect them with `git status` and `git diff` against the branch point.

Scope: review PRIMARILY the new changes introduced by this feature (the diff on the current
branch since it diverged). Do not flag — and never start changing — long-standing, pre-existing
code that is unrelated to this change. If you do spot an unrelated issue worth recording, write
it as its own file under `{{sessionsDir}}/issues/` (clear, self-contained description a developer
with no context can understand) instead of putting it in the review findings.

Write the full structured findings (for the new changes) to `{{sessionsDir}}/code-review-ce.md`.
For every finding include as much detail as possible: severity (critical / high / medium / low),
`file:line`, a description of the problem, the rationale (why it matters), and a concrete
suggested fix.
