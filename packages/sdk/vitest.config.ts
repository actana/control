import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
  resolve: {
    alias: {
      // Test-only, and deliberately not a dependency: the Core client suites
      // drive the real Core server rather than a hand-rolled stand-in, and the
      // Core depends on this package (ADR 0025 D2) — a manifest entry pointing
      // back would be a cycle in the published graph for the sake of a test.
      // The Panel's own core-link suites resolve the Core the same way.
      "@actana/core": path.resolve(import.meta.dirname, "../core/src"),
      "@actana/shared": path.resolve(import.meta.dirname, "../shared/src"),
    },
  },
});
