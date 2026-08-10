import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/lib/__tests__/aiworker-video-release-rollback-policy.test.mjs'],
  },
})
