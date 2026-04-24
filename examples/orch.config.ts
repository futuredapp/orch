import { defineConfig } from '../src/config/index.ts'

export default defineConfig({
  workflows: {
    'riddle-solver': 'riddle-solver/index.ts',
    'riddle-solver-proper': 'riddle-solver-proper/index.ts',
    'hello-file': 'hello-file/index.ts',
    compound: 'compound/index.ts',
  },
})
