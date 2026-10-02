// CLI build — bundles the `actana` command with esbuild, as CommonJS.
//
//   dist-tarball/actana-cli.cjs
//                         staged into the Core tarball as `app/actana-cli.cjs` by
//                         `scripts/build-core-tarball.mjs`, which `bin/actana` in the tarball
//                         execs on the bundled Node. That script fails the build if the file is
//                         not there, which is the line that keeps this wiring honest.
//
// This package is private (`@actana/core-cli`) and is never published, so there is no ESM bundle
// and no `bin` shim any more: the npm install of `actana` is the client's `@actana/cli`.
//
// The CJS half is CJS because the tarball's tree is: `app/package.json` is `type: commonjs`, and
// `app/core-entry.cjs` — the daemon this bundle `require`s by path for the `daemon` verb — is
// emitted the same way.
//
// `@actana/shared` is INLINED, and that is the whole of #288 D5: ADR 0025 D4 keeps that package
// private so nobody outside this repository can take a dependency on its surface, and **an
// inlined bundle offers no surface to depend on**. `src/__tests__/no-local-escape.test.ts`
// asserts it.
//
// The runtime dependencies stay external and resolve from `app/node_modules` in the tarball:
// `ws` for the socket, `undici` for the file surface's mTLS `fetch` (#167), and `selfsigned` for
// the certificate material `actana setup` mints (#288 C2). `ws` and undici are both CommonJS, and
// undici in particular reaches for `require("node:assert")` down a conditional path that esbuild
// cannot see at build time — bundled, it becomes `Dynamic require of "node:assert" is not
// supported` the first time `actana` runs, which is a failure the build itself reports as a
// success. `selfsigned` is external because the Core's own bundle has always treated it that way
// and the tarball already ships one copy in `app/node_modules`.
import { build } from "esbuild";

const shared = {
  bundle: true,
  platform: "node",
  sourcemap: true,
  logLevel: "info",
  // The three names both bundles import at runtime rather than inlining. Stated
  // as a literal here because `no-local-escape.test.ts` reads this array out of
  // the file and checks every name in it against `package.json`'s
  // `dependencies` — the two drift only at runtime, in a stranger's install.
  external: ["ws", "undici", "selfsigned"],
  entryPoints: ["src/actana-cli-entry.ts"],
};

await build({
  ...shared,
  // The tarball ships its own pinned Node, so this half is free to target what
  // that runtime is — the same target `packages/core/build.mjs` uses for the
  // daemon it sits beside.
  target: "node24",
  format: "cjs",
  outfile: "dist-tarball/actana-cli.cjs",
});
