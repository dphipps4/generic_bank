import { defineConfig } from 'vitest/config';
import base from './vitest.config.js';

// The evidence walks: run on their own, one scenario at a time (WALK=<name> npx vitest run -c
// vitest.evidence.config.ts), never as part of the suite. Each one walks a bank through its web UI
// and keeps a masked frame of every page.
export default defineConfig({
  resolve: base.resolve,
  test: { include: ['tests/evidence/**/*.walk.ts'], testTimeout: 600_000 },
});
