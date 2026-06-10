You are working inside a shared feature session at `{{sessionsDir}}`.

Before doing anything, read the artifacts already present in that directory — they are the
context produced by earlier steps of this workflow (brainstorm, acceptance tests, plan,
reviews). Treat `{{sessionsDir}}/brainstorm.md` and `{{sessionsDir}}/acceptance-tests.md` as
the human-reviewed acceptance contract: do not contradict or silently expand them.

When you finish, you MUST write your output to `{{sessionsDir}}/{{artifactName}}` — create the
file (and any parent directory) if it does not exist, update it in place if it does.

Hard constraints:
- Use repo-relative paths in everything you write — never absolute paths.
- Do NOT run `git commit`, `git push`, `git stash`, or create/switch/delete branches. Stay on
  the current branch and leave your work in the working tree. The orchestrator owns all commits.
