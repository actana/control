import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    // `.tsx` too: a component whose whole point is what it renders is best
    // tested by rendering it.
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
  resolve: {
    alias: {
      "~": path.resolve(__dirname, "./src"),
      "@actana/sdk": path.resolve(__dirname, "../sdk/src"),
      "@actana/shared": path.resolve(__dirname, "../shared/src"),
      // Test-only: the core-link suites drive the Panel's client against the
      // real Core server rather than a hand-rolled stand-in.
      "@actana/core": path.resolve(__dirname, "../core/src"),
    },
  },
});
