import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import {
  BUNDLED_NODE_VERSION,
  CORE_RUNTIME_DEPENDENCIES,
  CORE_TARGETS,
  UNBUNDLED_EXTERNALS,
  buildManifest,
  findTarget,
  formatShasums,
  hostTarget,
  nodeDistDirName,
  nodeDistShasumsUrl,
  nodeDistTarballUrl,
  parseCoreLinkProtocolVersion,
  parseShasums,
  planDependencyLayout,
  prebuildDirName,
  tarballName,
  tarballRootDirName,
} from "../lib/core-tarball.mjs";

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

describe("tarball naming", () => {
  it("names the archive after version and target", () => {
    expect(tarballName("0.1.0", "linux-arm64")).toBe("actana-core-0.1.0-linux-arm64.tar.gz");
  });

  it("puts everything under one directory so extraction never litters the CWD", () => {
    expect(tarballRootDirName("0.1.0", "linux-arm64")).toBe("actana-core-0.1.0-linux-arm64");
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
