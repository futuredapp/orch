import { defineConfig } from '../src/config/index.ts'

export default defineConfig({
  workflows: {
    'riddle-solver': '/examples/riddle-solver/index.ts',
    'riddle-solver-proper': '/examples/riddle-solver-proper/index.ts',
    'hello-file': '/examples/hello-file/index.ts',
    compound: '/examples/compound/index.ts',
  },
})
