import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // The suites share one database, so they run one at a time rather than
    // truncating each other's fixtures out from underneath.
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 30_000,
    hookTimeout: 60_000,
    reporters: ["default"],
  },
});
