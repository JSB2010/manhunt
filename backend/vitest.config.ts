import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Integration/security suites share the Firebase emulators; run files serially.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    include: ['tests/**/*.test.ts'],
  },
});
