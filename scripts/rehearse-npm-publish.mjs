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
// ── Two modes, and only one of them is a rehearsal for a publish ─────────────
//
// **`--beta <x.y.z>`** packs the same CLI as a Release *asset* and publishes
// nothing at all. ADR 0036 D15 drops the registry from the beta path outright:
// a beta version string is `x.y.z-beta` with no counter (C1), a beta is cut
// repeatedly as the train moves, and the second cut of the same string is a 403
// from a registry that has already burned it — see the paragraph above, which
// is the same fact from the other end. So `@actana/cli` is packed and attached
// to the `v<x.y.z>-beta` prerelease and installed with `npm i -g <asset-url>`
// (D16), and the version namespace is never touched. `rehearseBeta` below
// carries the route, the one dependency question it has to answer, and why the
// answer is the one it is.
//
// Everything else is shared, and deliberately: a beta asset is installed by the
// same `npm i -g` onto the same operator's machine, so it is asserted by the
// same module. The only rules that differ are the two `beta: true` narrows.
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
//   node scripts/rehearse-npm-publish.mjs --beta 0.4.1 --out-dir artifacts/beta --install-check
//
// --out-dir <dir>   where the tarballs land. Default: a fresh temp directory.
// --version <x.y.z> the release being cut; every publishable manifest must
//                   already carry it (D13). Omitted outside a release.
// --npm-dry-run     additionally run `npm publish <tarball> --dry-run`, which
//                   proves npm accepts the tarball spec and the flags. Off by
//                   default so the test that calls this needs no network.
// --beta <x.y.z>    the beta mode: pack `@actana/cli` alone, at `<x.y.z>-beta`,
//                   as the asset ADR 0036 D16 attaches to the prerelease.
//                   Publishes nothing and rehearses no publish. The line is
//                   `x.y.z`; the `-beta` is appended here and carries no
//                   counter, because C1 does not have one to carry.
// --install-check   with `--beta`, actually run `npm i -g <the tarball>` into a
//                   fresh prefix under an empty HOME and ask the installed
//                   `actana` for its version. Needs the public registry. This
//                   is #320's acceptance criterion, run rather than assumed.
//
// Output, on stdout:
//   tarballs=<path> <path>              the packed tarballs, in publish order
//   packages=@actana/sdk @actana/cli    the names they carry
//   absent=                             intended by D13 and not written yet
//
// and, under `--beta`, additionally:
//   asset=actana-cli-0.4.1-beta.tgz     the Release asset's filename
//   version=0.4.1-beta                  what C1 fixes, on every surface
//   sha256=<hex>                        the row #318's SHA256SUMS carries
//   install=ok                          only with `--install-check`

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { makeFail, parseArgs, stringFlag } from "./lib/cli.mjs";
import {
  assertBundleInlines,
  assertMonorepoKeepsTheGuard,
  assertPackedBin,
  assertPackedFiles,
  assertPackedManifest,
  assertPublishSet,
  betaVersion,
  binTargets,
  discoverPublishable,
  externalNames,
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

/**
 * The same read, with room for a bundle.
 *
 * `run` takes `execFileSync`'s default `maxBuffer`, which is 1 MiB, and every
 * entry the release path reads — a manifest, a `bin/` shim — is far under it.
 * The beta path reads `dist/actana-cli.mjs`, which is past 1 MiB today because
 * it has the SDK and `@actana/shared` inlined into it — the very property
 * `assertBundleInlines` is being asked to confirm. So the check that exists
 * because the bundle is large was the one call that could not read it, and it
 * failed as `spawnSync tar ENOBUFS` rather than as anything about packaging.
 */
const readBundleEntry = (tarball, entry) =>
  execFileSync("tar", ["-xzOf", tarball, entry], {
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });

/** The one package the beta path ships, and the one dependency it has to lose. */
const BETA_PACKAGE = "@actana/cli";
const INLINED_SIBLING = "@actana/sdk";

/**
 * A refusal raised from inside the beta pack's `try`, so that the `finally`
 * restores the manifest before anything exits.
 *
 * It exists because `fail` is `process.exit(1)` (`lib/cli.mjs`), and
 * `process.exit` inside a `try` **skips the `finally` outright** — the restore
 * never runs, and the working tree is left carrying `x.y.z-beta` with the SDK
 * dropped. That is precisely the state this function exists to prevent, and it
 * would be committed by the next person to `git add -A` in that checkout. So
 * nothing between the manifest edit and the restore may call `fail`: a refusal
 * throws, the `catch` records the message, the `finally` puts the bytes back,
 * and only then does the process exit.
 */
class BetaPackRefused extends Error {}

fs.mkdirSync(outDir, { recursive: true });

// The beta mode is a different artifact for a different channel, so it takes
// the whole script rather than adding a branch to every step below. Nothing
// under it publishes, rehearses a publish, or touches a registry.
const betaLine = stringFlag(args, "beta", fail);
if (betaLine !== undefined) {
  rehearseBeta(betaLine);
  process.exit(0);
}

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


/**
 * Pack the CLI as a beta Release asset and assert it — the whole of #320's
 * route, and it publishes nothing.
 *
 * ── Which of #320's three routes this is, and why ────────────────────────────
 *
 * The route is fixed by the operator and by ADR 0036 D16 and is not reopened
 * here: the CLI is **packed and attached to the `v<x.y.z>-beta` prerelease as
 * an asset**, installed with `npm i -g <asset-url>`, and **never published to
 * registry.npmjs.org under a beta version**. D15 gives the reason in one line —
 * an npm version is burned by its first publish (see this file's own header),
 * a beta string carries no counter (C1), and a beta is designed to be cut
 * repeatedly, so the second cut of `0.4.1-beta` would 403 after the tag has
 * moved and every asset has been replaced.
 *
 * What that route leaves open is one question, and #320 lists three answers.
 * `@actana/cli` declares `"@actana/sdk": "workspace:*"`; pnpm resolves it to a
 * real version as it packs; under D15 that version is on no registry, so
 * `npm i -g <asset-url>` would fail resolving it. **This is route 2: the beta
 * manifest drops the dependency**, because `packages/cli/build.mjs` marks only
 * `ws`, `undici` and `selfsigned` external and therefore inlines the SDK into
 * the bundle already.
 *
 * Route 2 rather than route 1 (attach the SDK tarball too and point the CLI's
 * range at its asset URL) for a reason that is about the acceptance criterion
 * rather than about elegance. #320 asks that `npm i -g <asset-url>` be
 * **asserted in CI, not assumed** — *"that assertion is the whole ticket"*. A
 * URL range can only be asserted once the Release exists to serve it, so on a
 * pull request the check would have to install from a `file:` URL and hope the
 * `https:` one behaves the same. Route 2's tarball resolves nothing that is
 * not on the public registry, so the bytes CI installs are the bytes the
 * operator installs, and `--install-check` below runs that install for real.
 * Route 3 (attach both and document a two-step install) is refused
 * deliberately: it is honest and it is worse for the operator, which is
 * exactly how #320 lists it.
 *
 * The cost route 2 carries, stated rather than hidden: the beta manifest's
 * dependency set differs from the release manifest's by one name, which is the
 * kind of divergence the packing guards exist to catch. So it is not left to a
 * convention — `assertPackedManifest`'s `beta` branch *requires* the absence,
 * refusing `@actana/sdk` at any range at all, and `assertBundleInlines` reads
 * the packed bundle to confirm the code the manifest stopped naming is in the
 * tarball. A future `build.mjs` that externalised the SDK would fail here, on
 * the artifact, rather than in a stranger's install.
 *
 * The release side is not this module's mirror image, and saying so plainly is
 * worth a sentence: `assertPackedManifest` only validates a dependency that is
 * *present*, so it refuses a release CLI pinned to another train's SDK and has
 * nothing to say about a release manifest that dropped the SDK entirely. That
 * one is held by `packages/cli/src/__tests__/no-local-escape.test.ts`, which
 * pins the working-tree manifest to exactly four names on every pull request —
 * and the release packs from that working tree, while the edit below is made
 * only here and never committed.
 *
 * ── The manifest edit, and why it is never committed ─────────────────────────
 *
 * Both edits — the version and the dropped dependency — happen to the manifest
 * **in this checkout** and are restored in a `finally` before anything else
 * runs. ADR 0023 D3 is why: the train's six manifests carry `x.y.z`, and
 * `ci.yml`'s `Train rules` job asserts them on every pull request into the
 * train. A committed `0.4.1-beta` would fail that job, and a committed
 * dependency drop would fail `no-local-escape.test.ts`'s pin on the CLI's
 * dependency set — which is the pin doing its job, because on the *release*
 * path that dependency has to be there.
 *
 * This also fixes an ordering the caller cannot see: `pnpm install` runs
 * **before** this, because dropping the dependency from the manifest does not
 * remove the `node_modules` link esbuild resolves the SDK's source through. A
 * beta packed in a checkout that had never been installed would fail in the
 * build, loudly, which is the right way round.
 */
function rehearseBeta(line) {
  // C1, at the first opportunity: a line is `x.y.z` and the beta of it is
  // `x.y.z-beta`. There is no counter to pass in and nowhere to put one.
  let betaString;
  try {
    betaString = betaVersion(line);
  } catch (error) {
    fail(error.message);
  }

  const cli = discoverPublishable(repoRoot).find((pkg) => pkg.name === BETA_PACKAGE);
  if (cli === undefined) {
    fail(
      `${BETA_PACKAGE} is not a publishable workspace package, so there is nothing to pack for a beta. The beta ` +
        "asset is the same artifact a release publishes, minus the registry — if this package has gone private or " +
        "gone missing, the beta path is broken in the same way the release path is.",
    );
  }

  // Asserted before the manifest is touched rather than after the pack: the
  // dependency is only droppable because the bundle carries the SDK's code,
  // and `build.mjs`'s `external` array is where that stops being true first.
  const externals = externalNames(fs.readFileSync(path.join(cli.dir, "build.mjs"), "utf8"));
  if (externals.includes(INLINED_SIBLING)) {
    fail(
      `packages/cli/build.mjs marks ${INLINED_SIBLING} external, so the bundle imports it at runtime. The beta ` +
        `manifest drops that dependency on the grounds that it is inlined (ADR 0036 D16), and dropping an external ` +
        "one publishes an asset whose `npm i -g` fails on a version no registry has. Fix the external array or " +
        "re-decide the route with the owner.",
    );
  }
  note(`${INLINED_SIBLING} is not external in build.mjs — externals are ${externals.join(", ")}`);

  // The line the caller named against the line this checkout actually is. The
  // beta workflow's one input is the train branch (`beta/0.4.1`), and `x.y.z`
  // comes out of that name — while the manifests carry the line because the
  // cut wrote it there (ADR 0023 D3). Those are two independent statements of
  // one fact, and a beta cut from the wrong branch, or from a train whose
  // manifests were never stamped, is exactly where they come apart. Silently
  // trusting the flag would attach `actana-cli-0.4.1-beta.tgz` to a checkout of
  // the 0.4.2 line, which installs perfectly and is the wrong program.
  if (cli.manifest.version !== line) {
    fail(
      `--beta names the ${line} line and ${cli.relative} carries ${cli.manifest.version}. The train's manifests are ` +
        "stamped with the line by the cut (ADR 0023 D3) and the beta is named after the branch, so these disagreeing " +
        "means one of the two is not the train you think it is. Nothing is packed until they agree.",
    );
  }

  const manifestPath = path.join(cli.dir, "package.json");
  // The original bytes, restored verbatim. Not a re-serialisation: a `finally`
  // that reformats the file is a `finally` that leaves a diff behind.
  const original = fs.readFileSync(manifestPath);
  const tarball = path.join(outDir, tarballName({ name: cli.name, version: betaString }));

  // Nothing inside this block calls `fail`. See `BetaPackRefused`: `fail` is
  // `process.exit`, and an exit here would step straight over the `finally`
  // that puts the manifest back. The message is carried out instead.
  let refusal;
  try {
    const manifest = JSON.parse(original.toString("utf8"));
    manifest.version = betaString;
    if (manifest.dependencies?.[INLINED_SIBLING] === undefined) {
      throw new BetaPackRefused(
        `${BETA_PACKAGE} does not depend on ${INLINED_SIBLING} in the working tree, so there is nothing for the ` +
          "beta path to drop. Either the dependency moved and this narrowing is stale, or the manifest lost it on " +
          "the release path too — and the release path needs it.",
      );
    }
    delete manifest.dependencies[INLINED_SIBLING];
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    note(`packing ${cli.name} at ${betaString}, without ${INLINED_SIBLING} (ADR 0036 D16, route 2)`);
    // `pnpm pack`, not `npm pack`, for the reason this file's header gives —
    // and here it is also what rewrites nothing: the dependency is gone from
    // the manifest, so there is no `workspace:` protocol left to resolve.
    run("pnpm", ["pack", "--pack-destination", outDir], cli.dir);
  } catch (error) {
    refusal =
      error instanceof BetaPackRefused
        ? error.message
        : `\`pnpm pack\` failed for ${cli.name} at ${betaString}: ${error.stderr || error.message}`;
  } finally {
    // Every path out of the `try` comes through here, which is the whole point:
    // a pack that failed — `pnpm` not on PATH, a build error, a full disk — must
    // leave the checkout exactly as it found it. The original bytes, not a
    // re-serialisation, so `keywords` and every other array keep their shape.
    fs.writeFileSync(manifestPath, original);
  }
  if (refusal !== undefined) fail(refusal);

  if (!fs.existsSync(tarball)) {
    fail(`\`pnpm pack\` produced no ${path.basename(tarball)} in ${outDir}`);
  }

  // C1 on the filename, which is the surface an operator actually reads: the
  // asset is `actana-cli-<x.y.z>-beta.tgz` and the URL it hangs off is
  // `.../releases/download/v<x.y.z>-beta/`. pnpm names a tarball after the
  // manifest, so this is really a second reading of the version — asserted
  // anyway, because the filename is what gets pasted into an install command.
  const asset = path.basename(tarball);
  if (asset !== `actana-cli-${betaString}.tgz`) {
    fail(`the packed asset is named ${asset}, not actana-cli-${betaString}.tgz (ADR 0036 C1).`);
  }

  try {
    const packed = JSON.parse(readEntry(tarball, "package/package.json"));
    const entries = listEntries(tarball);
    assertPackedManifest(packed, { version: betaString, beta: true });
    assertPackedFiles(packed, entries);
    for (const target of binTargets(packed)) {
      assertPackedBin(packed.name, target, readEntry(tarball, target));
    }
    // The assertion the dropped dependency rests on, read off the shipped
    // bundle rather than off the config that produced it.
    assertBundleInlines(
      packed.name,
      readBundleEntry(tarball, "package/dist/actana-cli.mjs"),
      INLINED_SIBLING,
    );
    note(
      `${packed.name}@${packed.version} — command \`${Object.keys(packed.bin).join("`, `")}\`, engines ` +
        `${packed.engines.node}, ${entries.length} files, dependencies ` +
        `${Object.keys(packed.dependencies ?? {}).join(" ")}, ${INLINED_SIBLING} inlined not imported.`,
    );
  } catch (error) {
    fail(`${cli.name}: ${error.message}`);
  }

  const digest = createHash("sha256").update(fs.readFileSync(tarball)).digest("hex");

  const installed = args["install-check"] === true;
  if (installed) installCheck(tarball, betaString);

  note(`✅ beta asset rehearsed in ${outDir} at ${betaString}`);

  // `writeSync`, not `process.stdout.write`: this path exits immediately after,
  // and a write to a pipe is not guaranteed to have flushed by then.
  fs.writeSync(
    1,
    [
      `tarballs=${tarball}`,
      `packages=${cli.name}`,
      `asset=${asset}`,
      `version=${betaString}`,
      `sha256=${digest}`,
      `absent=`,
      // Emitted only when the install actually ran, never as a default: a
      // caller that greps for this line must not find it on a run that skipped
      // the one assertion #320 calls the whole ticket.
      ...(installed ? ["install=ok"] : []),
      "",
    ].join("\n"),
  );
}

/**
 * The acceptance criterion, run rather than reasoned about: `npm i -g <the
 * tarball>` on a machine with nothing installed, and the `actana` that lands on
 * `PATH` answers with the beta version.
 *
 * It is the packed bytes and the public registry and nothing else. The prefix
 * and the home are both fresh temporary directories, and the environment is
 * built from nothing rather than spread from `process.env` — for the reason
 * `npm-publish.test.mjs` gives about a CI runner that is itself a container
 * Core, and because a machine with a Core installed under it would answer
 * `--version` with a second line about that install (ADR 0032 D10).
 *
 * `PATH` carries `node`, which the shim's `#!/usr/bin/env node` needs, and
 * nothing carries a registry override: this must resolve `ws`, `undici` and
 * `selfsigned` from registry.npmjs.org exactly as an operator's machine does,
 * and must resolve nothing else. `@actana/sdk` not being in that list is the
 * whole point — it is in the bundle.
 *
 * **Two commands, not one.** `--version` proves the shim resolved, the bundle
 * loaded and every external in the manifest was there — a dropped `@actana/sdk`
 * that was *not* inlined would be `ERR_MODULE_NOT_FOUND` before a byte is
 * printed. What it does not prove is that a **client noun** dispatches, and the
 * client nouns are the entire reason this install surface exists: the machine
 * this asset is for drives Cores it does not host. So `actana core ls` is run
 * too — the registry read, no dialling — on a machine with nothing registered,
 * which is every machine a fresh `npm i -g` lands on. It is the shape of check
 * that was made by hand while this was written; made by hand it proves nothing
 * on anyone else's run, so it is made here.
 */
function installCheck(tarball, betaString) {
  const prefix = fs.mkdtempSync(path.join(os.tmpdir(), "actana-beta-prefix-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "actana-beta-home-"));
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
  };
  // As in `rehearseBeta`, nothing between here and the `finally` calls `fail`:
  // `fail` is `process.exit`, and an exit inside the `try` would step over the
  // cleanup and leave two temporary trees — one of them a whole global npm
  // prefix — behind on every failed run.
  let refusal;
  const asked = (command, argv) =>
    execFileSync(command, argv, { cwd: home, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  try {
    note(`installing ${path.basename(tarball)} with \`npm i -g\` into a clean prefix`);
    asked("npm", ["install", "-g", "--prefix", prefix, tarball]);

    const command = path.join(prefix, "bin", "actana");
    if (!fs.existsSync(command)) {
      throw new BetaPackRefused(
        `\`npm i -g\` installed ${path.basename(tarball)} and put no \`actana\` in ${prefix}/bin.`,
      );
    }

    const reported = asked(command, ["--version"]).trim();
    if (reported !== `actana ${betaString}`) {
      throw new BetaPackRefused(`the installed command answers \`${reported}\`, not \`actana ${betaString}\`.`);
    }

    // The client noun. `core ls` reads this machine's registry and dials
    // nothing, so it is the one verb that answers the same way on every clean
    // machine — and answering at all means the client half of the program
    // dispatched out of a bundle whose manifest no longer names the SDK.
    const listed = asked(command, ["core", "ls"]).trim();
    if (!listed.includes("No Cores registered")) {
      throw new BetaPackRefused(
        `\`actana core ls\` on a machine with nothing registered answered \`${listed}\`. The client nouns are what ` +
          "this install surface exists for, so one of them running is part of the criterion rather than a bonus.",
      );
    }

    note(`✅ \`npm i -g\` → ${command} → ${reported}`);
    note(`✅ \`actana core ls\` → ${listed}`);
  } catch (error) {
    refusal =
      error instanceof BetaPackRefused
        ? error.message
        : `\`npm i -g\` on ${path.basename(tarball)} failed: ${error.stderr || error.message}. This is #320's whole ` +
          "acceptance criterion — a beta asset that does not install is a URL nobody has run.";
  } finally {
    fs.rmSync(prefix, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
  if (refusal !== undefined) fail(refusal);
}
