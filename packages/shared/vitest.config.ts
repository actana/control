import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
  resolve: {
    alias: {
      // Same mapping as tsconfig's `paths` — the core-link frames live in
      // `@actana/sdk` (ADR 0025), and vitest needs telling where that is.
      "@actana/sdk": path.resolve(__dirname, "../sdk/src"),
    },
  },
});
