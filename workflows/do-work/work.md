/ce-work
{{work}}

Context:
- Plan: `{{planFile}}` — read it to understand the full scope before starting.
- Summaries: `{{summariesFile}}` — read it (if it exists) to understand what has already been implemented; do not redo completed work.

Hard constraints:
- Stay on the current git branch — do NOT create, switch, or delete branches.
- Do NOT run `git commit`, `git stash`, or `git push` — leave all changes in the working tree; the workflow handles commits.
- Implement only the work described above; leave unrelated items untouched.

When done, append a brief entry to `{{summariesFile}}`:
- A `## <short task title>` heading.
- 2–3 sentences: what changed, any key learnings, and the current state of the codebase.
- Create the file if it does not exist.

Stop after appending the summary.

You are running autonomously inside an orchestrator — there is no human to answer questions, so do not ask any; make reasonable decisions and proceed.
