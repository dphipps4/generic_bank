import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Tests import our own packages from their source, not their build output: otherwise a test run
// before `tsc -b` quietly tests yesterday's code.
const packages = readdirSync(new URL('./packages', import.meta.url));
const alias = Object.fromEntries(
  packages.map((p) => [
    `@gb/${p}`,
    fileURLToPath(new URL(`./packages/${p}/src/index.ts`, import.meta.url)),
  ]),
);

export default defineConfig({
  resolve: { alias },
  test: {
    include: ['apps/*/test/**/*.test.ts', 'packages/*/test/**/*.test.ts', 'tests/**/*.test.ts'],
    // The long suite runs on its own (vitest.long.config.ts): on every merge to master, and with
    // just test-long.
    exclude: ['**/node_modules/**', 'tests/long/**'],
    // With --changed, a change to any of these runs everything: tests read them as files (the
    // migrations, the seeds, the compose and secrets files), not through imports.
    forceRerunTriggers: [
      '**/package.json',
      'package-lock.json',
      '**/vitest*.config.*',
      'tsconfig*.json',
      'packages/db/prisma/**',
      'apps/memory/prisma/**',
      'seeds/**',
      'config/**',
      'infra/**',
      '.github/**',
      'tests/support/**',
      'tests/fixtures/**',
    ],
    environment: 'node',
    // The bank's tests start an in-process Postgres per file; on a small laptop running every
    // file at once, starting one can take longer than the 5-second default.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
