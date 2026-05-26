import { defineConfig } from '../src/config/index.ts'

export default defineConfig({
  workflows: {
    'riddle-solver': 'riddle-solver/index.ts',
    'riddle-solver-proper': 'riddle-solver-proper/index.ts',
    'codex-riddle-solver': 'codex-riddle-solver/index.ts',
    'codex-and-claude': 'codex-and-claude/index.ts',
    'hello-file': 'hello-file/index.ts',
    compound: 'compound/index.ts',
    'feature-loop': 'feature-loop/index.ts',
    'ask-demo': 'ask-demo/index.ts',
    'command-tick-demo': 'command-tick-demo/index.ts',
    'command-lazygit': 'command-lazygit/index.ts',
  },
})
