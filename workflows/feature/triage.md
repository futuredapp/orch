Read both code reviews (`{{sessionsDir}}/code-review-ce.md` and
`{{sessionsDir}}/code-review-codex.md`), plus `{{sessionsDir}}/brainstorm.md`,
`{{sessionsDir}}/acceptance-tests.md`, and `{{sessionsDir}}/plan.md`.

Double-check every finding from both reviews against the actual code and the acceptance contract.
Then sort them:

1. **Actionable fixes** — select the middle way. Pick what genuinely makes sense: critical or
   high-priority correctness issues, easy wins, and changes with clear value for reliability,
   simplicity, or bug prevention. Do NOT select everything; skip low-value churn. Anything that
   would change scope or contradict the brainstorm / acceptance tests is NOT an actionable fix —
   record it as an issue instead (below). Write the selected fixes to
   `{{sessionsDir}}/fix-plan.md`, grouped into **1 to 6 groups** by complexity and similarity.
   Each group MUST carry a `Status: not-started` line. Follow the testing conventions in
   `docs/testing-strategy.md`, and for any fix that could break existing behavior, include the
   tests that would catch that regression.

2. **Issues worth mentioning** — anything not selected for fixing but still worth the developer's
   attention (scope-changing findings, deferred improvements, risks, follow-ups). Write EACH one
   as its own file under `{{sessionsDir}}/issues/` (one issue per file, descriptive filename).
   Each file must have a clear, self-contained description that a developer with no prior context
   can fully understand: what the issue is, where it is, why it matters, and a suggested next step.
