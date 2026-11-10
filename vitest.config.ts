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
    // Hooks get the same budget as tests: the beforeEach hooks of test/integration.test.ts index
    // conversations with the real embedding model (2-7s alone) and crossed vitest's 10s hook default
    // when the suite grew from 83 to 143 files (measured 10.6s and 10.8s, 2026-11-11).
    hookTimeout: 30000,
  },
});
