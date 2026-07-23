import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

// Scoped to tools/ on purpose: the repo root contains infra/cdk/cdk.out and
// several .tmp-* directories with vendored node_modules, and an unscoped
// vitest run crawls all of them.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    include: ['**/*.test.mjs'],
    exclude: ['**/node_modules/**', '**/fixtures/**'],
  },
});
