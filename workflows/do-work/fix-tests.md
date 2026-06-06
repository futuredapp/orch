`bun run check` is failing. Diagnose the root cause (lint error, type error, or test failure) and fix it. Re-run `bun run check` after each fix until it passes.

Hard constraints:
- Do NOT run `git commit`, `git stash`, or `git push` — leave all changes in the working tree.
- Fix the underlying issue; do not change behaviour to silence a test or suppress a type error.
- If a failure is unrelated to the recent work, still fix it.

Plan context (for understanding intended behaviour): `{{planFile}}`

Failing output:

{{testOutput}}

Stop when `bun run check` is green.

You are running autonomously inside an orchestrator — there is no human to answer questions, so do not ask any; make reasonable decisions and proceed.
