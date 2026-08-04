import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
  resolve: {
    alias: {
      // Same mapping as tsconfig's `paths` — Core reaches shared by package
      // name (ADR 0016 D3), and vitest needs telling where that lives.
      "@actana/shared": path.resolve(__dirname, "../shared/src"),
    },
  },
});
