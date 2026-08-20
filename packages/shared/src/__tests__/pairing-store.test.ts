// The file a Core keeps its pairing state in (#282).
//
// `pairing-session.ts` owns the rules and holds nothing; this is the other
// half. Two processes read and write it — the operator's `actana pair new` and
// the daemon's redemption endpoint — so what these tests pin is that the
// transitions survive the round trip through disk, and that the one transition
// with a race in it decides that race.
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createPairingSession, PAIRING_ATTEMPT_CAP } from "../pairing-session";
import {
  PAIRING_SESSION_RETENTION_MS,
  PairingStore,
  derivePairingCodeKey,
  hashPairingCode,
  pairingCodeMatches,
  pairingStorePath,
  type PairedClient,
} from "../pairing-store";

let dir: string;
let store: PairingStore;
const NOW = 1_700_000_000_000;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "actana-pairing-store-"));
  store = new PairingStore(path.join(dir, "pairing.json"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function session(id = "ps_1", now = NOW, ttlMs?: number) {
  return createPairingSession({
    id,
    label: "laptop",
    codeHash: "a".repeat(64),
    now,
    ...(ttlMs === undefined ? {} : { ttlMs }),
  });
}

function client(certSerial = "0a1b"): PairedClient {
  return {
    certSerial,
    certSubject: "CN=laptop",
    label: "laptop",
    sessionId: "ps_1",
    pairedAt: NOW,
    certNotAfter: NOW + 365 * 24 * 60 * 60 * 1000,
    revokedAt: null,
    created_by: null,
    tenant_id: null,
    auth_method: null,
  };
}

describe("the file", () => {
  it("reads as empty before anything has written it", () => {
    // A daemon booting before its first `pair new` must not treat "no file" as
    // a failure, and must not create one it has nothing to put in.
    expect(store.read()).toEqual({ version: 1, sessions: [], clients: [] });
    expect(fs.existsSync(path.join(dir, "pairing.json"))).toBe(false);
  });

  it("reads as empty rather than throwing on a corrupt file", () => {
    fs.writeFileSync(path.join(dir, "pairing.json"), "{ this is not json");
    expect(store.read().sessions).toEqual([]);
  });

  it("drops a row that is not the shape it claims", () => {
    fs.writeFileSync(
      path.join(dir, "pairing.json"),
      JSON.stringify({ version: 1, sessions: [{ id: "ps_1" }, session()], clients: [] }),
    );
    expect(store.listSessions()).toHaveLength(1);
  });

  it("is written owner-only, because a live code's digest is in it", () => {
    store.createSession(session(), NOW);
    const mode = fs.statSync(path.join(dir, "pairing.json")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("sits beside the material file it is derived from", () => {
    expect(pairingStorePath("/var/lib/actana/material.json")).toBe("/var/lib/actana/pairing.json");
  });
});

describe("sessions", () => {
  it("round-trips a minted session", () => {
    store.createSession(session(), NOW);
    expect(store.getSession("ps_1")).toMatchObject({ id: "ps_1", label: "laptop", attempts: 0, consumedAt: null });
  });

  it("counts a wrong attempt and stops at the cap", () => {
    store.createSession(session(), NOW);
    for (let i = 0; i < PAIRING_ATTEMPT_CAP + 3; i += 1) store.recordWrongAttempt("ps_1");
    expect(store.getSession("ps_1")?.attempts).toBe(PAIRING_ATTEMPT_CAP);
  });

  it("says nothing about a session that is not there", () => {
    expect(store.recordWrongAttempt("ps_nothing")).toBeNull();
    expect(store.consume("ps_nothing", NOW)).toEqual({ ok: false, reason: "unknown" });
  });

  it("consumes once and refuses the replay", () => {
    store.createSession(session(), NOW);

    const first = store.consume("ps_1", NOW);
    const second = store.consume("ps_1", NOW);

    expect(first).toMatchObject({ ok: true });
    expect(second).toEqual({ ok: false, reason: "already-consumed" });
    expect(store.getSession("ps_1")?.consumedAt).toBe(NOW);
  });

  it("refuses to consume an expired session", () => {
    store.createSession(session("ps_1", NOW, 60_000), NOW);
    expect(store.consume("ps_1", NOW + 60_001)).toEqual({ ok: false, reason: "expired" });
  });

  it("refuses to consume a dead session", () => {
    store.createSession(session(), NOW);
    for (let i = 0; i < PAIRING_ATTEMPT_CAP; i += 1) store.recordWrongAttempt("ps_1");
    expect(store.consume("ps_1", NOW)).toEqual({ ok: false, reason: "attempts-exhausted" });
  });

  it("forgets a session a day after it settled, and keeps a fresh one", () => {
    store.createSession(session("ps_old", NOW - PAIRING_SESSION_RETENTION_MS - 60_000, 60_000), NOW);
    store.createSession(session("ps_new", NOW), NOW);

    expect(store.listSessions().map((s) => s.id)).toEqual(["ps_new"]);
  });

  it("answers a pruned session exactly as it answers an unknown one", () => {
    // Pruning must not be observable: both are `unknown`, and the endpoint
    // turns both into the same refusal.
    store.createSession(session("ps_old", NOW - PAIRING_SESSION_RETENTION_MS - 60_000, 60_000), NOW);
    store.createSession(session("ps_new", NOW), NOW);

    expect(store.consume("ps_old", NOW)).toEqual({ ok: false, reason: "unknown" });
    expect(store.consume("ps_never", NOW)).toEqual({ ok: false, reason: "unknown" });
  });
});

describe("paired clients", () => {
  it("records one and lists it", () => {
    store.recordClient(client(), NOW);
    expect(store.listClients()).toEqual([client()]);
  });

  it("keeps the sessions beside them", () => {
    store.createSession(session(), NOW);
    store.recordClient(client(), NOW);
    expect(store.getSession("ps_1")).not.toBeNull();
  });

  it("revokes by serial, and stamps rather than deletes", () => {
    // `actana pair revoke` has to be able to say what it revoked, and a row
    // that vanished would take the trail of the pairing with it.
    store.recordClient(client("0a1b"), NOW);
    store.recordClient(client("0c2d"), NOW);

    const revoked = store.revokeClient("0a1b", NOW + 5);

    expect(revoked).toMatchObject({ certSerial: "0a1b", revokedAt: NOW + 5 });
    expect(store.listClients().find((c) => c.certSerial === "0c2d")?.revokedAt).toBeNull();
  });

  it("says nothing about a serial it never issued", () => {
    expect(store.revokeClient("nope", NOW)).toBeNull();
  });

  it("leaves an already-revoked pairing's timestamp alone", () => {
    store.recordClient(client("0a1b"), NOW);
    store.revokeClient("0a1b", NOW + 5);
    expect(store.revokeClient("0a1b", NOW + 500)?.revokedAt).toBe(NOW + 5);
  });
});

describe("the code digest", () => {
  const key = derivePairingCodeKey("a-core-bearer-secret");

  it("is not the code, and not a hash anybody can take without the secret", () => {
    const mine = hashPairingCode({ key, sessionId: "ps_1", code: "ABCD-EFGH" });
    const theirs = hashPairingCode({
      key: derivePairingCodeKey("some-other-core"),
      sessionId: "ps_1",
      code: "ABCD-EFGH",
    });

    expect(mine).not.toContain("ABCD");
    expect(mine).not.toBe(theirs);
  });

  it("differs from the bearer's own HMAC over the same input", () => {
    // The domain separator. Neither use may be an oracle for the other.
    expect(derivePairingCodeKey("s").toString("hex")).not.toBe(
      hashPairingCode({ key: Buffer.from("s"), sessionId: "", code: "" }),
    );
  });

  it("binds the digest to the session it was minted for", () => {
    // Session binding under the cryptography as well as at the lookup: a digest
    // lifted out of one session's row does not match another's.
    const a = hashPairingCode({ key, sessionId: "ps_a", code: "ABCD-EFGH" });
    const b = hashPairingCode({ key, sessionId: "ps_b", code: "ABCD-EFGH" });
    expect(a).not.toBe(b);
  });

  it("matches a digest of the same code and refuses everything else", () => {
    const stored = hashPairingCode({ key, sessionId: "ps_1", code: "ABCD-EFGH" });

    expect(pairingCodeMatches(stored, hashPairingCode({ key, sessionId: "ps_1", code: "ABCD-EFGH" }))).toBe(true);
    expect(pairingCodeMatches(stored, hashPairingCode({ key, sessionId: "ps_1", code: "ABCD-EFGJ" }))).toBe(false);
  });

  it("refuses a digest of the wrong length rather than throwing", () => {
    // `timingSafeEqual` throws on a length mismatch, and a pre-auth endpoint is
    // not a place to find that out at runtime.
    expect(pairingCodeMatches("aabb", "aa")).toBe(false);
    expect(pairingCodeMatches("", "")).toBe(false);
  });
});

// ─── Cancelling a pending code (#283) ───────────────────────────────────────
//
// `actana pair revoke` pointed at a session, rather than at a paired client.
// The property is not that the row changed — it is that the endpoint's own
// gate now refuses the code, which is the only thing that stops a redemption.

describe("cancelling a pending session", () => {
  it("stops the code being redeemed", () => {
    const pending = createPairingSession({ id: "ps_9", label: "laptop", codeHash: "h", now: NOW });
    store.createSession(pending, NOW);
    expect(store.consume("ps_9", NOW).ok).toBe(true);

    const again = createPairingSession({ id: "ps_10", label: "laptop", codeHash: "h", now: NOW });
    store.createSession(again, NOW);
    expect(store.cancelSession("ps_10", NOW)?.revokedAt).toBe(NOW);
    expect(store.consume("ps_10", NOW)).toEqual({ ok: false, reason: "revoked" });
  });

  it("survives the round trip through disk", () => {
    store.createSession(createPairingSession({ id: "ps_11", label: "l", codeHash: "h", now: NOW }), NOW);
    store.cancelSession("ps_11", NOW);
    expect(new PairingStore(path.join(dir, "pairing.json")).getSession("ps_11")?.revokedAt).toBe(NOW);
  });

  it("reports a session that was already redeemed rather than pretending to undo it", () => {
    store.createSession(createPairingSession({ id: "ps_12", label: "l", codeHash: "h", now: NOW }), NOW);
    store.consume("ps_12", NOW);
    const after = store.cancelSession("ps_12", NOW + 1);
    // There is a certificate in the world for this one. The thing to take back
    // is the client, and the caller is told so by what comes back unchanged.
    expect(after?.consumedAt).toBe(NOW);
    expect(after?.revokedAt).toBe(null);
  });

  it("answers null for a session this Core does not have", () => {
    expect(store.cancelSession("ps_nope", NOW)).toBe(null);
  });

  it("is idempotent — a second cancel changes nothing", () => {
    store.createSession(createPairingSession({ id: "ps_13", label: "l", codeHash: "h", now: NOW }), NOW);
    store.cancelSession("ps_13", NOW);
    expect(store.cancelSession("ps_13", NOW + 5_000)?.revokedAt).toBe(NOW);
  });
});
