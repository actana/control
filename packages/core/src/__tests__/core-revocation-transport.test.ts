// Revocation, over the real transport (#283).
//
// Every other revocation assertion in this repository is made either against
// `clientCertGate` / `coreLinkUpgradeGate` as pure functions, or against a fake
// WebSocket server that is *handed* a `CoreLinkPeer`. Both are worth having and
// neither exercises the code that has to produce that peer in the first place:
// `peerCertSerial` reading `getPeerCertificate()` off a TLS socket,
// `isRevokedPeer`, the `isRevokedSerial` predicate threaded into
// `mountHttpRoutes`, and the `wss.on("connection", (ws, req))` extraction in
// `defaultCreateServer`. Nothing there had a test, so "a revoked certificate is
// refused on every `/v1/…` request" was asserted at the predicate and never
// through a server.
//
// So this suite pairs a client for real — a code, a CSR, a certificate this
// Core's CA signed — then revokes it the way `actana pair revoke` does, and
// dials back with exactly that certificate. The Core is built by its own
// default factory throughout; overriding `createServer` would test a rig.
import * as fs from "node:fs";
import * as https from "node:https";
import { Server } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { X509Certificate } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { generateCertMaterial, generateClientCsr } from "@actana/shared/core-cert-material";
import { verifyBearer } from "@actana/shared/core-link-bearer";
import { generatePairingCode } from "@actana/shared/pairing-code";
import { createPairingSession } from "@actana/shared/pairing-session";
import { PairingStore, derivePairingCodeKey, hashPairingCode } from "@actana/shared/pairing-store";
import { PtyCoreLinkServer } from "../pty-core-link-server";
import type { PtyCore, PtyCoreEvent } from "../pty-manager";
import { createCoreFilesRequestHandler } from "../core-files-routes";
import { buildCorePairingRoutes, composeCoreHttpRoutes, isPairingPath } from "../core-pairing-wiring";
import { PairingRevocations } from "../core-pairing-revocation";

const SECRET = "core-revocation-suite-secret-at-least-32-bytes";
const CORE_UUID = "0b1d2e3f-4a5b-6c7d-8e9f-0a1b2c3d4e5f";

type Paired = {
  /** The certificate this Core's CA signed, and the key that never left here. */
  cert: string;
  key: string;
  bearer: string;
  serial: string;
};

type Rig = {
  origin: string;
  wsUrl: string;
  caCert: string;
  store: PairingStore;
  storeFile: string;
  revocations: PairingRevocations;
  server: PtyCoreLinkServer;
  /** Redeem a fresh code and come back with a usable client credential. */
  pair(label?: string): Promise<Paired>;
};

let live: PtyCoreLinkServer | null = null;
const tempDirs: string[] = [];

afterEach(() => {
  live?.close();
  live = null;
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function mockCore(): PtyCore {
  return {
    setEmitTarget: (_fn: ((event: PtyCoreEvent) => void) | null) => {},
    spawn: async () => ({ ptyId: "pty-1", hooksReportTurnStart: true }),
    write: () => true,
    resize: () => true,
    kill: () => true,
    killLaunchProcesses: async () => ({ ptyCount: 0, ports: [] }),
    findByTask: () => ({ ptyId: null }),
    replay: () => ({ data: "", nextSeq: 0, from: 0 }),
    killAll: () => {},
  } as unknown as PtyCore;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = new Server();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address && typeof address === "object") {
        const { port } = address;
        probe.close(() => resolve(port));
      } else {
        probe.close();
        reject(new Error("no port"));
      }
    });
  });
}

type Response = { status: number; body: string };

function request(
  rig: Rig,
  url: string,
  opts: { method?: string; body?: object; client?: { cert: string; key: string } } = {},
): Promise<Response> {
  const payload = opts.body === undefined ? "" : JSON.stringify(opts.body);
  return new Promise((resolve, reject) => {
    const req = https.request(
      `${rig.origin}${url}`,
      {
        method: opts.method ?? "GET",
        agent: false,
        ca: rig.caCert,
        ...(opts.client ? { cert: opts.client.cert, key: opts.client.key } : {}),
        headers: payload ? { "content-type": "application/json" } : {},
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Dial the core link with this material. Resolves with what the Core did. */
function dial(
  rig: Rig,
  client: { cert: string; key: string },
  bearer: string,
): Promise<{ frames: string[]; error: string | null }> {
  return new Promise((resolve) => {
    const frames: string[] = [];
    const socket = new WebSocket(rig.wsUrl, { ca: rig.caCert, cert: client.cert, key: client.key });
    const done = (error: string | null) => {
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        /* already gone */
      }
      resolve({ frames, error });
    };
    const timer = setTimeout(() => done("timeout"), 10_000);
    socket.on("open", () => socket.send(JSON.stringify({ type: "auth", reqId: "a1", bearer })));
    socket.on("message", (data: unknown) => {
      const frame = JSON.parse(String(data)) as { type: string };
      frames.push(frame.type);
      if (frame.type === "authOk" || frame.type === "authError") done(null);
    });
    // A refused upgrade is an `error` here, not a frame: the server writes a 403
    // and destroys the socket before `ws` ever completes the handshake.
    socket.on("error", (err: Error) => done(err.message));
    socket.on("close", () => done(null));
  });
}

async function startCore(): Promise<Rig> {
  const material = await generateCertMaterial({ hosts: ["127.0.0.1"] });
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "actana-revocation-transport-"));
  tempDirs.push(dir);
  const storeFile = path.join(dir, "pairing.json");
  const store = new PairingStore(storeFile);
  const codeKey = derivePairingCodeKey(SECRET);
  const revocations = new PairingRevocations(store);
  revocations.refresh();

  const pairingRoutes = buildCorePairingRoutes({
    material: {
      caCert: material.ca.cert,
      caKey: material.ca.key,
      bearerSecret: SECRET,
      coreId: "core_revocation",
      coreUuid: CORE_UUID,
    },
    sessions: store,
    endpointFor: () => `wss://127.0.0.1:${port}`,
  });
  const fileRoutes = createCoreFilesRequestHandler({
    filesPort: { projectRoot: () => null },
    authVerifier: (bearer) => verifyBearer(bearer, SECRET),
  });

  const server = new PtyCoreLinkServer(mockCore(), {
    port,
    host: "127.0.0.1",
    tls: { caCert: material.ca.cert, serverCert: material.server.cert, serverKey: material.server.key },
    authVerifier: (bearer) => verifyBearer(bearer, SECRET),
    httpRoutes: composeCoreHttpRoutes(pairingRoutes, fileRoutes),
    isPreAuthPath: isPairingPath,
    revocation: revocations,
  });
  live = server;

  const rig: Rig = {
    origin: `https://127.0.0.1:${port}`,
    wsUrl: `wss://127.0.0.1:${port}`,
    caCert: material.ca.cert,
    store,
    storeFile,
    revocations,
    server,
    pair: async (label = "laptop") => {
      const code = generatePairingCode();
      const sessionId = `ps_${Math.random().toString(16).slice(2, 10)}`;
      store.createSession(
        createPairingSession({
          id: sessionId,
          label,
          codeHash: hashPairingCode({ key: codeKey, sessionId, code }),
          now: Date.now(),
        }),
      );
      const { csrPem, privateKeyPem } = await generateClientCsr(label);
      const res = await request(rig, "/v1/pair/redeem", {
        method: "POST",
        body: { sessionId, code, client: { label, platform: "linux" }, csr: csrPem },
      });
      if (res.status !== 200) throw new Error(`pairing failed: ${res.status} ${res.body}`);
      const issued = JSON.parse(res.body) as Record<string, string>;
      return {
        cert: issued.clientCert!,
        key: privateKeyPem,
        bearer: issued.bearer!,
        serial: new X509Certificate(issued.clientCert!).serialNumber,
      };
    },
  };

  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      await request(rig, "/healthz");
      return rig;
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

/** What `actana pair revoke` does, in the process that is not this one. */
function revoke(rig: Rig, serial: string): void {
  rig.store.revokeClient(serial.toLowerCase(), Date.now());
  rig.revocations.refresh();
}

describe("a revoked certificate, over the real transport", () => {
  it("is refused on the routes it was working on a moment ago", async () => {
    const rig = await startCore();
    const client = await rig.pair();

    // The control: the credential works before it is revoked, so the refusal
    // below is the revocation and not a broken handshake.
    const before = await request(rig, "/v1/projects/p1/files", { client });
    expect(before.status).not.toBe(403);

    revoke(rig, client.serial);

    const after = await request(rig, "/v1/projects/p1/files", { client });
    expect(after.status).toBe(403);
    expect(after.body).toContain("client-certificate-required");
  }, 30_000);

  it("is refused at the core-link upgrade", async () => {
    const rig = await startCore();
    const client = await rig.pair();

    const before = await dial(rig, client, client.bearer);
    expect(before.frames).toContain("authOk");

    revoke(rig, client.serial);

    const after = await dial(rig, client, client.bearer);
    expect(after.frames).not.toContain("authOk");
  }, 30_000);

  it("does not take another paired client down with it", async () => {
    const rig = await startCore();
    const doomed = await rig.pair("doomed");
    const spared = await rig.pair("spared");

    revoke(rig, doomed.serial);

    expect((await request(rig, "/v1/projects/p1/files", { client: doomed })).status).toBe(403);
    expect((await request(rig, "/v1/projects/p1/files", { client: spared })).status).not.toBe(403);
    expect((await dial(rig, spared, spared.bearer)).frames).toContain("authOk");
  }, 30_000);

  it("can still reach the pairing endpoint, which is how a machine re-pairs", async () => {
    // Revocation gets no pre-auth exception and needs none: the redemption dial
    // presents no certificate at all, so there is nothing on it to have been
    // revoked, and the operator's recovery path stays open.
    const rig = await startCore();
    const client = await rig.pair();
    revoke(rig, client.serial);

    const res = await request(rig, "/v1/pair/redeem", { method: "POST", body: { nonsense: true } });
    expect(res.status).not.toBe(403);
  }, 30_000);
});

describe("an unreadable pairing store, over the real transport", () => {
  it("refuses every paired client rather than serving them all", async () => {
    // The fail-closed guarantee, end to end. A half-written document is renamed
    // into place — which is how `PairingStore` writes, so a truncated write
    // looks exactly like this — and the daemon re-reads it.
    const rig = await startCore();
    const client = await rig.pair();
    expect((await request(rig, "/v1/projects/p1/files", { client })).status).not.toBe(403);

    fs.writeFileSync(rig.storeFile, '{"version":1,"sessions":[],"clients":[{"certSerial"');
    expect(rig.revocations.refresh().ok).toBe(false);

    expect((await request(rig, "/v1/projects/p1/files", { client })).status).toBe(403);
    expect((await dial(rig, client, client.bearer)).frames).not.toContain("authOk");
  }, 30_000);

  it("serves them again once the store is readable", async () => {
    const rig = await startCore();
    const client = await rig.pair();
    const good = fs.readFileSync(rig.storeFile, "utf8");

    fs.writeFileSync(rig.storeFile, "{ not json");
    rig.revocations.refresh();
    expect((await request(rig, "/v1/projects/p1/files", { client })).status).toBe(403);

    fs.writeFileSync(rig.storeFile, good);
    rig.revocations.refresh();
    expect((await request(rig, "/v1/projects/p1/files", { client })).status).not.toBe(403);
  }, 30_000);
});
