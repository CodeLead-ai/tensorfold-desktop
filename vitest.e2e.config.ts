import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

/** `npm run test:e2e`: the built app, driven through its UI against the mock. */
export default defineConfig({
  resolve: { alias: { '@shared': resolve('src/shared') } },
  test: {
    include: ['test/e2e/**/*.e2e.ts'],
    environment: 'node',
    testTimeout: 90_000,
    hookTimeout: 60_000,
    fileParallelism: false
  }
})
