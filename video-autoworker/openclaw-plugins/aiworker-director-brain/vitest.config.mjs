import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['openclaw-plugins/aiworker-director-brain/test/**/*.test.mjs'],
  },
})
