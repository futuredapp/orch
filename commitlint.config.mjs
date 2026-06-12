// Conventional-commits enforcement for orch.
//
// The PR workflow (.github/workflows/pr.yml) runs commitlint over the PR's
// commit range, and a local commit-msg hook (.githooks/commit-msg, wired by the
// package.json "prepare" script) runs the SAME rules before each commit is
// created — so a bad type never enters history in the first place.
//
// Allowed types are the stock @commitlint/config-conventional set (feat, fix,
// docs, style, refactor, perf, test, build, ci, chore, revert) plus `agent`,
// which the orchestrator's bookkeeping commits use.
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [
      2,
      'always',
      [
        'agent',
        'build',
        'chore',
        'ci',
        'docs',
        'feat',
        'fix',
        'perf',
        'refactor',
        'revert',
        'style',
        'test',
      ],
    ],
  },
}
