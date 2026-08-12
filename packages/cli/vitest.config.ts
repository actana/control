import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
  resolve: {
    alias: {
      // The same mapping as `tsconfig.json`'s `paths`, stated again because the
      // type checker and the test runner resolve independently — the SDK is a
      // real dependency of this package, and it is consumed from source in the
      // workspace exactly as the Panel and the Core consume it.
      "@actana/sdk": path.resolve(import.meta.dirname, "../sdk/src"),
      // Test-only, and deliberately not a dependency (ADR 0025 D4): the live
      // suites drive the real Core server, and the Core depends on the SDK this
      // package depends on. A manifest entry would put a private package and a
      // daemon in the published CLI's graph for the sake of a test.
      "@actana/core": path.resolve(import.meta.dirname, "../core/src"),
      "@actana/shared": path.resolve(import.meta.dirname, "../shared/src"),
    },
  },
});
