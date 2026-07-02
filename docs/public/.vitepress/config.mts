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
  // Served from the project Pages subpath https://futuredapp.github.io/orch/.
  // The leading + trailing slash matches the repo name; without it every asset
  // 404s on the project Pages URL. Revert to '/' only if the site ever moves to
  // a custom domain or the org root.
  base: '/orch/',
  cleanUrls: true,
  // Fail the build on broken internal links — the main correctness gate.
  ignoreDeadLinks: false,

  srcExclude: ['**/README.md', '**/node_modules/**'],

  themeConfig: {
    search: { provider: 'local' },

    nav: [
      { text: 'Guide', link: '/guide/1-what-is-orch' },
      { text: 'Recipes', link: '/guides/built-in-workflows' },
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
          { text: 'Troubleshooting', link: '/guide/troubleshooting' },
        ],
      },
      {
        // Task-oriented how-tos, ordered from "run something now" through
        // composition and typing to extending orch itself.
        text: 'Recipes',
        items: [
          { text: 'Built-in workflows', link: '/guides/built-in-workflows' },
          { text: 'Chain two agents', link: '/guides/chain-two-agents' },
          { text: 'Parallel work', link: '/guides/parallel-work' },
          { text: 'Subworkflows', link: '/guides/subworkflows' },
          { text: 'Interactive steps', link: '/guides/interactive-steps' },
          { text: 'File-based prompts', link: '/guides/file-based-prompts' },
          { text: 'Typed prompt vars', link: '/guides/typed-prompt-vars' },
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
          { text: 'Built-in workflows', link: '/reference/built-ins' },
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
