// The Panel's file surface, driven the way a browser drives it (#169, #129 F6/F11).
//
// The claim #129 makes for the whole phase is that **a file dropped on a Project
// is `cat`-able by a harness on that Core seconds later**, and there is only one
// honest way to test that: put a real Core on a real mTLS port with its real
// `/v1/…` routes, register its credential through the Panel's own Core service
// the way pairing does, PUT bytes at the Panel, and then read the file off that
// Core's disk with `fs`. Nothing below the Panel's API router is
// injected — no fake fetch, no stubbed link — so a
// pass means the certificate, the bearer, the URL shape, the capability gate and
// the streams all actually lined up.
//
// The suite is also where the *negative* half of "dumb pipe" is pinned, because
// it is the half a reviewer cannot see in a diff: a `..` path reaching the Core
// and being refused **by the Core** is what proves the Panel did not validate it,
// and a Core with no file routes being refused **before a request goes out** is
// what proves the F9 gate is a gate rather than a 404 handler.
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Server } from "node:net";
import { PtyCoreLinkServer } from "@actana/core/pty-core-link-server";
import { buildCoreFileRoutes } from "@actana/core/core-files-wiring";
import { generateCertMaterial } from "@actana/shared/core-cert-material";
import { signBearer, verifyBearer } from "@actana/shared/core-link-bearer";
import type { PtyCore } from "@actana/core/pty-manager";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ac-core-files-api-test-"));
process.env.AC_USER_DATA_DIR = path.join(tmpRoot, "app");
process.env.AC_PANEL_DATA_DIR = path.join(tmpRoot, "panel");

const { handleApiRequest } = await import("../api-router");
const { closePanelDb, getPanelDb } = await import("../panel-db");
const { operatorSessionCookie } = await import("./_operator-session");
const { coreLinkManager, resetCoreLinkManagerForTests } = await import(
  "../services/core-link-manager"
);
const { registerCoreFromCredential } = await import("../services/cores");
const { resetCoreFilesSendersForTests } = await import("../services/core-files-proxy");

const ORIGIN = "http://panel.example.test";
const BEARER_SECRET = "core-files-api-test-secret-32-bytes-x";
const PROJECT_ID = "p-files-1";

async function call(
  pathname: string,
  init: RequestInit & { anonymous?: boolean } = {},
): Promise<Response> {
  const { anonymous, ...rest } = init;
  const headers: Record<string, string> = { ...(rest.headers as Record<string, string>) };
  if (!anonymous) headers.cookie = operatorSessionCookie();
  const response = await handleApiRequest(
    new Request(`${ORIGIN}${pathname}`, { ...rest, headers } as RequestInit),
  );
  if (!response) throw new Error(`no API response for ${pathname}`);
  return response;
}

/** Every NDJSON line of an answer, parsed. The shape the Core streams (F5). */
async function ndjson(response: Response): Promise<Record<string, unknown>[]> {
  const text = await response.text();
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = new Server();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address && typeof address === "object") probe.close(() => resolve(address.port));
      else {
        probe.close();
        reject(new Error("no port"));
      }
    });
  });
}

function mockCore(): PtyCore {
  return {
    setEmitTarget: () => {},
    spawn: async () => ({ ptyId: "pty-1" }),
    write: () => true,
    resize: () => true,
    kill: () => true,
    killLaunchProcesses: async () => ({ ptyCount: 0, ports: [] }),
    killPtysUnderPath: async () => ({ ptyCount: 0 }),
    findByTask: () => ({ ptyId: null }),
    taskIdForPty: () => null,
    replay: () => ({ data: "", nextSeq: 0 }),
    killAll: () => {},
  } as unknown as PtyCore;
}

type CoreCredential = Parameters<typeof registerCoreFromCredential>[0];

type CoreFixture = { server: PtyCoreLinkServer; credential: CoreCredential; projectRoot: string };

/**
 * A Core on a real mTLS port.
 *
 * `createServer` is **not** overridden — the Core's own default factory is what
 * mounts the `/v1/…` routes beside the WebSocket, so overriding it would test a
 * rig rather than the thing. `withFiles: false` is the F9 case: the same Core,
 * the same link, no `httpRoutes`, and therefore no `files` on `ready`.
 */
async function startCore(label: string, opts: { withFiles?: boolean } = {}): Promise<CoreFixture> {
  const withFiles = opts.withFiles ?? true;
  const material = await generateCertMaterial({ host: "127.0.0.1" });
  const port = await freePort();
  const projectRoot = fs.mkdtempSync(path.join(tmpRoot, "project-"));
  const authVerifier = (bearer: string) => verifyBearer(bearer, BEARER_SECRET);
  const server = new PtyCoreLinkServer(mockCore(), {
    port,
    host: "127.0.0.1",
    tls: {
      caCert: material.ca.cert,
      serverCert: material.server.cert,
      serverKey: material.server.key,
    },
    authVerifier,
    ...(withFiles
      ? {
          httpRoutes: buildCoreFileRoutes({
            filesPort: { projectRoot: (id) => (id === PROJECT_ID ? projectRoot : null) },
            authVerifier,
          }),
        }
      : {}),
  });
  const credential = {
    endpoint: `wss://127.0.0.1:${port}`,
    label,
    caCert: material.ca.cert,
    clientCert: material.client.cert,
    clientKey: material.client.key,
    bearer: signBearer({ coreId: "core_files", exp: Date.now() + 600_000 }, BEARER_SECRET),
  };
  return { server, credential, projectRoot };
}

const running: PtyCoreLinkServer[] = [];

async function pair(opts: { withFiles?: boolean } = {}): Promise<{ id: string; projectRoot: string }> {
  const core = await startCore("files-vm", opts);
  running.push(core.server);
  // The two calls the pairing controller makes once a code has been redeemed.
  // There is no add route to POST a blob at any more (#287). The Operator row
  // is what the registry's foreign key points at, and an HTTP registration used
  // to create it on the way past — so ask for it before registering.
  operatorSessionCookie();
  const registered = registerCoreFromCredential(core.credential);
  coreLinkManager().dial(registered.id);
  await vi.waitFor(
    async () => {
      const dial = await dialOf(registered.id);
      expect(dial.state).toBe("connected");
      // The capability rides the dial status (#129 F9), so waiting on the state
      // alone would race the `ready` frame that carries it.
      expect(dial.files ?? null).toEqual(opts.withFiles === false ? null : { version: 1 });
    },
    { timeout: 15_000 },
  );
  return { id: registered.id, projectRoot: core.projectRoot };
}

async function dialOf(id: string): Promise<{ state: string; files?: { version: 1 } | null }> {
  const body = (await (await call("/api/cores")).json()) as {
    cores: { id: string; dial: { state: string; files?: { version: 1 } | null } }[];
  };
  const core = body.cores.find((c) => c.id === id);
  if (!core) throw new Error(`core ${id} not listed`);
  return core.dial;
}

function filesUrl(coreId: string, query: string): string {
  return `/api/cores/${coreId}/projects/${PROJECT_ID}/files${query}`;
}

async function put(
  coreId: string,
  filePath: string,
  body: string | Uint8Array,
): Promise<Response> {
  return call(filesUrl(coreId, `?path=${encodeURIComponent(filePath)}`), {
    method: "PUT",
    headers: { "content-type": "application/octet-stream" },
    body: body as BodyInit,
  });
}

afterEach(() => {
  resetCoreLinkManagerForTests();
  resetCoreFilesSendersForTests();
  for (const server of running.splice(0)) server.close();
  const db = getPanelDb();
  db.prepare("DELETE FROM core_secrets").run();
  db.prepare("DELETE FROM cores").run();
});

afterAll(() => {
  closePanelDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("a file dropped on a Project", () => {
  it("is on that Core's disk, at the path the browser named", async () => {
    const { id, projectRoot } = await pair();

    const response = await put(id, "notes/hello.txt", "the harness can read this");
    expect(response.status).toBe(200);

    const lines = await ndjson(response);
    expect(lines.at(-1)).toMatchObject({ type: "done", entries: 1 });

    // The claim, made the way #129 makes it: not "the Panel said 200" but
    // "the bytes are on that machine's filesystem, under that name".
    expect(fs.readFileSync(path.join(projectRoot, "notes/hello.txt"), "utf8")).toBe(
      "the harness can read this",
    );
  }, 40_000);

  it("reports progress from the Core's own NDJSON stream, naming every overwrite", async () => {
    const { id, projectRoot } = await pair();

    const first = await ndjson(await put(id, "readme.md", "first"));
    expect(first[0]).toMatchObject({ type: "entry", path: "readme.md", result: "written" });

    // F5: an overwrite is *named*, not inferred from a second 200.
    const second = await ndjson(await put(id, "readme.md", "second"));
    expect(second[0]).toMatchObject({ type: "entry", path: "readme.md", result: "overwritten" });
    expect(fs.readFileSync(path.join(projectRoot, "readme.md"), "utf8")).toBe("second");

    // The entries carry the manifest shape a future diff endpoint needs (F10),
    // and the Panel passed them through rather than re-deriving them.
    expect(second[0]).toMatchObject({ size: 6 });
    expect(typeof second[0]!.sha256).toBe("string");
  }, 40_000);

  it("comes back out of the same route, byte for byte", async () => {
    const { id } = await pair();
    await put(id, "round/trip.bin", new Uint8Array([0, 1, 2, 250, 251, 252]));

    const response = await call(filesUrl(id, `?path=${encodeURIComponent("round/trip.bin")}`));
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array([0, 1, 2, 250, 251, 252]),
    );
  }, 40_000);
});

describe("the file view", () => {
  it("lists the Project's tree as the Core streams it", async () => {
    const { id } = await pair();
    await put(id, "src/index.ts", "export {};\n");
    await put(id, "src/deep/leaf.txt", "leaf");

    const response = await call(`/api/cores/${id}/projects/${PROJECT_ID}/files/list?path=`);
    expect(response.status).toBe(200);
    const paths = (await ndjson(response))
      .filter((line) => line.type === undefined || line.type === "entry")
      .map((line) => line.path);
    expect(paths).toEqual(expect.arrayContaining(["src", "src/index.ts", "src/deep/leaf.txt"]));
  }, 40_000);

  it("is absent, not broken, against a Core that announces no file surface", async () => {
    const { id } = await pair({ withFiles: false });

    // The Core is *connected and healthy* — this is not an outage, and the dial
    // status says so: `files` is null and the state is still `connected`, which
    // is what lets a browser withhold the view instead of drawing a broken one.
    expect((await dialOf(id)).state).toBe("connected");

    for (const response of [
      await call(`/api/cores/${id}/projects/${PROJECT_ID}/files/list?path=`),
      await call(filesUrl(id, "?path=x.txt")),
      await put(id, "x.txt", "nope"),
    ]) {
      expect(response.status).toBe(501);
      expect(await response.json()).toMatchObject({ code: "files-unsupported" });
    }
  }, 40_000);

  it("says which Core it cannot find, rather than 500-ing", async () => {
    const response = await call(`/api/cores/core_missing/projects/${PROJECT_ID}/files/list?path=`);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "no-such-core" });
  });

  it("is behind the Operator session like every other route", async () => {
    const { id } = await pair();
    const response = await call(filesUrl(id, "?path=x.txt"), { anonymous: true });
    expect(response.status).toBe(401);
  }, 40_000);
});

describe("the Panel validates no path", () => {
  it("forwards `..` and lets the Core refuse it, with the Core's own code", async () => {
    const { id, projectRoot } = await pair();

    const response = await put(id, "../escaped.txt", "should never land");

    // A 400 from the *Core*, carrying the Core's vocabulary. A Panel that had
    // pre-validated would have answered with its own message and this code
    // would not exist — which is exactly how this test tells the two apart.
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "dot-dot-segment" });
    expect(fs.existsSync(path.join(path.dirname(projectRoot), "escaped.txt"))).toBe(false);
  }, 40_000);

  it("forwards an absolute path and lets the Core refuse that too", async () => {
    const { id } = await pair();
    const response = await put(id, "/etc/passwd", "no");
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "absolute-path" });
  }, 40_000);

  it("passes the Core's 404 for an unknown Project through unchanged", async () => {
    const { id } = await pair();
    const response = await call(`/api/cores/${id}/projects/p-unknown/files/list?path=`);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "project-not-found" });
  }, 40_000);
});
