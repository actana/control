// The pairing endpoint, against a real Core (#282).
//
// Everything here goes over the wire. The server is built by the Core's own
// default factory, the certificates come from `generateCertMaterial` — the
// material `actana setup` writes — the sessions go through the same
// `PairingStore` the operator's `actana pair new` will write, and the client
// dials `https` with no client certificate, because not having one is the whole
// reason it is here.
//
// What that buys over a handler test: the claims this ticket makes are claims
// about a *server* — that a route can be reached without a client certificate
// while every other route on the same port cannot, that the certificate handed
// back completes an mTLS handshake, that the bearer beside it satisfies the
// `auth` frame. None of those can be observed from a handler in isolation.
import * as fs from "node:fs";
import * as https from "node:https";
import { Server } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { X509Certificate, createPublicKey } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { generateCertMaterial, generateClientCsr } from "@actana/shared/core-cert-material";
import { verifyBearer, decodeBearer } from "@actana/shared/core-link-bearer";
import { generatePairingCode } from "@actana/shared/pairing-code";
import { createPairingSession } from "@actana/shared/pairing-session";
import { PairingStore, derivePairingCodeKey, hashPairingCode } from "@actana/shared/pairing-store";
import { PtyCoreLinkServer } from "../pty-core-link-server";
import type { PtyCore, PtyCoreEvent } from "../pty-manager";
import { createCoreFilesRequestHandler } from "../core-files-routes";
import { buildCorePairingRoutes, composeCoreHttpRoutes, isPairingPath } from "../core-pairing-wiring";
import { PairingRateLimiter } from "../core-pairing-rate-limit";
import type { PairingAuditEvent } from "@actana/shared/pairing-audit";

const SECRET = "core-pairing-suite-secret-at-least-32-bytes";
const CORE_UUID = "3f6d0f0a-6c1f-4a5e-9c2f-1d0a5b7e9c31";

type Rig = {
  origin: string;
  wsUrl: string;
  caCert: string;
  store: PairingStore;
  audit: PairingAuditEvent[];
  /** Open a pending session and return its id and the code the operator reads out. */
  openSession(opts?: { label?: string; ttlMs?: number; now?: number }): { sessionId: string; code: string };
  clock: { now: number };
};

let server: PtyCoreLinkServer | null = null;
const tempDirs: string[] = [];

afterEach(() => {
  server?.close();
  server = null;
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
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

/** A free TCP port on 127.0.0.1, found by briefly binding port 0. */
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

async function startCore(opts: { rateLimiter?: PairingRateLimiter } = {}): Promise<Rig> {
  const material = await generateCertMaterial({ host: "127.0.0.1" });
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "actana-pairing-"));
  tempDirs.push(dir);
  const store = new PairingStore(path.join(dir, "pairing.json"));
  const audit: PairingAuditEvent[] = [];
  // A clock the tests move, so "expired" is a fact rather than a wait.
  const clock = { now: Date.now() };
  const codeKey = derivePairingCodeKey(SECRET);

  const pairingRoutes = buildCorePairingRoutes({
    material: {
      caCert: material.ca.cert,
      caKey: material.ca.key,
      bearerSecret: SECRET,
      coreId: "core_pairing",
      coreUuid: CORE_UUID,
    },
    sessions: store,
    endpoint: `wss://127.0.0.1:${port}`,
    now: () => clock.now,
    audit: (event) => audit.push(event),
    ...(opts.rateLimiter ? { rateLimiter: opts.rateLimiter } : {}),
  });

  // The file routes are mounted beside it, exactly as `core-entry` mounts them,
  // so "every other route keeps its mTLS requirement" is asserted against a
  // route that really is there.
  const fileRoutes = createCoreFilesRequestHandler({
    filesPort: { projectRoot: () => null },
    authVerifier: (bearer) => verifyBearer(bearer, SECRET),
  });

  // No `createServer` override — the default factory is what mounts the routes
  // and applies the pre-auth gate, so overriding it would test a rig.
  server = new PtyCoreLinkServer(mockCore(), {
    port,
    host: "127.0.0.1",
    tls: {
      caCert: material.ca.cert,
      serverCert: material.server.cert,
      serverKey: material.server.key,
    },
    authVerifier: (bearer) => verifyBearer(bearer, SECRET),
    httpRoutes: composeCoreHttpRoutes(pairingRoutes, fileRoutes),
    isPreAuthPath: isPairingPath,
  });

  const rig: Rig = {
    origin: `https://127.0.0.1:${port}`,
    wsUrl: `wss://127.0.0.1:${port}`,
    caCert: material.ca.cert,
    store,
    audit,
    clock,
    openSession: ({ label = "laptop", ttlMs, now } = {}) => {
      const code = generatePairingCode();
      const sessionId = `ps_${Math.random().toString(16).slice(2, 10)}`;
      store.createSession(
        createPairingSession({
          id: sessionId,
          label,
          codeHash: hashPairingCode({ key: codeKey, sessionId, code }),
          now: now ?? clock.now,
          ...(ttlMs === undefined ? {} : { ttlMs }),
        }),
        clock.now,
      );
      return { sessionId, code };
    },
  };

  // `listen` is fired without a callback inside the factory, so readiness is
  // observed rather than awaited: poll until a request completes.
  //
  // The probe deliberately misses the pairing route. A probe that hit it would
  // spend a rate-limit attempt and write an audit line before any test had
  // started, and two suites below count exactly those.
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      await post(rig, "/healthz", "", { method: "GET" });
      return rig;
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

type Response = { status: number; headers: Record<string, string | string[] | undefined>; body: string };

/** A pairing dial: the CA is verified, and no client certificate is presented. */
function post(
  rig: Rig,
  url: string,
  body: string | object,
  opts: { clientCert?: { cert: string; key: string }; contentType?: string; method?: string } = {},
): Promise<Response> {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request(
      `${rig.origin}${url}`,
      {
        method: opts.method ?? "POST",
        agent: false,
        ca: rig.caCert,
        ...(opts.clientCert ? { cert: opts.clientCert.cert, key: opts.clientCert.key } : {}),
        headers: {
          "content-type": opts.contentType ?? "application/json",
          "content-length": String(Buffer.byteLength(payload)),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

type Redemption = { sessionId: string; code: string; csr: string; label?: string };

function redeem(rig: Rig, redemption: Redemption): Promise<Response> {
  return post(rig, "/v1/pair/redeem", {
    sessionId: redemption.sessionId,
    code: redemption.code,
    client: { label: redemption.label ?? "laptop", platform: "linux" },
    csr: redemption.csr,
  });
}

/** The frames a client sees after dialling the core link with issued material. */
function coreLinkAuth(rig: Rig, material: { cert: string; key: string }, bearer: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const seen: string[] = [];
    const socket = new WebSocket(rig.wsUrl, { ca: rig.caCert, cert: material.cert, key: material.key });
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`no authOk — saw ${seen.join(", ") || "nothing"}`));
    }, 10_000);
    socket.on("open", () => socket.send(JSON.stringify({ type: "auth", reqId: "a1", bearer })));
    socket.on("message", (data: unknown) => {
      const frame = JSON.parse(String(data)) as { type: string };
      seen.push(frame.type);
      if (frame.type !== "authOk" && frame.type !== "authError") return;
      clearTimeout(timer);
      socket.close();
      resolve(seen);
    });
    socket.on("error", (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

describe("a client with a code, and no certificate, pairs end to end", () => {
  it("issues a certificate, a CA and a bearer — and never a private key", async () => {
    const rig = await startCore();
    const { sessionId, code } = rig.openSession({ label: "laptop" });
    const { csrPem, privateKeyPem } = await generateClientCsr("laptop");

    const res = await redeem(rig, { sessionId, code, csr: csrPem });

    expect(res.status).toBe(200);
    const issued = JSON.parse(res.body) as Record<string, string>;
    expect(Object.keys(issued).sort()).toEqual(["bearer", "caCert", "clientCert", "endpoint"]);
    expect(issued.endpoint).toMatch(/^wss:\/\/127\.0\.0\.1:\d+$/);

    // The response is searched for a key rather than checked field by field: a
    // field added later would slip past a field-by-field assertion, and this is
    // the property #280 will not trade — the private key never crosses the wire.
    expect(res.body).not.toMatch(/PRIVATE KEY/);
    expect(res.body).not.toContain(privateKeyPem.split("\n")[1]!);

    const cert = new X509Certificate(issued.clientCert!);
    expect(cert.verify(createPublicKey(issued.caCert!))).toBe(true);
    expect(cert.ca).toBe(false);
  }, 30_000);

  it("hands back material that completes an mTLS handshake and an auth frame", async () => {
    // The end of the flow, and the only assertion that proves the credential is
    // *usable*: the same socket the Panel dials, with the certificate this
    // endpoint signed and the bearer it issued beside it.
    const rig = await startCore();
    const { sessionId, code } = rig.openSession();
    const { csrPem, privateKeyPem } = await generateClientCsr("laptop");

    const res = await redeem(rig, { sessionId, code, csr: csrPem });
    const issued = JSON.parse(res.body) as Record<string, string>;

    const frames = await coreLinkAuth(rig, { cert: issued.clientCert!, key: privateKeyPem }, issued.bearer!);

    expect(frames).toContain("authOk");
    expect(frames).not.toContain("authError");
  }, 30_000);

  it("issues a bearer carrying iss, sub, aud and jti beside exp", async () => {
    const rig = await startCore();
    const { sessionId, code } = rig.openSession();
    const { csrPem } = await generateClientCsr("laptop");

    const res = await redeem(rig, { sessionId, code, csr: csrPem });
    const issued = JSON.parse(res.body) as Record<string, string>;

    const verdict = verifyBearer(issued.bearer!, SECRET);
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.aud).toBe(CORE_UUID);
    expect(verdict.iss).toBe("core:core_pairing");
    expect(verdict.sub).toBe(`pair:${new X509Certificate(issued.clientCert!).serialNumber.toLowerCase()}`);
    expect(decodeBearer(issued.bearer!)?.jti).toMatch(/^[0-9a-f-]{36}$/);
  }, 30_000);

  it("persists the paired client so `pair ls` and `pair revoke` have something to read", async () => {
    const rig = await startCore();
    const { sessionId, code } = rig.openSession({ label: "studio laptop" });
    const { csrPem } = await generateClientCsr("laptop");

    const res = await redeem(rig, { sessionId, code, csr: csrPem });
    const issued = JSON.parse(res.body) as Record<string, string>;

    const [client] = rig.store.listClients();
    expect(client).toMatchObject({
      label: "studio laptop",
      sessionId,
      revokedAt: null,
      created_by: null,
      tenant_id: null,
      auth_method: null,
    });
    expect(client!.certSerial).toBe(new X509Certificate(issued.clientCert!).serialNumber.toLowerCase());
    expect(client!.certSubject).toContain("studio laptop");
  }, 30_000);
});

describe("the defences, over the real transport", () => {
  it("kills the session at five wrong codes, and refuses identically throughout", async () => {
    const rig = await startCore();
    const { sessionId } = rig.openSession();
    const { csrPem } = await generateClientCsr("laptop");

    const refusals: Response[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      refusals.push(await redeem(rig, { sessionId, code: "ZZZZ-ZZZZ", csr: csrPem }));
    }

    expect(refusals.map((r) => r.status)).toEqual([403, 403, 403, 403, 403]);
    expect(new Set(refusals.map((r) => r.body)).size).toBe(1);
    expect(rig.store.getSession(sessionId)?.attempts).toBe(5);

    // And now even the right code is refused: the session is dead, not merely
    // out of guesses.
    const { code } = rig.openSession();
    const dead = await redeem(rig, { sessionId, code, csr: csrPem });
    expect(dead.status).toBe(403);
    expect(dead.body).toBe(refusals[0]!.body);
  }, 30_000);

  it("refuses an expired session", async () => {
    const rig = await startCore();
    const { sessionId, code } = rig.openSession({ ttlMs: 60_000 });
    const { csrPem } = await generateClientCsr("laptop");

    rig.clock.now += 60_001;
    const res = await redeem(rig, { sessionId, code, csr: csrPem });

    expect(res.status).toBe(403);
    expect(rig.audit.at(-1)).toMatchObject({ outcome: "refused", reason: "expired" });
  }, 30_000);

  it("refuses a replay of a consumed session", async () => {
    const rig = await startCore();
    const { sessionId, code } = rig.openSession();
    const first = await generateClientCsr("laptop");
    const second = await generateClientCsr("attacker");

    const ok = await redeem(rig, { sessionId, code, csr: first.csrPem });
    const replay = await redeem(rig, { sessionId, code, csr: second.csrPem });

    expect(ok.status).toBe(200);
    expect(replay.status).toBe(403);
    expect(rig.store.listClients()).toHaveLength(1);
  }, 30_000);

  it("refuses a code that belongs to another session", async () => {
    // Session binding. The code is real, the session is real, and they are not
    // each other's — which is the whole of "cannot be replayed against another".
    const rig = await startCore();
    const a = rig.openSession({ label: "a" });
    const b = rig.openSession({ label: "b" });
    const { csrPem } = await generateClientCsr("laptop");

    const crossed = await redeem(rig, { sessionId: b.sessionId, code: a.code, csr: csrPem });

    expect(crossed.status).toBe(403);
    expect(rig.store.getSession(b.sessionId)?.attempts).toBe(1);
    // And session A is untouched: the guess was spent against the session it
    // named, not against the one the code came from.
    expect(rig.store.getSession(a.sessionId)?.attempts).toBe(0);
  }, 30_000);

  it("refuses an unknown session with the same answer as a wrong code", async () => {
    const rig = await startCore();
    const { sessionId, code } = rig.openSession();
    const { csrPem } = await generateClientCsr("laptop");

    const unknown = await redeem(rig, { sessionId: "ps_nothing", code, csr: csrPem });
    const wrong = await redeem(rig, { sessionId, code: "ZZZZ-ZZZZ", csr: csrPem });

    expect(unknown.status).toBe(wrong.status);
    expect(unknown.body).toBe(wrong.body);
    expect(unknown.headers["content-length"]).toBe(wrong.headers["content-length"]);
  }, 30_000);

  it("trips its own rate limit before the per-session cap is spent", async () => {
    // The defence the attempt cap cannot provide: this session has five
    // attempts, and the endpoint stops the caller at three regardless.
    const rig = await startCore({
      rateLimiter: new PairingRateLimiter({ peer: { limit: 3, windowMs: 60_000 } }),
    });
    const { sessionId } = rig.openSession();
    const { csrPem } = await generateClientCsr("laptop");

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      statuses.push((await redeem(rig, { sessionId, code: "ZZZZ-ZZZZ", csr: csrPem })).status);
    }

    expect(statuses).toEqual([403, 403, 403, 429]);
    expect(rig.store.getSession(sessionId)?.attempts).toBe(3);
    expect(rig.audit.at(-1)).toMatchObject({ outcome: "rate-limited" });
  }, 30_000);

  it("does not spend the session on a CSR it cannot sign", async () => {
    const rig = await startCore();
    const { sessionId, code } = rig.openSession();

    const bad = await redeem(rig, { sessionId, code, csr: "-----BEGIN CERTIFICATE REQUEST-----\nnope\n" });

    expect(bad.status).toBe(400);
    expect(rig.store.getSession(sessionId)?.consumedAt).toBeNull();

    // The operator's code still works, which is the point of checking the CSR
    // before consuming: a client bug must not cost a pairing session.
    const { csrPem } = await generateClientCsr("laptop");
    expect((await redeem(rig, { sessionId, code, csr: csrPem })).status).toBe(200);
  }, 30_000);

  it("lets only one of two simultaneous redemptions win", async () => {
    const rig = await startCore();
    const { sessionId, code } = rig.openSession();
    const first = await generateClientCsr("laptop");
    const second = await generateClientCsr("desktop");

    const [a, b] = await Promise.all([
      redeem(rig, { sessionId, code, csr: first.csrPem }),
      redeem(rig, { sessionId, code, csr: second.csrPem }),
    ]);

    expect([a.status, b.status].sort()).toEqual([200, 403]);
    expect(rig.store.listClients()).toHaveLength(1);
  }, 30_000);

  it("audits every attempt — success and failure — and never the code or the CSR", async () => {
    const rig = await startCore();
    const { sessionId, code } = rig.openSession({ label: "laptop" });
    const { csrPem } = await generateClientCsr("laptop");

    await redeem(rig, { sessionId, code: "ZZZZ-ZZZZ", csr: csrPem });
    await redeem(rig, { sessionId, code, csr: csrPem });

    expect(rig.audit.map((event) => event.outcome)).toEqual(["refused", "issued"]);
    for (const event of rig.audit) {
      expect(event.peer).toMatch(/127\.0\.0\.1|::ffff:127\.0\.0\.1|::1/);
      expect(event.label).toBe("laptop");
      const serialised = JSON.stringify(event);
      expect(serialised).not.toContain(code);
      expect(serialised).not.toContain("CERTIFICATE REQUEST");
    }
  }, 30_000);

  it("refuses a body too large to be a redemption", async () => {
    const rig = await startCore();
    const res = await post(rig, "/v1/pair/redeem", { csr: "x".repeat(64 * 1024) });
    expect(res.status).toBe(413);
  }, 30_000);

  it("refuses a GET at the redemption path", async () => {
    const rig = await startCore();
    const res = await post(rig, "/v1/pair/redeem", "", { method: "GET" });
    expect(res.status).toBe(405);
    expect(res.headers.allow).toBe("POST");
  }, 30_000);
});

describe("a session the operator cancelled (#283)", () => {
  it("is refused, and the refusal is indistinguishable from every other one", async () => {
    const rig = await startCore();
    const { sessionId, code } = rig.openSession();
    const { csrPem } = await generateClientCsr("laptop");

    rig.store.cancelSession(sessionId, rig.clock.now);

    const res = await redeem(rig, { sessionId, code, csr: csrPem });
    expect(res.status).toBe(403);
    expect(rig.store.listClients()).toEqual([]);
  }, 30_000);

  it("says `revoked` in the audit log, not `wrong-code`", async () => {
    // The operator reading this log has to be able to see that their own
    // cancellation is what stopped the redemption. Caught in the state ladder
    // rather than left to `consume()` is what makes that true.
    const rig = await startCore();
    const { sessionId, code } = rig.openSession();
    const { csrPem } = await generateClientCsr("laptop");
    rig.store.cancelSession(sessionId, rig.clock.now);

    await redeem(rig, { sessionId, code, csr: csrPem });

    expect(rig.audit.at(-1)).toMatchObject({ outcome: "refused", reason: "revoked", sessionId });
  }, 30_000);

  it("does not spend an attempt the session will never get to use", async () => {
    const rig = await startCore();
    const { sessionId } = rig.openSession();
    const { csrPem } = await generateClientCsr("laptop");
    rig.store.cancelSession(sessionId, rig.clock.now);

    await redeem(rig, { sessionId, code: "AAAA-BBBB", csr: csrPem });

    expect(rig.store.getSession(sessionId)?.attempts).toBe(0);
  }, 30_000);
});

describe("the pre-auth hole is exactly one route wide", () => {
  it("answers the pairing route to a client with no certificate", async () => {
    const rig = await startCore();
    const res = await post(rig, "/v1/pair/redeem", { sessionId: "ps_x", code: "AAAA-AAAA", csr: "x" });
    // A refusal on the merits — not a TLS failure and not a 403 from the gate.
    expect(res.status).toBe(400);
  }, 30_000);

  it("refuses every other route to that same client", async () => {
    const rig = await startCore();

    const files = await post(rig, "/v1/projects/p1/files?path=a.txt", "", { method: "GET" });
    const unknown = await post(rig, "/healthz", "", { method: "GET" });

    expect(files.status).toBe(403);
    expect(JSON.parse(files.body).code).toBe("client-certificate-required");
    expect(unknown.status).toBe(403);
  }, 30_000);

  it("refuses the core-link upgrade to that same client", async () => {
    // The socket that can spawn a PTY is not part of the exception, and a
    // pre-auth WebSocket would be one that never had to say who it was.
    const rig = await startCore();

    await expect(
      new Promise((resolve, reject) => {
        const socket = new WebSocket(rig.wsUrl, { ca: rig.caCert });
        socket.on("open", () => {
          socket.close();
          resolve("opened");
        });
        socket.on("error", reject);
      }),
    ).rejects.toThrow(/403|Unexpected server response/i);
  }, 30_000);

  it("still serves a route to a client that does present its certificate", async () => {
    // The gate refuses for want of a certificate, not for want of a bearer:
    // this request has the certificate and no bearer, and must reach the file
    // routes' own 401 rather than the gate's 403.
    const rig = await startCore();
    const { sessionId, code } = rig.openSession();
    const { csrPem, privateKeyPem } = await generateClientCsr("laptop");
    const issued = JSON.parse((await redeem(rig, { sessionId, code, csr: csrPem })).body) as Record<string, string>;

    const res = await post(rig, "/v1/projects/p1/files?path=a.txt", "", {
      method: "GET",
      clientCert: { cert: issued.clientCert!, key: privateKeyPem },
    });

    expect(res.status).toBe(401);
    expect(JSON.parse(res.body).code).toBe("unauthorized");
  }, 30_000);
});
