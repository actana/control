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
import * as https from "node:https";
import { Server } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPairing } from "@actana/sdk/pairing/server";
import { generateCertMaterial, generateClientCsr } from "@actana/shared/core-cert-material";
import { PtyCoreLinkServer } from "../pty-core-link-server";
import type { PtyCore } from "../pty-manager";
import { CORE_PAIRING_NAMES } from "../core-pairing-wiring";
import { corePairingStore } from "../core-pairing-store";

const SECRET = "pairing-sdk-contract-secret-at-least-32-bytes";
const CORE_UUID = "5b1d2e3f-4a5b-6c7d-8e9f-0a1b2c3d4e5f";

const tempDirs: string[] = [];
let server: PtyCoreLinkServer | null = null;
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

  it("sweeps: calls onRevoked for a fresh revocation and on entering fail-closed, never at boot", async () => {
    const file = tempFile();
    let calls = 0;
    const { store, pairing, revocations } = await build(file, () => {
      calls += 1;
    });
    await store.recordClient(client("abc123", null));
    await revocations.refresh();
    const sweep = pairing.startRevocationSweep();
    try {
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(calls).toBe(0);

      await store.revoke({ kind: "client", certSerial: "abc123", at: Date.now() });
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

// ─── the rate limiter, over a real socket ───────────────────────────────────

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = new Server();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = address && typeof address === "object" ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

function mockCore(): PtyCore {
  return {
    setEmitTarget: () => {},
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

type Answer = { status: number; retryAfter: string | undefined };

describe("the rate limiter (through the real redeem route)", () => {
  async function start() {
    const { raw, persisted } = await material();
    const port = await freePort();
    const pairing = createPairing({
      store: corePairingStore(tempFile()),
      material: persisted,
      endpointScheme: "wss",
      port,
      publicHosts: ["127.0.0.1"],
      names: CORE_PAIRING_NAMES,
      onRevoked: () => {},
    });
    server = new PtyCoreLinkServer(mockCore(), {
      port,
      host: "127.0.0.1",
      tls: { caCert: raw.ca.cert, serverCert: raw.server.cert, serverKey: raw.server.key },
      httpRoutes: pairing.redeem,
      isPreAuthPath: pairing.gate.isPreAuthPath,
    });
    const { csrPem } = await generateClientCsr("laptop");
    const body = JSON.stringify({
      sessionId: "ps_nosuchsession",
      code: "AAAA-AAAA",
      client: { label: "laptop", platform: "linux" },
      csr: csrPem,
    });
    const attempt = (peer: string): Promise<Answer> =>
      new Promise((resolve, reject) => {
        const req = https.request(
          {
            host: "127.0.0.1",
            port,
            path: "/v1/pair/redeem",
            method: "POST",
            ca: raw.ca.cert,
            agent: false,
            localAddress: peer,
            headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) },
          },
          (res) => {
            res.resume();
            res.on("end", () =>
              resolve({ status: res.statusCode ?? 0, retryAfter: res.headers["retry-after"] as string | undefined }),
            );
          },
        );
        req.on("error", reject);
        req.end(body);
      });
    // Ready when a route that is not the redeem one answers.
    const deadline = Date.now() + 10_000;
    for (;;) {
      try {
        await new Promise<void>((resolve, reject) => {
          const req = https.request(
            { host: "127.0.0.1", port, path: "/healthz", ca: raw.ca.cert, agent: false },
            (res) => {
              res.resume();
              res.on("end", () => resolve());
            },
          );
          req.on("error", reject);
          req.end();
        });
        break;
      } catch (err) {
        if (Date.now() > deadline) throw err;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    return { attempt };
  }

  it("allows ten attempts a minute from one peer and refuses the eleventh with a retry-after", async () => {
    const { attempt } = await start();
    const statuses: number[] = [];
    for (let i = 0; i < 10; i += 1) statuses.push((await attempt("127.0.0.1")).status);
    expect(statuses).toEqual(Array(10).fill(403));

    const limited = await attempt("127.0.0.1");
    expect(limited.status).toBe(429);
    expect(Number(limited.retryAfter)).toBeGreaterThan(0);
    expect(Number(limited.retryAfter)).toBeLessThanOrEqual(60);
  }, 30_000);

  it("buckets by peer: one peer being limited does not limit another", async () => {
    const { attempt } = await start();
    for (let i = 0; i < 11; i += 1) await attempt("127.0.0.1");
    expect((await attempt("127.0.0.1")).status).toBe(429);
    expect((await attempt("127.0.0.2")).status).toBe(403);
  }, 30_000);

  it("caps the whole endpoint at sixty attempts a minute across peers", async () => {
    const { attempt } = await start();
    // Six peers at ten each: none is over its own limit, and together they are
    // exactly at the global one.
    for (let peer = 1; peer <= 6; peer += 1) {
      for (let i = 0; i < 10; i += 1) {
        expect((await attempt(`127.0.0.${peer}`)).status).toBe(403);
      }
    }
    // A seventh, fresh peer is turned away by the global window alone.
    expect((await attempt("127.0.0.7")).status).toBe(429);
  }, 60_000);
});
