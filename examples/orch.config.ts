import { defineConfig } from '../src/config/index.ts'

export default defineConfig({
  workflows: {
    'riddle-solver': 'riddle-solver/index.ts',
    'riddle-solver-proper': 'riddle-solver-proper/index.ts',
    'codex-riddle-solver': 'codex-riddle-solver/index.ts',
    'codex-and-claude': 'codex-and-claude/index.ts',
    'math-duel': 'math-duel/index.ts',
    'hello-file': 'hello-file/index.ts',
    compound: 'compound/index.ts',
    'feature-loop': 'feature-loop/index.ts',
    'ask-demo': 'ask-demo/index.ts',
    'command-tick-demo': 'command-tick-demo/index.ts',
    'command-lazygit': 'command-lazygit/index.ts',
    'file-prompts-demo': 'file-prompts-demo/index.ts',
    // Subworkflow examples (U10). `feature` dispatches to one of two subs,
    // `parent`/`branch-isolated` show cwd isolation, `ship-many` shows the
    // parallel-of-distinct-subs canonical shape.
    feature: 'feature/index.ts',
    'simple-feature': 'simple-feature/index.ts',
    'complex-feature': 'complex-feature/index.ts',
    parent: 'parent/index.ts',
    'branch-isolated': 'branch-isolated/index.ts',
    'ship-many': 'ship-many/index.ts',
    'ship-one': 'ship-one/index.ts',
  },
})
