import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["acceptance/**/*.test.ts"],
    setupFiles: ["./vitest.setup.ts"],
    fileParallelism: false,
    pool: "forks",
    maxWorkers: 1,
  },
});
