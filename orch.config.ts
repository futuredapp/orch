import { defineConfig } from './src/config/index.ts'

export const config = defineConfig({
  workflows: {
    feature: 'workflows/feature/index.ts',
    'new-feature': 'workflows/new-feature/index.ts',
    'tic-tac-toe': 'workflows/tic-tac-toe/index.ts',
    'execute-plan': 'workflows/execute-plan/index.ts',
    'do-work': 'workflows/do-work/index.ts',
    'generate-changelog': 'workflows/generate-changelog/index.ts',
    session: 'workflows/session/index.ts',
    'master-worker': 'workflows/master-worker/index.ts',
    'scroll-test': 'workflows/scroll-test/index.ts',
  },
})
