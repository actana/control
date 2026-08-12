// CLI build — bundles the `actana` client commands with esbuild.
//
// ESM output, unlike the Core's CJS bundle: this package is `type: module`,
// its only workspace input is `packages/sdk` (which is ESM and written for
// direct Node resolution), and there is no lazy `require()` of a native
// addon anywhere in the client half. `ws` stays external — it is the SDK's
// runtime dependency and resolves from this package's `node_modules`.
//
// `bin/actana.mjs` is the shim npm links as `actana`; it loads the file this
// writes. Two files rather than one because the shim is a *published path* —
// renaming it renames the command's entry point in every already-installed
// copy — while the bundle underneath is free to move.
//
// The compiled `.d.ts` half of #129 D12, the `engines` floor, and the publish
// itself belong to #159. What this exists for is that `actana` is a program
// you can run from a checkout today.
import { build } from "esbuild";

await build({
  bundle: true,
  platform: "node",
  // Node 22, not 24: #129 D12 puts the published floor at `>=22`, and a
  // bundle targeting 24 would emit syntax the floor this package is heading
  // for cannot parse. Declaring that floor is #159's line to write; not
  // foreclosing it is this one's.
  target: "node22",
  format: "esm",
  sourcemap: true,
  logLevel: "info",
  external: ["ws"],
  entryPoints: ["src/actana-cli-entry.ts"],
  outfile: "dist/actana-cli.mjs",
});
