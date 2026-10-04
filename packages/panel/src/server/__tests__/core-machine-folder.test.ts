import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CoreFilesFetch } from "@actana/sdk/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emptyMachineFolder } from "../services/core-machine-folder";

/**
 * Emptying `~/shared` on the machine through the Core's Files API (#564, ADR 0041 D12, D38), against a real directory.
 *
 * The Core is stood in for by `coreFiles`, which answers the two routes the purge uses the way the Core's own handler does
 * (`core-files-routes.ts`; the Core's side of them is proven over its real handler in
 * `packages/core/src/__tests__/core-files-shared-purge.test.ts`): a listing reports a symlink as `kind: "symlink"` and
 * never walks through it, and a `DELETE` does not follow its last component and needs the trailing `/` for a folder.
 */

let home: string;
let outside: string;
let requests: { method: string; path: string }[];

beforeEach(() => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ac-machine-folder-")));
  home = path.join(base, "home");
  outside = path.join(base, "outside");
  fs.mkdirSync(home);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "keep.txt"), "mine");
  requests = [];
});
afterEach(() => {
  fs.rmSync(path.dirname(home), { recursive: true, force: true });
});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const coreFiles: CoreFilesFetch = async (req) => {
  const url = new URL(req.url);
  const rel = url.searchParams.get("path") ?? "";
  requests.push({ method: req.method, path: rel });
  expect(req.headers.authorization).toBe("Bearer bearer-1");
  const absolute = path.join(home, rel.replace(/\/+$/, ""));
  if (req.method === "GET" && url.pathname === "/v1/files/list") {
    if (!fs.existsSync(absolute) && !fs.lstatSync(absolute, { throwIfNoEntry: false })) return json(404, { code: "not-found" });
    const lines: unknown[] = [];
    // The path asked for is resolved through links (the Core's confinement); the entries under it are lstat'd.
    for (const name of fs.readdirSync(fs.realpathSync(absolute))) {
      const stat = fs.lstatSync(path.join(fs.realpathSync(absolute), name));
      lines.push({
        type: "entry",
        path: rel === "" ? name : `${rel.replace(/\/+$/, "")}/${name}`,
        kind: stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : "file",
      });
    }
    lines.push({ type: "done", entries: lines.length, skipped: 0, bytes: 0 });
    return new Response(lines.map((l) => JSON.stringify(l)).join("\n"), { status: 200 });
  }
  if (req.method === "DELETE" && url.pathname === "/v1/files") {
    // The last component is not followed; its parents are.
    const parent = fs.realpathSync(path.dirname(absolute));
    const target = path.join(parent, path.basename(absolute));
    const stat = fs.lstatSync(target, { throwIfNoEntry: false });
    if (!stat) return json(404, { code: "not-found" });
    if (stat.isDirectory() && !rel.endsWith("/")) return json(400, { code: "bad-request" });
    if (!stat.isDirectory() && rel.endsWith("/")) return json(400, { code: "bad-request" });
    fs.rmSync(target, { recursive: stat.isDirectory() });
    return json(200, { deleted: true });
  }
  return json(405, {});
};

const target = () => ({ baseUrl: "https://core.test:7777", bearer: "bearer-1", fetch: coreFiles });
const shared = () => path.join(home, "shared");
const listing = (dir: string) => fs.readdirSync(dir).sort();

describe("emptyMachineFolder", () => {
  it("removes every file and folder in ~/shared and keeps the folder", async () => {
    fs.mkdirSync(path.join(shared(), "sub", "deep"), { recursive: true });
    fs.writeFileSync(path.join(shared(), "a.txt"), "a");
    fs.writeFileSync(path.join(shared(), "sub", "b.txt"), "b");
    fs.writeFileSync(path.join(shared(), "sub", "deep", "c.txt"), "c");
    fs.writeFileSync(path.join(shared(), ".hidden"), "h");

    expect(await emptyMachineFolder(target())).toEqual({ state: "emptied", removed: 3 });
    expect(listing(shared())).toEqual([]);
  });

  it("touches nothing else in the home", async () => {
    fs.mkdirSync(shared());
    fs.writeFileSync(path.join(shared(), "a.txt"), "a");
    fs.mkdirSync(path.join(home, "work"));
    fs.writeFileSync(path.join(home, "work", "code.ts"), "code");
    fs.writeFileSync(path.join(home, ".bashrc"), "rc");
    fs.mkdirSync(path.join(home, "shared-notes"));
    fs.writeFileSync(path.join(home, "shared-notes", "n.md"), "n");

    await emptyMachineFolder(target());
    expect(listing(home)).toEqual([".bashrc", "shared", "shared-notes", "work"]);
    expect(fs.readFileSync(path.join(home, "work", "code.ts"), "utf8")).toBe("code");
    expect(fs.readFileSync(path.join(home, "shared-notes", "n.md"), "utf8")).toBe("n");
    // Every delete was one child of shared; the home and the folder itself were only ever listed.
    const deletes = requests.filter((q) => q.method === "DELETE").map((q) => q.path);
    expect(deletes).toEqual(["shared/a.txt"]);
  });

  it("removes a symlink inside ~/shared as a link and never follows it out", async () => {
    fs.mkdirSync(shared());
    fs.writeFileSync(path.join(shared(), "a.txt"), "a");
    fs.symlinkSync(outside, path.join(shared(), "to-folder"));
    fs.symlinkSync(path.join(outside, "keep.txt"), path.join(shared(), "to-file"));
    fs.symlinkSync(path.join(home, "work"), path.join(shared(), "dangling"));
    fs.mkdirSync(path.join(shared(), "sub"));
    fs.symlinkSync(outside, path.join(shared(), "sub", "inner-link"));

    expect(await emptyMachineFolder(target())).toEqual({ state: "emptied", removed: 5 });
    expect(listing(shared())).toEqual([]);
    // What the links pointed at is all still there.
    expect(listing(outside)).toEqual(["keep.txt"]);
    expect(fs.readFileSync(path.join(outside, "keep.txt"), "utf8")).toBe("mine");
    // A link was deleted as a link: its path never carried the folder's trailing slash.
    expect(requests.filter((q) => q.method === "DELETE").map((q) => q.path).sort()).toEqual([
      "shared/a.txt",
      "shared/dangling",
      "shared/sub/",
      "shared/to-file",
      "shared/to-folder",
    ]);
  });

  it("leaves everything alone when ~/shared is itself a symlink", async () => {
    const elsewhere = path.join(home, "elsewhere");
    fs.mkdirSync(elsewhere);
    fs.writeFileSync(path.join(elsewhere, "precious.txt"), "p");
    fs.symlinkSync(elsewhere, shared());

    const result = await emptyMachineFolder(target());
    expect(result).toMatchObject({ state: "kept", removed: 0 });
    expect(result.state === "kept" && result.reason).toMatch(/symlink, not a folder/);
    expect(fs.readFileSync(path.join(elsewhere, "precious.txt"), "utf8")).toBe("p");
    expect(fs.lstatSync(shared()).isSymbolicLink()).toBe(true);
    expect(requests.some((q) => q.method === "DELETE")).toBe(false);
  });

  it("leaves a ~/shared that is a file alone", async () => {
    fs.writeFileSync(shared(), "not a folder");
    expect(await emptyMachineFolder(target())).toMatchObject({ state: "kept", removed: 0 });
    expect(fs.readFileSync(shared(), "utf8")).toBe("not a folder");
  });

  it("is a no-op when there is no ~/shared yet", async () => {
    expect(await emptyMachineFolder(target())).toEqual({ state: "emptied", removed: 0 });
    expect(requests.every((q) => q.method === "GET")).toBe(true);
  });

  it("refuses a listed name that is not one plain segment under shared/", async () => {
    fs.mkdirSync(shared());
    fs.writeFileSync(path.join(home, "victim.txt"), "v");
    const hostile: CoreFilesFetch = async (req) => {
      const rel = new URL(req.url).searchParams.get("path");
      requests.push({ method: req.method, path: rel ?? "" });
      if (req.method === "GET" && rel === "") {
        return new Response([{ type: "entry", path: "shared", kind: "directory" }, { type: "done" }].map((l) => JSON.stringify(l)).join("\n"));
      }
      if (req.method === "GET") {
        const lines = [
          { type: "entry", path: "shared/../victim.txt", kind: "file" },
          { type: "entry", path: "shared/a/b", kind: "file" },
          { type: "entry", path: "victim.txt", kind: "file" },
          { type: "entry", path: "shared", kind: "directory" },
          { type: "done" },
        ];
        return new Response(lines.map((l) => JSON.stringify(l)).join("\n"));
      }
      return json(200, {});
    };
    expect(await emptyMachineFolder({ ...target(), fetch: hostile })).toMatchObject({ state: "kept", removed: 0 });
    expect(requests.some((q) => q.method === "DELETE")).toBe(false);
    expect(fs.existsSync(path.join(home, "victim.txt"))).toBe(true);
  });

  it("stops and reports what stayed when the Core refuses a delete", async () => {
    fs.mkdirSync(shared());
    fs.writeFileSync(path.join(shared(), "a.txt"), "a");
    fs.writeFileSync(path.join(shared(), "b.txt"), "b");
    let deletes = 0;
    const refusing: CoreFilesFetch = async (req) => {
      if (req.method === "DELETE") {
        deletes += 1;
        if (deletes === 2) return json(500, { code: "write-failed" });
      }
      return coreFiles(req);
    };
    const result = await emptyMachineFolder({ ...target(), fetch: refusing });
    expect(result).toMatchObject({ state: "kept", removed: 1 });
    expect(result.state === "kept" && result.reason).toMatch(/was refused \(500\)/);
    expect(listing(shared())).toHaveLength(1);
  });

  it("does not delete on a listing that did not finish", async () => {
    fs.mkdirSync(shared());
    fs.writeFileSync(path.join(shared(), "a.txt"), "a");
    const cut: CoreFilesFetch = async (req) => {
      const rel = new URL(req.url).searchParams.get("path");
      if (req.method === "GET" && rel === "shared") {
        return new Response(JSON.stringify({ type: "entry", path: "shared/a.txt", kind: "file" }));
      }
      return coreFiles(req);
    };
    const result = await emptyMachineFolder({ ...target(), fetch: cut });
    expect(result).toMatchObject({ state: "kept", removed: 0 });
    expect(fs.existsSync(path.join(shared(), "a.txt"))).toBe(true);
  });

  it("reports an unreachable Core as kept", async () => {
    const down: CoreFilesFetch = async () => {
      throw new Error("connect ECONNREFUSED");
    };
    const result = await emptyMachineFolder({ ...target(), fetch: down });
    expect(result).toMatchObject({ state: "kept", removed: 0 });
    expect(result.state === "kept" && result.reason).toMatch(/ECONNREFUSED/);
  });

  it("never reports an unreadable ~/shared as emptied: a skipped line is kept", async () => {
    fs.mkdirSync(shared());
    const unreadable: CoreFilesFetch = async (req) => {
      const rel = new URL(req.url).searchParams.get("path");
      if (req.method === "GET" && rel === "shared") {
        const lines = [{ type: "skipped", path: "shared", code: "unreadable-directory" }, { type: "done", entries: 0, skipped: 1, bytes: 0 }];
        return new Response(lines.map((l) => JSON.stringify(l)).join("\n"));
      }
      return coreFiles(req);
    };
    const result = await emptyMachineFolder({ ...target(), fetch: unreadable });
    expect(result).toMatchObject({ state: "kept", removed: 0 });
    expect(result.state === "kept" && result.reason).toMatch(/could not be read/);
  });

  it("keeps the folder when the listing names an entry that is not a plain child, and deletes nothing", async () => {
    fs.mkdirSync(shared());
    fs.writeFileSync(path.join(shared(), "a.txt"), "a");
    const odd: CoreFilesFetch = async (req) => {
      const rel = new URL(req.url).searchParams.get("path");
      if (req.method === "GET" && rel === "shared") {
        const lines = [
          { type: "entry", path: "shared/a.txt", kind: "file" },
          { type: "entry", path: "shared/back\\slash", kind: "file" },
          { type: "done" },
        ];
        return new Response(lines.map((l) => JSON.stringify(l)).join("\n"));
      }
      return coreFiles(req);
    };
    const result = await emptyMachineFolder({ ...target(), fetch: odd });
    expect(result).toMatchObject({ state: "kept", removed: 0 });
    expect(requests.some((q) => q.method === "DELETE")).toBe(false);
    expect(fs.existsSync(path.join(shared(), "a.txt"))).toBe(true);
  });

  it("keeps it when the home cannot be listed (404): that says nothing about ~/shared", async () => {
    const missing: CoreFilesFetch = async () => json(404, { code: "not-found" });
    const result = await emptyMachineFolder({ ...target(), fetch: missing });
    expect(result).toMatchObject({ state: "kept", removed: 0 });
  });

  describe("against a Core that allows one write at a time", () => {
    // The Core's lease (`core-files-routes.ts`): a delete while another write holds it is 409 `transfer-in-progress`. The
    // lease is released a moment after the answer is sent, so `lagging` keeps it for the first `lag` ms of the next call.
    function singleWriter(opts: { lag?: number; stuck?: number } = {}) {
      const state = { inFlight: 0, overlapped: 0, refusals: 0, attempts: 0, waits: [] as number[] };
      const fetch: CoreFilesFetch = async (req) => {
        if (req.method !== "DELETE") return coreFiles(req);
        state.attempts += 1;
        if (state.inFlight > 0) {
          state.overlapped += 1;
          state.refusals += 1;
          return json(409, { code: "transfer-in-progress", error: "another write is already running in the home" });
        }
        state.inFlight += 1;
        try {
          // The lease outlives the answer for a tick: a delete sent straight after the answer can still be refused.
          if (state.refusals < (opts.stuck ?? 0) || (opts.lag && state.attempts % 2 === 1 && state.attempts <= opts.lag)) {
            state.refusals += 1;
            return json(409, { code: "transfer-in-progress", error: "another write is already running in the home" });
          }
          await new Promise((resolve) => setTimeout(resolve, 5));
          return await coreFiles(req);
        } finally {
          state.inFlight -= 1;
        }
      };
      return { state, fetch, sleep: async (ms: number) => void state.waits.push(ms) };
    }

    it("sends the deletes one after another, never two at once, one call per top-level child", async () => {
      fs.mkdirSync(path.join(shared(), "big", "deep"), { recursive: true });
      for (let i = 0; i < 5; i += 1) fs.writeFileSync(path.join(shared(), "big", `f${i}`), "x");
      fs.writeFileSync(path.join(shared(), "deep.txt"), "d");
      fs.writeFileSync(path.join(shared(), "e2e-hello.txt"), "h");
      const core = singleWriter();
      const result = await emptyMachineFolder({ ...target(), fetch: core.fetch, sleep: core.sleep });
      expect(result).toEqual({ state: "emptied", removed: 3 });
      expect(core.state.overlapped).toBe(0);
      // The folder cost one recursive call, not one per file.
      expect(core.state.attempts).toBe(3);
      expect(listing(shared())).toEqual([]);
    });

    it("waits and retries the same delete when the Core answers transfer-in-progress", async () => {
      fs.mkdirSync(shared());
      fs.writeFileSync(path.join(shared(), "e2e-hello.txt"), "h");
      const core = singleWriter({ stuck: 3 });
      const result = await emptyMachineFolder({ ...target(), fetch: core.fetch, sleep: core.sleep });
      expect(result).toEqual({ state: "emptied", removed: 1 });
      expect(core.state.attempts).toBe(4);
      // Waits grow and are bounded.
      expect(core.state.waits).toEqual([100, 200, 400]);
      expect(requests.filter((q) => q.method === "DELETE").every((q) => q.path === "shared/e2e-hello.txt")).toBe(true);
    });

    it("gives up after a bounded number of attempts and reports kept with the reason, deleting nothing else", async () => {
      fs.mkdirSync(shared());
      fs.writeFileSync(path.join(shared(), "a.txt"), "a");
      fs.writeFileSync(path.join(shared(), "b.txt"), "b");
      const core = singleWriter({ stuck: 1000 });
      const result = await emptyMachineFolder({ ...target(), fetch: core.fetch, sleep: core.sleep });
      expect(result).toMatchObject({ state: "kept", removed: 0 });
      expect(result.state === "kept" && result.reason).toMatch(/refused \(409, transfer-in-progress, still after 8 attempts\)/);
      expect(core.state.attempts).toBe(8);
      expect(listing(shared())).toEqual(["a.txt", "b.txt"]);
    });

    it("does not retry a 409 that is not transfer-in-progress", async () => {
      fs.mkdirSync(shared());
      fs.writeFileSync(path.join(shared(), "a.txt"), "a");
      let calls = 0;
      const other: CoreFilesFetch = async (req) => {
        if (req.method === "DELETE") {
          calls += 1;
          return json(409, { code: "bad-request" });
        }
        return coreFiles(req);
      };
      const result = await emptyMachineFolder({ ...target(), fetch: other, sleep: async () => {} });
      expect(result).toMatchObject({ state: "kept", removed: 0 });
      expect(calls).toBe(1);
    });

    it("still removes a symlink as a link, never followed, while retrying", async () => {
      fs.mkdirSync(shared());
      fs.symlinkSync(outside, path.join(shared(), "to-folder"));
      const core = singleWriter({ stuck: 2 });
      expect(await emptyMachineFolder({ ...target(), fetch: core.fetch, sleep: core.sleep })).toEqual({ state: "emptied", removed: 1 });
      expect(listing(outside)).toEqual(["keep.txt"]);
      expect(requests.filter((q) => q.method === "DELETE").every((q) => q.path === "shared/to-folder")).toBe(true);
    });
  });
});
