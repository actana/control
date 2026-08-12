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
    },
  },
});
