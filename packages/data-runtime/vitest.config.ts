import { defineConfig } from 'vitest/config';

/**
 * The bounded-release integration tests exercise real DuckDB databases and real
 * filesystem spill paths. Measured durations sit at 4.2-5.0s against vitest's
 * 5000ms default, so a changing subset of them timed out on every run — a budget
 * problem, not a logic regression. Give this package headroom so the suite is
 * deterministic under machine load.
 */
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
