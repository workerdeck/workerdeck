import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { conditions: ['@workerdeck/source'] },
  test: { include: ['test/**/*.test.ts'] },
})
