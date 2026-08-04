// Core build — bundles the daemon + the `actana` CLI entries with esbuild.
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

// The `actana` CLI. Deliberately a separate bundle from the daemon: it
// `require`s dist/core-entry.cjs at runtime for the `daemon` verb rather
// than bundling it, so the tarball ships one copy of the Core, not two.
await build({
  ...shared,
  entryPoints: ["src/actana-cli-entry.ts"],
  outfile: "dist/actana-cli.cjs",
});
