import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Tests import our own packages from their source, not their build output: otherwise a test run
// before `tsc -b` quietly tests yesterday's code.
const packages = readdirSync(new URL('./packages', import.meta.url));
const alias = [
  // A package's own subpaths first: the masking rule alone, with no browser in it.
  {
    find: '@gb/runtime/rule',
    replacement: fileURLToPath(new URL('./packages/runtime/src/rule.ts', import.meta.url)),
  },
  ...packages.map((p) => ({
    find: `@gb/${p}`,
    replacement: fileURLToPath(new URL(`./packages/${p}/src/index.ts`, import.meta.url)),
  })),
];

export default defineConfig({
  resolve: { alias },
  test: {
    include: ['apps/*/test/**/*.test.ts', 'packages/*/test/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: ['**/node_modules/**'],
    // With --changed, a change to any of these runs everything: tests read them as files (the
    // migrations, the compose and secrets files), not through imports.
    forceRerunTriggers: [
      '**/package.json',
      'package-lock.json',
      '**/vitest*.config.*',
      'tsconfig*.json',
      'packages/db/prisma/**',
      'apps/memory/prisma/**',
      // config/app.env is not here: only the factory's tests read it, and CI runs them when it
      // changes. Compose, scripts and CI are the fresh-clone check's.
      'tests/support/**',
    ],
    environment: 'node',
    // The bank's tests start an in-process Postgres per file; on a small laptop running every
    // file at once, starting one can take longer than the 5-second default.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
