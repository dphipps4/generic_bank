import { defineConfig } from 'vitest/config';
import base from './vitest.config.js';

// The long suite: runs that sit through the banks' real hazards for minutes. CI runs it on every
// merge to master; just test-long runs it here.
export default defineConfig({
  ...base,
  test: { ...base.test, include: ['tests/long/**/*.test.ts'], exclude: ['**/node_modules/**'] },
});
