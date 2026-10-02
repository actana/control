import { describe, it, expect } from "vitest";
import {
  PAIRING_ATTEMPT_CAP,
  PAIRING_SESSION_TTL_MS,
  canRedeem,
  createPairingSession,
  isConsumed,
  isDead,
  isExpired,
  isRevoked,
  type PairingSession,
} from "../pairing-session";

// Three separate defences (#280): a TTL, a cap of five wrong attempts, and
// single use. Every transition here is pure and takes `now` from the caller,
// so a session can be walked past its expiry without fake timers.

const MINT = 1_700_000_000_000;

function session(overrides: Partial<PairingSession> = {}): PairingSession {
  return {
    ...createPairingSession({
      id: "pair_abc",
      label: "mehdi-laptop",
      codeHash: "sha256:deadbeef",
      now: MINT,
    }),
    ...overrides,
  };
}

describe("pairing session", () => {
  describe("createPairingSession", () => {
    it("expires five minutes after the mint by default", () => {
      expect(PAIRING_SESSION_TTL_MS).toBe(5 * 60 * 1000);
      expect(session().expiresAt).toBe(MINT + PAIRING_SESSION_TTL_MS);
      expect(session().createdAt).toBe(MINT);
    });

    it("honours an explicit TTL and attempt cap", () => {
      const s = createPairingSession({
        id: "pair_abc",
        label: "l",
        codeHash: "h",
        now: MINT,
        ttlMs: 60_000,
        attemptCap: 2,
      });
      expect(s.expiresAt).toBe(MINT + 60_000);
      expect(s.attemptCap).toBe(2);
    });

    it("starts pending: no attempts, not consumed", () => {
      const s = session();
      expect(s.attempts).toBe(0);
      expect(s.attemptCap).toBe(PAIRING_ATTEMPT_CAP);
      expect(s.consumedAt).toBeNull();
      expect(isConsumed(s)).toBe(false);
      expect(isDead(s)).toBe(false);
    });

    it("defaults the three future-proofing fields to null", () => {
      const s = session();
      expect(s.created_by).toBeNull();
      expect(s.tenant_id).toBeNull();
      expect(s.auth_method).toBeNull();
    });
  });

  describe("isExpired", () => {
    it("is live before the boundary", () => {
      expect(isExpired(session(), session().expiresAt - 1)).toBe(false);
    });

    it("is live exactly at the boundary, as the bearer is", () => {
      expect(isExpired(session(), session().expiresAt)).toBe(false);
    });

    it("is expired one millisecond past the boundary", () => {
      expect(isExpired(session(), session().expiresAt + 1)).toBe(true);
    });

    it("refuses redemption once expired", () => {
      const s = session();
      expect(canRedeem(s, s.expiresAt)).toEqual({ ok: true });
      expect(canRedeem(s, s.expiresAt + 1)).toEqual({ ok: false, reason: "expired" });
    });
  });

  describe("canRedeem, in the order the reasons are checked", () => {
    it("refuses a session that was already redeemed", () => {
      expect(canRedeem(session({ consumedAt: MINT + 1_000 }), MINT + 2_000)).toEqual({
        ok: false,
        reason: "already-consumed",
      });
      expect(isConsumed(session({ consumedAt: MINT + 1_000 }))).toBe(true);
    });

    it("refuses a session that hit the attempt cap", () => {
      const s = session({ attempts: PAIRING_ATTEMPT_CAP });
      expect(isDead(s)).toBe(true);
      expect(canRedeem(s, MINT)).toEqual({ ok: false, reason: "attempts-exhausted" });
    });

    it("refuses a session the operator revoked, ahead of every other reason", () => {
      // Revocation is the operator's own decision, so it is the answer the
      // audit log should carry even when the session had also run out of time.
      const s = session({ revokedAt: MINT + 1 });
      expect(canRedeem(s, s.expiresAt + 1)).toEqual({ ok: false, reason: "revoked" });
      expect(isRevoked(s)).toBe(true);
    });

    it("does not read a session written before the field existed as revoked", () => {
      // Every pending session on a Core would die at the moment it upgraded if
      // `undefined` counted. This is that regression, written down.
      const { revokedAt: _absent, ...older } = session();
      expect(isRevoked(older as PairingSession)).toBe(false);
      expect(canRedeem(older as PairingSession, MINT)).toEqual({ ok: true });
    });

    it("reports consumption ahead of expiry, so a replay reads as a replay", () => {
      const s = session({ consumedAt: MINT });
      expect(canRedeem(s, s.expiresAt + 1)).toEqual({ ok: false, reason: "already-consumed" });
    });
  });
});
