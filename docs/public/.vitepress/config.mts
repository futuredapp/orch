import { defineConfig } from 'vitepress'

// User-facing documentation for orch.
//
// Source root is `docs/public/`. The rest of `docs/` (brainstorms, plans,
// adr, findings, issues, solutions) is internal and lives outside this root,
// so it is never part of the published site. `srcExclude` additionally guards
// against any internal markdown that might be dropped under the root by
// mistake.
export default defineConfig({
  title: 'orch',
  description:
    'Code-first orchestrator for chaining coding-agent CLIs (Claude Code, Codex) into deterministic, resumable workflows.',
  lang: 'en-US',
  cleanUrls: true,
  // Fail the build on broken internal links — the main correctness gate.
  ignoreDeadLinks: false,

  srcExclude: ['**/README.md', '**/node_modules/**'],

  themeConfig: {
    search: { provider: 'local' },

    nav: [
      { text: 'Guide', link: '/guide/1-what-is-orch' },
      { text: 'Reference', link: '/reference/api' },
      { text: 'Examples', link: '/examples' },
    ],

    sidebar: [
      {
        text: 'Guide',
        items: [
          { text: 'What is orch?', link: '/guide/1-what-is-orch' },
          { text: 'Getting started', link: '/guide/2-getting-started' },
          { text: 'Core concepts', link: '/guide/3-core-concepts' },
          { text: 'Writing a workflow', link: '/guide/4-writing-a-workflow' },
          { text: 'Running workflows', link: '/guide/5-running-workflows' },
          { text: 'Debugging', link: '/guide/6-debugging' },
        ],
      },
      {
        text: 'Guides',
        items: [
          { text: 'Chain two agents', link: '/guides/chain-two-agents' },
          { text: 'Interactive steps', link: '/guides/interactive-steps' },
          { text: 'Parallel work', link: '/guides/parallel-work' },
          { text: 'Typed returns', link: '/guides/typed-returns' },
          { text: 'Validators', link: '/guides/validators' },
          { text: 'Worktrees and commits', link: '/guides/worktrees-and-commits' },
          { text: 'Add a runner', link: '/guides/add-a-runner' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'Authoring API', link: '/reference/api' },
          { text: 'Runners', link: '/reference/runners' },
          { text: 'CLI', link: '/reference/cli' },
          { text: 'Configuration', link: '/reference/config' },
        ],
      },
      {
        text: 'Examples',
        items: [{ text: 'Examples overview', link: '/examples' }],
      },
    ],
  },
})
