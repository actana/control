import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSharedHome } from "../shared-home-io";
import { createSharedSync, type SharedSync } from "../shared-sync";
import { SHARED_CHANGED_EVENT_KIND, startSharedFolder, type SharedFolder } from "../shared-folder-feed";
import { FakeS3 } from "./shared-s3-fake";

// What the sync writes into `~/shared` is a change like any other: the watcher of #561 sees
// it and the feed appends the same `shared:changed` event (#562). The real watcher, the real
// folder and the real sync; only S3 is the fake.

const HOUR = 3_600_000;
const T0 = Date.parse("2026-10-01T12:00:00Z");

let root: string;
let home: string;
let folder: string;
let events: Array<{ kind: string; payload: Record<string, unknown>; sessionId: string | null | undefined }>;
let feed: SharedFolder;
let sync: SharedSync;
let s3: FakeS3;

beforeEach(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shared-sync-events-")));
  home = path.join(root, "home");
  folder = path.join(home, "shared");
  fs.mkdirSync(folder, { recursive: true });
  events = [];
  s3 = new FakeS3();
  s3.clock = () => T0;
  s3.issue({ accessKeyId: "AK", sessionToken: "TOKEN", prefix: "cores/core-a", expiresAt: T0 + HOUR });
  feed = await startSharedFolder({
    home,
    appendEvent: (kind, payload, opts) => {
      events.push({ kind, payload: JSON.parse(payload) as Record<string, unknown>, sessionId: opts?.sessionId });
      return events.length;
    },
    watchOptions: { debounceMs: 20, maxWaitMs: 100, safetyScanMs: 200 },
  });
  sync = createSharedSync({
    stateDir: path.join(root, "state"),
    home: createSharedHome({ home, identityEnv: {} }),
    now: () => T0,
    fetch: s3.fetch,
    intervalMs: HOUR,
  });
});

afterEach(() => {
  sync.stop();
  feed.stop();
  fs.rmSync(root, { recursive: true, force: true });
});

const attach = () =>
  sync.handle({
    type: "sharedAttach",
    reqId: "r",
    endpoint: "http://s3.test",
    bucket: s3.bucket,
    prefix: "cores/core-a",
    region: "us-east-1",
    credentials: { accessKeyId: "AK", secretAccessKey: "SECRET", sessionToken: "TOKEN" },
    expiresAt: new Date(T0 + HOUR).toISOString(),
  });

describe("shared:changed for what the sync writes", () => {
  it("emits the change for a file that came down from S3, and for one deleted there", async () => {
    s3.seed("cores/core-a/reports/r1.md", "# from the controller", T0 - 5_000);
    await attach();
    await sync.idle();

    await vi.waitFor(() => expect(events.find((e) => e.payload.path === "reports/r1.md")).toBeDefined(), { timeout: 3_000 });
    const arrived = events.find((e) => e.payload.path === "reports/r1.md")!;
    expect(arrived.kind).toBe(SHARED_CHANGED_EVENT_KIND);
    expect(arrived.sessionId).toBeNull();
    expect(arrived.payload).toEqual({
      path: "reports/r1.md",
      size: "# from the controller".length,
      mtime: T0 - 5_000,
      deleted: false,
    });

    s3.objects.delete("cores/core-a/reports/r1.md");
    await sync.pass();
    await vi.waitFor(() => expect(events.some((e) => e.payload.path === "reports/r1.md" && e.payload.deleted === true)).toBe(true), {
      timeout: 3_000,
    });
  });
});
