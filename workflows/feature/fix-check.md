`bun run check` (lint + tests) failed on the current branch. The captured output is appended
below as context.

Fix the failing lint errors and failing tests. Stay on the current branch and leave the work in
the working tree — do NOT commit. Do NOT weaken, skip, or delete tests to make the gate pass;
fix the underlying cause. If a test encodes a genuine behavior change, fix the code to match the
acceptance contract in `{{sessionsDir}}/brainstorm.md` and `{{sessionsDir}}/acceptance-tests.md`.

Artifact: write what you changed (and anything still failing that needs the user) to
`{{sessionsDir}}/check-report.md`.
