import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'sim-tests',
    include: ['src/**/*.test.ts'],
    environment: 'node',
    testTimeout: 120_000,
  },
});
