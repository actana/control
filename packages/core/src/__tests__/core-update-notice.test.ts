import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { UPDATE_CHECK_TTL_MS } from "@actana/shared/actana-update-check";
import { runUpdateNotice, type UpdateNoticeDeps } from "../core-update-notice";

let dir: string;
let logged: string[];
const NOW = 1_700_000_000_000;

const answering = (tag: string | null) => ({
  fetchText: async () => {
    if (tag === null) throw new Error("HTTP 404 Not Found");
    return JSON.stringify({ tag_name: `v${tag}` });
  },
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "core-update-notice-"));
  logged = [];
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function notice(over: Partial<UpdateNoticeDeps> = {}): Promise<void> {
  return runUpdateNotice({
    current: "0.1.0",
    fetcher: answering("0.2.0"),
    cachePath: path.join(dir, "update-check.json"),
    noticePath: path.join(dir, "update-notice.json"),
    env: {},
    now: () => NOW,
    log: (message) => logged.push(message),
    remedy: "actana update",
    ...over,
  });
}

describe("the daemon's update notice", () => {
  it("names the release, this Core's version, and the command to run", async () => {
    await notice();
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("Actana 0.2.0 is available");
    expect(logged[0]).toContain("on 0.1.0");
    expect(logged[0]).toContain("actana update");
  });

  it("names the compose commands when the Core is a container", async () => {
    await notice({ remedy: "docker compose pull && docker compose up -d" });
    expect(logged[0]).toContain("docker compose pull && docker compose up -d");
  });

  // Everything uninteresting is silent — a daily line that says nothing is a
  // line operators learn to skip.
  it("says nothing when this Core is already current", async () => {
    await notice({ fetcher: answering("0.1.0") });
    expect(logged).toEqual([]);
  });

  it("says nothing when the channel has published no releases", async () => {
    await notice({ fetcher: answering(null) });
    expect(logged).toEqual([]);
  });

  it("says nothing, and asks nothing, when the operator opted out", async () => {
    let asked = 0;
    await notice({
      env: { ACTANA_UPDATE_CHECK: "off" },
      fetcher: {
        fetchText: async () => {
          asked += 1;
          return JSON.stringify({ tag_name: "v0.2.0" });
        },
      },
    });
    expect(logged).toEqual([]);
    expect(asked).toBe(0);
  });

  // The daemon and the CLI share one cache file, so a Core restarting in a
  // loop cannot turn into a request loop.
  it("reuses the cached answer rather than asking again", async () => {
    let asked = 0;
    const fetcher = {
      fetchText: async () => {
        asked += 1;
        return JSON.stringify({ tag_name: "v0.2.0" });
      },
    };
    await notice({ fetcher });
    await notice({ fetcher, now: () => NOW + 60_000 });

    expect(asked).toBe(1);
  });

  // "Once a day at most" has to survive a restart: a container under
  // `restart: unless-stopped` boots as often as its host decides.
  it("says it once a day however often the daemon restarts", async () => {
    await notice();
    await notice({ now: () => NOW + 60_000 });
    await notice({ now: () => NOW + UPDATE_CHECK_TTL_MS - 1 });

    expect(logged).toHaveLength(1);
  });

  it("says it again the next day", async () => {
    await notice();
    await notice({ now: () => NOW + UPDATE_CHECK_TTL_MS });

    expect(logged).toHaveLength(2);
  });

  // A new release is news whenever it lands, not on tomorrow's schedule. The
  // CLI shares the check's cache, so `actana status` can refresh what the
  // channel says between two of this daemon's ticks.
  it("speaks straight away for a different release", async () => {
    await notice();
    await notice({
      fetcher: answering("0.3.0"),
      cachePath: path.join(dir, "refreshed-by-the-cli.json"),
      now: () => NOW + 60_000,
    });

    expect(logged).toHaveLength(2);
    expect(logged[1]).toContain("0.3.0");
  });

  // The bookkeeping's failure mode is a repeated line, never a missed one.
  it("repeats rather than goes quiet when it cannot write its own record", async () => {
    const blocked = path.join(dir, "a-file-not-a-dir");
    fs.writeFileSync(blocked, "");
    const noticePath = path.join(blocked, "update-notice.json");

    await notice({ noticePath });
    await notice({ noticePath, now: () => NOW + 60_000 });

    expect(logged).toHaveLength(2);
  });
});

// #322. A Core installed from a beta is a prerelease of a line (ADR 0036 D1),
// and the release it is waiting for is that same line's. The old comparison
// compared only the numeric core, called `0.4.1` and `0.4.1-beta` equal, and
// so said nothing to the population most in need of the notice.
describe("a Core running a beta", () => {
  const BETA = "0.4.1-beta";

  it("is told when its own line's release lands", async () => {
    await notice({ current: BETA, fetcher: answering("0.4.1") });

    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("Actana 0.4.1 is available");
    expect(logged[0]).toContain(`on ${BETA}`);
    expect(logged[0]).toContain("actana update");
  });

  it("is told once, on the same throttle as everyone else", async () => {
    await notice({ current: BETA, fetcher: answering("0.4.1") });
    await notice({ current: BETA, fetcher: answering("0.4.1"), now: () => NOW + 60_000 });
    await notice({
      current: BETA,
      fetcher: answering("0.4.1"),
      now: () => NOW + UPDATE_CHECK_TTL_MS - 1,
    });

    expect(logged).toHaveLength(1);
  });

  // The channel's newest release is the *previous* line's while a beta is out
  // ahead of it — `/releases/latest` excludes prereleases. Announcing it would
  // be telling an operator that an older version is available.
  it("says nothing about a release older than the beta it is running", async () => {
    await notice({ current: BETA, fetcher: answering("0.4.0") });
    expect(logged).toEqual([]);
  });

  // A beta tag is re-cut at a new commit per cut and publishes the same
  // version string (ADR 0036 D7). Nothing may read that as news.
  it("says nothing when the channel answers with the beta's own version", async () => {
    await notice({ current: BETA, fetcher: answering(BETA) });
    expect(logged).toEqual([]);
  });

  it("is still told about a later line's release", async () => {
    await notice({ current: BETA, fetcher: answering("0.5.0") });
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("Actana 0.5.0 is available");
  });
});
