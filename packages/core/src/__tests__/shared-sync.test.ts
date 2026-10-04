import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CoreLinkRequestFrame, CoreLinkSharedMountStatus } from "@actana/sdk/core";
import { createS3CoreShared, CoreSharedError } from "@actana/sdk/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { announceShared, sharedCapability } from "../shared-capability";
import { buildSharedHome, createSharedHome } from "../shared-home-io";
import { createSharedKeyStore } from "../shared-key-store";
import { createSharedSync, SYNC_STATE_FILE, type SharedSync } from "../shared-sync";
import { FakeS3, type FakeKey } from "./shared-s3-fake";

// The Shared folder's sync, end to end on a real folder (the Core's own Files operations
// in `~/shared`) and a fake S3 that checks the key on every request (#562, ADR 0041 D33).
// The clock is the test's own: one hour is one assignment.

const HOUR = 3_600_000;
const T0 = Date.parse("2026-10-01T12:00:00Z");
const ENDPOINT = "http://s3.test";

let root: string;
let stateDir: string;
let homeDir: string;
let folder: string;
let t: number;
let s3: FakeS3;
let sync: SharedSync;
let keySeq = 0;

type Attach = Extract<CoreLinkRequestFrame, { type: "sharedAttach" }>;
type Creds = Extract<CoreLinkRequestFrame, { type: "sharedCredentials" }>;

/** A key the fake issues for `prefix`, and the frame fields that carry it. */
function newKey(prefix = "cores/core-a", life = HOUR): FakeKey & { secretAccessKey: string } {
  keySeq += 1;
  const key = {
    accessKeyId: `AK${keySeq}`,
    secretAccessKey: `SECRET-${keySeq}`,
    sessionToken: `TOKEN-${keySeq}`,
    prefix,
    expiresAt: t + life,
  };
  s3.issue(key);
  return key;
}

const credentials = (k: ReturnType<typeof newKey>) => ({
  accessKeyId: k.accessKeyId,
  secretAccessKey: k.secretAccessKey,
  sessionToken: k.sessionToken,
});

function attachFrame(k: ReturnType<typeof newKey>, prefix = k.prefix): Attach {
  return {
    type: "sharedAttach",
    reqId: "r1",
    endpoint: ENDPOINT,
    bucket: s3.bucket,
    prefix,
    region: "us-east-1",
    credentials: credentials(k),
    expiresAt: new Date(k.expiresAt).toISOString(),
  };
}

const credsFrame = (k: ReturnType<typeof newKey>): Creds => ({
  type: "sharedCredentials",
  reqId: "r2",
  credentials: credentials(k),
  expiresAt: new Date(k.expiresAt).toISOString(),
});

async function attach(k = newKey()): Promise<CoreLinkSharedMountStatus> {
  const status = await sync.handle(attachFrame(k));
  await sync.idle();
  return status;
}

function makeSync(): SharedSync {
  return createSharedSync({
    stateDir,
    home: createSharedHome({ home: homeDir, identityEnv: {} }),
    now: () => t,
    fetch: s3.fetch,
    intervalMs: 3_600_000,
  });
}

function writeLocal(rel: string, content: string, mtimeSeconds?: number): void {
  const file = path.join(folder, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  if (mtimeSeconds !== undefined) fs.utimesSync(file, mtimeSeconds, mtimeSeconds);
}

const readLocal = (rel: string): string | null => {
  try {
    return fs.readFileSync(path.join(folder, rel), "utf8");
  } catch {
    return null;
  }
};

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shared-sync-")));
  stateDir = path.join(root, "state");
  homeDir = path.join(root, "home");
  folder = path.join(homeDir, "shared");
  fs.mkdirSync(folder, { recursive: true });
  fs.mkdirSync(stateDir, { mode: 0o700 });
  t = T0;
  s3 = new FakeS3();
  s3.clock = () => t;
  sync = makeSync();
});

afterEach(() => {
  sync.stop();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("local to S3", () => {
  it("uploads a file, under the Core's prefix and nowhere else", async () => {
    writeLocal("notes/a.txt", "hello");
    expect(await attach()).toEqual({ state: "attached", expiresAt: new Date(T0 + HOUR).toISOString() });
    expect(s3.text("cores/core-a/notes/a.txt")).toBe("hello");
    expect([...s3.objects.keys()]).toEqual(["cores/core-a/notes/a.txt"]);
  });

  it("uploads a change and does not upload again when nothing changed", async () => {
    writeLocal("a.txt", "one", 1_000);
    await attach();
    writeLocal("a.txt", "two!", 2_000);
    t += 1_000;
    expect((await sync.pass()).uploaded).toEqual(["a.txt"]);
    expect(s3.text("cores/core-a/a.txt")).toBe("two!");
    const puts = s3.requests.filter((r) => r.method === "PUT").length;
    await sync.pass();
    expect(s3.requests.filter((r) => r.method === "PUT").length).toBe(puts);
  });

  it("deletes in S3 what was deleted here", async () => {
    writeLocal("gone.txt", "x");
    await attach();
    expect(s3.objects.size).toBe(1);
    fs.rmSync(path.join(folder, "gone.txt"));
    expect((await sync.pass()).deletedRemote).toEqual(["gone.txt"]);
    expect(s3.objects.size).toBe(0);
  });

  it("never follows a symlink, in the folder or as the folder", async () => {
    const secret = path.join(homeDir, "private", "secret.txt");
    fs.mkdirSync(path.dirname(secret), { recursive: true });
    fs.writeFileSync(secret, "TOP-SECRET");
    fs.symlinkSync("/etc/hostname", path.join(folder, "out-of-home"));
    fs.symlinkSync(secret, path.join(folder, "into-home-file"));
    fs.symlinkSync(path.dirname(secret), path.join(folder, "into-home-dir"));
    writeLocal("real.txt", "fine");
    await attach();
    expect([...s3.objects.keys()]).toEqual(["cores/core-a/real.txt"]);

    // The folder itself a link: the whole pass is refused, nothing is sent.
    fs.rmSync(folder, { recursive: true });
    fs.symlinkSync(path.dirname(secret), folder);
    const before = s3.requests.length;
    expect((await sync.pass()).skipped).toBe("no-folder");
    expect(s3.requests.length).toBe(before);
    expect([...s3.objects.values()].map((o) => new TextDecoder().decode(o.bytes))).not.toContain("TOP-SECRET");
  });
});

describe("S3 to local", () => {
  it("downloads a file with its mtime, and a nested one, and does not send it back", async () => {
    s3.seed("cores/core-a/docs/deep/r.md", "from the controller", T0 - 5_000);
    await attach();
    expect(readLocal("docs/deep/r.md")).toBe("from the controller");
    expect(Math.floor(fs.statSync(path.join(folder, "docs/deep/r.md")).mtimeMs)).toBe(T0 - 5_000);
    expect(s3.requests.filter((r) => r.method === "PUT")).toEqual([]);
    expect((await sync.pass()).downloaded).toEqual([]);
  });

  it("deletes here what was deleted in S3", async () => {
    writeLocal("a.txt", "x");
    await attach();
    s3.objects.delete("cores/core-a/a.txt");
    expect((await sync.pass()).deletedLocal).toEqual(["a.txt"]);
    expect(readLocal("a.txt")).toBeNull();
  });

  it("lets the newer side win when both changed, and a change beat a deletion", async () => {
    writeLocal("both.txt", "v0", 1_000);
    writeLocal("kept.txt", "k0", 1_000);
    await attach();
    writeLocal("both.txt", "local-old", 2_000);
    s3.seed("cores/core-a/both.txt", "remote-new", T0 + 10_000);
    s3.objects.delete("cores/core-a/kept.txt");
    writeLocal("kept.txt", "k-edited", 3_000);
    t += 20_000;
    await sync.pass();
    expect(readLocal("both.txt")).toBe("remote-new");
    expect(s3.text("cores/core-a/kept.txt")).toBe("k-edited");
  });

  it("does not upload a download that was cut short", async () => {
    s3.seed("cores/core-a/big.txt", "the whole file");
    await attach();
    // A crash left half of it on disk and the journal saying so.
    fs.writeFileSync(path.join(folder, "big.txt"), "the who");
    const state = JSON.parse(fs.readFileSync(path.join(stateDir, SYNC_STATE_FILE), "utf8")) as { pending: string[] };
    state.pending = ["big.txt"];
    fs.writeFileSync(path.join(stateDir, SYNC_STATE_FILE), JSON.stringify(state));
    await sync.pass();
    expect(readLocal("big.txt")).toBe("the whole file");
    expect(s3.text("cores/core-a/big.txt")).toBe("the whole file");
  });
});

describe("isolation between Cores", () => {
  it("A's key can neither list, read nor write B's prefix", async () => {
    s3.seed("cores/core-b/secret.txt", "B's");
    const a = newKey("cores/core-a");
    const asA = createS3CoreShared({
      endpoint: ENDPOINT,
      bucket: s3.bucket,
      prefix: "cores/core-b",
      credentials: { get: async () => ({ ...credentials(a), expiresAt: new Date(a.expiresAt) }) },
      fetch: s3.fetch,
      now: () => t,
    });
    for (const attempt of [() => asA.list(""), () => asA.get("secret.txt"), () => asA.put("mine.txt", "x"), () => asA.rm("secret.txt")]) {
      await expect(attempt()).rejects.toMatchObject({ code: "forbidden" });
    }
    expect(s3.text("cores/core-b/secret.txt")).toBe("B's");
    expect(s3.objects.has("cores/core-b/mine.txt")).toBe(false);
  });

  it("attaching with A's key to B's prefix is refused and keeps nothing", async () => {
    s3.seed("cores/core-b/secret.txt", "B's");
    const a = newKey("cores/core-a");
    const status = await sync.handle(attachFrame(a, "cores/core-b"));
    expect(status).toMatchObject({ state: "error", code: "mount-failed" });
    expect(sync.attached).toBe(false);
    expect(fs.existsSync(createSharedKeyStore(stateDir).path)).toBe(false);
    expect(readLocal("secret.txt")).toBeNull();
  });

  it("a syncing Core touches only its own prefix", async () => {
    s3.seed("cores/core-b/theirs.txt", "B's");
    writeLocal("mine.txt", "A's");
    await attach();
    const touched = new Set(s3.requests.filter((r) => r.key !== "").map((r) => r.key.split("/").slice(0, 2).join("/")));
    expect([...touched]).toEqual(["cores/core-a"]);
    expect(readLocal("theirs.txt")).toBeNull();
  });

  it("refuses a prefix that would climb out of the Core's own", async () => {
    const k = newKey();
    for (const prefix of ["", "/", "cores/../core-b", "cores//core-a"]) {
      expect(await sync.handle(attachFrame(k, prefix)), prefix).toMatchObject({ state: "error", code: "invalid-frame" });
    }
    expect(sync.attached).toBe(false);
  });
});

describe("the key", () => {
  it("is stored once, replaced on a push, and answered with the frames' statuses", async () => {
    const first = newKey();
    expect(await attach(first)).toMatchObject({ state: "attached" });
    expect(await sync.handle(attachFrame(newKey()))).toMatchObject({ state: "error", code: "already-attached" });
    const second = newKey();
    t += 40 * 60_000;
    second.expiresAt = t + HOUR;
    expect(await sync.handle(credsFrame(second))).toEqual({ state: "attached", expiresAt: new Date(second.expiresAt).toISOString() });
    expect(createSharedKeyStore(stateDir).load()?.accessKeyId).toBe(second.accessKeyId);
    expect(await sync.handle({ ...credsFrame(second), expiresAt: new Date(t - 1).toISOString() })).toMatchObject({
      state: "error",
      code: "invalid-frame",
    });
    await sync.idle();
  });

  it("a push before any attach is not-attached", async () => {
    expect(await sync.handle(credsFrame(newKey()))).toMatchObject({ state: "error", code: "not-attached" });
    expect(await sync.handle({ type: "sharedDetach", reqId: "r", keepLocalCopy: true })).toMatchObject({
      state: "error",
      code: "not-attached",
    });
  });

  it("a refresh in the middle of an upload does not break it", async () => {
    const first = newKey();
    await attach(first);
    writeLocal("big.bin", "x".repeat(1_000_000));
    const held = s3.hold((r) => r.method === "PUT" && r.key.endsWith("big.bin"));
    const pass = sync.pass();
    await held.reached;

    // The controller's push lands while the PUT is in flight.
    const second = newKey();
    expect(await sync.handle(credsFrame(second))).toMatchObject({ state: "attached" });
    expect(createSharedKeyStore(stateDir).load()?.accessKeyId).toBe(second.accessKeyId);
    held.release();

    const report = await pass;
    expect(report.failed).toEqual([]);
    expect(s3.text("cores/core-a/big.bin")?.length).toBe(1_000_000);
    const put = s3.requests.find((r) => r.method === "PUT" && r.key.endsWith("big.bin"));
    expect(put).toMatchObject({ accessKeyId: first.accessKeyId, status: 200 });
    await sync.idle();
    // What came after the push is signed with the new key, and nothing is sent twice.
    expect(s3.requests.at(-1)?.accessKeyId).toBe(second.accessKeyId);
    expect(s3.requests.filter((r) => r.method === "PUT" && r.key.endsWith("big.bin")).length).toBe(1);
  });
});

describe("expiry", () => {
  it("stops sending to S3 when the key has expired, and writes again after the next push", async () => {
    await attach();
    writeLocal("before.txt", "1");
    await sync.pass();
    expect(s3.text("cores/core-a/before.txt")).toBe("1");

    // The Core is paused for two hours: no controller, no push.
    t += 2 * HOUR;
    writeLocal("while-asleep.txt", "2");
    const requests = s3.requests.length;
    const report = await sync.pass();
    expect(report.skipped).toBe("expired");
    expect(s3.requests.length).toBe(requests);
    expect(s3.objects.has("cores/core-a/while-asleep.txt")).toBe(false);
    expect(readLocal("while-asleep.txt")).toBe("2");

    // Wakes, and the controller pushes.
    const fresh = newKey();
    expect(await sync.handle(credsFrame(fresh))).toMatchObject({ state: "attached" });
    await sync.idle();
    expect(s3.text("cores/core-a/while-asleep.txt")).toBe("2");
    expect(s3.requests.at(-1)?.accessKeyId).toBe(fresh.accessKeyId);
  });

  it("is still expired after a restart, and picks the stored key up", async () => {
    await attach();
    sync.stop();
    t += 2 * HOUR;
    sync = makeSync();
    expect(sync.attached).toBe(true);
    expect((await sync.pass()).skipped).toBe("expired");
    expect(await sync.handle(credsFrame(newKey()))).toMatchObject({ state: "attached" });
    await sync.idle();
  });
});

describe("unpair", () => {
  it("copies S3 into the folder, stops syncing and forgets the key, and the folder keeps its contents", async () => {
    writeLocal("mine.txt", "mine");
    await attach();
    s3.seed("cores/core-a/from-s3.txt", "S3's", T0 - 1_000);
    s3.seed("cores/core-a/dir/deep.txt", "deep", T0 - 1_000);
    const status = await sync.handle({ type: "sharedDetach", reqId: "d", keepLocalCopy: true });
    expect(status).toEqual({ state: "detached", keptLocalCopy: true });
    expect(readLocal("from-s3.txt")).toBe("S3's");
    expect(readLocal("dir/deep.txt")).toBe("deep");
    expect(readLocal("mine.txt")).toBe("mine");
    expect(sync.attached).toBe(false);
    expect(fs.existsSync(createSharedKeyStore(stateDir).path)).toBe(false);
    expect(fs.existsSync(path.join(stateDir, SYNC_STATE_FILE))).toBe(false);

    // Stopped: later edits go nowhere, and S3 is not asked.
    const requests = s3.requests.length;
    writeLocal("after.txt", "after");
    expect((await sync.pass()).skipped).toBe("detached");
    expect(s3.requests.length).toBe(requests);
  });

  it("copies back a file that was deleted here but is still in S3, and deletes nothing", async () => {
    writeLocal("a.txt", "a");
    writeLocal("b.txt", "b");
    await attach();
    fs.rmSync(path.join(folder, "a.txt")); // not yet synced as a deletion
    await sync.handle({ type: "sharedDetach", reqId: "d", keepLocalCopy: true });
    expect(readLocal("a.txt")).toBe("a");
    expect(readLocal("b.txt")).toBe("b");
    expect(s3.objects.size).toBe(2);
  });

  it("does not overwrite a file the Core changed since the last pass", async () => {
    writeLocal("a.txt", "v0", 1_000);
    await attach();
    writeLocal("a.txt", "edited here", 2_000);
    s3.seed("cores/core-a/a.txt", "edited there", T0 + 5_000);
    t += 10_000;
    await sync.handle({ type: "sharedDetach", reqId: "d", keepLocalCopy: true });
    expect(readLocal("a.txt")).toBe("edited here");
  });

  it("with an expired key it copies nothing, deletes nothing and stays attached", async () => {
    writeLocal("mine.txt", "mine");
    await attach();
    t += 2 * HOUR;
    const status = await sync.handle({ type: "sharedDetach", reqId: "d", keepLocalCopy: true });
    expect(status).toMatchObject({ state: "error", code: "mount-failed" });
    expect(sync.attached).toBe(true);
    expect(readLocal("mine.txt")).toBe("mine");
    expect(fs.existsSync(createSharedKeyStore(stateDir).path)).toBe(true);
  });

  describe("a pass asked for during the detach pull never runs as a sync (#562)", () => {
    /** Folder listings the sync made: one per pass that got as far as reading the folder. */
    let listings = 0;
    beforeEach(() => {
      const home = createSharedHome({ home: homeDir, identityEnv: {} });
      listings = 0;
      sync = createSharedSync({
        stateDir,
        home: {
          ...home,
          list: () => {
            listings++;
            return home.list();
          },
        },
        now: () => t,
        fetch: s3.fetch,
        intervalMs: 3_600_000,
      });
    });

    /** Attached, with a file only S3 has, a detach paused in its pull and a local file a sync would upload. */
    async function detachPausedInPull(): Promise<{ done: Promise<CoreLinkSharedMountStatus>; release: () => void }> {
      await attach();
      s3.seed("cores/core-a/from-s3.txt", "S3's", T0 - 1_000);
      const held = s3.hold((r) => r.method === "GET" && r.key.endsWith("from-s3.txt"));
      const done = sync.handle({ type: "sharedDetach", reqId: "d", keepLocalCopy: true });
      await held.reached;
      writeLocal("new-here.txt", "new");
      return { done, release: held.release };
    }

    // The attach pass and the pull are the only two passes there may be.
    const noSyncAfterPull = (): void => {
      expect(listings).toBe(2);
      expect(s3.requests.filter((r) => r.method === "PUT" || r.method === "DELETE")).toEqual([]);
      expect(s3.text("cores/core-a/new-here.txt")).toBeUndefined();
      expect(readLocal("from-s3.txt")).toBe("S3's");
      expect(sync.attached).toBe(false);
      expect(fs.existsSync(path.join(stateDir, SYNC_STATE_FILE))).toBe(false);
      expect(fs.existsSync(createSharedKeyStore(stateDir).path)).toBe(false);
    };

    it("a timer tick", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const { done, release } = await detachPausedInPull();
        await vi.advanceTimersByTimeAsync(3_600_000);
        release();
        expect(await done).toEqual({ state: "detached", keptLocalCopy: true });
        await sync.idle();
        noSyncAfterPull();
        await vi.advanceTimersByTimeAsync(3_600_000);
        await sync.idle();
        noSyncAfterPull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("a credential push", async () => {
      const { done, release } = await detachPausedInPull();
      const pushed = await sync.handle(credsFrame(newKey()));
      expect(pushed.state).toBe("attached");
      release();
      expect(await done).toEqual({ state: "detached", keptLocalCopy: true });
      await sync.idle();
      noSyncAfterPull();
    });

    it("syncing goes on when the pull fails and nothing is detached", async () => {
      await attach();
      t += 2 * HOUR;
      expect(await sync.handle({ type: "sharedDetach", reqId: "d", keepLocalCopy: true })).toMatchObject({ state: "error" });
      writeLocal("later.txt", "later");
      await sync.handle(credsFrame(newKey()));
      await sync.idle();
      expect(s3.text("cores/core-a/later.txt")).toBe("later");
    });
  });
});

describe("what ready.shared says", () => {
  it("is s3 from the attach to the detach, and local otherwise", async () => {
    const local = sharedCapability("local");
    expect(announceShared(sync.attached, local)).toEqual({ version: 1, backend: "local" });
    await attach();
    expect(announceShared(sync.attached, local)).toEqual({ version: 1, backend: "s3" });
    await sync.handle({ type: "sharedDetach", reqId: "d", keepLocalCopy: true });
    expect(announceShared(sync.attached, local)).toEqual({ version: 1, backend: "local" });
    expect(announceShared(false, null)).toBeNull();
  });
});

describe("the SDK error codes this relies on", () => {
  it("reads a 403 as forbidden and an expired token as expired", async () => {
    const a = newKey();
    const client = (key: ReturnType<typeof newKey>) =>
      createS3CoreShared({
        endpoint: ENDPOINT,
        bucket: s3.bucket,
        prefix: "cores/core-a",
        credentials: { get: async () => ({ ...credentials(key), expiresAt: new Date(key.expiresAt + 10 * HOUR) }) },
        fetch: s3.fetch,
        now: () => t,
      });
    t += 2 * HOUR;
    await expect(client(a).list("")).rejects.toBeInstanceOf(CoreSharedError);
    await expect(client(a).list("")).rejects.toMatchObject({ code: "expired" });
  });
});

// ─── The review of #631 ──────────────────────────────────────────────────────

const isRoot = process.getuid?.() === 0;

describe("a folder the listing could not read is not a folder of deleted files (R1)", () => {
  it.skipIf(isRoot)("does not delete in S3 what is under a directory it cannot open, and goes on with the rest", async () => {
    writeLocal("open/a.txt", "a");
    writeLocal("locked/b.txt", "b");
    writeLocal("locked/deep/c.txt", "c");
    await attach();
    expect([...s3.objects.keys()].sort()).toEqual(["cores/core-a/locked/b.txt", "cores/core-a/locked/deep/c.txt", "cores/core-a/open/a.txt"]);

    const output: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => void output.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")));
    fs.chmodSync(path.join(folder, "locked"), 0o000);
    try {
      writeLocal("open/new.txt", "new");
      const report = await sync.pass();
      // Nothing under `locked` was deleted in S3, and the readable part still synced.
      expect(report.deletedRemote).toEqual([]);
      expect(s3.requests.filter((r) => r.method === "DELETE")).toEqual([]);
      expect(s3.text("cores/core-a/locked/b.txt")).toBe("b");
      expect(s3.text("cores/core-a/locked/deep/c.txt")).toBe("c");
      expect(s3.text("cores/core-a/open/new.txt")).toBe("new");
      expect(output.join("\n")).toContain("shared-sync.unreadable-folders");
      // And not downloaded over, either: S3 changes under it wait.
      s3.seed("cores/core-a/locked/b.txt", "changed in S3", t + 5_000);
      t += 10_000;
      expect((await sync.pass()).downloaded).toEqual([]);
    } finally {
      fs.chmodSync(path.join(folder, "locked"), 0o755);
      vi.restoreAllMocks();
    }
    // Readable again: the files were never gone, so the next pass takes the change from S3.
    await sync.pass();
    expect(readLocal("locked/b.txt")).toBe("changed in S3");
    expect(s3.text("cores/core-a/locked/deep/c.txt")).toBe("c");
  });

  it("treats a skipped line as an unreadable folder, and a listing that never ended as a failure", async () => {
    const lines = (...l: unknown[]) => Buffer.from(l.map((x) => JSON.stringify(x)).join("\n") + "\n");
    const top = lines({ type: "entry", path: "shared", kind: "directory", size: 0, mtime: 1, mode: 0o755 });
    const home = (list: Buffer) =>
      buildSharedHome(async (request) => ({ status: 200, headers: {}, body: request.op === "list" && request.path === "" ? top : list }));
    const seen = await home(
      lines(
        { type: "entry", path: "shared/a.txt", kind: "file", size: 1, mtime: 1, mode: 0o644 },
        { type: "skipped", path: "shared/locked", code: "unreadable-directory", message: "EACCES" },
        { type: "done", entries: 1, skipped: 1, bytes: 1 },
      ),
    ).list();
    expect(seen?.unreadable).toEqual(["locked"]);
    expect(seen?.files.map((f) => f.path)).toEqual(["a.txt"]);
    await expect(
      home(lines({ type: "entry", path: "shared/a.txt", kind: "file", size: 1, mtime: 1, mode: 0o644 })).list(),
    ).rejects.toThrow(/did not finish/);
  });
});

describe("a Core on one user does not claim a key nobody can read (R2)", () => {
  it("announces keyIsolated only when the daemon and core are different users", () => {
    const local = sharedCapability("local");
    expect(announceShared(true, local, true)).toEqual({ version: 1, backend: "s3", keyIsolated: true });
    expect(announceShared(true, local, false)).toEqual({ version: 1, backend: "s3" });
    expect(announceShared(true, local)).toEqual({ version: 1, backend: "s3" });
    expect(announceShared(false, local, true)).toEqual(local);
  });

  it("is not isolated when there is one user, says so in its log on attach, and still syncs", async () => {
    expect(sync.keyIsolated).toBe(false);
    const output: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => void output.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")));
    writeLocal("a.txt", "a");
    expect(await attach()).toMatchObject({ state: "attached" });
    expect(output.join("\n")).toContain("shared-sync.key-not-isolated");
    expect(s3.text("cores/core-a/a.txt")).toBe("a");
    vi.restoreAllMocks();
  });

  it("is isolated when told the users differ", () => {
    const two = createSharedSync({ stateDir, home: createSharedHome({ home: homeDir, identityEnv: {} }), keyIsolated: true });
    expect(two.keyIsolated).toBe(true);
  });
});

describe("remarks of the review", () => {
  it("does not overwrite a file changed locally while the pass was downloading", async () => {
    writeLocal("a.txt", "v0", 1_000);
    await attach();
    s3.seed("cores/core-a/a.txt", "from S3", t + 5_000);
    t += 10_000;
    const held = s3.hold((r) => r.method === "GET" && r.key.endsWith("a.txt"));
    const pass = sync.pass();
    await held.reached;
    writeLocal("a.txt", "edited meanwhile", 9_000);
    held.release();
    await pass;
    expect(readLocal("a.txt")).toBe("edited meanwhile");
  });

  it("keeps a file's mode when a change comes down", async () => {
    writeLocal("run.sh", "#!/bin/sh\n", 1_000);
    fs.chmodSync(path.join(folder, "run.sh"), 0o755);
    await attach();
    s3.seed("cores/core-a/run.sh", "#!/bin/sh\necho changed\n", t + 5_000);
    t += 10_000;
    await sync.pass();
    expect(readLocal("run.sh")).toContain("changed");
    expect(fs.statSync(path.join(folder, "run.sh")).mode & 0o777).toBe(0o755);
  });

  it("refuses a push that arrives while an attach is still proving its key, and keeps nothing of it", async () => {
    const k = newKey();
    const held = s3.hold((r) => r.method === "GET" && r.key === "");
    const attaching = sync.handle(attachFrame(k));
    await held.reached;
    expect(await sync.handle(credsFrame(newKey()))).toMatchObject({ state: "error", code: "mount-failed" });
    expect(createSharedKeyStore(stateDir).load()).toBeNull();
    held.release();
    expect(await attaching).toMatchObject({ state: "attached" });
    await sync.idle();
  });

  it("skips a key in S3 that is no path in the folder, once, and syncs the rest", async () => {
    const output: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => void output.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")));
    s3.seed("cores/core-a/bad\\name.txt", "x");
    s3.seed("cores/core-a/good.txt", "g");
    await attach();
    const report = await sync.pass();
    vi.restoreAllMocks();
    expect(report.failed).toEqual([]);
    expect(readLocal("good.txt")).toBe("g");
    expect(output.filter((l) => l.includes("remote-path-skipped")).length).toBe(1);
  });
});

describe("folders (#562)", () => {
  const dirAt = (rel: string): boolean => fs.existsSync(path.join(folder, rel)) && fs.statSync(path.join(folder, rel)).isDirectory();

  it("removes the folder a remote delete or move left empty, and every empty parent of it", async () => {
    s3.seed("cores/core-a/old/deep/a.txt", "a");
    s3.seed("cores/core-a/keep/b.txt", "b");
    await attach();
    expect(dirAt("old/deep")).toBe(true);
    s3.objects.delete("cores/core-a/old/deep/a.txt");
    const report = await sync.pass();
    expect(report.deletedLocal).toEqual(["old/deep/a.txt"]);
    expect(report.deletedDirs).toEqual(["old/deep", "old"]);
    expect(dirAt("old")).toBe(false);
    expect(dirAt("keep")).toBe(true);
  });

  it("removes the old folder when the Panel renames it", async () => {
    s3.seed("cores/core-a/before/f.txt", "f");
    await attach();
    s3.objects.delete("cores/core-a/before/f.txt");
    s3.seed("cores/core-a/after/f.txt", "f");
    await sync.pass();
    expect(dirAt("before")).toBe(false);
    expect(readLocal("after/f.txt")).toBe("f");
  });

  it("never removes a folder `core` made, empty or holding a file the sync has not uploaded", async () => {
    fs.mkdirSync(path.join(folder, "mine/empty"), { recursive: true });
    await attach();
    writeLocal("mine/new.txt", "n");
    s3.seed("cores/core-a/other/o.txt", "o");
    await sync.pass();
    s3.objects.delete("cores/core-a/other/o.txt");
    fs.mkdirSync(path.join(folder, "other/sub"), { recursive: true });
    writeLocal("other/mine.txt", "m", 1_000);
    await sync.pass();
    expect(dirAt("mine/empty")).toBe(true);
    expect(dirAt("other")).toBe(true);
    expect(readLocal("other/mine.txt")).toBe("m");
  });

  it("keeps a folder that still holds a file `core` changed while S3 deleted its other files", async () => {
    s3.seed("cores/core-a/d/a.txt", "a");
    s3.seed("cores/core-a/d/b.txt", "b");
    await attach();
    s3.objects.delete("cores/core-a/d/a.txt");
    s3.objects.delete("cores/core-a/d/b.txt");
    writeLocal("d/b.txt", "changed here", 4_000_000_000);
    await sync.pass();
    expect(readLocal("d/b.txt")).toBe("changed here");
    expect(dirAt("d")).toBe(true);
  });

  it("makes the empty folder the Panel made (a marker in S3), and keeps it", async () => {
    await attach();
    s3.seed("cores/core-a/Empty/", "");
    s3.seed("cores/core-a/Empty/Inner/", "");
    const report = await sync.pass();
    expect(report.createdDirs).toEqual(["Empty", "Empty/Inner"]);
    expect(dirAt("Empty/Inner")).toBe(true);
    const again = await sync.pass();
    expect(again.createdDirs).toEqual([]);
    expect(again.deletedDirs).toEqual([]);
    expect(dirAt("Empty/Inner")).toBe(true);
  });

  it("removes a made folder when the marker goes, and does not make again one `core` removed", async () => {
    s3.seed("cores/core-a/gone/", "");
    s3.seed("cores/core-a/mine/", "");
    await attach();
    expect(dirAt("gone")).toBe(true);
    fs.rmdirSync(path.join(folder, "mine"));
    s3.objects.delete("cores/core-a/gone/");
    const report = await sync.pass();
    expect(report.deletedDirs).toEqual(["gone"]);
    expect(dirAt("gone")).toBe(false);
    expect(dirAt("mine")).toBe(false);
  });

  it("does not remove folders on unpair, and copies the markers", async () => {
    s3.seed("cores/core-a/x/f.txt", "f");
    await attach();
    s3.objects.delete("cores/core-a/x/f.txt");
    s3.seed("cores/core-a/marker/", "");
    expect((await sync.handle({ type: "sharedDetach", reqId: "r9", keepLocalCopy: true })).state).toBe("detached");
    expect(dirAt("marker")).toBe(true);
    expect(dirAt("x")).toBe(true);
  });

  it("makes no folder through a symlink that leaves the Shared folder", async () => {
    const outside = path.join(homeDir, "proj");
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(folder, "l"));
    s3.seed("cores/core-a/l/new/", "");
    s3.seed("cores/core-a/fine/", "");
    await attach();
    const report = await sync.pass();
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(report.failed).toEqual([]);
    expect(dirAt("fine")).toBe(true);
  });

  it("a marker under a local file or at a link is no pass failure: unpair still works and removal still runs", async () => {
    s3.seed("cores/core-a/a", "i am a file");
    s3.seed("cores/core-a/gone/f.txt", "f");
    fs.symlinkSync(homeDir, path.join(folder, "ln"));
    await attach();
    s3.seed("cores/core-a/a/b/", "");
    s3.seed("cores/core-a/ln/", "");
    s3.objects.delete("cores/core-a/gone/f.txt");
    const report = await sync.pass();
    expect(report.failed).toEqual([]);
    expect(report.deletedDirs).toEqual(["gone"]);
    expect(readLocal("a")).toBe("i am a file");
    expect(await sync.handle({ type: "sharedDetach", reqId: "r8", keepLocalCopy: true })).toMatchObject({ state: "detached" });
  });

  it("removes a folder the Core emptied itself, once S3 has nothing under it (the rule is for both sides)", async () => {
    s3.seed("cores/core-a/outputs/a.txt", "a");
    await attach();
    fs.rmSync(path.join(folder, "outputs/a.txt"));
    const report = await sync.pass();
    expect(report.deletedRemote).toEqual(["outputs/a.txt"]);
    expect(report.deletedDirs).toEqual(["outputs"]);
  });

  it("the helper's folder removal refuses a folder with anything in it", async () => {
    const home = createSharedHome({ home: homeDir, identityEnv: {} });
    writeLocal("full/f.txt", "f");
    fs.mkdirSync(path.join(folder, "bare"));
    expect(await home.removeEmptyDir("full")).toBe(false);
    expect(readLocal("full/f.txt")).toBe("f");
    expect(await home.removeEmptyDir("bare")).toBe(true);
    expect(await home.removeEmptyDir("bare")).toBe(false);
    expect((await home.list())!.dirs).toEqual(["full"]);
  });
});
