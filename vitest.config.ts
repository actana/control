// Root vitest project — the repo-level build and packaging scripts. Package
// tests live in packages/*/vitest.config.ts and run via `pnpm -r test`.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["scripts/**/*.test.mjs"],
  },
});
