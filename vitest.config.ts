import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Every test file starts isolated from the developer's real config dir,
    // Claude account and LLM endpoint (see test/setup.ts).
    setupFiles: ['test/setup.ts'],
    testTimeout: 30000, // 30 seconds for embedding/indexing tests
  },
});
