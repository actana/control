// Core build — bundles the daemon. Just the daemon, since #288.
//
// CJS output on purpose: the source tree is written for CommonJS emit (lazy
// require() of node-pty with try/catch fallbacks), and plain
// `node dist/core-entry.cjs` runs it on the standard Node ABI. Native and
// runtime deps stay external and resolve from this package's node_modules;
// workspace TS (../shared/src) is bundled in.
import { build } from "esbuild";

const shared = {
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  sourcemap: true,
  logLevel: "info",
  external: [
    "better-sqlite3",
    "node-pty",
    "ws",
    "selfsigned",
  ],
};

await build({
  ...shared,
  entryPoints: ["src/core-entry.ts"],
  outfile: "dist/core-entry.cjs",
});

// **No second bundle here.** `dist/actana-cli.cjs` used to be emitted from this
// package too, because the operator CLI lived in `packages/core/src`. It does
// not any more: `packages/cli` owns the whole `actana` command and emits both
// the published ESM bundle and the tarball's CJS one (#288 D1). This package is
// the daemon and nothing else, and `scripts/build-core-tarball.mjs` stages the
// CLI from `packages/cli/dist`.
