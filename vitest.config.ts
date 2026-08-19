// Root vitest project — the repo-level build and packaging scripts. Package
// tests live in packages/*/vitest.config.ts; `pnpm test` drives this suite and
// each package's in turn from scripts/run-unit-tests.mjs. `pnpm -r test` is
// gone — it bailed on the first failing package and hid the rest (issue #257),
// and scripts/__tests__/unit-tests.test.mjs asserts it stays gone.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["scripts/**/*.test.mjs"],
  },
});
