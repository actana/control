import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import {
  BETA_PRERELEASE,
  BUNDLED_NODE_VERSION,
  CORE_RUNTIME_DEPENDENCIES,
  CORE_TARGETS,
  UNBUNDLED_EXTERNALS,
  assertCoreVersion,
  assertShasumsSet,
  assertTarballSurfaces,
  buildManifest,
  findTarget,
  formatShasums,
  hostTarget,
  isBetaVersion,
  nodeDistDirName,
  nodeDistShasumsUrl,
  nodeDistTarballUrl,
  parseCoreLinkProtocolVersion,
  parseShasums,
  parseTarballName,
  planDependencyLayout,
  prebuildDirName,
  tarballName,
  tarballRootDirName,
} from "../lib/core-tarball.mjs";
import { parseAssetName } from "../lib/fixture-release.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");

describe("CORE_TARGETS", () => {
  it("covers exactly the three supported Cores", () => {
    expect(CORE_TARGETS.map((t) => t.target)).toEqual([
      "linux-x64",
      "linux-arm64",
      "mac-arm64",
    ]);
  });

  // Apple silicon only, and no Windows at all. An Intel Mac runs its Core from
  // the Core image, so `mac-x64` is an answered question rather than a gap —
  // `install.sh` and `releaseTargetFor` both refuse it by name.
  it("carries one darwin target, and it is arm64", () => {
    expect(CORE_TARGETS.filter((t) => t.platform === "darwin").map((t) => t.arch)).toEqual([
      "arm64",
    ]);
    expect(CORE_TARGETS.some((t) => t.platform === "win32")).toBe(false);
  });

  // The Node.org slug is `darwin-arm64` while the asset is `mac-arm64` — the
  // one target where the two names differ, and the reason `nodeDistId` is a
  // field rather than the target name reused.
  it("points mac-arm64 at the darwin-arm64 Node runtime", () => {
    expect(findTarget("mac-arm64")).toMatchObject({
      platform: "darwin",
      arch: "arm64",
      nodeDistId: "darwin-arm64",
    });
  });
});

describe("findTarget", () => {
  it("resolves a known target", () => {
    expect(findTarget("linux-arm64")).toMatchObject({ platform: "linux", arch: "arm64" });
  });

  it("returns undefined for an unknown target", () => {
    expect(findTarget("linux-riscv64")).toBeUndefined();
  });
});

describe("hostTarget", () => {
  it("maps a build host to the target it can legitimately produce", () => {
    expect(hostTarget("linux", "x64")?.target).toBe("linux-x64");
    expect(hostTarget("linux", "arm64")?.target).toBe("linux-arm64");
    expect(hostTarget("darwin", "arm64")?.target).toBe("mac-arm64");
  });

  it("has no target for an unsupported host", () => {
    expect(hostTarget("win32", "x64")).toBeUndefined();
    expect(hostTarget("darwin", "x64")).toBeUndefined();
  });
});

describe("CORE_RUNTIME_DEPENDENCIES", () => {
  it("covers every external the Core build leaves unbundled", () => {
    // Adding an `external` to packages/core/build.mjs without adding it
    // here ships a tarball that dies on its first require(). Fail here instead.
    const buildScript = fs.readFileSync(
      path.join(repoRoot, "packages", "core", "build.mjs"),
      "utf8",
    );
    const externalBlock = /external:\s*\[([\s\S]*?)\]/.exec(buildScript);
    expect(externalBlock).not.toBeNull();

    const externals = [...externalBlock[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(externals.length).toBeGreaterThan(0);

    const missing = externals.filter(
      (name) => !CORE_RUNTIME_DEPENDENCIES.includes(name) && !UNBUNDLED_EXTERNALS.includes(name),
    );
    expect(missing).toEqual([]);
  });
});

describe("prebuildDirName", () => {
  it("names the one node-pty prebuild directory the target needs", () => {
    expect(prebuildDirName(findTarget("linux-arm64"))).toBe("linux-arm64");
    expect(prebuildDirName(findTarget("linux-x64"))).toBe("linux-x64");
    // node-pty names its prebuilds by `process.platform`, so the mac leg wants
    // `darwin-arm64` — not the `mac-arm64` the asset is called.
    expect(prebuildDirName(findTarget("mac-arm64"))).toBe("darwin-arm64");
  });
});

describe("node dist locations", () => {
  it("names the directory the Node tarball extracts to", () => {
    expect(nodeDistDirName("24.15.0", "linux-arm64")).toBe("node-v24.15.0-linux-arm64");
  });

  it("builds the runtime tarball URL", () => {
    expect(nodeDistTarballUrl("24.15.0", "linux-arm64")).toBe(
      "https://nodejs.org/dist/v24.15.0/node-v24.15.0-linux-arm64.tar.gz",
    );
  });

  it("builds the checksum manifest URL for the same release", () => {
    expect(nodeDistShasumsUrl("24.15.0")).toBe("https://nodejs.org/dist/v24.15.0/SHASUMS256.txt");
  });
});

describe("parseShasums", () => {
  it("parses a Node.org style manifest", () => {
    const text = [
      `${"a".repeat(64)}  node-v24.15.0-linux-x64.tar.gz`,
      `${"b".repeat(64)}  node-v24.15.0-darwin-arm64.tar.gz`,
      "",
    ].join("\n");

    expect(parseShasums(text)).toEqual(
      new Map([
        ["node-v24.15.0-linux-x64.tar.gz", "a".repeat(64)],
        ["node-v24.15.0-darwin-arm64.tar.gz", "b".repeat(64)],
      ]),
    );
  });

  it("tolerates the binary-mode asterisk", () => {
    const parsed = parseShasums(`${"c".repeat(64)} *thing.tar.gz\n`);
    expect(parsed.get("thing.tar.gz")).toBe("c".repeat(64));
  });

  it("throws on a line that is not a checksum entry", () => {
    // A proxy serving an HTML error page must fail loudly here, not later as
    // an inscrutable digest mismatch.
    expect(() => parseShasums("<html><body>404</body></html>\n")).toThrow(/unparseable/);
  });
});

describe("formatShasums", () => {
  it("renders digest, two spaces, name — sorted by name", () => {
    const text = formatShasums(
      new Map([
        ["actana-core-1.0.0-linux-x64.tar.gz", "b".repeat(64)],
        ["actana-core-1.0.0-linux-arm64.tar.gz", "a".repeat(64)],
      ]),
    );

    expect(text).toBe(
      `${"a".repeat(64)}  actana-core-1.0.0-linux-arm64.tar.gz\n` +
        `${"b".repeat(64)}  actana-core-1.0.0-linux-x64.tar.gz\n`,
    );
  });

  it("round-trips through parseShasums", () => {
    const entries = new Map([
      ["one.tar.gz", "1".repeat(64)],
      ["two.tar.gz", "2".repeat(64)],
    ]);
    expect(parseShasums(formatShasums(entries))).toEqual(entries);
  });

  it("verifies against the file `sha256sum -c` would accept", () => {
    // `sha256sum -c` requires exactly two spaces (or ` *`) as the separator.
    const line = formatShasums(new Map([["x.tar.gz", "f".repeat(64)]])).trimEnd();
    expect(line).toMatch(/^[0-9a-f]{64} {2}x\.tar\.gz$/);
  });
});

// ─── the version a tarball may carry ───────────────────────────────────────
//
// A Core tarball self-identifies, and ADR 0036 D18 keeps it that way: the
// version is in the asset name, in the archive root and in the manifest, which
// is precisely why a beta's bytes cannot be renamed into a release's. The
// string those three carry is therefore worth being strict about, and C1 fixes
// it — a beta is `x.y.z-beta` with nothing after the word, on every surface.

describe("assertCoreVersion", () => {
  it("takes a release version", () => {
    expect(assertCoreVersion("0.4.1")).toEqual({
      version: "0.4.1",
      line: "0.4.1",
      prerelease: null,
    });
  });

  it("takes a beta, which is the line plus one fixed word", () => {
    expect(assertCoreVersion("0.4.1-beta")).toEqual({
      version: "0.4.1-beta",
      line: "0.4.1",
      prerelease: BETA_PRERELEASE,
    });
    expect(isBetaVersion("0.4.1-beta")).toBe(true);
    expect(isBetaVersion("0.4.1")).toBe(false);
  });

  // ADR 0036 C1 bans a counted beta outright, on every surface — and an asset
  // filename is a surface. A run number or a short sha appended by a workflow
  // is the shape that would arrive by accident, so it dies here rather than in
  // a published asset name nobody can rename afterwards.
  it("refuses a counted beta, whatever counts it", () => {
    for (const version of ["0.4.1-beta.1", "0.4.1-beta1", "0.4.1-beta.20260824", "0.4.1-beta-2"]) {
      expect(() => assertCoreVersion(version), version).toThrow(/counted beta/);
    }
  });

  it("refuses a beta that is spelled differently rather than treating it as one", () => {
    expect(() => assertCoreVersion("0.4.1-BETA")).toThrow(/counted beta/);
  });

  // The backport candidate ADR 0023 D30 publishes carries an identifier by
  // design, and C1 binds the beta channel only. Banning every prerelease would
  // be a wider rule than the record made.
  it("leaves a backport release candidate alone", () => {
    expect(assertCoreVersion("1.2.4-rc.1").prerelease).toBe("rc.1");
  });

  it("refuses anything that is not a version at all", () => {
    for (const version of ["v0.4.1", "0.4", "0.4.1.2", "", "latest", "0.4.1 ", undefined]) {
      expect(() => assertCoreVersion(version), JSON.stringify(version)).toThrow(/unusable/);
    }
  });
});

describe("tarball naming", () => {
  it("names the archive after version and target", () => {
    expect(tarballName("0.1.0", "linux-arm64")).toBe("actana-core-0.1.0-linux-arm64.tar.gz");
  });

  it("puts everything under one directory so extraction never litters the CWD", () => {
    expect(tarballRootDirName("0.1.0", "linux-arm64")).toBe("actana-core-0.1.0-linux-arm64");
  });

  // The beta's asset name is the release's with the version it actually has —
  // no separate naming scheme, no channel segment. That is what makes a beta
  // installable the same way a release is, and what makes the two impossible
  // to confuse (ADR 0036 D20).
  it("names a beta's archive with the beta version, unchanged", () => {
    expect(tarballName("0.4.1-beta", "linux-x64")).toBe("actana-core-0.4.1-beta-linux-x64.tar.gz");
    expect(tarballRootDirName("0.4.1-beta", "linux-x64")).toBe("actana-core-0.4.1-beta-linux-x64");
  });

  it("refuses a version the build may not publish, at every surface", () => {
    // One gate, three doors: a counted beta cannot reach one of the three by a
    // path that skips the other two.
    expect(() => tarballName("0.4.1-beta.1", "linux-x64")).toThrow(/counted beta/);
    expect(() => tarballRootDirName("0.4.1-beta.1", "linux-x64")).toThrow(/counted beta/);
    expect(() =>
      buildManifest({
        version: "0.4.1-beta.1",
        protocolVersion: "0.8.0",
        target: "linux-x64",
        nodeVersion: BUNDLED_NODE_VERSION,
      }),
    ).toThrow(/counted beta/);
  });
});

describe("parseTarballName", () => {
  it("is the inverse of tarballName for every shape the build emits", () => {
    for (const [version, target] of [
      ["0.1.0", "linux-x64"],
      ["0.4.1-beta", "linux-arm64"],
      ["1.2.4-rc.1", "mac-arm64"],
    ]) {
      expect(parseTarballName(tarballName(version, target))).toEqual({ version, target });
    }
  });

  it("is null for a name this build could not have produced", () => {
    for (const name of [
      "SHA256SUMS",
      "actana-core-0.1.0-linux-x64.tar.gz.bak",
      "actana-core-0.1.0-solaris-sparc.tar.gz",
      "actana-core-0.4.1-beta.1-linux-x64.tar.gz",
      "notes.txt",
    ]) {
      expect(parseTarballName(name), name).toBeNull();
    }
  });

  // The fixture release server reads asset names off a directory to answer as
  // GitHub would, so its parser and this one are two readings of one contract
  // — `install.sh`'s (ADR 0016 D29). They may differ in what they tolerate;
  // they may not differ on what a name the build emits *means*.
  it("agrees with the fixture server's reading of the same names", () => {
    for (const [version, target] of [
      ["0.1.0", "linux-x64"],
      ["0.4.1-beta", "mac-arm64"],
    ]) {
      const name = tarballName(version, target);
      expect(parseAssetName(name)).toEqual(parseTarballName(name));
    }
  });
});

describe("assertShasumsSet", () => {
  it("reports the one version covered and the targets it covers", () => {
    expect(
      assertShasumsSet(CORE_TARGETS.map((t) => tarballName("0.4.1-beta", t.target))),
    ).toEqual({
      version: "0.4.1-beta",
      targets: ["linux-x64", "linux-arm64", "mac-arm64"],
    });
  });

  // The case this exists for. `SHA256SUMS` is one Release's asset, and a file
  // covering a beta and a release at once is the confusion ADR 0036 D20 rules
  // out — published under a single name, with no way for a downloader to tell
  // which half they verified against.
  it("refuses a set holding two versions", () => {
    expect(() =>
      assertShasumsSet([
        tarballName("0.4.1-beta", "linux-x64"),
        tarballName("0.4.1", "linux-arm64"),
      ]),
    ).toThrow(/two versions/);
  });

  it("refuses two tarballs claiming one target", () => {
    expect(() =>
      assertShasumsSet([tarballName("0.4.1", "linux-x64"), "actana-core-0.4.1-linux-x64.tar.gz"]),
    ).toThrow(/two linux-x64 tarballs/);
  });

  it("refuses a file that is not one of ours, rather than checksumming it", () => {
    expect(() => assertShasumsSet(["actana-core-0.4.1-linux-x64.tar.gz", "notes.tar.gz"])).toThrow(
      /not a Core tarball asset name/,
    );
  });

  it("refuses an empty set", () => {
    expect(() => assertShasumsSet([])).toThrow(/no Core tarballs/);
  });
});

describe("assertTarballSurfaces", () => {
  const surfaces = (over = {}) => ({
    assetName: "actana-core-0.4.1-beta-linux-x64.tar.gz",
    rootDirName: "actana-core-0.4.1-beta-linux-x64",
    manifest: buildManifest({
      version: "0.4.1-beta",
      protocolVersion: "0.8.0",
      target: "linux-x64",
      nodeVersion: BUNDLED_NODE_VERSION,
    }),
    ...over,
  });

  it("returns the version and target all three agree on", () => {
    expect(assertTarballSurfaces(surfaces())).toEqual({
      version: "0.4.1-beta",
      target: "linux-x64",
    });
  });

  // Each of these is a real published artifact that would install as something
  // other than what its name says. The first is the rename ADR 0036 D18 refuses
  // — beta bytes under a release name — and it is refused here on the bytes.
  it("refuses an archive root that disagrees with the asset name", () => {
    expect(() =>
      assertTarballSurfaces(surfaces({ assetName: "actana-core-0.4.1-linux-x64.tar.gz" })),
    ).toThrow(/asset name and the archive root disagree/);
  });

  it("refuses a manifest that disagrees about the version", () => {
    expect(() =>
      assertTarballSurfaces(
        surfaces({
          manifest: buildManifest({
            version: "0.4.1",
            protocolVersion: "0.8.0",
            target: "linux-x64",
            nodeVersion: BUNDLED_NODE_VERSION,
          }),
        }),
      ),
    ).toThrow(/disagree about the version/);
  });

  it("refuses a manifest that disagrees about the target", () => {
    expect(() =>
      assertTarballSurfaces(
        surfaces({
          manifest: buildManifest({
            version: "0.4.1-beta",
            protocolVersion: "0.8.0",
            target: "linux-arm64",
            nodeVersion: BUNDLED_NODE_VERSION,
          }),
        }),
      ),
    ).toThrow(/disagree about the target/);
  });

  it("refuses a name that is not a Core tarball's", () => {
    expect(() => assertTarballSurfaces(surfaces({ assetName: "core.tar.gz" }))).toThrow(
      /not a Core tarball asset name/,
    );
  });
});

describe("parseCoreLinkProtocolVersion", () => {
  it("reads the exported literal", () => {
    expect(parseCoreLinkProtocolVersion('export const CORE_LINK_PROTOCOL_VERSION = "1.2.3";')).toBe(
      "1.2.3",
    );
  });

  it("throws when the constant is gone", () => {
    expect(() => parseCoreLinkProtocolVersion("export const SOMETHING_ELSE = 1;")).toThrow(
      /CORE_LINK_PROTOCOL_VERSION/,
    );
  });

  it("finds the real constant in the SDK package", () => {
    // Guards the rename that would otherwise ship a stale protocol version in
    // every tarball.
    const source = fs.readFileSync(
      path.join(repoRoot, "packages", "sdk", "src", "core-link-frames.ts"),
      "utf8",
    );
    expect(parseCoreLinkProtocolVersion(source)).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("buildManifest", () => {
  it("embeds version, protocol version, target and runtime", () => {
    expect(
      buildManifest({
        version: "0.1.0",
        protocolVersion: "0.8.0",
        target: "linux-arm64",
        nodeVersion: BUNDLED_NODE_VERSION,
      }),
    ).toEqual({
      name: "actana-core",
      version: "0.1.0",
      protocolVersion: "0.8.0",
      target: "linux-arm64",
      platform: "linux",
      arch: "arm64",
      nodeVersion: BUNDLED_NODE_VERSION,
    });
  });

  it("writes a beta version through unchanged — the manifest is the third surface", () => {
    // `runActanaSetup` installs into `versions/<manifest.version>` and
    // `actana status` reports it, so this field is what a machine says it is
    // running. A beta that wrote its line here would be a machine reporting a
    // release it is not (ADR 0036 D20).
    expect(
      buildManifest({
        version: "0.4.1-beta",
        protocolVersion: "0.8.0",
        target: "linux-x64",
        nodeVersion: BUNDLED_NODE_VERSION,
      }).version,
    ).toBe("0.4.1-beta");
  });

  it("rejects an unknown target", () => {
    expect(() =>
      buildManifest({
        version: "0.1.0",
        protocolVersion: "0.8.0",
        target: "solaris-sparc",
        nodeVersion: BUNDLED_NODE_VERSION,
      }),
    ).toThrow(/unknown target/);
  });
});

describe("planDependencyLayout", () => {
  const fakeTree = (packages) => (name) => {
    const entry = packages[name];
    return entry ? { dir: `/fake/${name}`, packageJson: entry } : undefined;
  };

  const pathsByName = (planned) => Object.fromEntries(planned.map((p) => [p.name, p.installPath]));

  it("walks dependencies transitively and hoists them to the top", () => {
    const planned = planDependencyLayout(
      ["better-sqlite3"],
      fakeTree({
        "better-sqlite3": { version: "12.10.0", dependencies: { bindings: "^1.5.0" } },
        bindings: { version: "1.5.0", dependencies: { "file-uri-to-path": "1.0.0" } },
        "file-uri-to-path": { version: "1.0.0" },
      }),
    );

    expect(pathsByName(planned)).toEqual({
      "better-sqlite3": "node_modules/better-sqlite3",
      bindings: "node_modules/bindings",
      "file-uri-to-path": "node_modules/file-uri-to-path",
    });
    expect(planned[1]).toMatchObject({ sourceDir: "/fake/bindings", version: "1.5.0" });
  });

  it("ignores devDependencies", () => {
    const planned = planDependencyLayout(
      ["ws"],
      fakeTree({ ws: { version: "8.21.0", devDependencies: { vitest: "4.1.6" } } }),
    );
    expect(planned.map((p) => p.name)).toEqual(["ws"]);
  });

  it("survives a dependency cycle", () => {
    const planned = planDependencyLayout(
      ["a"],
      fakeTree({ a: { version: "1.0.0", dependencies: { b: "1" } }, b: { version: "1.0.0", dependencies: { a: "1" } } }),
    );
    expect(planned.map((p) => p.name)).toEqual(["a", "b"]);
  });

  it("throws when a dependency is not installed", () => {
    expect(() => planDependencyLayout(["missing"], fakeTree({}))).toThrow(/not installed/);
  });

  it("resolves each dependency from the package that declares it", () => {
    // pnpm's strict layout: `bindings` is only visible from better-sqlite3's
    // own directory, never from the core package.
    const resolvePackage = (name, fromDir) => {
      if (name === "better-sqlite3" && fromDir === undefined) {
        return { dir: "/store/better-sqlite3", packageJson: { version: "12.10.0", dependencies: { bindings: "^1.5.0" } } };
      }
      if (name === "bindings" && fromDir === "/store/better-sqlite3") {
        return { dir: "/store/bindings", packageJson: { version: "1.5.0" } };
      }
      return undefined;
    };

    const planned = planDependencyLayout(["better-sqlite3"], resolvePackage);
    expect(planned.find((p) => p.name === "bindings")?.sourceDir).toBe("/store/bindings");
  });

  it("nests the loser when two versions of one package are both needed", () => {
    // The real closure does this: selfsigned reaches both tslib 1 and tslib 2.
    const resolvePackage = (name, fromDir) => {
      if (name === "a") return { dir: "/store/a", packageJson: { version: "1.0.0", dependencies: { dup: "^1" } } };
      if (name === "b") return { dir: "/store/b", packageJson: { version: "1.0.0", dependencies: { dup: "^2" } } };
      if (name === "dup" && fromDir === "/store/a") return { dir: "/store/dup1", packageJson: { version: "1.0.0" } };
      if (name === "dup" && fromDir === "/store/b") return { dir: "/store/dup2", packageJson: { version: "2.0.0" } };
      return undefined;
    };

    const planned = planDependencyLayout(["a", "b"], resolvePackage);
    expect(planned.map((p) => [p.name, p.version, p.installPath])).toEqual([
      ["a", "1.0.0", "node_modules/a"],
      ["dup", "1.0.0", "node_modules/dup"],
      ["b", "1.0.0", "node_modules/b"],
      ["dup", "2.0.0", "node_modules/b/node_modules/dup"],
    ]);
  });

  it("copies a shared dependency once when the version agrees", () => {
    const resolvePackage = (name) => {
      if (name === "a") return { dir: "/store/a", packageJson: { version: "1.0.0", dependencies: { shared: "^1" } } };
      if (name === "b") return { dir: "/store/b", packageJson: { version: "1.0.0", dependencies: { shared: "^1" } } };
      return { dir: "/store/shared", packageJson: { version: "1.0.0" } };
    };

    const planned = planDependencyLayout(["a", "b"], resolvePackage);
    expect(planned.filter((p) => p.name === "shared")).toHaveLength(1);
  });

  it("drops install-time-only dependencies and their closures", () => {
    const planned = planDependencyLayout(
      ["better-sqlite3"],
      fakeTree({
        "better-sqlite3": { version: "12.10.0", dependencies: { "prebuild-install": "^7", bindings: "^1" } },
        "prebuild-install": { version: "7.1.3", dependencies: { "tunnel-agent": "^0.6.0" } },
        "tunnel-agent": { version: "0.6.0" },
        bindings: { version: "1.5.0" },
      }),
    );

    expect(planned.map((p) => p.name)).toEqual(["better-sqlite3", "bindings"]);
  });
});

// ─── Every pipeline that builds a tarball builds both bundles first ─────────
//
// `build-core-tarball.mjs` stages two files into `app/`: `core-entry.cjs` from
// `packages/core/dist` and `actana-cli.cjs` from `packages/cli/dist-tarball`
// (#288 D1). It fails loudly without either, which is the enforcing line the
// issue names — but only if something built them, and nothing in the pipeline
// did. Both release-tarball jobs and `pnpm core:tarball` ran
// `pnpm --filter @actana/core build` and stopped, so every tarball leg went red
// the moment the CLI's bundle moved out of the Core package.
//
// So the pair has one name — `build:core-tarball-bundles` — and this asserts
// that every caller uses it rather than spelling the two filters out again. A
// third package added to the tarball later changes one script; a workflow that
// went back to building one of them fails here instead of in a release.

describe("the tarball's bundles are built by one named script", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const BUNDLE_SCRIPT = "build:core-tarball-bundles";

  it("names both packages the tarball stages from", () => {
    const script = manifest.scripts[BUNDLE_SCRIPT];
    expect(script, `package.json has no \`${BUNDLE_SCRIPT}\` script`).toBeDefined();
    expect(script).toContain("@actana/core");
    expect(script).toContain("@actana/cli");
  });

  it("is what `core:tarball` runs before the builder", () => {
    const script = manifest.scripts["core:tarball"];
    expect(script).toContain(BUNDLE_SCRIPT);
    expect(script).toContain("scripts/build-core-tarball.mjs");
    // The order matters and a substring check cannot see it.
    expect(script.indexOf(BUNDLE_SCRIPT)).toBeLessThan(script.indexOf("build-core-tarball.mjs"));
  });

  it("is what every workflow that calls the builder directly runs first", () => {
    // `pnpm core:tarball` covers ci.yml, container-image.yml and
    // housekeeping.yml. `release.yml` is the one that calls the builder itself,
    // in two jobs, and it is the leg that actually ships a tarball — so it is
    // the one this most needs to hold.
    const workflows = fs
      .readdirSync(path.join(repoRoot, ".github", "workflows"))
      .filter((name) => name.endsWith(".yml"));

    let checked = 0;
    for (const name of workflows) {
      const text = fs.readFileSync(path.join(repoRoot, ".github", "workflows", name), "utf8");
      if (!text.includes("scripts/build-core-tarball.mjs")) continue;
      checked += 1;
      expect(
        text.includes(`pnpm ${BUNDLE_SCRIPT}`),
        `${name} runs scripts/build-core-tarball.mjs without \`pnpm ${BUNDLE_SCRIPT}\` first`,
      ).toBe(true);
      expect(
        /pnpm --filter @actana\/core build\b/.test(text),
        `${name} still builds only the Core's bundle — the tarball needs the CLI's too`,
      ).toBe(false);
    }
    // The guard on the guard: a rename of the builder would make the loop above
    // sweep nothing and pass.
    expect(checked, "no workflow calls scripts/build-core-tarball.mjs any more").toBeGreaterThan(0);
  });
});
