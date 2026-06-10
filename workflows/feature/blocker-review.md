/compound-engineering:ce-brainstorm

A previous step of this feature workflow raised a BLOCKER and paused the workflow so the user
can review it before anything else happens.

The blocker is recorded at `{{blockerPath}}`. Read it first, then walk the user through it:
explain what was found and why it blocks progress. Discuss with the user what to do about it,
and apply whatever was agreed — e.g. update `{{sessionsDir}}/brainstorm.md`,
`{{sessionsDir}}/acceptance-tests.md`, or `{{sessionsDir}}/plan.md` to reflect the decision.

When the blocker is resolved (or the user has explicitly decided to proceed anyway), append a
short "Resolution:" note to `{{blockerPath}}` describing what was decided, and end the session.
The workflow will continue after you exit.
