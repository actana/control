// The parts of the tarball's offline smoke that need no Core (#580 T-405): reading what an extracted
// tarball inlined, and holding it to the manifests' pins and the manifest's protocol.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  assertExtractedTarballPins,
  bundledProtocolVersions,
  classifySessionStart,
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

describe("classifySessionStart", () => {
  it("is refused when the Core refuses to spawn the harness, whatever the reason", () => {
    for (const reason of ["binary-not-found", "permission-denied"]) {
      expect(classifySessionStart({ status: 1, stderr: `actana session start: pty:spawn rejected (${reason})` })).toEqual({ kind: "refused" });
    }
  });

  it("is started, with its id, when a harness exists and a Session came up", () => {
    expect(classifySessionStart({ status: 0, stdout: "t-abc123\n" })).toEqual({ kind: "started", id: "t-abc123" });
  });

  it("is unexpected for any other failure, so a broken CLI is not mistaken for a missing harness", () => {
    expect(classifySessionStart({ status: 1, stderr: "certificate signature failure" }).kind).toBe("unexpected");
    expect(classifySessionStart({ status: 2, stderr: "unknown flag" }).kind).toBe("unexpected");
    expect(classifySessionStart({ status: 0, stdout: "" }).kind).toBe("unexpected");
  });
});

// The image smoke only really runs after a PR is ready, and nothing runs it locally (it needs Docker), so
// what it runs is pinned here: #645 named session ls, session start --await-prompt, events and files as the
// verbs it has to judge (#646 R1 of #648).
describe("scripts/smoke-core-image.mjs runs the bundled actana's verbs in the image", () => {
  const source = fs.readFileSync(path.join(repoRoot, "scripts", "smoke-core-image.mjs"), "utf8");

  it.each([
    ['"session", "ls"'],
    ['"session", "start", "--await-prompt"'],
    ['"events", "tail"'],
    ['["files", "ls"]'],
    ['["shared", "ls"]'],
  ])("runs %s as core", (needle) => {
    expect(source).toContain(needle);
  });

  it("goes through the same session-start classifier as the tarball smoke", () => {
    expect(source).toContain("classifySessionStart");
  });
});
