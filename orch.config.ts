import { defineConfig } from './src/config/index.ts'

export const config = defineConfig({
  workflows: {
    'new-feature': 'workflows/new-feature/index.ts',
    'tic-tac-toe': 'workflows/tic-tac-toe/index.ts',
    'execute-plan': 'workflows/execute-plan/index.ts',
  },
})
