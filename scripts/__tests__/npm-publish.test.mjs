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
  MONOREPO_ENGINES,
  NODE_GUARD,
  PUBLISHABLE,
  PUBLISHED_ENGINES,
  assertMonorepoKeepsTheGuard,
  assertPackedFiles,
  assertPackedManifest,
  assertPublishSet,
  discoverPublishable,
  workspaceManifests,
} from "../lib/npm-packages.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");

/** A manifest as it comes out of a pack: everything D12 and D13 want, and nothing else. */
const packed = (overrides = {}) => ({
  name: "@actana/sdk",
  version: "0.2.2",
  engines: { node: PUBLISHED_ENGINES },
  exports: { "./*": { types: "./dist/*.d.ts", default: "./dist/*.js" } },
  publishConfig: { access: "public", provenance: true },
  scripts: { build: "tsc -p tsconfig.build.json" },
  ...overrides,
});

const files = (...extra) => [
  "package/package.json",
  "package/LICENSE",
  "package/dist/core-client.js",
  "package/dist/core-client.d.ts",
  ...extra,
];

describe("what this repository publishes to npm (#129 D13)", () => {
  it("is @actana/sdk today and @actana/cli when #157 lands, and nothing else", () => {
    expect(PUBLISHABLE).toEqual(["@actana/sdk", "@actana/cli"]);
    const found = discoverPublishable(repoRoot);
    expect(found.map((pkg) => pkg.name)).toContain("@actana/sdk");
    // The CLI is created in parallel by #157. Its absence is allowed and
    // reported; anything *else* being publishable is not.
    expect(assertPublishSet(found).every((name) => PUBLISHABLE.includes(name))).toBe(true);
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
    const found = [
      { name: "@actana/sdk", relative: "packages/sdk/package.json" },
      { name: "@actana/panel", relative: "packages/panel/package.json" },
    ];
    expect(() => assertPublishSet(found)).toThrow(/@actana\/panel would be published/);
  });

  // The opposite direction, and the reason it is an error rather than a skip: a
  // release that publishes nothing reports the same green as one that
  // published, and the first anyone would hear of it is an `npm i` that 404s.
  it("refuses a release that would publish nothing", () => {
    expect(() => assertPublishSet([])).toThrow(/@actana\/sdk is not publishable/);
  });
});

describe("the published manifest (#129 D12)", () => {
  it("accepts the shape D12 describes", () => {
    expect(() => assertPackedManifest(packed(), { version: "0.2.2" })).not.toThrow();
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

describe("the published tarball (#129 D12, #159)", () => {
  it("accepts compiled JavaScript with types beside it", () => {
    expect(() => assertPackedFiles("@actana/sdk", files())).not.toThrow();
  });

  // #159, literally: the guard cannot reach a published tarball.
  it("refuses a tarball carrying the Node-24 guard", () => {
    expect(() => assertPackedFiles("@actana/sdk", files(`package/scripts/${NODE_GUARD}`))).toThrow(
      new RegExp(NODE_GUARD),
    );
  });

  // A whitelist rather than a blocklist, so the rule survives a rename. "No
  // `require-node-24.mjs`" would pass a tarball carrying the whole of
  // `scripts/` the day somebody renames that file.
  it("refuses anything outside dist/ and the paperwork", () => {
    expect(() => assertPackedFiles("@actana/sdk", files("package/scripts/ensure-node-sqlite.mjs"))).toThrow(
      /outside `dist\/`/,
    );
    expect(() => assertPackedFiles("@actana/sdk", files("package/src/core-client.ts"))).toThrow(
      /outside `dist\/`/,
    );
  });

  it("refuses a module that resolves at runtime but not at compile time", () => {
    const withoutTypes = files().filter((entry) => !entry.endsWith(".d.ts"));
    expect(() => assertPackedFiles("@actana/sdk", withoutTypes)).toThrow(/no `\.d\.ts` beside it/);
  });

  it("refuses a tarball with no compiled output at all", () => {
    expect(() => assertPackedFiles("@actana/sdk", ["package/package.json"])).toThrow(
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
    expect(() => assertPackedFiles("@actana/sdk", unlicensed)).toThrow(/packs no LICENSE/);
    expect(() =>
      assertPackedFiles("@actana/sdk", [...unlicensed, "package/LICENSE.md"]),
    ).not.toThrow();
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
describe("packing @actana/sdk for real", () => {
  /** @type {string} */ let outDir;
  /** @type {{tarball: string, entries: string[], manifest: object}[]} */ let packed;

  beforeAll(() => {
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), "actana-npm-publish-test-"));
    const stdout = execFileSync(
      process.execPath,
      [path.join(repoRoot, "scripts/rehearse-npm-publish.mjs"), "--out-dir", outDir],
      { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    packed = /^tarballs=(.*)$/m
      .exec(stdout)[1]
      .split(" ")
      .filter(Boolean)
      .map((tarball) => ({
        tarball,
        // Read the artifact again here rather than trusting the script's own
        // exit code: what #159 wants asserted is a property of the bytes.
        entries: execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" })
          .split("\n")
          .filter(Boolean),
        manifest: JSON.parse(
          execFileSync("tar", ["-xzOf", tarball, "package/package.json"], { encoding: "utf8" }),
        ),
      }));
  }, 300_000);

  afterAll(() => {
    if (outDir) fs.rmSync(outDir, { recursive: true, force: true });
  });

  it("produces a tarball that passes every rule", () => {
    expect(packed.length).toBeGreaterThan(0);
    for (const { entries, manifest } of packed) {
      expect(entries.some((entry) => entry.endsWith(NODE_GUARD))).toBe(false);
      expect(entries).toContain("package/dist/core-client.js");
      expect(entries).toContain("package/dist/core-client.d.ts");
      // pnpm copies the workspace root's LICENSE in; the real pack is where
      // that behaviour is confirmed rather than assumed.
      expect(entries).toContain("package/LICENSE");

      expect(manifest.engines.node).toBe(PUBLISHED_ENGINES);
      expect(manifest.scripts?.preinstall).toBeUndefined();
      expect(manifest.private).toBeUndefined();
      // `publishConfig.exports` was applied by the pack — the tarball's map
      // points at what is in it.
      expect(JSON.stringify(manifest.exports)).not.toContain("./src/");
    }
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
    expect(packed.length).toBeGreaterThan(0);
    for (const { entries } of packed) {
      const modules = entries
        .filter((entry) => /^package\/dist\/[^/]+\.js$/.test(entry))
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
      const { CoreClient } = await import(
        path.join(repoRoot, "packages/sdk/dist/core-client.js")
      );
      const { CoreSession } = await import(
        path.join(repoRoot, "packages/sdk/dist/core-session.js")
      );
      const { DurableCoreClient } = await import(
        path.join(repoRoot, "packages/sdk/dist/durable-core-client.js")
      );
      expect(typeof CoreClient).toBe("function");
      expect(typeof CoreSession).toBe("function");
      expect(typeof DurableCoreClient).toBe("function");
    }
  });
});
