#!/usr/bin/env node
// Pack every publishable package and assert the tarball, without publishing
// anything (#129 D12, D13; ADR 0018 as amended by #159).
//
// The thin edge of scripts/lib/npm-packages.mjs: this file runs `pnpm pack`,
// reads what came out, and renders the result as `key=value` lines. Every rule
// lives in the module and is unit-tested.
//
// ── Why a rehearsal exists at all ────────────────────────────────────────────
//
// An npm version number is burned by its first publish and cannot be reused —
// unpublishing inside the 72-hour window frees the bytes and not the name.
// `@actana/sdk@0.2.2` gets exactly one attempt, ever, and a mistake in it is
// not fixable by re-running the release: it is fixable only by burning the next
// version too. Docker Hub has no equivalent property, so nothing in this
// repository's publishing path was built to be rehearsed before now.
//
// So this runs in two places, and the earlier one is the point:
//
//   * on **every pull request**, through `scripts/__tests__/npm-publish.test.mjs`
//     and `pnpm test` — long before any `v0.2.2` tag exists. A packaging
//     mistake is a red pull request, which is a place where mistakes are free.
//   * in **`release.yml`'s publish job**, immediately before `npm publish`, on
//     the tarballs that are then published — so what was asserted and what
//     goes to the registry are the same bytes rather than the same intent.
//
// `pnpm pack` and not `npm pack`, and this is load-bearing: the SDK's working
// `exports` map points at TypeScript source, because inside the workspace it is
// consumed as source and Node strips the types. What npm installs is compiled
// JavaScript, and the two are reconciled by `publishConfig.exports`, which
// **pnpm** applies as it packs and npm does not. `npm pack` here would produce
// a tarball whose every subpath resolves to a `./src/*.ts` file that is not in
// it. The module asserts that too, so this cannot be quietly "simplified".
//
// Usage:
//   node scripts/rehearse-npm-publish.mjs
//   node scripts/rehearse-npm-publish.mjs --out-dir artifacts/npm --version 0.2.2 --npm-dry-run
//
// --out-dir <dir>   where the tarballs land. Default: a fresh temp directory.
// --version <x.y.z> the release being cut; every publishable manifest must
//                   already carry it (D13). Omitted outside a release.
// --npm-dry-run     additionally run `npm publish <tarball> --dry-run`, which
//                   proves npm accepts the tarball spec and the flags. Off by
//                   default so the test that calls this needs no network.
//
// Output, on stdout:
//   tarballs=<path> <path>              the packed tarballs, in publish order
//   packages=@actana/sdk @actana/cli    the names they carry
//   absent=                             intended by D13 and not written yet

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { makeFail, parseArgs, stringFlag } from "./lib/cli.mjs";
import {
  assertMonorepoKeepsTheGuard,
  assertPackedBin,
  assertPackedFiles,
  assertPackedManifest,
  assertPublishSet,
  binTargets,
  discoverPublishable,
  publishOrder,
  workspaceManifests,
} from "./lib/npm-packages.mjs";

const fail = makeFail("rehearse-npm-publish");
const note = (message) => console.error(`[rehearse-npm-publish] ${message}`);

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));
const version = stringFlag(args, "version", fail);
const outDir = path.resolve(
  stringFlag(args, "out-dir", fail) ??
    fs.mkdtempSync(path.join(os.tmpdir(), "actana-npm-rehearsal-")),
);

const run = (command, argv, cwd) =>
  execFileSync(command, argv, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** `@actana/sdk` at 0.2.2 → `actana-sdk-0.2.2.tgz`, the name npm gives a pack. */
const tarballName = (manifest) =>
  `${manifest.name.replace(/^@/, "").replace(/\//g, "-")}-${manifest.version}.tgz`;

/** The `package/`-prefixed paths inside a tarball, and one file read out of it. */
const listEntries = (tarball) =>
  run("tar", ["-tzf", tarball]).split("\n").filter(Boolean).sort();
const readEntry = (tarball, entry) => run("tar", ["-xzOf", tarball, entry]);

fs.mkdirSync(outDir, { recursive: true });

// D12's other half first: the guard the monorepo keeps is the thing the tarball
// must not have, so a repository that had quietly dropped it would make every
// assertion below pass for the wrong reason.
try {
  assertMonorepoKeepsTheGuard(repoRoot);
} catch (error) {
  fail(error.message);
}

// Dependency-first: the CLI depends on the SDK at the version being released,
// and it is published by a loop over this list.
const publishable = publishOrder(discoverPublishable(repoRoot));
let absent = [];
try {
  // The whole workspace, not only what was discovered: a `PUBLISHABLE` package
  // whose manifest exists and carries `private: true` is an error rather than
  // an absence, and the discovered set alone cannot tell the two apart.
  absent = assertPublishSet(publishable, workspaceManifests(repoRoot));
} catch (error) {
  fail(error.message);
}

// Reported, never passed over: the danger of a set discovered from the
// workspace is that "that leg never ran" and "that leg passed" produce the same
// green. Empty today — D13's two packages both exist and both publish.
for (const name of absent) {
  note(
    `${name} is one of D13's packages and has no manifest in packages/ yet. Nothing here has exercised it; ` +
      "it publishes with no further edit the moment a non-private manifest lands.",
  );
}

const tarballs = [];
for (const pkg of publishable) {
  note(`packing ${pkg.name} from ${pkg.relative}`);

  // `pnpm pack` runs `prepack`, which is the build — so the tarball is the
  // current source compiled, never a stale `dist/` from an earlier checkout.
  try {
    run("pnpm", ["pack", "--pack-destination", outDir], pkg.dir);
  } catch (error) {
    fail(`\`pnpm pack\` failed for ${pkg.name}: ${error.stderr || error.message}`);
  }

  const tarball = path.join(outDir, tarballName(pkg.manifest));
  if (!fs.existsSync(tarball)) {
    fail(`\`pnpm pack\` produced no ${path.basename(tarball)} in ${outDir}`);
  }

  try {
    const packed = JSON.parse(readEntry(tarball, "package/package.json"));
    const entries = listEntries(tarball);
    assertPackedManifest(packed, { version });
    assertPackedFiles(packed, entries);
    // The one rule that is about a file's contents rather than its name, so it
    // has to read the file: a linked command without `#!` reaches the shell.
    for (const target of binTargets(packed)) {
      assertPackedBin(packed.name, target, readEntry(tarball, target));
    }
    const shape = packed.exports ? "library" : `command \`${Object.keys(packed.bin).join("`, `")}\``;
    note(
      `${packed.name}@${packed.version} — ${shape}, engines ${packed.engines.node}, ` +
        `${entries.length} files, no install lifecycle, no Node-24 guard.`,
    );
  } catch (error) {
    fail(`${pkg.name}: ${error.message}`);
  }

  if (args["npm-dry-run"]) {
    // The publish command itself, minus the publish. It needs no credentials
    // and proves npm accepts a pnpm-packed tarball under the flags the release
    // passes — the one part of the real invocation a pack cannot cover.
    try {
      run("npm", ["publish", tarball, "--access", "public", "--dry-run"], repoRoot);
      note(`npm publish --dry-run accepted ${path.basename(tarball)}`);
    } catch (error) {
      fail(`\`npm publish --dry-run\` rejected ${path.basename(tarball)}: ${error.stderr || error.message}`);
    }
  }

  tarballs.push(tarball);
}

if (tarballs.length === 0) {
  fail("nothing to publish — no workspace manifest is publishable, which `assertPublishSet` should have caught.");
}

note(`✅ ${tarballs.length} tarball(s) rehearsed in ${outDir}${version ? ` at ${version}` : ""}`);

process.stdout.write(
  [
    `tarballs=${tarballs.join(" ")}`,
    `packages=${publishable.map((pkg) => pkg.name).join(" ")}`,
    `absent=${absent.join(" ")}`,
    "",
  ].join("\n"),
);
