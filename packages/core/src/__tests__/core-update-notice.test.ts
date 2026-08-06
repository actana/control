import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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
    expect(logged).toHaveLength(2);
  });
});
