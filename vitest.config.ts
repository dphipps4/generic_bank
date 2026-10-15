import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['apps/*/test/**/*.test.ts', 'packages/*/test/**/*.test.ts'],
    environment: 'node',
    // The bank's tests start an in-process Postgres per file; on a small laptop running every
    // file at once, starting one can take longer than the 5-second default.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
