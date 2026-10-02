import { generateKeyPairSync } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createS3CoreShared } from "@actana/sdk/shared";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { closePanelTestDb, openPanelTestDb, resetPanelState } from "./_panel-test-db";
import { FakeClock, fakeSts } from "./_shared-fakes";
import { FakeS3 } from "./_shared-s3-fake";

/**
 * The Files tab's routes (#565) through the real router, the real session gate and the real key issuer, on a fake S3
 * that answers only for the keys it issued, under the prefix each was issued for. No Core is connected in any of
 * them: the tab reads S3 directly. What is asserted, in the order the issue's proof asks for: Core and prefix scoping,
 * the path rules, that no key reaches the browser, the upload limit and the writes.
 */

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ac-shared-files-test-"));
process.env.AC_USER_DATA_DIR = path.join(tmpRoot, "app");
process.env.AC_PANEL_DATA_DIR = path.join(tmpRoot, "panel");

const { handleApiRequest } = await import("../api-router");
const testDb = await openPanelTestDb();
const { operatorSessionCookie, resetOperatorSessionForTests } = await import("./_operator-session");
const { registerCoreFromCredential } = await import("../services/cores");
const { saveStorageConfig, storageKeyIssuer } = await import("../services/storage");
const { DEFAULT_UPLOAD_LIMIT_BYTES } = await import("~/shared/shared-files");
const { SharedFiles, resetSharedFilesForTests } = await import("../services/shared-files");
const { updateSharedFolder } = await import("../repositories/core-shared-folders.repo");

const ORIGIN = "http://panel.example.test";
const BUCKET = "actana-shared";
const PREFIX = "cores";
const ENDPOINT = "http://seaweedfs.test:8333";
const masterPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const MASTER_PEM = masterPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const MASTER_BODY = MASTER_PEM.replace(/-----[A-Z ]+-----|\s/g, "");
const LIMIT = 64;

let n = 0;
/** A Core paired with its Shared folder attached. It is never connected: nothing here can reach a Core. */
async function attachedCore(opts: { state?: "attached" | "pending" } = {}): Promise<string> {
  n += 1;
  const core = await registerCoreFromCredential(
    { endpoint: `wss://files-core-${n}.test:7777`, caCert: "ca", clientCert: "cert", clientKey: "key", bearer: "b" },
    { label: `core ${n}`, pendingSharedFolder: true },
  );
  if ((opts.state ?? "attached") === "attached") {
    await updateSharedFolder(1, core.id, { state: "attached", s3Prefix: `${PREFIX}/${core.id}/` }, Date.now());
  }
  return core.id;
}

function rig() {
  const clock = new FakeClock();
  const s3 = new FakeS3(BUCKET);
  s3.clock = clock.now;
  const sts = fakeSts({ s3, masterPublic: masterPair.publicKey, prefix: PREFIX, clock });
  resetSharedFilesForTests(
    new SharedFiles({
      issuer: (ownerId) => storageKeyIssuer(ownerId, { fetch: sts.fetch, now: clock.now }),
      s3: ({ target, folder, key }) =>
        createS3CoreShared({
          endpoint: target.endpoint,
          bucket: target.bucket,
          prefix: folder.replace(/\/+$/, ""),
          region: target.region,
          credentials: { get: async () => key },
          fetch: s3.fetch,
          now: clock.now,
        }),
      now: clock.now,
    }),
  );
  return { clock, s3, sts };
}

async function call(
  pathname: string,
  init: { method?: string; json?: unknown; body?: BodyInit; headers?: Record<string, string>; cookie?: boolean } = {},
): Promise<Response> {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (init.cookie !== false) headers.cookie = await operatorSessionCookie();
  if (init.json !== undefined) headers["content-type"] = "application/json";
  return handleApiRequest(
    new Request(`${ORIGIN}${pathname}`, {
      method: init.method ?? "GET",
      headers,
      body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
      // @ts-expect-error — node's fetch needs this for a streamed body
      duplex: "half",
    }),
  ).then((r) => r!);
}

const files = (coreId: string, leaf = "", query = "") => `/api/cores/${coreId}/shared/files${leaf ? `/${leaf}` : ""}${query}`;
const q = (p: string) => `?path=${encodeURIComponent(p)}`;

beforeEach(async () => {
  resetOperatorSessionForTests();
  await operatorSessionCookie();
  await saveStorageConfig({
    backend: "seaweedfs",
    endpoint: ENDPOINT,
    bucket: BUCKET,
    prefix: PREFIX,
    oidcIssuer: "https://panel.test",
    keyId: "k1",
    masterKey: MASTER_PEM,
    uploadSizeLimitBytes: LIMIT,
  });
});
afterEach(async () => {
  resetSharedFilesForTests(null);
  await resetPanelState(testDb);
});
afterAll(async () => {
  await closePanelTestDb(testDb);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("listing the Shared folder with the Core offline", () => {
  it("lists folders first with item counts, then files with size and time, straight from S3", async () => {
    const { s3 } = rig();
    const a = await attachedCore();
    s3.seed(`${PREFIX}/${a}/readme.md`, "# hi", 1_000);
    s3.seed(`${PREFIX}/${a}/sessions/t1/report.md`, "r", 2_000);
    s3.seed(`${PREFIX}/${a}/sessions/t2/report.md`, "r", 2_000);
    s3.seed(`${PREFIX}/${a}/sessions/notes.txt`, "n", 3_000);

    const root = await (await call(files(a, "", q("")))).json();
    expect(root.entries.map((e: { name: string; kind: string }) => `${e.kind}:${e.name}`)).toEqual(["folder:sessions", "file:readme.md"]);
    expect(root.entries[0].itemCount).toBe(3);
    expect(root.entries[1]).toMatchObject({ path: "readme.md", size: 4, modifiedAt: 1_000 });

    const sessions = await (await call(files(a, "", q("sessions")))).json();
    expect(sessions.entries.map((e: { path: string }) => e.path)).toEqual(["sessions/t1", "sessions/t2", "sessions/notes.txt"]);
    expect(sessions.entries[0].itemCount).toBe(1);
  });

  it("answers for a Core that was never connected, and says nothing of the core-link", async () => {
    const { s3 } = rig();
    const a = await attachedCore();
    s3.seed(`${PREFIX}/${a}/x.txt`, "x");
    const res = await call(files(a, "", q("")));
    expect(res.status).toBe(200);
    expect((await res.json()).entries).toHaveLength(1);
  });

  it("refuses a Core with no Shared folder yet, and a Core that does not exist", async () => {
    rig();
    const pending = await attachedCore({ state: "pending" });
    const res = await call(files(pending, "", q("")));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/no Shared folder/);
    expect((await call(files("core_nope", "", q("")))).status).toBe(404);
  });

  it("needs the Operator's session", async () => {
    rig();
    const a = await attachedCore();
    expect((await call(files(a, "", q("")), { cookie: false })).status).toBe(401);
  });
});

describe("two Cores never reach each other's prefix", () => {
  it("serves each Core only its own objects and signs every request with that Core's key, for its own prefix", async () => {
    const { s3, sts } = rig();
    const a = await attachedCore();
    const b = await attachedCore();
    s3.seed(`${PREFIX}/${a}/only-a.txt`, "A");
    s3.seed(`${PREFIX}/${b}/only-b.txt`, "B");

    const listA = await (await call(files(a, "", q("")))).json();
    const listB = await (await call(files(b, "", q("")))).json();
    expect(listA.entries.map((e: { name: string }) => e.name)).toEqual(["only-a.txt"]);
    expect(listB.entries.map((e: { name: string }) => e.name)).toEqual(["only-b.txt"]);

    // The same name under B is not A's file: reading it as A is a 404, not B's bytes.
    expect((await call(files(a, "details", q("only-b.txt")))).status).toBe(404);
    expect((await call(files(a, "details", q(`../${b}/only-b.txt`)))).status).toBe(400);

    // Every request signed with A's key asked about A's prefix and nothing else, and likewise for B.
    const owner = new Map(sts.issued.map((k) => [k.accessKeyId, k.sub]));
    expect(new Set(owner.values())).toEqual(new Set([a, b]));
    for (const r of s3.requests) {
      const core = owner.get(r.accessKeyId)!;
      expect(r.key.startsWith(`${PREFIX}/${core}/`)).toBe(true);
      expect(r.status).not.toBe(403);
    }
    expect(s3.requests.some((r) => owner.get(r.accessKeyId) === a)).toBe(true);
    expect(s3.requests.some((r) => owner.get(r.accessKeyId) === b)).toBe(true);
  });

  it("writes only into the Core named in the URL", async () => {
    const { s3 } = rig();
    const a = await attachedCore();
    const b = await attachedCore();
    const res = await call(files(a, "upload", q("hello.txt")), { method: "PUT", body: "hi" });
    expect(res.status).toBe(200);
    expect(s3.text(`${PREFIX}/${a}/hello.txt`)).toBe("hi");
    expect([...s3.objects.keys()].some((k) => k.startsWith(`${PREFIX}/${b}/`))).toBe(false);
  });

  it("will not use a stored folder that is not the Core's own", async () => {
    const { s3 } = rig();
    const a = await attachedCore();
    const b = await attachedCore();
    s3.seed(`${PREFIX}/${b}/secret.txt`, "B");
    await updateSharedFolder(1, a, { s3Prefix: `${PREFIX}/${b}/x/` }, Date.now());
    const res = await call(files(a, "", q("")));
    expect(res.status).toBe(400);
    expect(s3.requests).toHaveLength(0);
  });
});

describe("paths from the browser are never trusted", () => {
  const bad = ["../x", "a/../b", "/etc/passwd", "a//b", "a\\b", "./a", "a/./b", "%2e%2e", "a\u0000b"];

  // `%2e%2e` is a name, not a traversal (the SDK does not decode): it is allowed, so it is not in the refused list.
  const refused = bad.filter((p) => p !== "%2e%2e");

  it.each(refused)("refuses %j on every route before a key is even issued, let alone anything sent to S3", async (p) => {
    const { s3, sts } = rig();
    const a = await attachedCore();
    const calls: Promise<Response>[] = [
      call(files(a, "", q(p))),
      call(files(a, "details", q(p))),
      call(files(a, "media", q(p))),
      call(files(a, "download-url"), { method: "POST", json: { path: p } }),
      call(files(a, "mkdir"), { method: "POST", json: { path: `${p}/` } }),
      call(files(a, "upload", q(p)), { method: "PUT", body: "x" }),
      call(files(a, "rename"), { method: "POST", json: { path: p, name: "n" } }),
      call(files(a, "move"), { method: "POST", json: { path: "ok.txt", to: p } }),
      call(files(a, "move"), { method: "POST", json: { path: p, to: "" } }),
      call(files(a, "delete"), { method: "POST", json: { path: p } }),
    ];
    for (const res of await Promise.all(calls)) expect(res.status).toBe(400);
    // The Panel's own rule refused it: the SDK's identical rule sits behind a key issued and a client built.
    expect(sts.issued).toHaveLength(0);
    expect(s3.requests).toHaveLength(0);
    expect(s3.objects.size).toBe(0);
  });

  it("refuses the root for rename, move and delete, and a name that is a path, before a key is issued", async () => {
    const { s3, sts } = rig();
    const a = await attachedCore();
    s3.seed(`${PREFIX}/${a}/f.txt`, "x");
    expect((await call(files(a, "delete"), { method: "POST", json: { path: "" } })).status).toBe(400);
    expect((await call(files(a, "rename"), { method: "POST", json: { path: "", name: "x" } })).status).toBe(400);
    expect((await call(files(a, "move"), { method: "POST", json: { path: "", to: "d/" } })).status).toBe(400);
    for (const name of ["a/b", "..", "", "x\\y"]) {
      expect((await call(files(a, "rename"), { method: "POST", json: { path: "f.txt", name } })).status).toBe(400);
    }
    expect(s3.text(`${PREFIX}/${a}/f.txt`)).toBe("x");
    expect(sts.issued).toHaveLength(0);
  });
});

describe("no key reaches the browser", () => {
  it("returns no credential of the Panel's from any route: not the master key, not an issued key", async () => {
    const { s3, sts } = rig();
    const a = await attachedCore();
    s3.seed(`${PREFIX}/${a}/a.txt`, "text");
    s3.seed(`${PREFIX}/${a}/pic.png`, "png");
    const seen: string[] = [];
    const record = async (res: Response) => {
      seen.push(`${res.status} ${JSON.stringify([...res.headers])} ${await res.clone().text()}`);
      return res;
    };
    await record(await call(files(a, "", q(""))));
    await record(await call(files(a, "details", q("a.txt"))));
    await record(await call(files(a, "media", q("pic.png"))));
    await record(await call(files(a, "search", "?q=a")));
    await record(await call(files(a, "summary", "?since=0")));
    await record(await call(files(a, "mkdir"), { method: "POST", json: { path: "d/" } }));
    await record(await call(files(a, "upload", q("d/u.txt")), { method: "PUT", body: "u" }));
    await record(await call(files(a, "rename"), { method: "POST", json: { path: "d/u.txt", name: "v.txt" } }));
    await record(await call(files(a, "move"), { method: "POST", json: { path: "d/v.txt", to: "" } }));
    await record(await call(files(a, "delete"), { method: "POST", json: { path: "v.txt" } }));
    await record(await call(files(a, "delete"), { method: "POST", json: { path: "nothing-here.txt" } }));
    await record(await call(files(a, "details", q("../bad"))));

    expect(sts.issued.length).toBeGreaterThan(0);
    const all = seen.join("\n");
    expect(all).not.toContain(MASTER_BODY);
    expect(all).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/);
    for (const k of sts.issued) expect(all).not.toContain(k.accessKeyId);
    expect(all).not.toMatch(/x-amz-security-token|sessiontoken|secretaccesskey/i);
  });

  it("hands out one signed URL for one object, valid five minutes, and no key beside it", async () => {
    const { s3, clock } = rig();
    const a = await attachedCore();
    s3.seed(`${PREFIX}/${a}/reports/r1.md`, "r");
    s3.seed(`${PREFIX}/${a}/reports/r2.md`, "r");
    const res = await call(files(a, "download-url"), { method: "POST", json: { path: "reports/r1.md" } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(["expiresAt", "url"]);
    const url = new URL(body.url);
    expect(url.origin).toBe(ENDPOINT);
    expect(decodeURIComponent(url.pathname)).toBe(`/${BUCKET}/${PREFIX}/${a}/reports/r1.md`);
    expect(url.searchParams.get("X-Amz-Expires")).toBe("300");
    expect(body.expiresAt).toBe(clock.now() + 300_000);
    expect(JSON.stringify(body)).not.toContain(MASTER_BODY);
    // A file that is not there gets no URL.
    expect((await call(files(a, "download-url"), { method: "POST", json: { path: "reports/none.md" } })).status).toBe(404);
    // A folder is not a file.
    expect((await call(files(a, "download-url"), { method: "POST", json: { path: "reports/" } })).status).toBe(400);
  });
});

describe("previews", () => {
  it("shows a text preview, the tail of a log, and says when it was cut", async () => {
    const { s3 } = rig();
    const a = await attachedCore();
    s3.seed(`${PREFIX}/${a}/doc.md`, "# title\nbody");
    s3.seed(`${PREFIX}/${a}/run.log`, `${"x".repeat(70 * 1024)}THE END`);
    const md = await (await call(files(a, "details", q("doc.md")))).json();
    expect(md.preview).toEqual({ kind: "markdown", text: "# title\nbody", truncated: false });
    const log = await (await call(files(a, "details", q("run.log")))).json();
    expect(log.preview.kind).toBe("log");
    expect(log.preview.truncated).toBe(true);
    expect(log.preview.text.endsWith("THE END")).toBe(true);
    expect(log.preview.text.length).toBe(64 * 1024);
  });

  it("streams an image inline through the Panel, and never an SVG or a page", async () => {
    const { s3 } = rig();
    const a = await attachedCore();
    s3.seed(`${PREFIX}/${a}/p.png`, "PNGDATA");
    s3.seed(`${PREFIX}/${a}/evil.svg`, "<svg onload=alert(1)/>");
    s3.seed(`${PREFIX}/${a}/page.html`, "<script>alert(1)</script>");
    const ok = await call(files(a, "media", q("p.png")));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("image/png");
    expect(ok.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await ok.text()).toBe("PNGDATA");
    expect((await call(files(a, "media", q("evil.svg")))).status).toBe(400);
    expect((await call(files(a, "media", q("page.html")))).status).toBe(400);
  });
});

describe("the upload limit is the one stored in Storage settings", () => {
  const put = (coreId: string, name: string, size: number) =>
    call(files(coreId, "upload", q(name)), { method: "PUT", body: new Uint8Array(size), headers: { "content-length": String(size) } });
  const setLimit = (uploadSizeLimitBytes: number) =>
    saveStorageConfig({ backend: "seaweedfs", endpoint: ENDPOINT, bucket: BUCKET, prefix: PREFIX, oidcIssuer: "https://panel.test", keyId: "k1", uploadSizeLimitBytes });

  it("refuses a file one byte over the stored limit and takes one at it, and the summary reports the same number", async () => {
    const { s3 } = rig();
    const a = await attachedCore();
    await setLimit(1_000);

    const over = await put(a, "over.bin", 1_001);
    expect(over.status).toBe(413);
    expect(over.headers.get("x-upload-limit")).toBe("1000");
    expect(s3.objects.size).toBe(0);
    expect((await put(a, "at.bin", 1_000)).status).toBe(200);
    expect(s3.objects.get(`${PREFIX}/${a}/at.bin`)?.bytes.byteLength).toBe(1_000);
    expect((await (await call(files(a, "summary"))).json()).uploadLimitBytes).toBe(1_000);
  });

  it("reads the limit again on every request: a change in Storage settings applies to the next upload", async () => {
    rig();
    const a = await attachedCore();
    await setLimit(500);
    expect((await put(a, "first.bin", 501)).status).toBe(413);

    await setLimit(600);
    expect((await put(a, "second.bin", 501)).status).toBe(200);
    await setLimit(100);
    expect((await put(a, "third.bin", 101)).status).toBe(413);
  });

  it("applies the stored limit to a stream with no declared length", async () => {
    const { s3 } = rig();
    const a = await attachedCore();
    await setLimit(70);
    const chunks = [new Uint8Array(40), new Uint8Array(40)];
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = chunks.shift();
        if (next) controller.enqueue(next);
        else controller.close();
      },
    });

    const res = await call(files(a, "upload", q("stream.bin")), { method: "PUT", body: stream });

    expect(res.status).toBe(413);
    expect(res.headers.get("x-upload-limit")).toBe("70");
    expect(s3.objects.size).toBe(0);
  });

  it("keeps a sane default of 100 MB when no limit is stored", async () => {
    rig();
    const a = await attachedCore();
    await testDb.pool.query("delete from storage_config");

    const over = await put(a, "huge.bin", DEFAULT_UPLOAD_LIMIT_BYTES + 1);

    expect(over.status).toBe(413);
    expect(over.headers.get("x-upload-limit")).toBe(String(DEFAULT_UPLOAD_LIMIT_BYTES));
  });
});

describe("uploads", () => {
  it("refuses a file over the limit from its declared length, before a key is issued: nothing written, S3 asked for nothing", async () => {
    const { s3, sts } = rig();
    const a = await attachedCore();
    const res = await call(files(a, "upload", q("big.bin")), {
      method: "PUT",
      body: new Uint8Array(LIMIT + 1),
      headers: { "content-length": String(LIMIT + 1) },
    });
    expect(res.status).toBe(413);
    expect(res.headers.get("x-upload-limit")).toBe(String(LIMIT));
    expect(sts.issued).toHaveLength(0);
    expect(s3.objects.size).toBe(0);
    expect(s3.requests.filter((r) => r.method === "PUT")).toHaveLength(0);
  });

  it("refuses a stream that goes over the limit with no length declared, and writes nothing", async () => {
    const { s3 } = rig();
    const a = await attachedCore();
    const chunks = [new Uint8Array(40), new Uint8Array(40)];
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = chunks.shift();
        if (next) controller.enqueue(next);
        else controller.close();
      },
    });
    const res = await call(files(a, "upload", q("big.bin")), { method: "PUT", body: stream });
    expect(res.status).toBe(413);
    expect(s3.objects.size).toBe(0);
  });

  it("takes a file exactly at the limit", async () => {
    const { s3 } = rig();
    const a = await attachedCore();
    const res = await call(files(a, "upload", q("edge.bin")), { method: "PUT", body: new Uint8Array(LIMIT) });
    expect(res.status).toBe(200);
    expect((await res.json()).entry).toMatchObject({ path: "edge.bin", size: LIMIT });
    expect(s3.objects.get(`${PREFIX}/${a}/edge.bin`)?.bytes.byteLength).toBe(LIMIT);
  });

  it("takes a body-less PUT as an empty file (a new text file is one)", async () => {
    const { s3 } = rig();
    const a = await attachedCore();
    const res = await call(files(a, "upload", q("notes/untitled.txt")), { method: "PUT" });
    expect(res.status).toBe(200);
    expect((await res.json()).entry).toMatchObject({ path: "notes/untitled.txt", size: 0 });
    expect(s3.objects.get(`${PREFIX}/${a}/notes/untitled.txt`)?.bytes.byteLength).toBe(0);
  });

  it("keeps a folder's whole tree: nested files and an empty folder come back where they were", async () => {
    const { s3 } = rig();
    const a = await attachedCore();
    const tree = ["brand/readme.md", "brand/src/a.ts", "brand/src/deep/b.ts", "brand/src/deep/er/c.ts"];
    for (const p of tree) expect((await call(files(a, "upload", q(p)), { method: "PUT", body: p })).status).toBe(200);
    expect((await call(files(a, "mkdir"), { method: "POST", json: { path: "brand/empty/" } })).status).toBe(200);

    const keys = [...s3.objects.keys()].filter((k) => !k.endsWith("/")).map((k) => k.slice(`${PREFIX}/${a}/`.length)).sort();
    expect(keys).toEqual([...tree].sort());
    for (const p of tree) expect(s3.text(`${PREFIX}/${a}/${p}`)).toBe(p);
    const top = await (await call(files(a, "", q("brand")))).json();
    expect(top.entries.map((e: { name: string }) => e.name)).toEqual(["empty", "src", "readme.md"]);
    const deep = await (await call(files(a, "", q("brand/src/deep")))).json();
    expect(deep.entries.map((e: { name: string }) => e.name)).toEqual(["er", "b.ts"]);
  });
});

describe("rename, move, delete and mkdir", () => {
  it("creates nested folders and lists them", async () => {
    rig();
    const a = await attachedCore();
    for (const p of ["a/", "a/b/", "a/b/c/"]) expect((await call(files(a, "mkdir"), { method: "POST", json: { path: p } })).status).toBe(200);
    expect((await (await call(files(a, "", q("a/b")))).json()).entries.map((e: { path: string }) => e.path)).toEqual(["a/b/c"]);
  });

  it("renames a file and a folder with its contents, and refuses a name that is taken", async () => {
    const { s3 } = rig();
    const a = await attachedCore();
    s3.seed(`${PREFIX}/${a}/d/one.txt`, "1");
    s3.seed(`${PREFIX}/${a}/d/two.txt`, "2");
    s3.seed(`${PREFIX}/${a}/d/sub/three.txt`, "3");
    const file = await call(files(a, "rename"), { method: "POST", json: { path: "d/one.txt", name: "uno.txt" } });
    expect(await file.json()).toEqual({ path: "d/uno.txt" });
    expect(s3.text(`${PREFIX}/${a}/d/uno.txt`)).toBe("1");
    expect(s3.objects.has(`${PREFIX}/${a}/d/one.txt`)).toBe(false);

    expect((await call(files(a, "rename"), { method: "POST", json: { path: "d/uno.txt", name: "two.txt" } })).status).toBe(409);

    const folder = await call(files(a, "rename"), { method: "POST", json: { path: "d/", name: "e" } });
    expect(await folder.json()).toEqual({ path: "e" });
    expect(s3.text(`${PREFIX}/${a}/e/sub/three.txt`)).toBe("3");
    expect([...s3.objects.keys()].some((k) => k.startsWith(`${PREFIX}/${a}/d/`))).toBe(false);
  });

  it("moves a file and a folder into another folder, and refuses a folder moved into itself", async () => {
    const { s3 } = rig();
    const a = await attachedCore();
    s3.seed(`${PREFIX}/${a}/x/f.txt`, "f");
    s3.seed(`${PREFIX}/${a}/x/y/g.txt`, "g");
    s3.seed(`${PREFIX}/${a}/dest/.keep`, "");
    expect(await (await call(files(a, "move"), { method: "POST", json: { path: "x/f.txt", to: "dest/" } })).json()).toEqual({ path: "dest/f.txt" });
    expect(s3.text(`${PREFIX}/${a}/dest/f.txt`)).toBe("f");
    expect(await (await call(files(a, "move"), { method: "POST", json: { path: "x/y/", to: "dest/" } })).json()).toEqual({ path: "dest/y" });
    expect(s3.text(`${PREFIX}/${a}/dest/y/g.txt`)).toBe("g");
    const into = await call(files(a, "move"), { method: "POST", json: { path: "dest/", to: "dest/y/" } });
    expect(into.status).toBe(400);
    expect(s3.text(`${PREFIX}/${a}/dest/y/g.txt`)).toBe("g");
  });

  it("deletes a file, and a folder with everything in it, and a missing one is a 404", async () => {
    const { s3 } = rig();
    const a = await attachedCore();
    s3.seed(`${PREFIX}/${a}/keep.txt`, "k");
    s3.seed(`${PREFIX}/${a}/gone/1.txt`, "1");
    s3.seed(`${PREFIX}/${a}/gone/deep/2.txt`, "2");
    expect((await call(files(a, "delete"), { method: "POST", json: { path: "gone/" } })).status).toBe(200);
    expect([...s3.objects.keys()]).toEqual([`${PREFIX}/${a}/keep.txt`]);
    expect((await call(files(a, "delete"), { method: "POST", json: { path: "keep.txt" } })).status).toBe(200);
    expect(s3.objects.size).toBe(0);
    expect((await call(files(a, "delete"), { method: "POST", json: { path: "keep.txt" } })).status).toBe(404);
  });
});

describe("search and the change feed", () => {
  it("finds names anywhere in the folder, folders first", async () => {
    const { s3 } = rig();
    const a = await attachedCore();
    s3.seed(`${PREFIX}/${a}/reports/Report-1.md`, "x");
    s3.seed(`${PREFIX}/${a}/reports/other.md`, "x");
    s3.seed(`${PREFIX}/${a}/old-reports/a.md`, "x");
    const res = await (await call(files(a, "search", "?q=report"))).json();
    expect(res.entries.map((e: { path: string }) => e.path)).toEqual(["old-reports", "reports", "reports/Report-1.md"]);
    expect((await (await call(files(a, "search", "?q="))).json()).entries).toEqual([]);
  });

  it("names the files written since the last visit, and the bytes used", async () => {
    const { s3 } = rig();
    const a = await attachedCore();
    s3.seed(`${PREFIX}/${a}/old.txt`, "1234", 1_000);
    s3.seed(`${PREFIX}/${a}/sub/fresh.txt`, "12", 5_000);
    const sum = await (await call(files(a, "summary", "?since=2000"))).json();
    expect(sum).toMatchObject({ backend: "SeaweedFS", usedBytes: 6, fileCount: 2, newPaths: ["sub/fresh.txt"], uploadLimitBytes: LIMIT });
    expect((await (await call(files(a, "summary", "?since=0"))).json()).newPaths).toEqual(["old.txt", "sub/fresh.txt"]);
  });
});
