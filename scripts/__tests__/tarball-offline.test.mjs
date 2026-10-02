// The parts of the tarball's offline smoke that need no Core (#580 T-405): reading what an extracted
// tarball inlined, and holding it to the manifests' pins and the manifest's protocol.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  assertExtractedTarballPins,
  bundledProtocolVersions,
  protocolFromVersionLine,
} from "../lib/tarball-offline.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const store = (pkg, version) => `../../../node_modules/.pnpm/${pkg.replace("/", "+")}@${version}_pg@8.23.0/node_modules/${pkg}/src/x.ts`;
const pin = (name) =>
  JSON.parse(fs.readFileSync(path.join(repoRoot, "packages", "cli", "package.json"), "utf8")).dependencies[name];

/** A fake extracted tarball: `app/<bundle>.map` for each bundle, and the bundles' protocol literals. */
function fakeTarball({ cli = pin("@actana/cli"), sdk = pin("@actana/sdk"), protocol = "0.19.0" } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fake-tarball-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, "app"));
  for (const file of ["actana-cli.cjs", "core-entry.cjs"]) {
    fs.writeFileSync(
      path.join(root, "app", `${file}.map`),
      JSON.stringify({ version: 3, sources: [store("@actana/cli", cli), store("@actana/sdk", sdk)] }),
    );
    fs.writeFileSync(path.join(root, "app", file), `var CORE_LINK_PROTOCOL_VERSION = "${protocol}";\n`);
  }
  return root;
}

describe("protocolFromVersionLine", () => {
  it("reads the protocol out of `actana --version`", () => {
    expect(protocolFromVersionLine("actana 0.5.0 (core-link protocol 0.19.0)\n")).toBe("0.19.0");
  });
  it("is null for a version line without one", () => {
    expect(protocolFromVersionLine("actana 0.5.0\n")).toBeNull();
  });
});

describe("assertExtractedTarballPins", () => {
  it("agrees for a tarball built from the pinned versions", () => {
    expect(assertExtractedTarballPins(fakeTarball(), repoRoot)).toEqual({
      "@actana/cli": pin("@actana/cli"),
      "@actana/sdk": pin("@actana/sdk"),
    });
  });

  it("fails for a tarball that inlined another @actana/cli than the manifests pin", () => {
    expect(() => assertExtractedTarballPins(fakeTarball({ cli: "0.6.0-next.9" }), repoRoot)).toThrow(
      /inlines @actana\/cli@0\.6\.0-next\.9 but .* is pinned/,
    );
  });

  it("fails for a tarball that inlined another @actana/sdk than the manifests pin", () => {
    expect(() => assertExtractedTarballPins(fakeTarball({ sdk: "0.5.0" }), repoRoot)).toThrow(
      /inlines @actana\/sdk@0\.5\.0 but .* is pinned/,
    );
  });

  it("fails for a tarball with no source map to read", () => {
    const root = fakeTarball();
    fs.rmSync(path.join(root, "app", "actana-cli.cjs.map"));
    expect(() => assertExtractedTarballPins(root, repoRoot)).toThrow(/no app\/actana-cli\.cjs\.map/);
  });
});

describe("bundledProtocolVersions", () => {
  it("reads the literal each bundle carries, so a mismatch with the manifest can be named", () => {
    expect(bundledProtocolVersions(fakeTarball({ protocol: "0.18.0" }))).toEqual({
      "actana-cli.cjs": "0.18.0",
      "core-entry.cjs": "0.18.0",
    });
  });
});
