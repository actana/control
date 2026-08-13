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
      // Test-only, and deliberately not a dependency (ADR 0025 D4): a manifest
      // entry would put a private package and a daemon in the published CLI's
      // graph for the sake of a test.
      //
      // What imports it is `src/__tests__/in-process-core.test.ts`, which boots
      // the Core's real `PtyCoreLinkServer` over a real `wss://` port so that
      // `core status` reaching a real Core — the ticket's criterion, and the
      // only use this package makes of a socket — is covered on every `pnpm
      // test` rather than only when somebody sets `ACTANA_CORE_BLOB`.
      // `live-core.test.ts` still covers the operator's own Core; this covers
      // the claim without one.
      "@actana/core": path.resolve(import.meta.dirname, "../core/src"),
      "@actana/shared": path.resolve(import.meta.dirname, "../shared/src"),
    },
  },
});
