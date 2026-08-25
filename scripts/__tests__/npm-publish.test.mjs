// The first npm publish this repository has ever done, asserted before it
// happens (#129 D12, D13; #159; ADR 0018 as amended).
//
// An npm version number is burned by its first publish. Unpublishing inside the
// 72-hour window frees the bytes and not the name, so `@actana/sdk@0.2.2` gets
// one attempt and a mistake in it costs the next version number too. Every
// other publishing surface in this repository is a container tag, which is
// re-pushable by comparison — the release workflow's whole design rests on
// digests being re-pointable, and none of that transfers.
//
// So the checks run here, on every pull request, before a tag exists. Two
// layers:
//
//   * the rules, as pure functions over a manifest and a file list, exercised
//     with the manifests that would be wrong. This is where a rule is
//     *falsifiable* — the packing test below cannot show that a `preinstall`
//     would be caught, only that today's package has none.
//   * the real thing: `scripts/rehearse-npm-publish.mjs` packs `@actana/sdk`
//     with `pnpm pack` and asserts the tarball that comes out. #159 asks that
//     `scripts/require-node-24.mjs` "cannot reach a published tarball" be
//     **asserted, not arranged**, and this is the assertion: the file list of
//     the artifact, not a reading of the `files` field that produced it.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  BETA_VERSION,
  MONOREPO_ENGINES,
  NODE_GUARD,
  PUBLISHABLE,
  PUBLISHED_ENGINES,
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
} from "../lib/npm-packages.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");

const repository = (directory) => ({
  type: "git",
  url: "git+https://github.com/actana/control.git",
  directory,
});

/**
 * A **library** manifest as it comes out of a pack: everything D12 and D13
 * want, and nothing else. `@actana/sdk`'s shape.
 */
const packed = (overrides = {}) => ({
  name: "@actana/sdk",
  version: "0.2.2",
  engines: { node: PUBLISHED_ENGINES },
  exports: { "./*": { types: "./dist/*.d.ts", default: "./dist/*.js" } },
  repository: repository("packages/sdk"),
  publishConfig: { access: "public", provenance: true },
  scripts: { build: "tsc -p tsconfig.build.json" },
  ...overrides,
});

/**
 * The other kind: a **command**. `@actana/cli`'s shape — a `bin` map, an
 * esbuild bundle, no `exports` and no types, because nothing imports a
 * program. Every rule that is not about being imported still applies to it.
 */
const packedCommand = (overrides = {}) => ({
  name: "@actana/cli",
  version: "0.2.2",
  engines: { node: PUBLISHED_ENGINES },
  bin: { actana: "bin/actana.mjs" },
  repository: repository("packages/cli"),
  publishConfig: { access: "public", provenance: true },
  scripts: { build: "node build.mjs" },
  dependencies: { "@actana/sdk": "0.2.2", ws: "8.21.0" },
  ...overrides,
});

const files = (...extra) => [
  "package/package.json",
  "package/LICENSE",
  "package/dist/core-client.js",
  "package/dist/core-client.d.ts",
  ...extra,
];

const commandFiles = (...extra) => [
  "package/package.json",
  "package/LICENSE",
  "package/README.md",
  "package/bin/actana.mjs",
  "package/dist/actana-cli.mjs",
  "package/dist/actana-cli.mjs.map",
  ...extra,
];

/** A workspace package as `workspaceManifests` reports it. */
const workspace = (name, { private: isPrivate = false } = {}) => ({
  name,
  dir: `/repo/packages/${name.split("/")[1]}`,
  relative: `packages/${name.split("/")[1]}/package.json`,
  manifest: { name, ...(isPrivate ? { private: true } : {}) },
});

describe("what this repository publishes to npm (#129 D13)", () => {
  it("is @actana/sdk and @actana/cli — both of them, and nothing else", () => {
    expect(PUBLISHABLE).toEqual(["@actana/sdk", "@actana/cli"]);
    const found = discoverPublishable(repoRoot);
    // Both, not a superset check: #159's first acceptance clause is that *both*
    // packages publish, and the way it was nearly missed is that a set which
    // happens to contain the SDK satisfies every weaker assertion.
    expect(found.map((pkg) => pkg.name).sort()).toEqual([...PUBLISHABLE].sort());
    // Nothing is merely intended any more: the whole set exists and publishes.
    expect(assertPublishSet(found, workspaceManifests(repoRoot))).toEqual([]);
  });

  // The seam between #157 and #159, and the reason it needed its own error.
  // #157 landed `packages/cli` with `private: true` saying #159 would flip it;
  // to a rule that only looks at what it discovered, that is indistinguishable
  // from a package nobody has written — one is a release waiting on a ticket,
  // the other is a release that publishes half of what its own docs claim and
  // goes green.
  it("refuses a package that exists, is meant to publish, and is held private", () => {
    const all = [workspace("@actana/sdk"), workspace("@actana/cli", { private: true })];
    const found = all.filter((pkg) => pkg.manifest.private !== true);
    expect(() => assertPublishSet(found, all)).toThrow(/@actana\/cli has a manifest .* and carries/s);
    expect(() => assertPublishSet(found, all)).toThrow(/not the same thing as a package that has not been written/);
  });

  // The absence that is still allowed, and is reported rather than thrown: a
  // name in PUBLISHABLE with no manifest anywhere in the workspace.
  it("allows an intended package that has not been written, and names it", () => {
    const all = [workspace("@actana/sdk")];
    expect(assertPublishSet(all, all)).toEqual(["@actana/cli"]);
  });

  // The CLI depends on the SDK at exactly the version being released, and the
  // release publishes this list in order. Alphabetically the CLI comes first,
  // which would put a package on the registry whose dependency is not there —
  // permanently, if the second publish then fails.
  it("publishes a package after the one it depends on", () => {
    const sdk = { ...workspace("@actana/sdk"), manifest: { name: "@actana/sdk" } };
    const cli = {
      ...workspace("@actana/cli"),
      manifest: { name: "@actana/cli", dependencies: { "@actana/sdk": "0.2.2" } },
    };
    expect(publishOrder([cli, sdk]).map((pkg) => pkg.name)).toEqual(["@actana/sdk", "@actana/cli"]);
    expect(publishOrder(discoverPublishable(repoRoot)).map((pkg) => pkg.name)).toEqual([
      "@actana/sdk",
      "@actana/cli",
    ]);
  });

  // The Panel is a web service and the Core is a daemon. Neither is an npm
  // package, and the only thing standing between them and a public registry is
  // one line in a manifest — which is exactly the kind of line that gets
  // deleted while tidying something else.
  it("keeps every other workspace package private", () => {
    const publishable = new Set(discoverPublishable(repoRoot).map((pkg) => pkg.name));
    for (const pkg of workspaceManifests(repoRoot)) {
      if (PUBLISHABLE.includes(pkg.name)) continue;
      expect(publishable.has(pkg.name), `${pkg.relative} would be published`).toBe(false);
    }
  });

  it("refuses a package that quietly became publishable", () => {
    const found = [workspace("@actana/sdk"), workspace("@actana/panel")];
    expect(() => assertPublishSet(found, found)).toThrow(/@actana\/panel would be published/);
  });

  // The opposite direction, and the reason it is an error rather than a skip: a
  // release that publishes nothing reports the same green as one that
  // published, and the first anyone would hear of it is an `npm i` that 404s.
  it("refuses a release that would publish nothing", () => {
    expect(() => assertPublishSet([], [])).toThrow(/@actana\/sdk is not publishable/);
  });
});

describe("the published manifest (#129 D12)", () => {
  it("accepts the shape D12 describes", () => {
    expect(() => assertPackedManifest(packed(), { version: "0.2.2" })).not.toThrow();
  });

  // The two kinds, and the reason the rules had to split: the CLI is an
  // esbuild bundle behind a `bin` map with no type surface at all, so a
  // library's `exports`-and-`.d.ts` requirement applied to it has exactly one
  // outcome — the CLI never becomes publishable, which is finding A.
  it("accepts a command: a bin map, no exports, no types", () => {
    expect(() => assertPackedManifest(packedCommand(), { version: "0.2.2" })).not.toThrow();
  });

  it("refuses a package that can be neither imported nor run", () => {
    expect(() => assertPackedManifest(packed({ exports: undefined }))).toThrow(
      /neither an `exports` map nor a `bin` map/,
    );
  });

  it("refuses a command that installs no command", () => {
    expect(() => assertPackedManifest(packedCommand({ bin: {} }))).toThrow(/empty `bin` map/);
  });

  // `npm publish --provenance` is refused by the registry without one, and the
  // refusal would land in the last job of the release, after both images and
  // their `:latest` have moved.
  it("requires a repository the attestation can name", () => {
    expect(() => assertPackedManifest(packed({ repository: undefined }))).toThrow(
      /declares no `repository.url`/,
    );
    expect(() => assertPackedManifest(packed({ repository: { type: "git" } }))).toThrow(
      /declares no `repository.url`/,
    );
  });

  // D13's lockstep where a consumer actually meets it. `workspace:*` in a
  // packed manifest means pnpm did not pack it and npm will refuse it; a
  // resolved-but-different version is worse, because it installs.
  it("refuses a published package pinned to another train's sibling", () => {
    expect(() =>
      assertPackedManifest(packedCommand({ dependencies: { "@actana/sdk": "workspace:*" } })),
    ).toThrow(/`workspace:` protocol reached the packed manifest/);
    expect(() =>
      assertPackedManifest(packedCommand({ dependencies: { "@actana/sdk": "0.2.1" } })),
    ).toThrow(/not on 0\.2\.2/);
    // A third-party dependency is nobody's train and is left alone.
    expect(() =>
      assertPackedManifest(packedCommand({ dependencies: { ws: "8.21.0" } })),
    ).not.toThrow();
  });

  it("requires the >=22 floor rather than the monorepo's own", () => {
    expect(() => assertPackedManifest(packed({ engines: { node: MONOREPO_ENGINES } }))).toThrow(
      /D12 says exactly ">=22"/,
    );
    expect(() => assertPackedManifest(packed({ engines: undefined }))).toThrow(/engines\.node/);
  });

  // The guard runs on the consumer's machine during `npm install`. Every
  // lifecycle that npm executes there is refused, not just `preinstall`:
  // `prepare` and `postinstall` reach the same shell by a different name.
  it.each(["preinstall", "install", "postinstall", "prepare"])(
    "refuses a %s lifecycle script",
    (lifecycle) => {
      const manifest = packed({ scripts: { [lifecycle]: `node scripts/${NODE_GUARD}` } });
      expect(() => assertPackedManifest(manifest)).toThrow(
        new RegExp(`ships a \`${lifecycle}\` script`),
      );
    },
  );

  // The failure this catches is a green pack that publishes a broken package:
  // the working `exports` map points at `./src/*.ts`, which is right inside the
  // workspace and resolves to nothing at all inside a tarball that ships
  // `dist/`. It is what `npm pack` would produce, because `publishConfig`
  // field replacement is pnpm's and not npm's.
  it("refuses a map still pointing at TypeScript source", () => {
    expect(() => assertPackedManifest(packed({ exports: { "./*": "./src/*.ts" } }))).toThrow(
      /points at TypeScript source/,
    );
  });

  it("requires a types condition, so a TypeScript consumer is not handed any", () => {
    expect(() => assertPackedManifest(packed({ exports: { "./*": "./dist/*.js" } }))).toThrow(
      /no `types` condition/,
    );
  });

  it("requires public access and provenance in the manifest, not only on the command line", () => {
    expect(() =>
      assertPackedManifest(packed({ publishConfig: { access: "restricted", provenance: true } })),
    ).toThrow(/access: "public"/);
    expect(() =>
      assertPackedManifest(packed({ publishConfig: { access: "public" } })),
    ).toThrow(/provenance: true/);
  });

  // D13's lockstep, at the only moment it can be checked against a real
  // release: `train-rules` asserts the five manifests agree with each other on
  // every pull request, and this asserts they agree with the tag being built.
  it("refuses a package that is not the version being released", () => {
    expect(() => assertPackedManifest(packed(), { version: "0.2.3" })).toThrow(
      /is not the version being released/,
    );
  });
});

// ─── The beta asset (#320, ADR 0036 D15/D16) ─────────────────────────────────
//
// A beta publishes nothing. Under ADR 0036 C1 a beta version string is
// `x.y.z-beta` exactly — no counter, ever — and a beta is designed to be cut
// repeatedly as the train moves, so the registry, which burns a version on
// first publish, can serve that string exactly once. D15 drops the registry
// from this path entirely and D16 attaches a packed tarball to the prerelease
// instead, installed with `npm i -g <asset-url>`.
//
// The route is the operator's and is not re-decided here. What is asserted here
// is that the artifact it produces installs, and that the one rule the route
// had to narrow is narrower rather than looser.
describe("the beta asset's manifest (ADR 0036 C1, D15, D16)", () => {
  const betaCommand = (overrides = {}) =>
    packedCommand({
      version: "0.4.1-beta",
      dependencies: { selfsigned: "^5.5.0", undici: "8.9.0", ws: "8.21.0" },
      ...overrides,
    });

  it("accepts the shape D16 attaches: a beta version, and no sibling to resolve", () => {
    expect(() =>
      assertPackedManifest(betaCommand(), { version: "0.4.1-beta", beta: true }),
    ).not.toThrow();
  });

  // C1, on the artifact rather than on the workflow that named it. This is the
  // counter ban with nowhere left to hide: the string reaches an asset
  // filename and a URL an operator pastes into a terminal.
  it.each(["0.4.1-beta.1", "0.4.1-beta.2", "0.4.1-beta-7c3a9f1", "0.4.1-beta1", "0.4.1"])(
    "refuses %s as a beta version",
    (version) => {
      expect(() => assertPackedManifest(betaCommand({ version }), { beta: true })).toThrow(
        /is packed as a beta and its version is not `x\.y\.z-beta`/,
      );
    },
  );

  // The narrowing, and the direction of it. A beta manifest that still names
  // `@actana/sdk` names a version registry.npmjs.org does not have and, under
  // D15, never will — so the operator's `npm i -g <asset-url>` fails on it.
  // Pinned *correctly* and pinned to another train fail identically here,
  // which is why the beta rule is absence rather than a looser range.
  it("refuses a beta that still depends on the sibling, at any version at all", () => {
    for (const range of ["0.4.1-beta", "0.4.1", "^0.4.0", "latest"]) {
      expect(() =>
        assertPackedManifest(betaCommand({ dependencies: { "@actana/sdk": range } }), {
          beta: true,
        }),
      ).toThrow(/is packed as a beta and still depends on @actana\/sdk/);
    }
  });

  // The clause #320 is explicit about: *the beta branch narrows it, never
  // removes it*. Same manifest, same module, `beta` off — and the release rule
  // is the rule it always was.
  it("leaves the release rule exactly as it was: a CLI on another train's SDK still fails", () => {
    expect(() =>
      assertPackedManifest(packedCommand({ dependencies: { "@actana/sdk": "0.2.1" } })),
    ).toThrow(/not on 0\.2\.2/);
    expect(() =>
      assertPackedManifest(packedCommand({ dependencies: { "@actana/sdk": "0.2.2" } })),
    ).not.toThrow();
    // **And the release path does NOT refuse a manifest with no SDK at all.**
    // An earlier draft of this comment claimed it did — the assertion below is
    // unchanged, only what it is said to mean. `assertPackedManifest` iterates
    // `Object.entries(packed.dependencies)`, so a dependency that is absent is
    // a loop body that never runs: the release branch validates a pin that is
    // *present* and has nothing to say about one that is missing.
    //
    // That is not a hole, because the release-side presence is held somewhere
    // else and always has been: `packages/cli/src/__tests__/no-local-escape.test.ts`
    // pins the working-tree manifest's dependency set to exactly four names, on
    // every pull request, and the release packs from that working tree. The
    // invariant on record is therefore the true one — this module refuses a
    // release pinned to the *wrong* SDK version, and that test refuses a release
    // that lost the SDK entirely.
    expect(() =>
      assertPackedManifest(betaCommand({ version: "0.2.2" }), { version: "0.2.2" }),
    ).not.toThrow();
  });

  // `workspace:` is the one failure both paths share, and for the same reason:
  // the protocol reaching a packed manifest means pnpm did not pack it.
  it("refuses the workspace protocol on either path", () => {
    for (const beta of [true, false]) {
      expect(() =>
        assertPackedManifest(betaCommand({ dependencies: { "@actana/sdk": "workspace:*" } }), {
          beta,
        }),
      ).toThrow(/`workspace:` protocol reached the packed manifest/);
    }
  });

  // Everything a beta shares with a release, asserted rather than assumed. The
  // asset is installed by the same `npm i -g` onto the same machine, so a beta
  // that quietly lost the engines floor or grew a `postinstall` would break an
  // operator in exactly the ways D12 exists to prevent.
  it("keeps every rule it did not narrow", () => {
    expect(() =>
      assertPackedManifest(betaCommand({ engines: { node: MONOREPO_ENGINES } }), { beta: true }),
    ).toThrow(/D12 says exactly ">=22"/);
    expect(() =>
      assertPackedManifest(betaCommand({ scripts: { postinstall: "node x.mjs" } }), { beta: true }),
    ).toThrow(/ships a `postinstall` script/);
    expect(() => assertPackedManifest(betaCommand({ bin: {} }), { beta: true })).toThrow(
      /empty `bin` map/,
    );
  });
});

describe("the beta version string, and the counter that does not exist (C1)", () => {
  it("names a line's beta and appends nothing else", () => {
    expect(betaVersion("0.4.1")).toBe("0.4.1-beta");
    expect(betaVersion("1.0.0")).toBe("1.0.0-beta");
    expect(BETA_VERSION.test("0.4.1-beta")).toBe(true);
  });

  // The input a second cut of the same beta would want to hand it. There is no
  // argument for a counter and no parameter to put one in: the function takes
  // a line, and `0.4.1-beta` is not a line.
  it.each(["0.4.1-beta", "0.4.1-beta.2", "v0.4.1", "0.4", "0.4.1-rc.1", ""])(
    "refuses %s as a line",
    (line) => {
      expect(() => betaVersion(line)).toThrow(/is not a release line/);
    },
  );
});

describe("the SDK is inlined, not imported (ADR 0036 D16)", () => {
  const build = fs.readFileSync(path.join(repoRoot, "packages/cli/build.mjs"), "utf8");

  // The precondition the whole route rests on, read off the file that decides
  // it. `packages/cli/src/__tests__/no-local-escape.test.ts` asserts the same
  // absence from inside the CLI package; this is the copy the packing path
  // reads, because the packing path is what would ship the mistake.
  it("marks only ws, undici and selfsigned external", () => {
    expect(externalNames(build)).toEqual(["ws", "undici", "selfsigned"]);
    expect(externalNames(build)).not.toContain("@actana/sdk");
  });

  it("catches a bundle that imports the sibling rather than carrying it", () => {
    for (const source of [
      'import { CoreClient } from "@actana/sdk/core-client";',
      'const sdk = require("@actana/sdk");',
      'const sdk = await import("@actana/sdk/core-session");',
    ]) {
      expect(() => assertBundleInlines("@actana/cli", source, "@actana/sdk")).toThrow(
        /imports @actana\/sdk at runtime rather than inlining it/,
      );
    }
  });

  // The false positive this rule had to be written around, and it is not
  // hypothetical: the CLI bundle inlines its own `package.json` — that is
  // where `actana --version` reads its answer — so the literal text
  // `"@actana/sdk": "workspace:*"` is in the bytes of a bundle that imports
  // nothing of the sort. A substring search would fail every pack.
  it("does not mistake the inlined manifest's own text for an import", () => {
    const inlinedManifest = 'var package_default = { dependencies: { "@actana/sdk": "workspace:*" } };';
    expect(() => assertBundleInlines("@actana/cli", inlinedManifest, "@actana/sdk")).not.toThrow();
  });
});

describe("the published tarball (#129 D12, #159)", () => {
  it("accepts compiled JavaScript with types beside it", () => {
    expect(() => assertPackedFiles(packed(), files())).not.toThrow();
  });

  // #159, literally: the guard cannot reach a published tarball.
  it("refuses a tarball carrying the Node-24 guard", () => {
    expect(() => assertPackedFiles(packed(), files(`package/scripts/${NODE_GUARD}`))).toThrow(
      new RegExp(NODE_GUARD),
    );
  });

  // A whitelist rather than a blocklist, so the rule survives a rename. "No
  // `require-node-24.mjs`" would pass a tarball carrying the whole of
  // `scripts/` the day somebody renames that file.
  it("refuses anything outside dist/ and the paperwork", () => {
    expect(() => assertPackedFiles(packed(), files("package/scripts/ensure-node-sqlite.mjs"))).toThrow(
      /outside `dist\/`/,
    );
    expect(() => assertPackedFiles(packed(), files("package/src/core-client.ts"))).toThrow(
      /outside `dist\/`/,
    );
  });

  it("refuses a module that resolves at runtime but not at compile time", () => {
    const withoutTypes = files().filter((entry) => !entry.endsWith(".d.ts"));
    expect(() => assertPackedFiles(packed(), withoutTypes)).toThrow(/no `\.d\.ts` beside it/);
  });

  it("refuses a tarball with no compiled output at all", () => {
    expect(() => assertPackedFiles(packed(), ["package/package.json"])).toThrow(
      /no compiled JavaScript/,
    );
  });

  // `packages/sdk/` has no LICENSE of its own — the one that ships is the
  // workspace root's, copied in by pnpm at pack time. That is a pnpm behaviour
  // rather than a guarantee, and the whitelist permits a LICENSE without ever
  // requiring one, so an MIT package could reach npm with no licence text in
  // it. Asserted here rather than inferred from how many files a pack emitted.
  it("refuses a tarball with no licence text in it", () => {
    const unlicensed = files().filter((entry) => entry !== "package/LICENSE");
    expect(() => assertPackedFiles(packed(), unlicensed)).toThrow(/packs no LICENSE/);
    expect(() =>
      assertPackedFiles(packed(), [...unlicensed, "package/LICENSE.md"]),
    ).not.toThrow();
  });
});

// A command's tarball. Everything above still applies — the guard, the
// whitelist, the licence — and the two rules that are about being *imported*
// give way to the two that are about being *run*.
describe("the published command's tarball (#129 D12, D13)", () => {
  it("accepts a bundle behind a bin shim", () => {
    expect(() => assertPackedFiles(packedCommand(), commandFiles())).not.toThrow();
  });

  // npm links `node_modules/.bin/actana` at whatever the manifest says and
  // never checks the target is in the tarball — the install is green and the
  // command is a link to nothing. `files` cannot cause this (npm packs a `bin`
  // target regardless of it); a renamed shim or an extension typo can, which is
  // why the assertion is against the file list rather than against `files`.
  it("refuses a command whose entry point is not in the tarball", () => {
    const withoutShim = commandFiles().filter((entry) => entry !== "package/bin/actana.mjs");
    expect(() => assertPackedFiles(packedCommand(), withoutShim)).toThrow(
      /maps a command to package\/bin\/actana\.mjs and does not pack it/,
    );
  });

  it("refuses a command with no bundle for the shim to load", () => {
    const withoutBundle = commandFiles().filter((entry) => !entry.startsWith("package/dist/"));
    expect(() => assertPackedFiles(packedCommand(), withoutBundle)).toThrow(/packs no bundle/);
  });

  // The whitelist is per kind, in both directions: `bin/` is a published path
  // for a command and a stray in a library, which is the same rule as before —
  // a published package is what it offers a consumer and nothing else.
  it("keeps bin/ out of a library, and src/ out of a command", () => {
    expect(() => assertPackedFiles(packed(), files("package/bin/actana.mjs"))).toThrow(
      /outside `dist\/`/,
    );
    expect(() =>
      assertPackedFiles(packedCommand(), commandFiles("package/src/actana-cli.ts")),
    ).toThrow(/outside `dist\/`/);
    expect(() =>
      assertPackedFiles(packedCommand(), commandFiles(`package/scripts/${NODE_GUARD}`)),
    ).toThrow(new RegExp(NODE_GUARD));
  });

  it("reads the bin map the way npm does", () => {
    expect(binTargets(packedCommand())).toEqual(["package/bin/actana.mjs"]);
    expect(binTargets(packedCommand({ bin: "./bin/actana.mjs" }))).toEqual([
      "package/bin/actana.mjs",
    ]);
    expect(binTargets(packed())).toEqual([]);
  });

  // The one rule that is about the file's contents. npm symlinks
  // `node_modules/.bin/actana` at this path; without `#!` the kernel hands it
  // to the shell, and the consumer's first `actana` prints a syntax error from
  // inside JavaScript they did not write.
  it("requires the linked file to start with a node shebang", () => {
    expect(() =>
      assertPackedBin("@actana/cli", "package/bin/actana.mjs", "#!/usr/bin/env node\nawait main()\n"),
    ).not.toThrow();
    expect(() =>
      assertPackedBin("@actana/cli", "package/bin/actana.mjs", "await main()\n"),
    ).toThrow(/no shebang/);
    expect(() =>
      assertPackedBin("@actana/cli", "package/bin/actana.mjs", "#!/bin/sh\nexec node \"$0\"\n"),
    ).toThrow(/does not name node/);
  });
});

// The half of D12 that is about this repository rather than about the
// registry. A check that only ever read the tarball would be just as happy if
// somebody made the root manifest `>=22` "for consistency" — which drops the
// Core and the Panel onto a runtime neither is built, tested, or shipped on.
describe("the monorepo keeps the guard the tarball drops (#129 D12)", () => {
  it("holds today", () => {
    expect(() => assertMonorepoKeepsTheGuard(repoRoot)).not.toThrow();
  });

  it("is what the root manifest actually says", () => {
    const root = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
    expect(root.engines.node).toBe(MONOREPO_ENGINES);
    expect(root.scripts.preinstall).toBe(`node scripts/${NODE_GUARD}`);
    expect(fs.existsSync(path.join(repoRoot, "scripts", NODE_GUARD))).toBe(true);
  });
});

// The rehearsal itself, on the real package. Everything above is a rule about a
// manifest; this is the artifact. It is the scoped dry run #159 asks for, and
// it runs here — on a pull request, before any tag exists — rather than in the
// release, where the first thing that could go wrong is also the last.
// The pack runs once, in `beforeAll`, and every test below reads what it
// produced. It used to run inside the first `it`, which made the import test
// below depend on a sibling's side effect — it asserted `dist/` existed with
// the message "run the packing test first", and held only because Vitest
// happens to run `it`s in file order. A test whose precondition is another
// test's ordering is one refactor from a confusing red.
//
// Both packages, and the reason that word is load-bearing: this block used to
// loop over "every tarball the rehearsal produced" while asserting
// `core-client.js` and a `.d.ts` beside every module — assertions only the SDK
// can satisfy. It passed because there was exactly one tarball. A CLI added to
// that loop would have failed on the SDK's rules rather than on its own, which
// is how a publish set of two ends up quietly staying a publish set of one.
describe("packing both published packages for real", () => {
  /** @type {string} */ let outDir;
  /** @type {Map<string, {tarball: string, entries: string[], manifest: object}>} */ let packs;
  /** @type {string[]} */ let order;

  const pack = (name) => {
    const found = packs.get(name);
    expect(found, `${name} was not packed by the rehearsal`).toBeDefined();
    return found;
  };

  beforeAll(() => {
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), "actana-npm-publish-test-"));
    const stdout = execFileSync(
      process.execPath,
      [path.join(repoRoot, "scripts/rehearse-npm-publish.mjs"), "--out-dir", outDir],
      { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    order = /^packages=(.*)$/m.exec(stdout)[1].split(" ").filter(Boolean);
    packs = new Map(
      /^tarballs=(.*)$/m
        .exec(stdout)[1]
        .split(" ")
        .filter(Boolean)
        .map((tarball) => {
          // Read the artifact again here rather than trusting the script's own
          // exit code: what #159 wants asserted is a property of the bytes.
          const entries = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" })
            .split("\n")
            .filter(Boolean);
          const manifest = JSON.parse(
            execFileSync("tar", ["-xzOf", tarball, "package/package.json"], { encoding: "utf8" }),
          );
          return [manifest.name, { tarball, entries, manifest }];
        }),
    );
  }, 300_000);

  afterAll(() => {
    if (outDir) fs.rmSync(outDir, { recursive: true, force: true });
  });

  // The clause this PR exists to satisfy — #159's first, *both* packages — read
  // off real tarballs rather than off the manifest that would produce them.
  it("packs both of D13's packages, the dependency before the dependent", () => {
    expect([...packs.keys()].sort()).toEqual([...PUBLISHABLE].sort());
    expect(order).toEqual(["@actana/sdk", "@actana/cli"]);
  });

  // D13's lockstep, on the artifacts: one version line, and the CLI's
  // dependency on the SDK resolved to exactly it. `workspace:*` surviving the
  // pack would be a tarball npm rejects; a different version would be a CLI
  // installed against another train's SDK.
  it("ships one version line, with the CLI pinned to this SDK", () => {
    const versions = new Set([...packs.values()].map(({ manifest }) => manifest.version));
    expect([...versions]).toHaveLength(1);
    const cli = pack("@actana/cli").manifest;
    expect(cli.dependencies["@actana/sdk"]).toBe(pack("@actana/sdk").manifest.version);
  });

  it("produces tarballs that pass every rule that applies to them", () => {
    for (const { entries, manifest } of packs.values()) {
      expect(entries.some((entry) => entry.endsWith(NODE_GUARD))).toBe(false);
      // pnpm copies the workspace root's LICENSE in; the real pack is where
      // that behaviour is confirmed rather than assumed.
      expect(entries).toContain("package/LICENSE");

      expect(manifest.engines.node).toBe(PUBLISHED_ENGINES);
      expect(manifest.scripts?.preinstall).toBeUndefined();
      expect(manifest.scripts?.prepack).toBeUndefined();
      expect(manifest.private).toBeUndefined();
      expect(manifest.repository.url).toMatch(/github\.com\/actana\/control/);
      expect(manifest.publishConfig.provenance).toBe(true);
      expect(manifest.publishConfig.access).toBe("public");
    }

    const sdk = pack("@actana/sdk");
    expect(sdk.entries).toContain("package/dist/core-client.js");
    expect(sdk.entries).toContain("package/dist/core-client.d.ts");
    // `publishConfig.exports` was applied by the pack — the tarball's map
    // points at what is in it.
    expect(JSON.stringify(sdk.manifest.exports)).not.toContain("./src/");

    const cli = pack("@actana/cli");
    expect(cli.entries).toContain("package/bin/actana.mjs");
    expect(cli.entries).toContain("package/dist/actana-cli.mjs");
    expect(cli.entries).toContain("package/README.md");
    expect(cli.manifest.bin).toEqual({ actana: "bin/actana.mjs" });
  });

  // The command npm installs, out of the bytes that would be published. The
  // shim is the path npm links, so its shebang and the relative hop to the
  // bundle beside it are the two things that decide whether `actana` runs at
  // all — and neither is visible in a manifest.
  it("packs an `actana` that runs, with its shebang and its bundle", () => {
    const { tarball, entries } = pack("@actana/cli");
    const shim = execFileSync("tar", ["-xzOf", tarball, "package/bin/actana.mjs"], {
      encoding: "utf8",
    });
    expect(shim.startsWith("#!/usr/bin/env node")).toBe(true);
    // The shim loads `../dist/<bundle>` relative to itself, so the two are
    // siblings in the tarball or the command exits 70 on a fresh install.
    expect(entries).toContain("package/dist/actana-cli.mjs");

    // Run it. `packages/cli/bin` rather than an extraction, for the reason the
    // SDK's import loop gives: the bundle leaves `ws` external, and a temp
    // directory outside the workspace has no `node_modules` to resolve it from
    // — that would test the extraction. `pnpm pack` ran `prepack`, so these are
    // the bytes in the tarball, in the same `bin/` → `../dist/` layout.
    // Under an empty HOME, deliberately. Since #288 there is one `actana` and
    // `--version` is one answer about *both* halves: a machine with a Core
    // installed under it gets a second line naming that install's version
    // (ADR 0032 D10, tolerate and report). What this test is about is the
    // published command running at all, so it is asked the question on a
    // machine with nothing installed — which is also every machine a fresh
    // `npm i -g @actana/cli` lands on.
    const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), "actana-npm-home-"));
    let version;
    try {
      version = execFileSync(
        process.execPath,
        [path.join(repoRoot, "packages/cli/bin/actana.mjs"), "--version"],
        {
          encoding: "utf8",
          // Built from nothing rather than spread from `process.env`: a CI
          // runner that is itself a container Core carries `ACTANA_CONTAINER`
          // and `ACTANA_ROOT`, and `actana` would then report *that* machine's
          // Core. The published command needs `PATH` and a home, and nothing
          // else.
          env: {
            PATH: process.env.PATH ?? "",
            HOME: emptyHome,
            XDG_DATA_HOME: path.join(emptyHome, ".local", "share"),
            XDG_CONFIG_HOME: path.join(emptyHome, ".config"),
          },
        },
      ).trim();
    } finally {
      fs.rmSync(emptyHome, { recursive: true, force: true });
    }
    expect(version).toBe(`actana ${pack("@actana/cli").manifest.version}`);
  });

  // Every published module loads under a plain `node`. A `dist/` that
  // type-checks and cannot be imported — a stray extensionless relative
  // specifier is all it takes, and `moduleResolution: Bundler` will not
  // complain about one — is a package that installs and then throws on first
  // `import`.
  //
  // Every module, not the entry point: importing `core-client` alone reaches 5
  // of the 9 published modules through its own import graph, and the four it
  // misses include `core-session` and `durable-core-client`, which are the two
  // the README tells a consumer to import first. The module most likely to be
  // somebody's first `import` was the one not covered.
  //
  // The list comes from the tarball rather than from a hard-coded array, so a
  // module added to `src/` is covered the day it is published rather than the
  // day somebody remembers this file.
  it("compiles to something Node can actually import — every published module", async () => {
    const modules = pack("@actana/sdk")
      .entries.filter((entry) => /^package\/dist\/[^/]+\.js$/.test(entry))
      .map((entry) => path.basename(entry));
    // Nine today. A bare `toBeGreaterThan(0)` here would pass a `dist/`
    // containing one file, which is the shape this test exists to refuse.
    const sources = fs
      .readdirSync(path.join(repoRoot, "packages/sdk/src"))
      .filter((file) => file.endsWith(".ts"));
    expect(
      modules.length,
      `${modules.length} module(s) in dist/ for ${sources.length} in src/ — the tarball ships a subset of the SDK`,
    ).toBe(sources.length);

    for (const basename of modules) {
      // `beforeAll` packed with `pnpm pack`, whose `prepack` is the build, so
      // these are the compiled bytes that went into the tarball. They are
      // imported from `dist/` rather than from the extracted tarball because
      // the SDK depends on `ws`, and a temp directory outside the workspace
      // has no `node_modules` to resolve it from — which would test the
      // extraction rather than the specifiers.
      const entry = path.join(repoRoot, "packages/sdk/dist", basename);
      const module = await import(entry);
      expect(Object.keys(module).length, `${basename} exports nothing at runtime`).toBeGreaterThan(
        0,
      );
    }

    // The three the README leads with, by name: a module can import cleanly
    // and still have lost the export a consumer copied out of the docs.
    const { CoreClient } = await import(path.join(repoRoot, "packages/sdk/dist/core-client.js"));
    const { CoreSession } = await import(path.join(repoRoot, "packages/sdk/dist/core-session.js"));
    const { DurableCoreClient } = await import(
      path.join(repoRoot, "packages/sdk/dist/durable-core-client.js")
    );
    expect(typeof CoreClient).toBe("function");
    expect(typeof CoreSession).toBe("function");
    expect(typeof DurableCoreClient).toBe("function");
  });
});

// #320's acceptance criterion, and the ticket says so in as many words: *`npm
// i -g <that asset URL>` on a clean machine, with no access to any private
// registry, installs and puts a working `actana` on `PATH` — asserted in CI,
// not assumed. That assertion is the whole ticket; if it cannot be made, say so
// rather than shipping a URL nobody has run.*
//
// So it is made, on the bytes. The rehearsal packs the asset, this reads the
// tarball again itself, and `--install-check` runs the real `npm i -g` into a
// fresh prefix under an empty HOME and asks the installed command its version.
//
// **The URL half is the one thing not exercised here, and that is a property of
// time rather than a gap in the check.** The asset URL cannot resolve until the
// Release exists to serve it, which is after a cut and long after a pull
// request. What a URL adds to a local path is npm's download, which is the same
// code path `npm i -g https://…` takes for any tarball — so the risk it carries
// is "the asset was not attached", which is #318's step and the checksum row,
// not the tarball's. Everything that is about *these bytes* is asserted here.
describe("packing the beta CLI asset for real (#320, ADR 0036 D16)", () => {
  // Read off the manifest rather than written in: the line moves every train,
  // and a number pinned here would either go stale or start asserting the
  // wrong train's beta. This is also the cross-check the script performs — the
  // caller names a line and the checkout has to agree it is that line.
  const line = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "packages/cli/package.json"), "utf8"),
  ).version;
  const beta = `${line}-beta`;

  // Opt-out rather than opt-in, and impossible to take in CI. A check that
  // skips by default is a check that is not made, and #320 asked for this one
  // specifically; the escape hatch exists for an offline working copy and the
  // `CI` guard below is what stops it becoming the normal state.
  const offline = process.env.ACTANA_SKIP_NPM_INSTALL_CHECK === "1";

  /** @type {string} */ let outDir;
  /** @type {string} */ let stdout;
  /** @type {string} */ let tarball;
  /** @type {string[]} */ let entries;
  /** @type {object} */ let manifest;

  beforeAll(() => {
    if (offline && !process.env.CI) {
      outDir = "";
      return;
    }
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), "actana-beta-asset-test-"));
    stdout = execFileSync(
      process.execPath,
      [
        path.join(repoRoot, "scripts/rehearse-npm-publish.mjs"),
        "--beta",
        line,
        "--out-dir",
        outDir,
        "--install-check",
      ],
      { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    tarball = /^tarballs=(.*)$/m.exec(stdout)[1];
    entries = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
    manifest = JSON.parse(
      execFileSync("tar", ["-xzOf", tarball, "package/package.json"], { encoding: "utf8" }),
    );
  }, 900_000);

  afterAll(() => {
    if (outDir) fs.rmSync(outDir, { recursive: true, force: true });
  });

  // The guard on the escape hatch. `ACTANA_SKIP_NPM_INSTALL_CHECK` turns off
  // the assertion #320 calls the whole ticket, so it may not be reachable on
  // the machine whose green light anyone acts on.
  it("cannot be skipped in CI", () => {
    expect(offline && process.env.CI, "the beta install check was skipped under CI").toBeFalsy();
  });

  // C1 on the two surfaces an operator actually reads: the version inside the
  // manifest and the filename hanging off the download URL. No counter, no run
  // number, no short sha, in either.
  it.skipIf(offline && !process.env.CI)("carries exactly the x.y.z-beta string, in the manifest and in the filename", () => {
    expect(manifest.version).toBe(beta);
    expect(BETA_VERSION.test(manifest.version)).toBe(true);
    expect(path.basename(tarball)).toBe(`actana-cli-${beta}.tgz`);
    // `/\./g`, not `"."` — a string argument to `replace` swaps the FIRST match
    // only, so `0.4.1-beta` escaped one dot and left two live. The regex still
    // matched, because `.` matches a dot, which is how a wrong escape survives
    // a green test: it is loose, not broken.
    expect(stdout).toMatch(new RegExp(`^asset=actana-cli-${beta.replace(/\./g, "\\.")}\\.tgz$`, "m"));
    expect(stdout).toMatch(new RegExp(`^version=${beta.replace(/\./g, "\\.")}$`, "m"));
    // The checksum row #318's SHA256SUMS carries, printed rather than left to
    // a second pass over the file — an asset hashed twice is an asset that can
    // be hashed differently.
    expect(stdout).toMatch(/^sha256=[0-9a-f]{64}$/m);
  });

  // Route 2, on the artifact. The manifest names the three externals
  // `build.mjs` names and nothing else — in particular not `@actana/sdk`,
  // whose version is on no registry under D15.
  it.skipIf(offline && !process.env.CI)("drops @actana/sdk from the packed manifest and keeps the three externals", () => {
    expect(Object.keys(manifest.dependencies).sort()).toEqual(["selfsigned", "undici", "ws"]);
    expect(manifest.dependencies["@actana/sdk"]).toBeUndefined();
    expect(manifest.bin).toEqual({ actana: "bin/actana.mjs" });
    expect(manifest.engines.node).toBe(PUBLISHED_ENGINES);
    // The same tarball a release would produce in every other respect.
    expect(entries).toContain("package/bin/actana.mjs");
    expect(entries).toContain("package/dist/actana-cli.mjs");
    expect(entries).toContain("package/LICENSE");
    expect(entries.some((entry) => entry.endsWith(NODE_GUARD))).toBe(false);
  });

  // Landmine one, proven rather than reasoned about: the SDK is *in* the
  // bundle. Read out of the tarball, in specifier position — the inlined
  // `package.json` puts the bare string in these bytes either way.
  it.skipIf(offline && !process.env.CI)("ships a bundle with the SDK inlined and no @actana specifier in it", () => {
    const bundle = execFileSync("tar", ["-xzOf", tarball, "package/dist/actana-cli.mjs"], {
      encoding: "utf8",
      maxBuffer: 128 * 1024 * 1024,
    });
    expect(() => assertBundleInlines("@actana/cli", bundle, "@actana/sdk")).not.toThrow();
    // The other direction, so a bundle that had lost the SDK entirely could not
    // pass this by importing nothing: the sourcemap names the modules esbuild
    // pulled in, and `packages/sdk/src` is among them.
    const map = JSON.parse(
      execFileSync("tar", ["-xzOf", tarball, "package/dist/actana-cli.mjs.map"], {
        encoding: "utf8",
        maxBuffer: 128 * 1024 * 1024,
      }),
    );
    const fromSdk = map.sources.filter((source) => source.includes("/sdk/src/"));
    expect(
      fromSdk.length,
      "the bundle inlines no @actana/sdk module, so the beta manifest dropped a dependency whose code is not in the tarball",
    ).toBeGreaterThan(0);
  });

  // The criterion itself. `npm i -g <the tarball>`, a fresh prefix, an empty
  // HOME, and the public registry for `ws`, `undici` and `selfsigned` — which
  // is what a machine wired to an external Core has, and all it has.
  it.skipIf(offline && !process.env.CI)("installs with `npm i -g` and puts a working `actana` on PATH", () => {
    expect(stdout).toMatch(/^install=ok$/m);
  }, 900_000);
});

// Review r1, finding 1 — regression. `fail()` is `process.exit(1)`, and a
// `process.exit` inside a `try` skips the `finally` outright. The beta pack
// called it from its `catch`, *after* the manifest had been rewritten, so a
// failed `pnpm pack` left `packages/cli/package.json` in the working tree
// carrying `x.y.z-beta` with `@actana/sdk` gone and `keywords` reflowed — the
// exact state ADR 0023 D3 says must never be committed, sitting there for the
// next `git add -A`. The doc block and the PR both claimed the opposite.
//
// Asserted on the bytes rather than on the code shape: the script is run with a
// `PATH` that has no `pnpm` on it, which is how the reviewer reproduced it, and
// the manifest is compared byte-for-byte before and after. A refusal *before*
// the edit and a failure *after* it are both covered — the first by the exit
// code, the second by the bytes.
describe("a failed beta pack leaves the working tree alone (review r1, finding 1)", () => {
  const manifestPath = path.join(repoRoot, "packages/cli/package.json");
  const line = JSON.parse(fs.readFileSync(manifestPath, "utf8")).version;

  /** @type {Buffer} */ let original;
  /** @type {string} */ let emptyPathDir;
  /** @type {string} */ let outDir;

  beforeAll(() => {
    // The safety net under the thing being tested. If the restore is broken
    // again, this test fails *and* puts the file back, rather than failing and
    // leaving the repository in the state it was complaining about.
    original = fs.readFileSync(manifestPath);
    emptyPathDir = fs.mkdtempSync(path.join(os.tmpdir(), "actana-no-pnpm-"));
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), "actana-beta-fail-"));
  });

  afterAll(() => {
    if (original) fs.writeFileSync(manifestPath, original);
    if (emptyPathDir) fs.rmSync(emptyPathDir, { recursive: true, force: true });
    if (outDir) fs.rmSync(outDir, { recursive: true, force: true });
  });

  it("restores the manifest byte-for-byte when `pnpm pack` cannot run", () => {
    const before = fs.readFileSync(manifestPath);
    let status = 0;
    let stderr = "";
    try {
      execFileSync(
        process.execPath,
        [path.join(repoRoot, "scripts/rehearse-npm-publish.mjs"), "--beta", line, "--out-dir", outDir],
        {
          cwd: repoRoot,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          // `node` is invoked by absolute path, so an empty `PATH` starves only
          // the `pnpm` the pack shells out to. Everything before the edit —
          // reading the manifests, reading `build.mjs` — needs no `PATH` at all,
          // which is what puts the failure on the far side of the rewrite.
          env: { PATH: emptyPathDir, HOME: process.env.HOME ?? emptyPathDir },
        },
      );
    } catch (error) {
      status = error.status ?? 1;
      stderr = error.stderr ?? "";
    }

    expect(status, "the pack was supposed to fail with no `pnpm` on PATH").not.toBe(0);
    expect(stderr).toMatch(/`pnpm pack` failed for @actana\/cli/);
    // The assertion the finding is about. Bytes, not a parsed comparison: the
    // rewrite also reflows `keywords`, so a JSON-equal check would have passed
    // on a file that is visibly modified in `git status`.
    expect(
      fs.readFileSync(manifestPath).equals(before),
      "a failed beta pack left packages/cli/package.json modified in the working tree",
    ).toBe(true);
  }, 120_000);
});
