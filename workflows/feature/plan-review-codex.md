Read `{{sessionsDir}}/plan.md`, `{{sessionsDir}}/brainstorm.md`, and
`{{sessionsDir}}/acceptance-tests.md`.

Critically review the PLAN (not the code — none exists yet):
- Is it over-complicated? Is there a simpler correct path to the same outcome?
- Will it actually fulfil the brainstorm and EVERY acceptance test? Name any gap.
- Are edge cases and failure modes covered?
- Is the phasing logical, and is the AI-vs-user-input separation correct?

Scope: focus on whether THIS feature's plan is sound. Do not propose reworking unrelated existing
architecture or pre-existing code that this feature does not touch. If you spot an unrelated issue
worth recording, write it as its own file under `{{sessionsDir}}/issues/` (clear, self-contained
description a developer with no context can understand) instead of folding it into the plan review.

Write detailed findings (about this plan) to `{{sessionsDir}}/plan-review.md`. For each finding
give: a short title, a severity (critical / high / medium / low), the rationale, and a concrete
suggested change. Do NOT modify the plan itself.
