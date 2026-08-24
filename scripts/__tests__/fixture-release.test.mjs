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
  isPrerelease,
  latestRelease,
  parseAssetName,
  releaseJson,
  routeFixtureRequest,
  startFixtureReleaseServer,
  writeStubRelease,
} from "../lib/fixture-release.mjs";
import { parseShasums, tarballName } from "../lib/core-tarball.mjs";

describe("parseAssetName", () => {
  it("is the inverse of tarballName for every shape the build emits", () => {
    for (const [version, target] of [
      ["0.1.0", "linux-x64"],
      ["1.0.0", "mac-arm64"],
      ["1.2.3-rc.1", "linux-arm64"],
    ]) {
      expect(parseAssetName(tarballName(version, target))).toEqual({ version, target });
    }
  });

  it("ignores files that are not release tarballs", () => {
    for (const name of ["SHA256SUMS", "actana-core-0.1.0-linux-x64.tar.gz.bak", "notes.txt"]) {
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

// `/releases/latest` excludes prereleases, and that exclusion is the whole
// reason ADR 0036 D2 stopped making it the installer's default: a beta could
// never be found through it. The fixture has to exclude them for the same
// reason a `uname` shim has to answer like `uname` — a fixture more generous
// than the real endpoint would let a beta install pass here and fail on
// github.com.
describe("latestRelease", () => {
  const index = (versions) =>
    indexReleases(versions.map((version) => tarballName(version, "linux-x64")));

  it("skips prereleases, however new they are", () => {
    expect(latestRelease(index(["0.1.0", "0.2.0", "0.3.0-beta"])).version).toBe("0.2.0");
    expect(latestRelease(index(["0.1.0", "9.9.0-beta"])).version).toBe("0.1.0");
  });

  it("answers the newest release when there is no prerelease to skip", () => {
    expect(latestRelease(index(["0.1.0", "0.2.0"])).version).toBe("0.2.0");
  });

  it("has no answer at all for a repository that has published only betas", () => {
    // A young line, before its first release: GitHub's endpoint 404s here, and
    // so does the fixture, which is what sends `install.sh` into the failure
    // path rather than into a prerelease it never asked for.
    expect(latestRelease(index(["0.9.0-beta", "1.0.0-beta"]))).toBeUndefined();
  });

  it("calls exactly the `-suffix` versions prereleases", () => {
    expect(isPrerelease("0.4.1-beta")).toBe(true);
    expect(isPrerelease("1.2.3-rc.1")).toBe(true);
    expect(isPrerelease("0.4.1")).toBe(false);
  });
});

describe("indexReleases", () => {
  it("groups tarballs by version, oldest first", () => {
    const index = indexReleases([
      tarballName("0.2.0", "linux-x64"),
      tarballName("0.1.0", "linux-x64"),
      tarballName("0.1.0", "mac-arm64"),
      "SHA256SUMS",
    ]);
    expect(index.map((r) => r.version)).toEqual(["0.1.0", "0.2.0"]);
    expect([...index[0].assets.keys()].sort()).toEqual(["linux-x64", "mac-arm64"]);
  });
});

describe("routeFixtureRequest", () => {
  const repo = DEFAULT_REPO;

  it("recognises the two release-API paths the installer uses", () => {
    expect(routeFixtureRequest(`/repos/${repo}/releases/latest`, repo)).toEqual({ kind: "latest" });
    expect(routeFixtureRequest(`/repos/${repo}/releases/tags/v0.1.0`, repo)).toEqual({
      kind: "tag",
      tag: "v0.1.0",
    });
  });

  it("recognises asset downloads", () => {
    expect(
      routeFixtureRequest(`/${repo}/releases/download/v0.1.0/${SHASUMS_ASSET}`, repo),
    ).toEqual({ kind: "asset", tag: "v0.1.0", asset: SHASUMS_ASSET });
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
      version: "0.1.0",
      assets: new Map([["linux-x64", tarballName("0.1.0", "linux-x64")]]),
      baseUrl: "http://127.0.0.1:9999",
    });
    expect(json.tag_name).toBe("v0.1.0");
    expect(json.assets.map((a) => a.name)).toEqual([SHASUMS_ASSET, tarballName("0.1.0", "linux-x64")]);
    expect(json.assets[0].browser_download_url).toBe(
      `http://127.0.0.1:9999/${DEFAULT_REPO}/releases/download/v0.1.0/${SHASUMS_ASSET}`,
    );
  });
});

describe("the fixture server", () => {
  let dir;
  let server;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "actana-fixture-release-"));
    for (const version of ["0.1.0", "0.2.0"]) {
      writeStubRelease({ dir, version, target: "linux-x64", script: "#!/bin/sh\nexit 0\n" });
    }
    server = await startFixtureReleaseServer({
      dir,
      corruptAssets: [tarballName("0.1.0", "linux-x64")],
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
    expect(JSON.parse(body.toString()).tag_name).toBe("v0.2.0");
  });

  it("answers a beta on its own tag, and never on `latest`", async () => {
    // The two halves of ADR 0036 D2 over a socket: step 3 reaches a beta by
    // naming its tag, and step 4 cannot reach one at all. Both matter — the
    // first is how a train installs, the second is why the public one-liner
    // does not become a beta installer the day a beta is published.
    writeStubRelease({
      dir,
      version: "0.3.0-beta",
      target: "linux-x64",
      script: "#!/bin/sh\nexit 0\n",
    });

    const tagged = await get(`/repos/${DEFAULT_REPO}/releases/tags/v0.3.0-beta`);
    expect(tagged.status).toBe(200);
    const json = JSON.parse(tagged.body.toString());
    expect(json.tag_name).toBe("v0.3.0-beta");
    expect(json.prerelease).toBe(true);

    const latest = await get(`/repos/${DEFAULT_REPO}/releases/latest`);
    expect(JSON.parse(latest.body.toString()).tag_name).toBe("v0.2.0");
  });

  it("answers a pinned tag with that exact release", async () => {
    const { body } = await get(`/repos/${DEFAULT_REPO}/releases/tags/v0.1.0`);
    expect(JSON.parse(body.toString()).tag_name).toBe("v0.1.0");
  });

  it("404s a tag it has no tarball for", async () => {
    expect((await get(`/repos/${DEFAULT_REPO}/releases/tags/v9.9.9`)).status).toBe(404);
  });

  it("derives SHA256SUMS from the bytes on disk", async () => {
    const name = tarballName("0.2.0", "linux-x64");
    const { body } = await get(`/${DEFAULT_REPO}/releases/download/v0.2.0/${SHASUMS_ASSET}`);
    const digests = parseShasums(body.toString());
    const { createHash } = await import("node:crypto");
    const onDisk = createHash("sha256").update(fs.readFileSync(path.join(dir, name))).digest("hex");
    expect(digests.get(name)).toBe(onDisk);
  });

  it("serves a corrupted asset that no longer matches its published digest", async () => {
    const name = tarballName("0.1.0", "linux-x64");
    const { body: served } = await get(`/${DEFAULT_REPO}/releases/download/v0.1.0/${name}`);
    const { body: sums } = await get(`/${DEFAULT_REPO}/releases/download/v0.1.0/${SHASUMS_ASSET}`);
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
