// Conventional-commits enforcement for orch.
//
// The PR workflow (.github/workflows/pr.yml) runs commitlint over the PR's
// commit range. Stock @commitlint/config-conventional is used unchanged: the
// allowed types are feat, fix, docs, style, refactor, perf, test, build, ci,
// chore, revert. The repo's historical `agent:` prefix is intentionally NOT
// allow-listed — those were agent bookkeeping commits and stop being valid
// going forward (see the public-release plan, U5).
//
// No local husky/commit-msg hook is wired here: CI is the gate. A local hook
// is optional developer convenience and is out of scope for this release.
export default {
  extends: ['@commitlint/config-conventional'],
}
