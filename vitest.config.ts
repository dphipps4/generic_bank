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
    environment: 'node',
    // The bank's tests start an in-process Postgres per file; on a small laptop running every
    // file at once, starting one can take longer than the 5-second default.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
