import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      // Every workspace package is its own project (named after its package.json).
      'engine/*',
      'games/rpg/apps/*',
      'games/rpg/packages/*',
      'games/rpg/tools/*',
      'games/survival-sandbox',
      'spikes/*',
      // Repository-level tests (lint boundary proofs).
      {
        test: {
          name: 'boundaries',
          include: ['tools/boundaries/**/*.test.ts'],
          testTimeout: 30_000,
        },
      },
      // Repository tooling (CI guards).
      { test: { name: 'repo-tools', include: ['tools/golden/**/*.test.ts'] } },
    ],
  },
});
