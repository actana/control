// CLI build — bundles the `actana` command with esbuild. **Twice.**
//
// One program, two doors (#288), so one entry point compiles into two bundles:
//
//   dist/actana-cli.mjs   ESM — what `bin/actana.mjs` loads, and therefore what
//                         `npm i -g @actana/cli` puts on an operator's PATH.
//   dist-tarball/actana-cli.cjs
//                         CJS — staged into the Core tarball as
//                         `app/actana-cli.cjs` by `scripts/build-core-tarball.mjs`,
//                         which `bin/actana` in the tarball execs on the bundled
//                         Node. That script fails the build if the file is not
//                         there, which is the line that keeps this wiring honest.
//
// **Outside `dist/`, and that is the point of the second directory.** This
// package's `files` field is `["dist", "bin"]`, so anything under `dist/` is
// published — and a second, differently-formatted copy of the same program in
// the npm tarball is bytes every installer downloads and nothing runs.
// `scripts/lib/npm-packages.mjs` enforces that from the other side: it fails
// the publish rehearsal on any packed file that is not the ESM bundle and its
// paperwork.
//
// The CJS half is CJS because the tarball's tree is: `app/package.json` is
// `type: commonjs`, and `app/core-entry.cjs` — the daemon this bundle
// `require`s by path for the `daemon` verb — is emitted the same way. It used
// to be built by `packages/core/build.mjs` from `packages/core/src`; the source
// moved here and the bundle followed it.
//
// `@actana/shared` is INLINED into both, and that is the whole of #288 D5:
// ADR 0025 D4 keeps that package private so nobody outside this repository can
// take a dependency on its surface, and **an inlined bundle offers no surface
// to depend on** — no manifest, no version, no resolvable specifier. Marking it
// external would turn a bundle into a dependency and break a stranger's global
// install. `src/__tests__/no-local-escape.test.ts` asserts both halves of that.
//
// The runtime dependencies stay external and resolve from this package's
// `node_modules` (or, in the tarball, from `app/node_modules`): `ws` for the
// socket, `undici` for the file surface's mTLS `fetch` (#167), and `selfsigned`
// for the certificate material `actana setup` mints (#288 C2).
//
// External is not a preference for any of the three. `ws` and undici are both
// CommonJS, and undici in particular reaches for `require("node:assert")` down
// a conditional path that esbuild cannot see at build time — bundled, it
// becomes `Dynamic require of "node:assert" is not supported` the first time
// `actana` runs, which is a failure the build itself reports as a success.
// `scripts/__tests__/npm-publish.test.mjs` catches it by packing the tarball
// and running the binary, which is how it was found. `selfsigned` is external
// because the Core's own bundle has always treated it that way and the tarball
// already ships one copy in `app/node_modules`.
//
// `bin/actana.mjs` is the shim npm links as `actana`; it loads the ESM file
// this writes. Two files rather than one because the shim is a *published
// path* — renaming it renames the command's entry point in every
// already-installed copy — while the bundle underneath is free to move.
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
  // Node 22, not 24: #129 D12 puts the published floor at `>=22`, and a bundle
  // targeting 24 would emit syntax the floor this package declares cannot
  // parse.
  target: "node22",
  format: "esm",
  outfile: "dist/actana-cli.mjs",
});

await build({
  ...shared,
  // The tarball ships its own pinned Node, so this half is free to target what
  // that runtime is — the same target `packages/core/build.mjs` uses for the
  // daemon it sits beside.
  target: "node24",
  format: "cjs",
  outfile: "dist-tarball/actana-cli.cjs",
});
