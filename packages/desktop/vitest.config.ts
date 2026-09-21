import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Process startup competes with test workers on Windows, exhausting CLI/lifecycle deadlines.
    fileParallelism: false,
  },
})
