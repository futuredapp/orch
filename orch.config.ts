import { defineConfig } from './src/config/index.ts'

export const config = defineConfig({
  workflows: {
    'new-feature': 'workflows/new-feature/index.ts',
  },
})
