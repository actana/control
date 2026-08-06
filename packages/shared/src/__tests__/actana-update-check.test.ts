import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  checkForUpdate,
  updateCheckEnabled,
  UPDATE_CHECK_TTL_MS,
  type LatestReleaseFetcher,
} from "../actana-update-check";
import { releaseChannel } from "../actana-release-channel";

/** A fetcher whose every answer is scripted, and which counts its calls. */
function fakeFetcher(answer: () => Promise<string>): LatestReleaseFetcher & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    fetchText(url) {
      calls.push(url);
      return answer();
    },
  };
}

const release = (tag: string) => () => Promise.resolve(JSON.stringify({ tag_name: tag }));
const notFound = () => Promise.reject(new Error("HTTP 404 Not Found"));

let dir: string;
let cachePath: string;
const T0 = 1_700_000_000_000;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "actana-update-check-"));
  cachePath = path.join(dir, "state", "update-check.json");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function check(over: Partial<Parameters<typeof checkForUpdate>[0]> = {}) {
  return checkForUpdate({
    current: "0.1.0",
    fetcher: fakeFetcher(release("v0.2.0")),
    cachePath,
    now: () => T0,
    env: {},
    ...over,
  });
}

// The live path until 0.1.0 ships: `releases/latest` 404s because the
// repository has published nothing yet.
describe("failing silently", () => {
  it("reports no update when the channel has no releases", async () => {
    const debug: string[] = [];
    const result = await check({ fetcher: fakeFetcher(notFound), debug: (m) => debug.push(m) });

    expect(result).toEqual({ current: "0.1.0", latest: null, updateAvailable: false });
    expect(debug.join("\n")).toContain("404");
  });

  it("reports no update when the request never answers", async () => {
    const result = await check({
      fetcher: fakeFetcher(() => new Promise<string>(() => {})),
      timeoutMs: 5,
    });
    expect(result.updateAvailable).toBe(false);
    expect(result.latest).toBeNull();
  });

  it("reports no update when the answer is not a release payload", async () => {
    const rateLimited = () =>
      Promise.resolve(JSON.stringify({ message: "API rate limit exceeded" }));
    expect(await check({ fetcher: fakeFetcher(rateLimited) })).toMatchObject({
      latest: null,
      updateAvailable: false,
    });
  });

  it("reports no update when the body is not JSON at all", async () => {
    expect(await check({ fetcher: fakeFetcher(() => Promise.resolve("<html>502</html>")) }))
      .toMatchObject({ latest: null, updateAvailable: false });
  });

  it("still answers when the cache directory cannot be written", async () => {
    const unwritable = path.join(dir, "not-a-dir");
    fs.writeFileSync(unwritable, "");
    const result = await check({ cachePath: path.join(unwritable, "update-check.json") });
    expect(result.updateAvailable).toBe(true);
  });
});

describe("the answer", () => {
  it("alerts when the channel published something newer", async () => {
    expect(await check()).toEqual({
      current: "0.1.0",
      latest: "0.2.0",
      updateAvailable: true,
    });
  });

  it("stays quiet when the newest release is the installed one", async () => {
    expect(await check({ fetcher: fakeFetcher(release("v0.1.0")) })).toMatchObject({
      latest: "0.1.0",
      updateAvailable: false,
    });
  });

  // `releases/latest` excludes prereleases, so a published 0.1.0 is what a
  // 0.2.0-rc.1 install sees — and it is not an update.
  it("stays quiet when the install is ahead of the published release", async () => {
    expect(
      await check({ current: "0.2.0-rc.1", fetcher: fakeFetcher(release("v0.1.0")) }),
    ).toMatchObject({ latest: "0.1.0", updateAvailable: false });
  });

  it("asks the channel the URL install.sh resolves", async () => {
    const fetcher = fakeFetcher(release("v0.2.0"));
    await check({ fetcher });
    expect(fetcher.calls).toEqual(["https://api.github.com/repos/actana/control/releases/latest"]);
  });

  it("asks a fixture server when one is named", async () => {
    const fetcher = fakeFetcher(release("v0.2.0"));
    await check({ fetcher, channel: releaseChannel({ baseUrl: "http://127.0.0.1:9099" }) });
    expect(fetcher.calls).toEqual([
      "http://127.0.0.1:9099/repos/actana/control/releases/latest",
    ]);
  });
});

describe("the daily cache", () => {
  it("asks the channel once and answers the rest of the day from disk", async () => {
    const fetcher = fakeFetcher(release("v0.2.0"));
    await check({ fetcher });
    const again = await check({ fetcher, now: () => T0 + UPDATE_CHECK_TTL_MS - 1 });

    expect(fetcher.calls).toHaveLength(1);
    expect(again).toMatchObject({ latest: "0.2.0", updateAvailable: true });
  });

  it("asks again once a day has passed", async () => {
    const fetcher = fakeFetcher(release("v0.2.0"));
    await check({ fetcher });
    await check({ fetcher, now: () => T0 + UPDATE_CHECK_TTL_MS });
    expect(fetcher.calls).toHaveLength(2);
  });

  // The whole point of caching the failures too: a 404 that re-asked every
  // time would spend the unauthenticated rate limit on nothing.
  it("caches a failure as firmly as an answer", async () => {
    const fetcher = fakeFetcher(notFound);
    await check({ fetcher });
    await check({ fetcher, now: () => T0 + 60_000 });
    expect(fetcher.calls).toHaveLength(1);
  });

  it("re-asks when the cache file is corrupt", async () => {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, "{ not json");
    const fetcher = fakeFetcher(release("v0.2.0"));
    expect(await check({ fetcher })).toMatchObject({ updateAvailable: true });
    expect(fetcher.calls).toHaveLength(1);
  });

  it("re-asks when the cache was written in the future", async () => {
    const fetcher = fakeFetcher(release("v0.2.0"));
    await check({ fetcher, now: () => T0 });
    await check({ fetcher, now: () => T0 - 60_000 });
    expect(fetcher.calls).toHaveLength(2);
  });
});

describe("the opt-out", () => {
  it("is on by default", () => {
    expect(updateCheckEnabled({})).toBe(true);
    expect(updateCheckEnabled({ ACTANA_UPDATE_CHECK: "1" })).toBe(true);
  });

  it.each(["0", "false", "off", "OFF", " off "])("is off for %j", (value) => {
    expect(updateCheckEnabled({ ACTANA_UPDATE_CHECK: value })).toBe(false);
  });

  it("makes no request and reports nothing when disabled", async () => {
    const fetcher = fakeFetcher(release("v0.2.0"));
    const result = await check({ fetcher, env: { ACTANA_UPDATE_CHECK: "0" } });

    expect(result).toEqual({ current: "0.1.0", latest: null, updateAvailable: false });
    expect(fetcher.calls).toEqual([]);
    expect(fs.existsSync(cachePath)).toBe(false);
  });
});
