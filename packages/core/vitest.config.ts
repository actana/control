import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
  resolve: {
    alias: {
      // Same mapping as tsconfig's `paths` — Core reaches its siblings by
      // package name (ADR 0016 D3), and vitest needs telling where they live.
      // The core-link frames are in `@actana/sdk` (ADR 0025).
      "@actana/sdk": path.resolve(__dirname, "../sdk/src"),
      "@actana/shared": path.resolve(__dirname, "../shared/src"),
      // This package, by its own name. Only the shared listing contract
      // (#218) needs it: that spec is written for both suites, so it reaches
      // the file routes the way the SDK's suite reaches them rather than by a
      // relative path that would only resolve from one of the two.
      "@actana/core": path.resolve(__dirname, "src"),
    },
  },
});
