import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  DEFAULT_API_BASE,
  DEFAULT_DOWNLOAD_BASE,
  DEFAULT_REPO,
  SHASUMS_ASSET,
  assetUrl,
  parseLatestTag,
  parseShasums,
  releaseAssetName,
  releaseChannel,
  releaseTargetFor,
  resolveReleaseVersion,
  sha256OfFile,
  type ReleaseFetcher,
} from "../actana-release";

/** A fetcher that answers a fixed map of URLs and records what was asked for. */
function fakeFetcher(texts: Record<string, string>) {
  const asked: string[] = [];
  const fetcher: ReleaseFetcher & { asked: string[] } = {
    asked,
    async fetchText(url) {
      asked.push(url);
      const body = texts[url];
      if (body === undefined) throw new Error(`404 ${url}`);
      return body;
    },
    async download(url) {
      asked.push(url);
      throw new Error(`unexpected download: ${url}`);
    },
  };
  return fetcher;
}

describe("release targets", () => {
  it.each([
    ["linux", "x64", "linux-x64"],
    ["linux", "arm64", "linux-arm64"],
    ["darwin", "arm64", "mac-arm64"],
    ["darwin", "x64", "mac-x64"],
  ])("maps %s/%s to the %s build", (platform, arch, target) => {
    expect(releaseTargetFor(platform as NodeJS.Platform, arch)).toBe(target);
  });

  it("has no build for a platform Cores do not run on", () => {
    expect(releaseTargetFor("win32", "x64")).toBeNull();
    expect(releaseTargetFor("linux", "ppc64")).toBeNull();
  });

  it("names the asset the way the release workflow does", () => {
    expect(releaseAssetName("0.50.0", "linux-arm64")).toBe(
      "actana-harness-0.50.0-linux-arm64.tar.gz",
    );
  });
});

describe("the release channel", () => {
  it("defaults to the project's GitHub releases", () => {
    const channel = releaseChannel({});
    expect(channel.repo).toBe(DEFAULT_REPO);
    expect(channel.apiBase).toBe(DEFAULT_API_BASE);
    expect(channel.downloadBase).toBe(DEFAULT_DOWNLOAD_BASE);
  });

  it("points both hosts at one base URL, so a fixture can stand in for GitHub", () => {
    const channel = releaseChannel({ baseUrl: "http://localhost:8788/" });
    expect(channel.apiBase).toBe("http://localhost:8788");
    expect(channel.downloadBase).toBe("http://localhost:8788");
  });

  it("builds the asset URL the release workflow publishes to", () => {
    const channel = releaseChannel({ repo: "acme/cores", baseUrl: "http://h:1" });
    expect(assetUrl(channel, "1.2.3", SHASUMS_ASSET)).toBe(
      "http://h:1/acme/cores/releases/download/v1.2.3/SHA256SUMS",
    );
  });
});

describe("parsing the releases API", () => {
  it("reads the tag, with or without the leading v", () => {
    expect(parseLatestTag(JSON.stringify({ tag_name: "v0.50.0" }))).toBe("0.50.0");
    expect(parseLatestTag(JSON.stringify({ tag_name: "0.50.0" }))).toBe("0.50.0");
  });

  it("returns null rather than guessing when the answer is not a release", () => {
    expect(parseLatestTag("not json")).toBeNull();
    expect(parseLatestTag(JSON.stringify({ message: "Not Found" }))).toBeNull();
    expect(parseLatestTag(JSON.stringify({ tag_name: "" }))).toBeNull();
  });
});

describe("parsing SHA256SUMS", () => {
  const digest = "a".repeat(64);

  it("reads both the coreutils and the shasum binary-mode spellings", () => {
    const sums = parseShasums(
      `${digest}  actana-harness-1.0.0-linux-x64.tar.gz\n` +
        `${"b".repeat(64)} *actana-harness-1.0.0-mac-arm64.tar.gz\n`,
    );
    expect(sums.get("actana-harness-1.0.0-linux-x64.tar.gz")).toBe(digest);
    expect(sums.get("actana-harness-1.0.0-mac-arm64.tar.gz")).toBe("b".repeat(64));
  });

  it("ignores blank lines and anything that is not a digest line", () => {
    const sums = parseShasums(`\n# a comment\n${digest}  one.tar.gz\nnonsense\n`);
    expect([...sums.keys()]).toEqual(["one.tar.gz"]);
  });

  it("lowercases digests so a hand-written uppercase file still matches", () => {
    expect(parseShasums(`${"A".repeat(64)}  one.tar.gz`).get("one.tar.gz")).toBe("a".repeat(64));
  });
});

describe("digesting a downloaded file", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "actana-release-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("matches the digest the release workflow publishes", () => {
    const file = path.join(tmp, "asset.tar.gz");
    fs.writeFileSync(file, "some bytes");
    expect(sha256OfFile(file)).toBe(createHash("sha256").update("some bytes").digest("hex"));
  });
});

describe("resolving which version to install", () => {
  const channel = releaseChannel({ baseUrl: "http://h:1" });
  const latestUrl = "http://h:1/repos/actana/control/releases/latest";

  it("asks the API for the latest release when no version is pinned", async () => {
    const fetcher = fakeFetcher({ [latestUrl]: JSON.stringify({ tag_name: "v0.51.0" }) });
    expect(await resolveReleaseVersion(fetcher, channel)).toBe("0.51.0");
  });

  it("does not call the API at all for a pinned version", async () => {
    const fetcher = fakeFetcher({});
    expect(await resolveReleaseVersion(fetcher, channel, "v0.49.0")).toBe("0.49.0");
    expect(fetcher.asked).toEqual([]);
  });

  it("explains an unreachable release channel instead of surfacing a fetch error", async () => {
    const fetcher = fakeFetcher({});
    await expect(resolveReleaseVersion(fetcher, channel)).rejects.toThrow(/releases\/latest/);
  });

  it("says so when the answer carries no release tag", async () => {
    const fetcher = fakeFetcher({ [latestUrl]: JSON.stringify({ message: "Not Found" }) });
    await expect(resolveReleaseVersion(fetcher, channel)).rejects.toThrow(/no release tag/i);
  });
});
