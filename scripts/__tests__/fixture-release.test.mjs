// The fixture release server stands in for GitHub Releases in every installer
// test, so the shapes it serves are load-bearing: a fixture that answers
// `latest` with the wrong release, or that serves a SHA256SUMS not derived
// from the bytes it hands out, would turn the installer suite green while the
// real thing is broken.
//
// The routing and indexing are asserted directly; the server itself is
// asserted over a socket, because "does the installer's fetch reach the right
// bytes" is the question and nothing below HTTP can answer it.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  DEFAULT_REPO,
  SHASUMS_ASSET,
  compareVersions,
  indexReleases,
  parseAssetName,
  releaseJson,
  routeFixtureRequest,
  startFixtureReleaseServer,
  writeStubRelease,
} from "../lib/fixture-release.mjs";
import { parseShasums, tarballName } from "../lib/harness-tarball.mjs";

describe("parseAssetName", () => {
  it("is the inverse of tarballName for every shape the build emits", () => {
    for (const [version, target] of [
      ["0.49.0", "linux-x64"],
      ["1.0.0", "mac-arm64"],
      ["1.2.3-rc.1", "linux-arm64"],
    ]) {
      expect(parseAssetName(tarballName(version, target))).toEqual({ version, target });
    }
  });

  it("ignores files that are not release tarballs", () => {
    for (const name of ["SHA256SUMS", "actana-harness-0.49.0-linux-x64.tar.gz.bak", "notes.txt"]) {
      expect(parseAssetName(name)).toBeNull();
    }
  });
});

describe("compareVersions", () => {
  it("orders numerically, not lexically", () => {
    expect(compareVersions("0.9.0", "0.10.0")).toBe(-1);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("2.0.0", "1.99.99")).toBe(1);
  });

  it("sorts a prerelease before the release it leads to", () => {
    expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBe(-1);
    expect(compareVersions("1.0.0-rc.1", "1.0.0-rc.2")).toBe(-1);
  });
});

describe("indexReleases", () => {
  it("groups tarballs by version, oldest first", () => {
    const index = indexReleases([
      tarballName("0.50.0", "linux-x64"),
      tarballName("0.49.0", "linux-x64"),
      tarballName("0.49.0", "mac-arm64"),
      "SHA256SUMS",
    ]);
    expect(index.map((r) => r.version)).toEqual(["0.49.0", "0.50.0"]);
    expect([...index[0].assets.keys()].sort()).toEqual(["linux-x64", "mac-arm64"]);
  });
});

describe("routeFixtureRequest", () => {
  const repo = DEFAULT_REPO;

  it("recognises the two release-API paths the installer uses", () => {
    expect(routeFixtureRequest(`/repos/${repo}/releases/latest`, repo)).toEqual({ kind: "latest" });
    expect(routeFixtureRequest(`/repos/${repo}/releases/tags/v0.49.0`, repo)).toEqual({
      kind: "tag",
      tag: "v0.49.0",
    });
  });

  it("recognises asset downloads", () => {
    expect(
      routeFixtureRequest(`/${repo}/releases/download/v0.49.0/${SHASUMS_ASSET}`, repo),
    ).toEqual({ kind: "asset", tag: "v0.49.0", asset: SHASUMS_ASSET });
  });

  it("serves the bootstrapper itself", () => {
    expect(routeFixtureRequest("/install.sh", repo)).toEqual({ kind: "script" });
  });

  it("refuses another repository's paths", () => {
    expect(routeFixtureRequest("/someone/else/releases/latest", repo).kind).toBe("not-found");
  });
});

describe("releaseJson", () => {
  it("lists the checksum asset alongside the tarballs", () => {
    const json = releaseJson({
      repo: DEFAULT_REPO,
      version: "0.49.0",
      assets: new Map([["linux-x64", tarballName("0.49.0", "linux-x64")]]),
      baseUrl: "http://127.0.0.1:9999",
    });
    expect(json.tag_name).toBe("v0.49.0");
    expect(json.assets.map((a) => a.name)).toEqual([SHASUMS_ASSET, tarballName("0.49.0", "linux-x64")]);
    expect(json.assets[0].browser_download_url).toBe(
      `http://127.0.0.1:9999/${DEFAULT_REPO}/releases/download/v0.49.0/${SHASUMS_ASSET}`,
    );
  });
});

describe("the fixture server", () => {
  let dir;
  let server;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "actana-fixture-release-"));
    for (const version of ["0.49.0", "0.50.0"]) {
      writeStubRelease({ dir, version, target: "linux-x64", script: "#!/bin/sh\nexit 0\n" });
    }
    server = await startFixtureReleaseServer({
      dir,
      corruptAssets: [tarballName("0.49.0", "linux-x64")],
    });
  });

  afterAll(async () => {
    await server?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const get = async (urlPath) => {
    const response = await fetch(`${server.url}${urlPath}`);
    return { status: response.status, body: Buffer.from(await response.arrayBuffer()) };
  };

  it("answers `latest` with the highest version present", async () => {
    const { status, body } = await get(`/repos/${DEFAULT_REPO}/releases/latest`);
    expect(status).toBe(200);
    expect(JSON.parse(body.toString()).tag_name).toBe("v0.50.0");
  });

  it("answers a pinned tag with that exact release", async () => {
    const { body } = await get(`/repos/${DEFAULT_REPO}/releases/tags/v0.49.0`);
    expect(JSON.parse(body.toString()).tag_name).toBe("v0.49.0");
  });

  it("404s a tag it has no tarball for", async () => {
    expect((await get(`/repos/${DEFAULT_REPO}/releases/tags/v9.9.9`)).status).toBe(404);
  });

  it("derives SHA256SUMS from the bytes on disk", async () => {
    const name = tarballName("0.50.0", "linux-x64");
    const { body } = await get(`/${DEFAULT_REPO}/releases/download/v0.50.0/${SHASUMS_ASSET}`);
    const digests = parseShasums(body.toString());
    const { createHash } = await import("node:crypto");
    const onDisk = createHash("sha256").update(fs.readFileSync(path.join(dir, name))).digest("hex");
    expect(digests.get(name)).toBe(onDisk);
  });

  it("serves a corrupted asset that no longer matches its published digest", async () => {
    const name = tarballName("0.49.0", "linux-x64");
    const { body: served } = await get(`/${DEFAULT_REPO}/releases/download/v0.49.0/${name}`);
    const { body: sums } = await get(`/${DEFAULT_REPO}/releases/download/v0.49.0/${SHASUMS_ASSET}`);
    const { createHash } = await import("node:crypto");
    expect(createHash("sha256").update(served).digest("hex")).not.toBe(
      parseShasums(sums.toString()).get(name),
    );
  });

  it("records what was asked for, so a test can assert what was never fetched", async () => {
    await get("/nope");
    expect(server.requests).toContain("/nope");
  });
});
