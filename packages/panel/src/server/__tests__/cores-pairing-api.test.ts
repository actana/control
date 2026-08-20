import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as https from "node:https";
import * as os from "node:os";
import * as path from "node:path";
import { Server } from "node:net";
import { X509Certificate } from "node:crypto";
import { generateCertMaterial } from "@actana/shared/core-cert-material";
import { verifyBearer } from "@actana/shared/core-link-bearer";
import { generatePairingCode } from "@actana/shared/pairing-code";
import { createPairingSession } from "@actana/shared/pairing-session";
import { PairingStore, derivePairingCodeKey, hashPairingCode } from "@actana/shared/pairing-store";
import { createCoreFilesRequestHandler } from "@actana/core/core-files-routes";
import {
  buildCorePairingRoutes,
  composeCoreHttpRoutes,
  isPairingPath,
} from "@actana/core/core-pairing-wiring";
import { PtyCoreLinkServer } from "@actana/core/pty-core-link-server";
import { fingerprintOf } from "@actana/sdk/core-pairing";
import type { PtyCore } from "@actana/core/pty-manager";
import type { EventLogPort } from "@actana/core/pty-core-link-server";

/**
 * The Panel's pairing surface, driven the way a browser drives it (#286).
 *
 * The Core here is real: the Core's own `PtyCoreLinkServer` with the Core's own
 * pairing routes mounted through the Core's own wiring, behind a real TLS
 * socket, with sessions in the `PairingStore` that `actana pair new` writes. So
 * "the code was redeemed" means a CSR was signed by that CA, and "the Panel can
 * dial what it paired" means an mTLS handshake and a bearer both actually
 * worked — not that a fake resolved a promise.
 *
 * What this suite is really watching for is the three ways this endpoint could
 * be wrong in a way nothing downstream would notice: a mismatch that stores
 * something, a Core paired by code that is not dialable the way a pasted one
 * is, and a code or a private key finding its way into a response.
 */

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ac-cores-pairing-test-"));
process.env.AC_USER_DATA_DIR = path.join(tmpRoot, "app");
process.env.AC_PANEL_DATA_DIR = path.join(tmpRoot, "panel");

const { handleApiRequest } = await import("../api-router");
const { closePanelDb, getPanelDb } = await import("../panel-db");
const { operatorSessionCookie } = await import("./_operator-session");
const { resetCoreLinkManagerForTests } = await import("../services/core-link-manager");

const ORIGIN = "http://panel.example.test";
const SECRET = "panel-pairing-suite-secret-at-least-32-bytes";
const CORE_UUID = "3b7c0d61-9a2e-4f10-8c5b-7d1e2a4f6b90";

async function call(
  pathname: string,
  init: RequestInit & { json?: unknown; anonymous?: boolean } = {},
): Promise<Response> {
  const { json, anonymous, ...rest } = init;
  const headers: Record<string, string> = { ...(rest.headers as Record<string, string>) };
  if (!anonymous) headers.cookie = operatorSessionCookie();
  if (json !== undefined) headers["content-type"] = "application/json";
  const response = await handleApiRequest(
    new Request(`${ORIGIN}${pathname}`, {
      ...rest,
      headers,
      body: json !== undefined ? JSON.stringify(json) : rest.body,
    }),
  );
  if (!response) throw new Error(`no API response for ${pathname}`);
  return response;
}

// ─── A real Core, with a real pairing endpoint ────────────────────────────

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

function emptyEventLog(): EventLogPort {
  return { appendEvent: () => 0, getLastEventId: () => 0, readEventTail: () => [] };
}

type Rig = {
  address: string;
  origin: string;
  fingerprint: string;
  caCert: string;
  openSession(label?: string): { sessionId: string; code: string };
};

const running: PtyCoreLinkServer[] = [];
const tempDirs: string[] = [];

async function startCore(): Promise<Rig> {
  const material = await generateCertMaterial({ host: "127.0.0.1" });
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-panel-pairing-store-"));
  tempDirs.push(dir);
  const store = new PairingStore(path.join(dir, "pairing.json"));
  const codeKey = derivePairingCodeKey(SECRET);

  const pairingRoutes = buildCorePairingRoutes({
    material: {
      caCert: material.ca.cert,
      caKey: material.ca.key,
      bearerSecret: SECRET,
      coreId: "core_paired",
      coreUuid: CORE_UUID,
    },
    sessions: store,
    endpoint: `wss://127.0.0.1:${port}`,
  });
  const fileRoutes = createCoreFilesRequestHandler({
    filesPort: { projectRoot: () => null },
    authVerifier: (bearer) => verifyBearer(bearer, SECRET),
  });

  const server = new PtyCoreLinkServer(mockCore(), {
    eventLog: emptyEventLog(),
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
  running.push(server);

  await waitForListening(port, material.ca.cert);

  return {
    address: `127.0.0.1:${port}`,
    origin: `https://127.0.0.1:${port}`,
    fingerprint: fingerprintOf(new X509Certificate(material.ca.cert).raw),
    caCert: material.ca.cert,
    openSession: (label = "the-panel") => {
      const code = generatePairingCode();
      const sessionId = `ps_${running.length}_${Date.now().toString(16)}`;
      store.createSession(
        createPairingSession({
          id: sessionId,
          label,
          codeHash: hashPairingCode({ key: codeKey, sessionId, code }),
          now: Date.now(),
        }),
        Date.now(),
      );
      return { sessionId, code };
    },
  };
}

/**
 * Readiness, observed on a route that is not the pairing one — a probe there
 * would spend a rate-limit attempt before a test had started.
 */
async function waitForListening(port: number, caCert: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      await new Promise<void>((resolve, reject) => {
        const req = https.request(
          { host: "127.0.0.1", port, path: "/healthz", method: "GET", ca: caCert, agent: false },
          (res) => {
            res.resume();
            res.on("end", () => resolve());
          },
        );
        req.on("error", reject);
        req.end();
      });
      return;
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

afterEach(() => {
  resetCoreLinkManagerForTests();
  for (const server of running.splice(0)) server.close();
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  const db = getPanelDb();
  db.prepare("DELETE FROM core_secrets").run();
  db.prepare("DELETE FROM cores").run();
});

afterAll(() => {
  closePanelDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

type Refusal = { failure: string; error: string; expectedFingerprint?: string; presentedFingerprint?: string };

async function inspect(address: string): Promise<Response> {
  return call("/api/cores/pairing/inspect", { method: "POST", json: { address } });
}

async function pair(body: Record<string, unknown>): Promise<Response> {
  return call("/api/cores/pairing", { method: "POST", json: body });
}

function registryCounts(): { cores: number; secrets: number } {
  const db = getPanelDb();
  const cores = (db.prepare("SELECT COUNT(*) AS n FROM cores").get() as { n: number }).n;
  const secrets = (db.prepare("SELECT COUNT(*) AS n FROM core_secrets").get() as { n: number }).n;
  return { cores, secrets };
}

async function dialOf(id: string): Promise<{ state: string; lastSeenAt: number | null }> {
  const body = (await (await call("/api/cores")).json()) as {
    cores: { id: string; dial: { state: string; lastSeenAt: number | null } }[];
  };
  const core = body.cores.find((c) => c.id === id);
  if (!core) throw new Error(`core ${id} not listed`);
  return core.dial;
}

describe("first contact: what the Core presents, before anything is sent", () => {
  it("reports the CA fingerprint an operator can compare", async () => {
    const rig = await startCore();
    const response = await inspect(rig.address);
    expect(response.status).toBe(200);
    expect((await response.json()) as unknown).toEqual({
      identity: { fingerprint: rig.fingerprint, httpsOrigin: rig.origin },
    });
  }, 30_000);

  it("does not hand the browser the certificate itself — only what it must compare", async () => {
    const rig = await startCore();
    const raw = await (await inspect(rig.address)).text();
    expect(raw).not.toContain("BEGIN CERTIFICATE");
  }, 30_000);

  it("refuses an address that is not one, and one nothing answers at", async () => {
    expect(((await (await inspect("http://plain.example:80")).json()) as Refusal).failure).toBe(
      "bad-address",
    );
    const dead = await inspect(`127.0.0.1:${await freePort()}`);
    expect(((await dead.json()) as Refusal).failure).toBe("unreachable");
  }, 30_000);

  it("requires an Operator session", async () => {
    const response = await call("/api/cores/pairing/inspect", {
      method: "POST",
      anonymous: true,
      json: { address: "127.0.0.1:1" },
    });
    expect(response.status).toBe(401);
  });
});

describe("a code redeemed against a Core the operator verified", () => {
  it("registers a Core the Panel then reaches over mTLS", async () => {
    const rig = await startCore();
    const { sessionId, code } = rig.openSession();

    const response = await pair({
      address: rig.address,
      code,
      sessionId,
      expectedFingerprint: rig.fingerprint,
      label: "prod-vm-1",
    });
    expect(response.status).toBe(201);
    const { core } = (await response.json()) as { core: { id: string; label: string; endpoint: string } };
    expect(core.label).toBe("prod-vm-1");
    expect(core.endpoint).toBe(`wss://127.0.0.1:${new URL(rig.origin).port}`);

    // The registry row and the sealed secrets are both there, and the dialer
    // gets all the way to an authenticated core-link with them.
    expect(registryCounts()).toEqual({ cores: 1, secrets: 1 });
    await vi.waitFor(async () => expect((await dialOf(core.id)).state).toBe("connected"), {
      timeout: 10_000,
    });
  }, 40_000);

  it("takes the code hyphenated or not, and in any case", async () => {
    const rig = await startCore();
    const { sessionId, code } = rig.openSession();
    const mangled = code.replace("-", "").toLowerCase();
    expect(mangled).not.toBe(code);

    const response = await pair({
      address: rig.address,
      code: mangled,
      sessionId,
      expectedFingerprint: rig.fingerprint,
    });
    expect(response.status).toBe(201);
  }, 40_000);

  it("takes the fingerprint the way a human copies it — no colons, any case", async () => {
    const rig = await startCore();
    const { sessionId, code } = rig.openSession();
    const response = await pair({
      address: rig.address,
      code,
      sessionId,
      expectedFingerprint: rig.fingerprint.replace(/:/g, "").toLowerCase(),
    });
    expect(response.status).toBe(201);
  }, 40_000);

  it("names the machine, not this Panel, when no alias is typed", async () => {
    const rig = await startCore();
    const { sessionId, code } = rig.openSession();
    const response = await pair({
      address: rig.address,
      code,
      sessionId,
      expectedFingerprint: rig.fingerprint,
      label: "",
    });
    // The label the Panel sends the Core describes the Panel; letting it come
    // back round as the alias would name every row after this Panel.
    expect(((await response.json()) as { core: { label: string } }).core.label).toBe("127.0.0.1");
  }, 40_000);

  it("never lets the code or the issued key back into a response", async () => {
    const rig = await startCore();
    const { sessionId, code } = rig.openSession();
    const created = await (
      await pair({ address: rig.address, code, sessionId, expectedFingerprint: rig.fingerprint })
    ).text();
    expect(created).not.toContain("PRIVATE KEY");
    expect(created).not.toContain("BEGIN CERTIFICATE");
    expect(created).not.toContain(code);
    expect(created).not.toContain(code.replace("-", ""));

    const listed = await (await call("/api/cores")).text();
    expect(listed).not.toContain("PRIVATE KEY");
    expect(listed).not.toContain(code);
  }, 40_000);

  it("refuses a second Core at an endpoint already registered", async () => {
    const rig = await startCore();
    const first = rig.openSession();
    expect(
      (await pair({ address: rig.address, code: first.code, sessionId: first.sessionId, expectedFingerprint: rig.fingerprint }))
        .status,
    ).toBe(201);

    const second = rig.openSession();
    const response = await pair({
      address: rig.address,
      code: second.code,
      sessionId: second.sessionId,
      expectedFingerprint: rig.fingerprint,
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain("already registered");
    expect(registryCounts()).toEqual({ cores: 1, secrets: 1 });
  }, 40_000);

  it("requires an Operator session", async () => {
    const response = await call("/api/cores/pairing", {
      method: "POST",
      anonymous: true,
      json: { address: "127.0.0.1:1", code: "AAAA-BBBB", sessionId: "ps_x", expectedFingerprint: "x" },
    });
    expect(response.status).toBe(401);
  });
});

describe("a fingerprint that does not match", () => {
  it("stores nothing, and shows both fingerprints", async () => {
    const rig = await startCore();
    const { sessionId, code } = rig.openSession();
    const wrong = rig.fingerprint.startsWith("AA")
      ? `BB${rig.fingerprint.slice(2)}`
      : `AA${rig.fingerprint.slice(2)}`;

    const response = await pair({
      address: rig.address,
      code,
      sessionId,
      expectedFingerprint: wrong,
    });
    expect(response.status).toBe(400);
    const refusal = (await response.json()) as Refusal;
    expect(refusal.failure).toBe("fingerprint-mismatch");
    expect(refusal.expectedFingerprint).toBe(wrong);
    expect(refusal.presentedFingerprint).toBe(rig.fingerprint);

    // Nothing was written, and — the part that matters — the code was not
    // spent, so the same session still redeems.
    expect(registryCounts()).toEqual({ cores: 0, secrets: 0 });
    expect(
      (await pair({ address: rig.address, code, sessionId, expectedFingerprint: rig.fingerprint }))
        .status,
    ).toBe(201);
  }, 40_000);

  it("refuses to send a code with no fingerprint to compare at all", async () => {
    const rig = await startCore();
    const { sessionId, code } = rig.openSession();
    const response = await pair({ address: rig.address, code, sessionId, expectedFingerprint: "" });
    expect(response.status).toBe(400);
    expect(((await response.json()) as Refusal).failure).toBe("fingerprint-unconfirmed");
    expect(registryCounts()).toEqual({ cores: 0, secrets: 0 });
    // Still redeemable: an unconfirmed fingerprint costs the session nothing.
    expect(
      (await pair({ address: rig.address, code, sessionId, expectedFingerprint: rig.fingerprint }))
        .status,
    ).toBe(201);
  }, 40_000);
});

describe("the failures an operator has to tell apart", () => {
  it("distinguishes a wrong code from a bad address, a bad code and an unreachable Core", async () => {
    const rig = await startCore();
    const { sessionId } = rig.openSession();

    const wrongCode = await pair({
      address: rig.address,
      code: "AAAA-BBBB",
      sessionId,
      expectedFingerprint: rig.fingerprint,
    });
    expect(((await wrongCode.json()) as Refusal).failure).toBe("refused");

    const badShape = await pair({
      address: rig.address,
      code: "nope",
      sessionId,
      expectedFingerprint: rig.fingerprint,
    });
    expect(((await badShape.json()) as Refusal).failure).toBe("bad-code");

    const badAddress = await pair({
      address: "ws://plain.example:80",
      code: "AAAA-BBBB",
      sessionId,
      expectedFingerprint: rig.fingerprint,
    });
    expect(((await badAddress.json()) as Refusal).failure).toBe("bad-address");

    const unreachable = await pair({
      address: `127.0.0.1:${await freePort()}`,
      code: "AAAA-BBBB",
      sessionId,
      expectedFingerprint: rig.fingerprint,
    });
    expect(((await unreachable.json()) as Refusal).failure).toBe("unreachable");

    expect(registryCounts()).toEqual({ cores: 0, secrets: 0 });
  }, 40_000);

  it("never quotes the code back, even when the code is what was wrong", async () => {
    const rig = await startCore();
    const { sessionId } = rig.openSession();
    // The SDK's own message for this failure quotes the string it was handed.
    // The Panel writes its sentence from the failure code instead, and this is
    // what stops a mistyped code landing in an error box, a log, or a report.
    const typed = "hunter2-secretish";
    const response = await pair({
      address: rig.address,
      code: typed,
      sessionId,
      expectedFingerprint: rig.fingerprint,
    });
    const raw = await response.text();
    expect(raw).toContain("bad-code");
    expect(raw).not.toContain(typed);
    expect(raw).not.toContain("HUNTER2");
  }, 40_000);

  it("rejects a body that is missing the fields the flow depends on", async () => {
    expect((await pair({ address: "127.0.0.1:1" })).status).toBe(400);
    expect((await pair({ code: "AAAA-BBBB" })).status).toBe(400);
  });
});
