import { defineConfig } from './src/config/index.ts'

export default defineConfig({
  workflows: {
    'new-feature': 'workflows/new-feature/index.ts',
  },
})
