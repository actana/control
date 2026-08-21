import { describe, it, expect } from "vitest";
import {
  PAIRING_ATTEMPT_CAP,
  PAIRING_SESSION_TTL_MS,
  canRedeem,
  consumePairingSession,
  createPairingSession,
  isConsumed,
  isDead,
  isExpired,
  isRevoked,
  recordWrongAttempt,
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

  describe("recordWrongAttempt", () => {
    it("dies at exactly the fifth wrong code, not the fourth", () => {
      let s = session();
      for (let i = 1; i < PAIRING_ATTEMPT_CAP; i += 1) {
        s = recordWrongAttempt(s);
        expect(s.attempts).toBe(i);
        expect(isDead(s)).toBe(false);
        expect(canRedeem(s, MINT)).toEqual({ ok: true });
      }
      s = recordWrongAttempt(s);
      expect(s.attempts).toBe(PAIRING_ATTEMPT_CAP);
      expect(isDead(s)).toBe(true);
      expect(canRedeem(s, MINT)).toEqual({ ok: false, reason: "attempts-exhausted" });
    });

    it("does not mutate the session it was given", () => {
      const s = session();
      recordWrongAttempt(s);
      expect(s.attempts).toBe(0);
    });

    it("stops the counter at the cap", () => {
      let s = session();
      for (let i = 0; i < PAIRING_ATTEMPT_CAP + 3; i += 1) s = recordWrongAttempt(s);
      expect(s.attempts).toBe(PAIRING_ATTEMPT_CAP);
    });

    it("keeps the session's own cap when it was minted with one", () => {
      let s = session({ attemptCap: 2 });
      s = recordWrongAttempt(s);
      expect(isDead(s)).toBe(false);
      s = recordWrongAttempt(s);
      expect(isDead(s)).toBe(true);
    });
  });

  describe("consumePairingSession", () => {
    it("stamps the consumption and leaves the input alone", () => {
      const s = session();
      const result = consumePairingSession(s, MINT + 1_000);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.session.consumedAt).toBe(MINT + 1_000);
        expect(isConsumed(result.session)).toBe(true);
      }
      expect(s.consumedAt).toBeNull();
    });

    it("refuses a second consume", () => {
      const first = consumePairingSession(session(), MINT + 1_000);
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      expect(consumePairingSession(first.session, MINT + 2_000)).toEqual({
        ok: false,
        reason: "already-consumed",
      });
    });

    it("refuses an expired session", () => {
      const s = session();
      expect(consumePairingSession(s, s.expiresAt + 1)).toEqual({
        ok: false,
        reason: "expired",
      });
    });

    it("refuses a session that hit the attempt cap", () => {
      let s = session();
      for (let i = 0; i < PAIRING_ATTEMPT_CAP; i += 1) s = recordWrongAttempt(s);
      expect(consumePairingSession(s, MINT)).toEqual({
        ok: false,
        reason: "attempts-exhausted",
      });
    });

    it("refuses a session the operator revoked, ahead of every other reason", () => {
      // Revocation is the operator's own decision, so it is the answer the
      // audit log should carry even when the session had also run out of time.
      const s = session({ revokedAt: MINT + 1 });
      expect(consumePairingSession(s, s.expiresAt + 1)).toEqual({ ok: false, reason: "revoked" });
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
      const first = consumePairingSession(session(), MINT);
      if (!first.ok) throw new Error("expected the first consume to succeed");
      expect(consumePairingSession(first.session, first.session.expiresAt + 1)).toEqual({
        ok: false,
        reason: "already-consumed",
      });
    });
  });
});
