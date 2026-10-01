import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  diffSharedSnapshots,
  scanSharedFolder,
  watchSharedFolder,
  type SharedChange,
  type SharedFolderWatcher,
} from "../shared-folder-watcher";

let tmp: string;
let root: string;
let outside: string;
let watchers: SharedFolderWatcher[];

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shared-watch-"));
  root = path.join(tmp, "shared");
  outside = path.join(tmp, "outside");
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  watchers = [];
});
afterEach(() => {
  for (const w of watchers) w.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Collects what the watcher reports and lets a test wait for a matching change. */
function collect() {
  const batches: SharedChange[][] = [];
  const all = () => batches.flat();
  const waiters: Array<() => void> = [];
  return {
    batches,
    all,
    onChanges: (changes: SharedChange[]) => {
      batches.push(changes);
      for (const w of waiters.splice(0)) w();
    },
    until: async (pred: (changes: SharedChange[]) => boolean, ms = 5_000): Promise<void> => {
      const start = Date.now();
      while (!pred(all())) {
        if (Date.now() - start > ms) throw new Error(`timed out; saw ${JSON.stringify(all())}`);
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
          setTimeout(resolve, 25);
        });
      }
    },
  };
}

async function start(c: ReturnType<typeof collect>, extra: Parameters<typeof watchSharedFolder>[0] extends infer O ? Partial<O> : never = {}) {
  const w = await watchSharedFolder({ root, onChanges: c.onChanges, debounceMs: 30, ...extra });
  watchers.push(w);
  return w;
}

describe("end to end: a file written under the folder is reported (#561)", () => {
  it("reports a new file, with its size and mtime, within a bound", async () => {
    const c = collect();
    await start(c);
    const wrote = Date.now();
    fs.writeFileSync(path.join(root, "report.md"), "hello");
    await c.until((all) => all.some((x) => x.path === "report.md"));
    const change = c.all().find((x) => x.path === "report.md")!;
    expect(change).toMatchObject({ path: "report.md", size: 5, deleted: false });
    expect(Math.abs(change.mtime - fs.statSync(path.join(root, "report.md")).mtimeMs)).toBeLessThan(2);
    expect(Date.now() - wrote).toBeLessThan(2_000);
  });
});

describe("the watcher", () => {
  it("does not report what was already there: the first scan is the baseline", async () => {
    fs.writeFileSync(path.join(root, "old.txt"), "before");
    const c = collect();
    await start(c, { debounceMs: 20 });
    fs.writeFileSync(path.join(root, "new.txt"), "x");
    await c.until((all) => all.some((x) => x.path === "new.txt"));
    expect(c.all().map((x) => x.path)).toEqual(["new.txt"]);
  });

  it("reports a file in a nested folder by its path relative to the folder", async () => {
    const c = collect();
    await start(c);
    fs.mkdirSync(path.join(root, "a", "b"), { recursive: true });
    fs.writeFileSync(path.join(root, "a", "b", "deep.txt"), "12");
    await c.until((all) => all.some((x) => x.path === "a/b/deep.txt"));
    expect(c.all().find((x) => x.path === "a/b/deep.txt")).toMatchObject({ size: 2, deleted: false });
  });

  it("reports a change to an existing file's size", async () => {
    fs.writeFileSync(path.join(root, "f.txt"), "1");
    const c = collect();
    await start(c);
    fs.writeFileSync(path.join(root, "f.txt"), "12345");
    await c.until((all) => all.some((x) => x.path === "f.txt" && x.size === 5));
  });

  it("coalesces a burst of writes to one file into one change", async () => {
    const c = collect();
    await start(c, { debounceMs: 250 });
    // Spaced writes, each well inside the window: only a real debounce makes them one change.
    for (let i = 1; i <= 15; i++) {
      fs.writeFileSync(path.join(root, "burst.txt"), "x".repeat(i));
      await new Promise((r) => setTimeout(r, 20));
    }
    await c.until((all) => all.some((x) => x.path === "burst.txt" && x.size === 15));
    await new Promise((r) => setTimeout(r, 500));
    const seen = c.all().filter((x) => x.path === "burst.txt");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.size).toBe(15);
  });

  it("reports a deletion as deleted: true", async () => {
    fs.writeFileSync(path.join(root, "gone.txt"), "bye");
    const c = collect();
    await start(c);
    fs.rmSync(path.join(root, "gone.txt"));
    await c.until((all) => all.some((x) => x.path === "gone.txt" && x.deleted));
    expect(c.all().find((x) => x.deleted)).toMatchObject({ path: "gone.txt", size: 0, deleted: true });
  });

  it("reports every file in a folder that is removed", async () => {
    fs.mkdirSync(path.join(root, "dir"));
    fs.writeFileSync(path.join(root, "dir", "one"), "1");
    fs.writeFileSync(path.join(root, "dir", "two"), "2");
    const c = collect();
    await start(c);
    fs.rmSync(path.join(root, "dir"), { recursive: true });
    await c.until((all) => all.filter((x) => x.deleted).length === 2);
    expect(c.all().map((x) => x.path).sort()).toEqual(["dir/one", "dir/two"]);
  });

  it("reports nothing for a file written and deleted inside one debounce window", async () => {
    const c = collect();
    await start(c, { debounceMs: 150 });
    fs.writeFileSync(path.join(root, "blink.txt"), "x");
    fs.rmSync(path.join(root, "blink.txt"));
    fs.writeFileSync(path.join(root, "marker.txt"), "x");
    await c.until((all) => all.some((x) => x.path === "marker.txt"));
    expect(c.all().map((x) => x.path)).toEqual(["marker.txt"]);
  });

  it("falls back to a periodic scan when recursive watching is unsupported", async () => {
    const unsupported = (() => {
      throw Object.assign(new Error("recursive watch is not supported"), { code: "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM" });
    }) as unknown as typeof fs.watch;
    const c = collect();
    const errors: string[] = [];
    const w = await start(c, { watch: unsupported, fallbackScanMs: 60, onError: (what) => errors.push(what) });
    expect(w.mode).toBe("scan");
    expect(errors).toContain("shared.watch-unavailable");
    fs.writeFileSync(path.join(root, "polled.txt"), "p");
    await c.until((all) => all.some((x) => x.path === "polled.txt"));
  });

  it("makes the folder again when it is deleted, and reports what was in it", async () => {
    fs.writeFileSync(path.join(root, "a.txt"), "a");
    const c = collect();
    await start(c, { fallbackScanMs: 60, ensureRoot: () => fs.mkdirSync(root, { recursive: true }) });
    fs.rmSync(root, { recursive: true });
    await c.until((all) => all.some((x) => x.path === "a.txt" && x.deleted));
    await new Promise((r) => setTimeout(r, 100));
    expect(fs.statSync(root).isDirectory()).toBe(true);
    // And it is being watched again.
    fs.writeFileSync(path.join(root, "after.txt"), "z");
    await c.until((all) => all.some((x) => x.path === "after.txt"));
  });

  it("stops reporting after stop()", async () => {
    const c = collect();
    const w = await start(c);
    w.stop();
    fs.writeFileSync(path.join(root, "late.txt"), "x");
    await new Promise((r) => setTimeout(r, 300));
    expect(c.all()).toEqual([]);
  });
});

describe("nothing outside the folder is reported", () => {
  it("does not follow a symlinked folder that leaves it", async () => {
    fs.writeFileSync(path.join(outside, "secret.txt"), "top secret");
    fs.symlinkSync(outside, path.join(root, "escape"));
    const { snapshot } = await scanSharedFolder(root);
    expect([...snapshot.keys()]).toEqual([]);

    const c = collect();
    await start(c);
    fs.writeFileSync(path.join(outside, "later.txt"), "written outside after the baseline");
    fs.writeFileSync(path.join(outside, "secret.txt"), "changed");
    fs.writeFileSync(path.join(root, "inside.txt"), "ok");
    await c.until((all) => all.some((x) => x.path === "inside.txt"));
    await new Promise((r) => setTimeout(r, 300));
    expect(c.all().map((x) => x.path)).toEqual(["inside.txt"]);
  });

  it("does not report a symlink to a file outside, nor read through it", async () => {
    fs.writeFileSync(path.join(outside, "target.txt"), "outside");
    fs.symlinkSync(path.join(outside, "target.txt"), path.join(root, "link.txt"));
    const { snapshot } = await scanSharedFolder(root);
    expect(snapshot.size).toBe(0);
  });

  it("reports only paths that are relative and cannot climb out", async () => {
    fs.mkdirSync(path.join(root, "x", "..y"), { recursive: true });
    fs.writeFileSync(path.join(root, "x", "..y", "f"), "1");
    fs.writeFileSync(path.join(root, "..hidden"), "1");
    const { snapshot } = await scanSharedFolder(root);
    for (const p of snapshot.keys()) {
      expect(p.startsWith("/")).toBe(false);
      expect(p.split("/")).not.toContain("..");
    }
    expect([...snapshot.keys()].sort()).toEqual(["..hidden", "x/..y/f"]);
  });

  it("treats a Shared folder that is itself a symlink as missing, never walking through it", async () => {
    fs.writeFileSync(path.join(outside, "x"), "1");
    const link = path.join(tmp, "link");
    fs.symlinkSync(outside, link);
    const { snapshot, rootMissing } = await scanSharedFolder(link);
    expect(rootMissing).toBe(true);
    expect(snapshot.size).toBe(0);
  });
});

describe("diffSharedSnapshots", () => {
  it("is empty for equal snapshots and sorted otherwise", () => {
    const a = new Map([["b", { size: 1, mtime: 1 }], ["a", { size: 1, mtime: 1 }]]);
    expect(diffSharedSnapshots(a, new Map(a), 9)).toEqual([]);
    expect(diffSharedSnapshots(new Map(), a, 9).map((c) => c.path)).toEqual(["a", "b"]);
    expect(diffSharedSnapshots(a, new Map(), 9)).toEqual([
      { path: "a", size: 0, mtime: 9, deleted: true },
      { path: "b", size: 0, mtime: 9, deleted: true },
    ]);
  });
});
