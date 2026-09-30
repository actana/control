// What the Core relies on from the published pairing surface, pinned here.
//
// The rate limiter and the revocation set are `@actana/sdk`'s now, and their own
// unit suites run in actana/client, not here. Control 0.4.5 tested both in this
// package, and a change in the SDK's thresholds or in how it fails would have
// gone through unnoticed. These are the numbers and behaviours the Core's
// security posture rests on, asserted against the installed SDK through
// `createPairing` — the only way the Core reaches them — so drift fails *this*
// repository's CI.
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPairing } from "@actana/sdk/pairing/server";
import { generateCertMaterial, generateClientCsr } from "@actana/shared/core-cert-material";
import { CORE_PAIRING_NAMES } from "../core-pairing-wiring";
import { derivePairingCodeKey, hashPairingCode } from "@actana/shared/pairing-store";
import { generatePairingCode } from "@actana/shared/pairing-code";
import { corePairingStore } from "../core-pairing-store";

const SECRET = "pairing-sdk-contract-secret-at-least-32-bytes";
const CORE_UUID = "5b1d2e3f-4a5b-6c7d-8e9f-0a1b2c3d4e5f";

const tempDirs: string[] = [];
let server: http.Server | null = null;
afterEach(() => {
  server?.close();
  server = null;
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function tempFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "actana-pairing-contract-"));
  tempDirs.push(dir);
  return path.join(dir, "pairing.json");
}

async function material() {
  const m = await generateCertMaterial({ hosts: ["127.0.0.1"] });
  return {
    raw: m,
    persisted: {
      caCert: m.ca.cert,
      caKey: m.ca.key,
      serverCert: m.server.cert,
      serverKey: m.server.key,
      clientCert: m.client.cert,
      clientKey: m.client.key,
      bearerSecret: SECRET,
      coreId: "core_contract",
      coreUuid: CORE_UUID,
      serverHosts: ["127.0.0.1"],
    },
  };
}

function client(certSerial: string, revokedAt: number | null) {
  return {
    certSerial,
    certSubject: "CN=laptop",
    label: "laptop",
    sessionId: "ps_x",
    pairedAt: 1,
    certNotAfter: 2,
    revokedAt,
    created_by: null,
    tenant_id: null,
    auth_method: null,
  };
}

describe("the revocation set (through createPairing().gate.revocations)", () => {
  async function build(file: string, onRevoked = () => {}) {
    const { persisted } = await material();
    const store = corePairingStore(file);
    const pairing = createPairing({
      store,
      material: persisted,
      endpointScheme: "wss",
      names: CORE_PAIRING_NAMES,
      onRevoked,
    });
    return { store, pairing, revocations: pairing.gate.revocations };
  }

  it("knows nothing is revoked on a Core that has paired nothing", async () => {
    const { revocations } = await build(tempFile());
    expect((await revocations.refresh()).ok).toBe(true);
    expect(revocations.isRevoked("abc123")).toBe(false);
    expect(revocations.isFailClosed()).toBe(false);
  });

  it("revokes live: a client revoked after boot is refused on the next refresh, and only that client", async () => {
    const { store, revocations } = await build(tempFile());
    await store.recordClient(client("abc123", null));
    await store.recordClient(client("def456", null));
    await revocations.refresh();
    expect(revocations.isRevoked("abc123")).toBe(false);

    await store.revoke({ kind: "client", certSerial: "abc123", at: Date.now() });
    const result = await revocations.refresh();

    expect(result).toEqual({ ok: true, revoked: ["abc123"] });
    expect(revocations.isRevoked("abc123")).toBe(true);
    expect(revocations.isRevoked("def456")).toBe(false);
    expect(revocations.isBearerSubjectRevoked("pair:abc123")).toBe(true);
    expect(revocations.isBearerSubjectRevoked("pair:def456")).toBe(false);
    // A subject that names no pairing is not a revoked one.
    expect(revocations.isBearerSubjectRevoked("core:whatever")).toBe(false);
    expect(revocations.isBearerSubjectRevoked(undefined)).toBe(false);
    // And a certificate that presented nothing cannot have been revoked.
    expect(revocations.isRevoked(null)).toBe(false);
  });

  it("matches a serial however it is spelled: case and leading zeros", async () => {
    const { store, revocations } = await build(tempFile());
    await store.recordClient(client("00ABc1", null));
    await store.revoke({ kind: "client", certSerial: "00ABc1", at: Date.now() });
    await revocations.refresh();
    expect(revocations.isRevoked("abc1")).toBe(true);
    expect(revocations.isRevoked("0ABC1")).toBe(true);
  });

  it("fails closed when the store cannot be read, for every serial, and recovers", async () => {
    const file = tempFile();
    const { store, revocations } = await build(file);
    await store.recordClient(client("abc123", null));
    await revocations.refresh();
    expect(revocations.isRevoked("abc123")).toBe(false);

    fs.writeFileSync(file, '{"version":1,"clients":[{"certSerial"');
    const broken = await revocations.refresh();
    expect(broken.ok).toBe(false);
    expect(revocations.isFailClosed()).toBe(true);
    expect(revocations.isRevoked("abc123")).toBe(true);
    expect(revocations.isRevoked("never-seen")).toBe(true);
    expect(revocations.isBearerSubjectRevoked("pair:never-seen")).toBe(true);
    // A connection that names no pairing is still not revoked.
    expect(revocations.isRevoked(null)).toBe(false);

    fs.writeFileSync(file, JSON.stringify({ version: 1, sessions: [], clients: [client("abc123", null)] }));
    expect((await revocations.refresh()).ok).toBe(true);
    expect(revocations.isFailClosed()).toBe(false);
    expect(revocations.isRevoked("abc123")).toBe(false);
  });

  it("sweeps: calls onRevoked for a fresh revocation and on entering fail-closed, never for what boot finds", async () => {
    const file = tempFile();
    let calls = 0;
    const { store, pairing } = await build(file, () => {
      calls += 1;
    });
    // A revocation already on file, and no refresh before the sweep starts: the
    // sweep's own boot read finds it, and must not dispatch `onRevoked` for it
    // (the server is not built yet when it runs). If it did, `calls` would be 1.
    await store.recordClient(client("boot01", null));
    await store.recordClient(client("live02", null));
    await store.revoke({ kind: "client", certSerial: "boot01", at: Date.now() });
    const sweep = pairing.startRevocationSweep();
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(pairing.gate.revocations.isRevoked("boot01")).toBe(true);
      expect(calls).toBe(0);

      await store.revoke({ kind: "client", certSerial: "live02", at: Date.now() });
      await waitFor(() => calls === 1);

      fs.writeFileSync(file, "{ not json");
      await waitFor(() => calls === 2);
    } finally {
      sweep.stop();
    }
  }, 15_000);
});

async function waitFor(check: () => boolean, ms = 6_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the sweep");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// ─── the rate limiter and the attempt cap, through the real redeem route ────
//
// Plain HTTP on loopback: the redeem handler needs no TLS, and the peer it
// buckets on is `req.socket.remoteAddress`, which the harness sets from a header
// so several peers can be played from one machine. (Binding 127.0.0.2 and up is
// not portable: macOS has only 127.0.0.1.)

type Answer = { status: number; retryAfter: string | undefined };

describe("the redeem route", () => {
  async function start() {
    const { persisted } = await material();
    const store = corePairingStore(tempFile());
    const pairing = createPairing({
      store,
      material: persisted,
      endpointScheme: "wss",
      port: 8443,
      publicHosts: ["127.0.0.1"],
      names: CORE_PAIRING_NAMES,
      onRevoked: () => {},
    });
    server = http.createServer((req, res) => {
      const peer = req.headers["x-test-peer"];
      if (typeof peer === "string") {
        Object.defineProperty(req.socket, "remoteAddress", { value: peer, configurable: true });
      }
      if (!pairing.redeem.handle(req, res)) {
        res.statusCode = 404;
        res.end();
      }
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const { csrPem } = await generateClientCsr("laptop");
    const codeKey = derivePairingCodeKey(SECRET);

    const post = (peer: string, payload: object): Promise<Answer> =>
      new Promise((resolve, reject) => {
        const text = JSON.stringify(payload);
        const req = http.request(
          {
            host: "127.0.0.1",
            port,
            path: "/v1/pair/redeem",
            method: "POST",
            agent: false,
            headers: {
              "content-type": "application/json",
              "content-length": String(Buffer.byteLength(text)),
              "x-test-peer": peer,
            },
          },
          (res) => {
            res.resume();
            res.on("end", () =>
              resolve({ status: res.statusCode ?? 0, retryAfter: res.headers["retry-after"] as string | undefined }),
            );
          },
        );
        req.on("error", reject);
        req.end(text);
      });
    const body = (sessionId: string, code: string, csr = csrPem) => ({
      sessionId,
      code,
      client: { label: "laptop", platform: "linux" },
      csr,
    });
    const openSession = async () => {
      const code = generatePairingCode();
      const sessionId = `ps_${Math.random().toString(16).slice(2, 10)}`;
      await store.createSession({
        id: sessionId,
        label: "laptop",
        codeHash: hashPairingCode({ key: codeKey, sessionId, code }),
        now: Date.now(),
      });
      return { sessionId, code };
    };
    const attemptsOf = async (sessionId: string) =>
      (await store.listSessions()).find((session) => session.id === sessionId)?.attempts;
    const wrongOf = (code: string) => (code === "AAAA-AAAA" ? "BBBB-BBBB" : "AAAA-AAAA");
    return { post, body, csrPem, openSession, attemptsOf, wrongOf };
  }

  describe("rate limit", () => {
    it("allows ten attempts a minute from one peer and refuses the eleventh with a retry-after", async () => {
      const { post, body } = await start();
      const statuses: number[] = [];
      for (let i = 0; i < 10; i += 1) statuses.push((await post("10.0.0.1", body("ps_none", "AAAA-AAAA"))).status);
      expect(statuses).toEqual(Array(10).fill(403));

      const limited = await post("10.0.0.1", body("ps_none", "AAAA-AAAA"));
      expect(limited.status).toBe(429);
      expect(Number(limited.retryAfter)).toBeGreaterThan(0);
      expect(Number(limited.retryAfter)).toBeLessThanOrEqual(60);
    });

    it("buckets by peer: one peer being limited does not limit another", async () => {
      const { post, body } = await start();
      for (let i = 0; i < 11; i += 1) await post("10.0.0.1", body("ps_none", "AAAA-AAAA"));
      expect((await post("10.0.0.1", body("ps_none", "AAAA-AAAA"))).status).toBe(429);
      expect((await post("10.0.0.2", body("ps_none", "AAAA-AAAA"))).status).toBe(403);
    });

    it("caps the whole endpoint at sixty attempts a minute across peers", async () => {
      const { post, body } = await start();
      // Six peers at ten each: none is over its own limit, and together they are
      // exactly at the global one.
      for (let peer = 1; peer <= 6; peer += 1) {
        for (let i = 0; i < 10; i += 1) {
          expect((await post(`10.0.1.${peer}`, body("ps_none", "AAAA-AAAA"))).status).toBe(403);
        }
      }
      // A seventh, fresh peer is turned away by the global window alone.
      expect((await post("10.0.1.7", body("ps_none", "AAAA-AAAA"))).status).toBe(429);
    });
  });

  // The SDK's store charges an attempt when a code is *claimed*, before the code
  // is compared, and 0.4.5 charged only a mismatch. Control cannot restore that
  // from a store override: the route calls the store once before it compares and
  // never says how the compare went, and the store has no refund. So the current
  // behaviour is pinned here, as a known gap (actana/client#14), and these are
  // the tests that should be flipped when the SDK charges on mismatch only.
  describe("attempt cap (known gap, actana/client#14)", () => {
    it("still pairs on the right code after three wrong ones", async () => {
      const { post, body, openSession, wrongOf } = await start();
      const { sessionId, code } = await openSession();
      for (let i = 0; i < 3; i += 1) expect((await post("10.0.0.1", body(sessionId, wrongOf(code)))).status).toBe(403);
      expect((await post("10.0.0.1", body(sessionId, code))).status).toBe(200);
    });

    it("refuses the right code after four wrong ones: 0.4.5 allowed the fifth guess, the SDK does not", async () => {
      const { post, body, openSession, wrongOf, attemptsOf } = await start();
      const { sessionId, code } = await openSession();
      for (let i = 0; i < 4; i += 1) await post("10.0.0.1", body(sessionId, wrongOf(code)));
      expect(await attemptsOf(sessionId)).toBe(4);

      expect((await post("10.0.0.1", body(sessionId, code))).status).toBe(403);
    });

    it("charges an attempt for the right code with a bad CSR: 0.4.5 did not", async () => {
      const { post, body, openSession, attemptsOf } = await start();
      const { sessionId, code } = await openSession();

      expect((await post("10.0.0.1", body(sessionId, code, "-----BEGIN CERTIFICATE REQUEST-----\nAAAA\n-----END CERTIFICATE REQUEST-----"))).status).toBe(400);

      expect(await attemptsOf(sessionId)).toBe(1);
    });
  });
});
