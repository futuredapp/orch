/compound-engineering:ce-plan

Read `{{sessionsDir}}/brainstorm.md` and `{{sessionsDir}}/acceptance-tests.md` first, then write a
phased implementation plan to `{{sessionsDir}}/plan.md`.

Phasing rules:
- Split the work into **1 to 4 implementation phases**, separated by genuine logical boundaries.
  Do NOT pad a small feature into more phases than it needs, and do NOT cram a large feature into
  too few.
- Calibration: a trivial change → 1 phase; most features → 2 or 3 phases; only a large,
  multi-surface feature → 4 phases.
- Examples of well-shaped phasings:
  - 1 phase: "Add the validation rule and its test."
  - 2 phases: "(1) data model + migration, (2) API + UI wiring."
  - 3 phases: "(1) core domain logic, (2) integration with existing services, (3) UI + polish."
  - 4 phases: "(1) schema, (2) backend, (3) frontend, (4) migration/rollout."

Each phase MUST include:
- A `Status: not-started` line (later steps update this to `done`).
- A clear separation between **AI-implementable** tasks and tasks that are
  **blocked-on-user-input** (decisions, credentials, external resources). Label them explicitly.

Keep the plan the simplest correct path to satisfy the brainstorm and every acceptance test.
