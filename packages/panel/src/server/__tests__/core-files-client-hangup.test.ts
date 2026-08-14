// A drop whose browser walked away, over a real socket (#225).
//
// The other file suites drive `handleApiRequest` directly, which is the right
// shape for what they assert and cannot express this one at all: the question
// here is what happens to a transfer when the **operator's connection** dies,
// and a `Request` built in the same process has no connection to lose. So this
// suite puts a real `node:http` server in front of the router — through
// `serveNodeRequest`, the same bridge `bin/panel.mjs` and the Vite dev
// middleware both run — and a real Core with its real `/v1/…` routes behind it.
//
// What #225 reported, in order: a drop that dies with the browser's `Failed to
// fetch`; an immediate retry refused `409 transfer-in-progress` by the transfer
// that had just been reported dead; and the Project's file listing failing at
// the same time, even though reads are supposed to be unrestricted and
// concurrent with a write.
//
// The last two are asserted here, against the Core's own lock table rather than
// against a status the Panel invented: `buildCoreFileRoutes` hands back the
// `ProjectWriteLocks` precisely so a test can see what is in flight. The first
// — the connection that produced no response at all — is pinned next door in
// `node-http-bridge.test.ts`, where a body that fails half-written no longer
// ends the Panel process with an unhandled `'error'` event.
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { Server } from "node:net";
import { PtyCoreLinkServer } from "@actana/core/pty-core-link-server";
import { buildCoreFileRoutes } from "@actana/core/core-files-wiring";
import { generateCertMaterial } from "@actana/core/core-cert-material";
import { signBearer, verifyBearer } from "@actana/shared/core-link-bearer";
import { encodeRegistrationBlob } from "@actana/shared/registration-blob";
import type { ProjectWriteLocks } from "@actana/core/files-transfer-locks";
import type { PtyCore } from "@actana/core/pty-manager";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ac-core-files-hangup-"));
process.env.AC_USER_DATA_DIR = path.join(tmpRoot, "app");
process.env.AC_PANEL_DATA_DIR = path.join(tmpRoot, "panel");

const { handleApiRequest } = await import("../api-router");
const { serveNodeRequest } = await import("../node-http-bridge");
const { closePanelDb, getPanelDb } = await import("../panel-db");
const { operatorSessionCookie } = await import("./_operator-session");
const { resetCoreLinkManagerForTests } = await import("../services/core-link-manager");
const { resetCoreFilesSendersForTests } = await import("../services/core-files-proxy");

const BEARER_SECRET = "core-files-hangup-secret-32-bytes-x";
const PROJECT_ID = "p-hangup";

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

const running: PtyCoreLinkServer[] = [];
const listening: http.Server[] = [];

type Rig = { coreId: string; projectRoot: string; locks: ProjectWriteLocks; port: number };

/** A real Core, paired through the Panel, behind a real Panel HTTP server. */
async function rig(): Promise<Rig> {
  const material = await generateCertMaterial({ host: "127.0.0.1" });
  const corePort = await freePort();
  const projectRoot = fs.mkdtempSync(path.join(tmpRoot, "project-"));
  const authVerifier = (bearer: string) => verifyBearer(bearer, BEARER_SECRET);
  const routes = buildCoreFileRoutes({
    filesPort: { projectRoot: (id) => (id === PROJECT_ID ? projectRoot : null) },
    authVerifier,
  });
  const core = new PtyCoreLinkServer(mockCore(), {
    port: corePort,
    host: "127.0.0.1",
    tls: {
      caCert: material.ca.cert,
      serverCert: material.server.cert,
      serverKey: material.server.key,
    },
    authVerifier,
    httpRoutes: routes,
  });
  running.push(core);

  const registrationBlob = encodeRegistrationBlob({
    endpoint: `wss://127.0.0.1:${corePort}`,
    label: "hangup-vm",
    caCert: material.ca.cert,
    clientCert: material.client.cert,
    clientKey: material.client.key,
    bearer: signBearer({ coreId: "core_hangup", exp: Date.now() + 600_000 }, BEARER_SECRET),
  });
  const added = await handleApiRequest(
    new Request("http://panel.test/api/cores", {
      method: "POST",
      headers: { cookie: operatorSessionCookie(), "content-type": "application/json" },
      body: JSON.stringify({ registrationBlob }),
    }),
  );
  const { core: registered } = (await added!.json()) as { core: { id: string } };
  await vi.waitFor(
    async () => {
      const listed = (await (
        await handleApiRequest(
          new Request("http://panel.test/api/cores", {
            headers: { cookie: operatorSessionCookie() },
          }),
        )
      )!.json()) as { cores: { id: string; dial: { state: string; files?: unknown } }[] };
      const row = listed.cores.find((c) => c.id === registered.id);
      expect(row?.dial.state).toBe("connected");
      expect(row?.dial.files).toEqual({ version: 1 });
    },
    { timeout: 15_000 },
  );

  // The Panel as it is actually deployed: a Node HTTP server whose every
  // request goes through the shared bridge.
  const server = http.createServer((req, res) => {
    void serveNodeRequest(req, res, (request) => handleApiRequest(request)).catch(() => {
      if (!res.headersSent && !res.destroyed) {
        res.statusCode = 500;
        res.end();
      }
    });
  });
  const panelPort = await freePort();
  await new Promise<void>((resolve) => server.listen(panelPort, "127.0.0.1", resolve));
  listening.push(server);

  return { coreId: registered.id, projectRoot, locks: routes.locks, port: panelPort };
}

function base(r: Rig): string {
  return `/api/cores/${encodeURIComponent(r.coreId)}/projects/${encodeURIComponent(PROJECT_ID)}`;
}

/**
 * A drop, driven down a raw socket so the test can hang up mid-transfer.
 *
 * `Content-Length` and a `File`-shaped body, which is what a browser sends —
 * the e2e's own helper uses chunked encoding and would not have found this.
 */
function startDrop(r: Rig, relative: string, size: number): { socket: net.Socket; sent: Promise<void> } {
  const socket = net.connect(r.port, "127.0.0.1");
  const sent = new Promise<void>((resolve, reject) => {
    socket.on("error", reject);
    // Hanging up is what this helper exists to do, so a socket that closes
    // part-way through settles rather than leaving the caller awaiting bytes
    // it has just decided never to send.
    socket.on("close", () => resolve());
    socket.on("connect", () => {
      socket.write(
        `PUT ${base(r)}/files?path=${encodeURIComponent(relative)} HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${r.port}\r\n` +
          `Connection: keep-alive\r\n` +
          `Content-Type: application/octet-stream\r\n` +
          `Accept: application/x-ndjson\r\n` +
          `Content-Length: ${size}\r\n` +
          `Cookie: ${operatorSessionCookie()}\r\n\r\n`,
      );
      const slice = Buffer.alloc(256 * 1024, 0xab);
      let written = 0;
      const pump = (): void => {
        while (written < size) {
          if (socket.destroyed) return;
          const n = Math.min(slice.length, size - written);
          written += n;
          if (!socket.write(slice.subarray(0, n))) {
            socket.once("drain", pump);
            return;
          }
        }
        resolve();
      };
      pump();
    });
  });
  return { socket, sent: sent.catch(() => undefined) };
}

async function call(r: Rig, pathname: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${r.port}${pathname}`, {
    ...init,
    headers: { cookie: operatorSessionCookie(), ...(init.headers as Record<string, string>) },
  } as RequestInit);
}

afterEach(async () => {
  resetCoreLinkManagerForTests();
  resetCoreFilesSendersForTests();
  for (const server of running.splice(0)) server.close();
  for (const server of listening.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  const db = getPanelDb();
  db.prepare("DELETE FROM core_secrets").run();
  db.prepare("DELETE FROM cores").run();
});

afterAll(() => {
  closePanelDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("a drop whose browser hangs up", () => {
  it("does not leave the Project's write lease held behind it", async () => {
    const r = await rig();

    const drop = startDrop(r, "assets/model.blend", 48 * 1024 * 1024);
    // The Core has the transfer: this is the state #225's retry ran into.
    await vi.waitFor(() => expect(r.locks.current(PROJECT_ID)).not.toBeNull(), { timeout: 15_000 });

    drop.socket.destroy();
    await drop.sent;

    // The whole of the reported symptom, as a fact about the Core rather than
    // as a status the Panel chose: nothing is writing this Project any more.
    // Without the abort the Panel now wires from the operator's socket into
    // `pipeToCore`, this lease is held for the rest of a transfer nobody is
    // receiving, and the operator's next drop is refused.
    await vi.waitFor(() => expect(r.locks.current(PROJECT_ID)).toBeNull(), { timeout: 15_000 });

    // …and the next drop is answered rather than refused `transfer-in-progress`,
    // on its first attempt, which is what the operator actually does next.
    const retry = await call(r, `${base(r)}/files?path=assets/model.blend`, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: "second attempt",
    });
    expect(retry.status).toBe(200);
    expect(await retry.text()).toContain('"result"');
  }, 60_000);

  it("still lets a read of the same Project through while a write is running", async () => {
    const r = await rig();
    await call(r, `${base(r)}/files?path=already-here.txt`, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: "here first",
    }).then((res) => res.text());

    const drop = startDrop(r, "assets/big.bin", 48 * 1024 * 1024);
    await vi.waitFor(() => expect(r.locks.current(PROJECT_ID)).not.toBeNull(), { timeout: 15_000 });

    // F8's other half, and the one an operator notices when it breaks: one
    // write at a time, and reads unrestricted and concurrent with it. Nothing
    // in #225's fix may serialise this behind the transfer.
    const listed = await call(r, `${base(r)}/files/list?path=`, {
      headers: { accept: "application/x-ndjson" },
    });
    expect(listed.status).toBe(200);
    expect(await listed.text()).toContain("already-here.txt");

    drop.socket.destroy();
    await drop.sent;
  }, 60_000);
});
