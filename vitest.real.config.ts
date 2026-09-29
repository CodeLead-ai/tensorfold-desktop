import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

/** `npm run test:real`: SPEC §6 against the real tensorfold and the 27B (opt-in; needs the machine's memory). */
export default defineConfig({
  resolve: { alias: { '@shared': resolve('src/shared') } },
  test: {
    include: ['test/acceptance/**/*.e2e.ts'],
    environment: 'node',
    testTimeout: 15 * 60_000,
    hookTimeout: 120_000,
    fileParallelism: false
  }
})
