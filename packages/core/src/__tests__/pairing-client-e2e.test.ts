// The published pairing client, against a real Core (#284).
//
// This suite used to live in `packages/sdk`, beside the client it drove. The
// client ships from actana/client now, so the half that needs a Core moved here:
// it is the check that the `@actana/sdk` a Panel or the CLI pairs with and the
// `@actana/sdk` the Core answers with still agree on the wire.
//
// Everything the client claims here is a claim about an exchange, so almost
// nothing below is stubbed: the server is the Core's own `PtyCoreLinkServer`
// with the SDK's pairing surface mounted the way `core-entry.ts` mounts it, the
// certificates come from `generateCertMaterial` (what `actana setup` writes),
// the sessions go into the JSON-file store the operator's `actana pair new`
// will write, and the client is `pairWithCore` with nothing patched underneath
// it.
//
// Two things are staged rather than real, and both are staged because the
// property under test cannot be observed otherwise:
//
//   • **Request bodies are recorded** by a route family wrapped around the
//     pairing one. "The private key never appears in any request body" and "the
//     code is not sent when the fingerprint does not match" are both statements
//     about bytes on the wire, and a client-side assertion would be the client
//     grading its own homework.
//   • **A Core that changes its certificate between the bootstrap dial and the
//     redemption** is an https server whose secure context is swapped after the
//     first handshake. No real Core does that; an attacker in the middle of one
//     is exactly that shape, and it is the only way to prove the redemption
//     dial is pinned rather than merely polite.

import * as fs from "node:fs";
import * as https from "node:https";
import { Server } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { X509Certificate, createPublicKey } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { generateCertMaterial, issueServerCert } from "@actana/shared/core-cert-material";
import { verifyBearer } from "@actana/shared/core-link-bearer";
import { generatePairingCode } from "@actana/shared/pairing-code";
import { derivePairingCodeKey, hashPairingCode } from "@actana/shared/pairing-store";
import { createPairing } from "@actana/sdk/pairing/server";
import {
  CORE_PAIRING_REDEEM_PATH,
  PairingError,
  coreConnectionFromBlob,
  fetchCorePairingIdentity,
  fingerprintOf,
  pairWithCore,
  parsePairingTicket,
  type CoreRegistrationBlob,
  type PairingFailure,
} from "@actana/sdk/pairing";
import { createNodeCoreLinkSocket } from "@actana/sdk/core";
import { createCoreFilesRequestHandler, type CoreHttpRoutes } from "../core-files-routes";
import { CORE_PAIRING_NAMES, composeCoreHttpRoutes } from "../core-pairing-wiring";
import { corePairingStore, type CorePairingStore } from "../core-pairing-store";
import { PtyCoreLinkServer } from "../pty-core-link-server";
import type { PtyCore, PtyCoreEvent } from "../pty-manager";

const SECRET = "core-pairing-client-suite-secret-32-bytes";
const CORE_UUID = "9c1f4a5e-3f6d-0f0a-6c1f-1d0a5b7e9c31";

/** What the pairing endpoint was actually sent, byte for byte. */
type WireLog = { requests: number; bodies: string[] };

type Rig = {
  address: string;
  origin: string;
  caCert: string;
  fingerprint: string;
  wire: WireLog;
  openSession(opts?: { label?: string; ttlMs?: number; now?: number }): Promise<{ sessionId: string; code: string }>;
  sessionOf(sessionId: string): Promise<{ attempts: number } | undefined>;
  store: CorePairingStore;
};

let server: PtyCoreLinkServer | null = null;
const stubs: https.Server[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  server?.close();
  server = null;
  while (stubs.length > 0) stubs.pop()!.close();
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

/**
 * Copy every byte posted to the pairing prefix, then hand the request on.
 *
 * The `data` listener is attached in the same tick as the real handler's — the
 * route reads its body synchronously from `handle` — so flowing mode delivers
 * every chunk to both and nothing is stolen from the server underneath.
 */
function recording(inner: CoreHttpRoutes, wire: WireLog): CoreHttpRoutes {
  const tee = (fn: (req: IncomingMessage, res: ServerResponse) => boolean) =>
    (req: IncomingMessage, res: ServerResponse): boolean => {
      if ((req.url ?? "").startsWith("/v1/pair/")) {
        wire.requests += 1;
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => wire.bodies.push(Buffer.concat(chunks).toString("utf8")));
      }
      return fn(req, res);
    };
  return { handle: tee(inner.handle), handleContinue: tee(inner.handleContinue) };
}

async function startCore(): Promise<Rig> {
  const material = await generateCertMaterial({ hosts: ["127.0.0.1"] });
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "actana-core-pairing-client-"));
  tempDirs.push(dir);
  const store = corePairingStore(path.join(dir, "pairing.json"));
  const wire: WireLog = { requests: 0, bodies: [] };
  const codeKey = derivePairingCodeKey(SECRET);

  const pairing = createPairing({
    store,
    material: {
      caCert: material.ca.cert,
      caKey: material.ca.key,
      serverCert: material.server.cert,
      serverKey: material.server.key,
      clientCert: material.client.cert,
      clientKey: material.client.key,
      bearerSecret: SECRET,
      coreId: "core_pairing",
      coreUuid: CORE_UUID,
      serverHosts: ["127.0.0.1"],
    },
    endpointScheme: "wss",
    port,
    publicHosts: ["127.0.0.1"],
    names: CORE_PAIRING_NAMES,
    clientLabel: "session-or-client",
    onRevoked: () => {},
  });
  const pairingRoutes = pairing.redeem;

  const fileRoutes = createCoreFilesRequestHandler({
    filesPort: { projectRoot: () => null },
    authVerifier: (bearer) => verifyBearer(bearer, SECRET),
  });

  server = new PtyCoreLinkServer(mockCore(), {
    port,
    host: "127.0.0.1",
    tls: {
      caCert: material.ca.cert,
      serverCert: material.server.cert,
      serverKey: material.server.key,
    },
    authVerifier: (bearer) => verifyBearer(bearer, SECRET),
    httpRoutes: composeCoreHttpRoutes(recording(pairingRoutes, wire), fileRoutes),
    isPreAuthPath: pairing.gate.isPreAuthPath,
  });

  const rig: Rig = {
    address: `127.0.0.1:${port}`,
    origin: `https://127.0.0.1:${port}`,
    caCert: material.ca.cert,
    fingerprint: fingerprintOf(new X509Certificate(material.ca.cert).raw),
    wire,
    store,
    sessionOf: async (sessionId) => (await store.listSessions()).find((session) => session.id === sessionId),
    openSession: async ({ label = "laptop", ttlMs, now } = {}) => {
      const code = generatePairingCode();
      const sessionId = `ps_${Math.random().toString(16).slice(2, 10)}`;
      await store.createSession({
        id: sessionId,
        label,
        codeHash: hashPairingCode({ key: codeKey, sessionId, code }),
        now: now ?? Date.now(),
        ...(ttlMs === undefined ? {} : { ttlMs }),
      });
      return { sessionId, code };
    },
  };

  // Readiness is observed rather than awaited, as the Core's own suite does —
  // and on a route that is not the pairing one, so no probe spends a rate-limit
  // attempt before a test has started.
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      await new Promise<void>((resolve, reject) => {
        const req = https.request(
          { host: "127.0.0.1", port, path: "/healthz", method: "GET", ca: material.ca.cert, agent: false },
          (res) => {
            res.resume();
            res.on("end", () => resolve());
          },
        );
        req.on("error", reject);
        req.end();
      });
      return rig;
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

/** The pairing failure of a call that must not have produced a blob. */
async function failureOf(promise: Promise<unknown>): Promise<PairingError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof PairingError) return err;
    throw err;
  }
  throw new Error("expected the pairing attempt to fail, and it did not");
}

/** Dial the core link with a blob and report the frames the Core answers with. */
function coreLinkAuth(blob: CoreRegistrationBlob): Promise<string[]> {
  const connection = coreConnectionFromBlob(blob);
  return new Promise((resolve, reject) => {
    const seen: string[] = [];
    const socket = createNodeCoreLinkSocket(connection.url, connection.tls ?? undefined);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`no authOk — saw ${seen.join(", ") || "nothing"}`));
    }, 10_000);
    socket.on("open", () => socket.send(JSON.stringify({ type: "auth", reqId: "a1", bearer: connection.bearer })));
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

/** The public key inside a PEM certificate, as DER, for comparing to a key. */
function certificatePublicKey(certPem: string): string {
  return new X509Certificate(certPem).publicKey.export({ type: "spki", format: "der" }).toString("base64");
}

function privateKeyPublicHalf(keyPem: string): string {
  return createPublicKey(keyPem).export({ type: "spki", format: "der" }).toString("base64");
}

describe("a client with a code pairs with a Core it has verified", () => {
  it("returns a blob assembled from the response and the key that never moved", async () => {
    const rig = await startCore();
    const { sessionId, code } = await rig.openSession({ label: "laptop" });

    const blob = await pairWithCore({
      address: rig.address,
      sessionId,
      code,
      expectedCaFingerprint: rig.fingerprint,
      label: "laptop",
      platform: "linux",
    });

    expect(blob.endpoint).toMatch(/^wss:\/\/127\.0\.0\.1:\d+$/);
    expect(blob.caCert).toBe(rig.caCert);
    expect(blob.clientCert).toContain("BEGIN CERTIFICATE");
    expect(blob.clientKey).toContain("BEGIN PRIVATE KEY");
    expect(blob.bearer.length).toBeGreaterThan(0);

    // The certificate the Core signed is a certificate *for the key this
    // machine generated* — which is the whole of what a CSR buys, and the only
    // proof that the `clientKey` in the blob is the returned credential's other
    // half rather than a key that merely came back in the same object.
    expect(certificatePublicKey(blob.clientCert)).toBe(privateKeyPublicHalf(blob.clientKey));

    // The bearer is the Core's, and it verifies against the Core's secret.
    expect(verifyBearer(blob.bearer, SECRET)).not.toBeNull();
  }, 30_000);

  it("sends the CSR and never the private key", async () => {
    const rig = await startCore();
    const { sessionId, code } = await rig.openSession();

    const blob = await pairWithCore({
      address: rig.address,
      sessionId,
      code,
      expectedCaFingerprint: rig.fingerprint,
      label: "laptop",
    });

    expect(rig.wire.bodies).toHaveLength(1);
    const sent = rig.wire.bodies[0]!;

    // Searched rather than checked field by field: a field added to the request
    // later would slip past an assertion that only looked at the four it knows.
    expect(sent).not.toMatch(/PRIVATE KEY/);
    for (const line of blob.clientKey.split("\n").filter((l) => l.length > 16)) {
      expect(sent).not.toContain(line);
    }

    const body = JSON.parse(sent) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["client", "code", "csr", "sessionId"]);
    expect(body.sessionId).toBe(sessionId);
    expect(String(body.csr)).toContain("BEGIN CERTIFICATE REQUEST");
    expect(body.client).toEqual({ label: "laptop" });
  }, 30_000);

  it("hands back material that completes an mTLS handshake and an auth frame", async () => {
    // The end of the flow, through the SDK's own front door: the blob goes
    // straight into `coreConnectionFromBlob` with no conversion, and what comes
    // out of that dials the same socket every Core client dials.
    const rig = await startCore();
    const { sessionId, code } = await rig.openSession();

    const blob = await pairWithCore({
      address: rig.address,
      sessionId,
      code,
      expectedCaFingerprint: rig.fingerprint,
    });

    const frames = await coreLinkAuth(blob);

    expect(frames).toContain("authOk");
    expect(frames).not.toContain("authError");
  }, 30_000);

  it("accepts the fingerprint in the shapes a human copies it in", async () => {
    const rig = await startCore();
    const { sessionId, code } = await rig.openSession();

    const blob = await pairWithCore({
      address: `https://${rig.address}`,
      sessionId,
      code: code.toLowerCase().replace("-", " "),
      expectedCaFingerprint: `sha256:${rig.fingerprint.replace(/:/g, "").toLowerCase()}`,
    });

    expect(blob.clientCert).toContain("BEGIN CERTIFICATE");
  }, 30_000);
});

describe("the fingerprint is checked before the code is sent", () => {
  it("reports the presented fingerprint without a code to send", async () => {
    const rig = await startCore();

    const identity = await fetchCorePairingIdentity({ address: rig.address });

    expect(identity.fingerprint).toBe(rig.fingerprint);
    expect(identity.caCert.replace(/\s/g, "")).toBe(rig.caCert.replace(/\s/g, ""));
    expect(identity.httpsOrigin).toBe(rig.origin);
    expect(rig.wire.requests).toBe(0);
  }, 30_000);

  it("is the format `actana pair new` prints — colon-separated uppercase hex of the DER", async () => {
    const rig = await startCore();

    const identity = await fetchCorePairingIdentity({ address: rig.address });

    expect(identity.fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    // Node computes the same digest independently, over the certificate it
    // parsed rather than the bytes this module hashed.
    expect(identity.fingerprint).toBe(new X509Certificate(rig.caCert).fingerprint256);
  }, 30_000);

  it("aborts on a mismatch, naming both fingerprints, with the Core never asked", async () => {
    const rig = await startCore();
    const { sessionId, code } = await rig.openSession();
    const wrong = "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99";

    const failure = await failureOf(
      pairWithCore({ address: rig.address, sessionId, code, expectedCaFingerprint: wrong }),
    );

    expect(failure.failure).toBe<PairingFailure>("fingerprint-mismatch");
    expect(failure.message).toContain(wrong);
    expect(failure.message).toContain(rig.fingerprint);
    expect(failure.detail.expectedFingerprint).toBe(wrong);
    expect(failure.detail.presentedFingerprint).toBe(rig.fingerprint);

    // The property the whole ticket turns on, asserted from the server's side:
    // the endpoint was never reached, so the code was never on the wire.
    expect(rig.wire.requests).toBe(0);
    expect(rig.wire.bodies).toEqual([]);
    // And the session is untouched: no attempt was spent on a Core the operator
    // never described.
    expect((await rig.sessionOf(sessionId))?.attempts).toBe(0);
  }, 30_000);

  it("refuses to send a code when it was given no fingerprint to check", async () => {
    const rig = await startCore();
    const { sessionId, code } = await rig.openSession();

    const failure = await failureOf(pairWithCore({ address: rig.address, sessionId, code }));

    expect(failure.failure).toBe<PairingFailure>("fingerprint-unconfirmed");
    expect(failure.detail.presentedFingerprint).toBe(rig.fingerprint);
    expect(failure.detail.presentedCaCert).toContain("BEGIN CERTIFICATE");
    expect(rig.wire.requests).toBe(0);
  }, 30_000);
});

describe("every refusal a caller can act on is a different failure", () => {
  it("tells a refused code from a rate limit, and both from an unreachable Core", async () => {
    // One rig, walked through the Core's refusals in the order a client meets
    // them. Sharing the rig is deliberate: the point is that the *same* client
    // call reports four different things.
    const rig = await startCore();
    const { sessionId, code } = await rig.openSession();

    const wrongCode = await failureOf(
      pairWithCore({
        address: rig.address,
        sessionId,
        code: code === "AAAA-AAAA" ? "BBBB-BBBB" : "AAAA-AAAA",
        expectedCaFingerprint: rig.fingerprint,
      }),
    );
    expect(wrongCode.failure).toBe<PairingFailure>("refused");
    expect(wrongCode.detail.status).toBe(403);
    expect(wrongCode.detail.coreCode).toBe("pairing-refused");
    // The Core knows which of the four it was. The client is told one thing on
    // purpose ("every refusal is the same refusal"), which is what the four
    // refusals below have in common.

    const good = await pairWithCore({
      address: rig.address,
      sessionId,
      code,
      expectedCaFingerprint: rig.fingerprint,
    });
    expect(good.clientCert).toContain("BEGIN CERTIFICATE");

    // Single use: the same code again is refused, and refused identically.
    const replay = await failureOf(
      pairWithCore({ address: rig.address, sessionId, code, expectedCaFingerprint: rig.fingerprint }),
    );
    expect(replay.failure).toBe<PairingFailure>("refused");

    // An expired session, minted two minutes ago with a one-minute life.
    const expiring = await rig.openSession({ ttlMs: 60_000, now: Date.now() - 120_000 });
    const expired = await failureOf(
      pairWithCore({
        address: rig.address,
        sessionId: expiring.sessionId,
        code: expiring.code,
        expectedCaFingerprint: rig.fingerprint,
      }),
    );
    expect(expired.failure).toBe<PairingFailure>("refused");

    // An unknown session — the same refusal again, and no leak of whether it
    // ever existed.
    const unknown = await failureOf(
      pairWithCore({
        address: rig.address,
        sessionId: "ps_nosuchsession",
        code,
        expectedCaFingerprint: rig.fingerprint,
      }),
    );
    expect(unknown.failure).toBe<PairingFailure>("refused");
  }, 60_000);

  it("reports a spent attempt cap as a refusal, and a rate limit as its own failure", async () => {
    const rig = await startCore();
    const { sessionId, code } = await rig.openSession();
    const wrong = code === "AAAA-AAAA" ? "BBBB-BBBB" : "AAAA-AAAA";

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const refusal = await failureOf(
        pairWithCore({ address: rig.address, sessionId, code: wrong, expectedCaFingerprint: rig.fingerprint }),
      );
      expect(refusal.failure).toBe<PairingFailure>("refused");
    }

    // The session is dead now, and the right code no longer works — still one
    // refusal, still nothing said about which defence answered. Attempts six to
    // ten spend the rest of the peer's window (ten a minute, the SDK's default).
    for (let attempt = 5; attempt < 10; attempt += 1) {
      const dead = await failureOf(
        pairWithCore({ address: rig.address, sessionId, code, expectedCaFingerprint: rig.fingerprint }),
      );
      expect(dead.failure).toBe<PairingFailure>("refused");
    }

    // And one more trips the limiter, which the Core *does* distinguish,
    // because a client that waits is not a client that guessed.
    const limited = await failureOf(
      pairWithCore({ address: rig.address, sessionId, code, expectedCaFingerprint: rig.fingerprint }),
    );
    expect(limited.failure).toBe<PairingFailure>("rate-limited");
    expect(limited.detail.status).toBe(429);
    expect(limited.detail.retryAfterSeconds).toBeGreaterThan(0);
  }, 60_000);

  it("reports an address nothing is listening on as unreachable", async () => {
    const port = await freePort();

    const failure = await failureOf(
      pairWithCore({
        address: `127.0.0.1:${port}`,
        sessionId: "ps_1",
        code: "ABCD-EFGH",
        expectedCaFingerprint: "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99",
        timeoutMs: 5_000,
      }),
    );

    expect(failure.failure).toBe<PairingFailure>("unreachable");
    expect(failure.message).toContain(String(port));
  }, 30_000);

  it("refuses what it can refuse without a Core at all", async () => {
    // Address, code and fingerprint are all checked before a socket is opened:
    // a typo does not cost a dial, and — for the code — does not spend one of
    // the five attempts on the operator's session.
    expect((await failureOf(pairWithCore({ address: "", code: "x" }))).failure).toBe("bad-address");
    expect((await failureOf(pairWithCore({ address: "ws://core:9443", code: "x" }))).failure).toBe("bad-address");
    expect(
      (await failureOf(pairWithCore({ address: "core:9443", code: "ABC", sessionId: "ps_1" }))).failure,
    ).toBe("bad-code");
    expect((await failureOf(pairWithCore({ address: "core:9443", code: "ABCD-EFGH" }))).failure).toBe("bad-code");
    expect(
      (
        await failureOf(
          pairWithCore({
            address: "core:9443",
            code: "ABCD-EFGH",
            sessionId: "ps_1",
            expectedCaFingerprint: "not-a-fingerprint",
          }),
        )
      ).failure,
    ).toBe("bad-fingerprint");
  });

  it("reads a session id carried on the code, and one passed beside it", () => {
    expect(parsePairingTicket("ps_7f3a:abcd-efgh")).toEqual({ sessionId: "ps_7f3a", code: "ABCD-EFGH" });
    expect(parsePairingTicket("abcd efgh", "ps_7f3a")).toEqual({ sessionId: "ps_7f3a", code: "ABCD-EFGH" });
    // An explicit session id wins, and the code beside it is read as a code.
    expect(parsePairingTicket("ABCD-EFGH", "ps_other")).toEqual({ sessionId: "ps_other", code: "ABCD-EFGH" });
    // Both at once — a caller that always forwards `--session` while an
    // operator pastes whatever they were read out. This used to keep the
    // `ps_7f3a:` prefix inside the code and refuse a perfectly good pairing.
    expect(parsePairingTicket("ps_7f3a:ABCD-EFGH", "ps_7f3a")).toEqual({
      sessionId: "ps_7f3a",
      code: "ABCD-EFGH",
    });
    // And two that disagree are refused rather than resolved: one of them is a
    // mistake, and redeeming against the wrong session fails in a way that
    // looks exactly like a mistyped code.
    const clash = (): unknown => parsePairingTicket("ps_7f3a:ABCD-EFGH", "ps_other");
    expect(clash).toThrow(PairingError);
    expect(clash).toThrow(/must agree/);
  });
});

// ─── A Core that is not the Core that was verified ───

/** An https server answering one canned response, on material a test controls. */
async function startStub(opts: {
  cert: { cert: string; key: string; ca: string };
  answer?: { status: number; body: string; headers?: Record<string, string> };
  /** The loopback address to bind. `127.0.0.2` is a Core reached off its SAN. */
  host?: string;
}): Promise<{ address: string; requests: number; server: https.Server }> {
  const state = { requests: 0 };
  const stub = https.createServer({ cert: opts.cert.cert, key: opts.cert.key, ca: opts.cert.ca }, (req, res) => {
    state.requests += 1;
    req.resume();
    req.on("end", () => {
      const answer = opts.answer ?? { status: 500, body: "{}" };
      res.writeHead(answer.status, { "content-type": "application/json", ...(answer.headers ?? {}) });
      res.end(answer.body);
    });
  });
  stubs.push(stub);
  const host = opts.host ?? "127.0.0.1";
  await new Promise<void>((resolve) => stub.listen(0, host, () => resolve()));
  const port = (stub.address() as { port: number }).port;
  return {
    address: `${host}:${port}`,
    get requests() {
      return state.requests;
    },
    server: stub,
  };
}

describe("the redemption dial is pinned to the certificate authority that matched", () => {
  it("sends nothing to a Core that changes its certificate after the fingerprint check", async () => {
    // The man-in-the-middle shape: the bootstrap dial sees the CA the operator
    // read out, and the redemption dial — a second connection — gets somebody
    // else's. If the code were posted on an unverified connection this is where
    // it would leak, so the assertion is that the second server saw no request.
    const honest = await generateCertMaterial({ hosts: ["127.0.0.1"] });
    const impostor = await generateCertMaterial({ hosts: ["127.0.0.1"] });
    const stub = await startStub({
      cert: { cert: honest.server.cert, key: honest.server.key, ca: honest.ca.cert },
      answer: { status: 200, body: JSON.stringify({ endpoint: "wss://127.0.0.1:1", caCert: "x", clientCert: "x", bearer: "x" }) },
    });
    // Swapped between the two connections. `connection` fires before the
    // handshake, and Node's own listener — registered first — has already built
    // that socket's context by then, so the swap goes in a `setImmediate`: too
    // late for the bootstrap dial, and long before the redemption opens the
    // second one.
    stub.server.once("connection", () =>
      setImmediate(() => {
        stub.server.setSecureContext({
          cert: impostor.server.cert,
          key: impostor.server.key,
          ca: impostor.ca.cert,
        });
      }),
    );

    const honestFingerprint = fingerprintOf(new X509Certificate(honest.ca.cert).raw);
    const failure = await failureOf(
      pairWithCore({
        address: stub.address,
        sessionId: "ps_1",
        code: "ABCD-EFGH",
        expectedCaFingerprint: honestFingerprint,
        timeoutMs: 5_000,
      }),
    );

    expect(failure.failure).toBe<PairingFailure>("fingerprint-mismatch");
    // The pin refusing, by name: OpenSSL finds the pinned CA by subject and the
    // impostor's signature does not check out against it.
    expect(failure.detail.tlsCode).toBe("CERT_SIGNATURE_FAILURE");
    expect(stub.requests).toBe(0);
  }, 30_000);

  it("refuses a Core that answers with a certificate authority it did not present", async () => {
    // The same trust question one layer up: the CA in the response is what
    // every later dial pins, so a Core that hands back a different one is
    // asking this client to trust something no human read out.
    const honest = await generateCertMaterial({ hosts: ["127.0.0.1"] });
    const other = await generateCertMaterial({ hosts: ["127.0.0.1"] });
    const stub = await startStub({
      cert: { cert: honest.server.cert, key: honest.server.key, ca: honest.ca.cert },
      answer: {
        status: 200,
        body: JSON.stringify({
          endpoint: "wss://127.0.0.1:1",
          caCert: other.ca.cert,
          clientCert: honest.client.cert,
          bearer: "b",
        }),
      },
    });

    const failure = await failureOf(
      pairWithCore({
        address: stub.address,
        sessionId: "ps_1",
        code: "ABCD-EFGH",
        expectedCaFingerprint: fingerprintOf(new X509Certificate(honest.ca.cert).raw),
        timeoutMs: 5_000,
      }),
    );

    expect(failure.failure).toBe<PairingFailure>("fingerprint-mismatch");
    expect(stub.requests).toBe(1);
  }, 30_000);
});

describe("a certificate problem is not an accusation", () => {
  it("tells a Core reached off its SAN from a Core that is not the right Core", async () => {
    // A Core set up for one address and reached at another: a second interface,
    // a tunnel, a DNS name added later. `core-cert-material.ts` covers the
    // configured host plus loopback and nothing else, so the fingerprint
    // matches perfectly and Node's hostname check still refuses.
    //
    // This used to be reported as `fingerprint-mismatch` — the operator was
    // told they were being intercepted and went looking for an attacker.
    const material = await generateCertMaterial({ hosts: ["127.0.0.1"] });
    const stub = await startStub({
      cert: { cert: material.server.cert, key: material.server.key, ca: material.ca.cert },
      host: "127.0.0.2",
      answer: { status: 200, body: "{}" },
    });

    const failure = await failureOf(
      pairWithCore({
        address: stub.address,
        sessionId: "ps_1",
        code: "ABCD-EFGH",
        expectedCaFingerprint: fingerprintOf(new X509Certificate(material.ca.cert).raw),
        timeoutMs: 5_000,
      }),
    );

    expect(failure.failure).toBe<PairingFailure>("hostname-mismatch");
    expect(failure.detail.tlsCode).toBe("ERR_TLS_CERT_ALTNAME_INVALID");
    expect(failure.message).toContain("127.0.0.2");
    // Said plainly, because the wrong sentence here costs an operator an
    // afternoon: this is the CA they were told to expect.
    expect(failure.message).toContain("presented the expected certificate authority");
    expect(stub.requests).toBe(0);
  }, 30_000);

  it("reports an expired server certificate as a certificate problem, not a mismatch", async () => {
    const ca = await generateCertMaterial({ hosts: ["127.0.0.1"] });
    const stale = await issueServerCert({
      ca: { cert: ca.ca.cert, key: ca.ca.key },
      hosts: ["127.0.0.1"],
      days: 1,
      notBefore: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000),
    });
    const stub = await startStub({
      cert: { cert: stale.cert, key: stale.key, ca: ca.ca.cert },
      answer: { status: 200, body: "{}" },
    });

    const failure = await failureOf(
      pairWithCore({
        address: stub.address,
        sessionId: "ps_1",
        code: "ABCD-EFGH",
        expectedCaFingerprint: fingerprintOf(new X509Certificate(ca.ca.cert).raw),
        timeoutMs: 5_000,
      }),
    );

    expect(failure.failure).toBe<PairingFailure>("certificate-invalid");
    expect(failure.detail.tlsCode).toBe("CERT_HAS_EXPIRED");
    expect(stub.requests).toBe(0);
  }, 30_000);
});

describe("answers that are not a Core's", () => {
  async function failureAgainst(answer: {
    status: number;
    body: string;
    headers?: Record<string, string>;
  }): Promise<PairingError> {
    const material = await generateCertMaterial({ hosts: ["127.0.0.1"] });
    const stub = await startStub({
      cert: { cert: material.server.cert, key: material.server.key, ca: material.ca.cert },
      answer,
    });
    return failureOf(
      pairWithCore({
        address: stub.address,
        sessionId: "ps_1",
        code: "ABCD-EFGH",
        expectedCaFingerprint: fingerprintOf(new X509Certificate(material.ca.cert).raw),
        timeoutMs: 5_000,
      }),
    );
  }

  it("tells a Core with no pairing endpoint from one that failed, and both from a bad answer", async () => {
    const missing = await failureAgainst({ status: 404, body: JSON.stringify({ code: "not-found", error: "no route" }) });
    expect(missing.failure).toBe<PairingFailure>("not-pairable");
    expect(missing.detail.status).toBe(404);

    const broken = await failureAgainst({
      status: 500,
      body: JSON.stringify({ code: "core-error", error: "this Core could not sign the request" }),
    });
    expect(broken.failure).toBe<PairingFailure>("core-error");

    const rejected = await failureAgainst({
      status: 400,
      body: JSON.stringify({ code: "bad-request", error: "the CSR was not acceptable" }),
    });
    expect(rejected.failure).toBe<PairingFailure>("rejected");
    expect(rejected.message).toContain("the CSR was not acceptable");

    const garbage = await failureAgainst({ status: 200, body: "not json at all" });
    expect(garbage.failure).toBe<PairingFailure>("malformed-response");

    const incomplete = await failureAgainst({ status: 200, body: JSON.stringify({ endpoint: "wss://x:1" }) });
    expect(incomplete.failure).toBe<PairingFailure>("malformed-response");
    expect(incomplete.message).toContain("caCert");

    // `JSON.parse("null")` succeeds, and so does an array. Both used to reach
    // the field sweep, where `null` threw a raw `TypeError` past the failure
    // union every caller of this module switches on.
    const nulled = await failureAgainst({ status: 200, body: "null" });
    expect(nulled.failure).toBe<PairingFailure>("malformed-response");

    const listed = await failureAgainst({ status: 200, body: "[]" });
    expect(listed.failure).toBe<PairingFailure>("malformed-response");
  }, 60_000);

  it("refuses a credential for a plaintext endpoint", async () => {
    // `coreConnectionFromBlob` reads TLS off the scheme: a `ws://` endpoint
    // yields `tls: null` and still carries the bearer, so accepting one here
    // would hand back a credential that ships the bearer in cleartext on every
    // later dial — undoing the whole of what the pinned exchange bought.
    const failure = await failureAgainst({
      status: 200,
      body: JSON.stringify({
        endpoint: "ws://127.0.0.1:9443",
        caCert: "-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----",
        clientCert: "-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----",
        bearer: "b",
      }),
    });

    expect(failure.failure).toBe<PairingFailure>("malformed-response");
    expect(failure.message).toContain("ws://127.0.0.1:9443");
  }, 30_000);
});
