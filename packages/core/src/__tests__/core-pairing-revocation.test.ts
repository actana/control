// What a revoked pairing means to the running daemon (#283).
//
// `actana pair revoke` runs in another process and can only stamp a row. These
// tests are about the half that makes the stamp mean something: the set the
// gates consult, and the sweep that notices a stamp arriving under a daemon
// that is already running.
import { describe, expect, it, vi } from "vitest";
import {
  PairingRevocations,
  REVOCATION_SWEEP_MS,
  certSerialFromBearerSubject,
  normaliseCertSerial,
  pairingBearerSubject,
  startPairingRevocationSweep,
} from "../core-pairing-revocation";
import { clientCertGate, coreLinkUpgradeGate } from "../core-preauth-gate";
import type { PairedClient } from "@actana/shared/pairing-store";

const NOW = 1_700_000_000_000;

function client(over: Partial<PairedClient> = {}): PairedClient {
  return {
    certSerial: "0a1b2c",
    certSubject: "CN=laptop",
    label: "laptop",
    sessionId: "ps_1",
    pairedAt: NOW,
    certNotAfter: NOW + 1,
    revokedAt: null,
    created_by: null,
    tenant_id: null,
    auth_method: null,
    ...over,
  };
}

/** A store double, so a test can revoke a row between two reads. */
function fakeStore(rows: PairedClient[] = []) {
  return { rows, listClients: () => rows };
}

describe("the bearer subject a pairing speaks for", () => {
  it("round-trips", () => {
    expect(certSerialFromBearerSubject(pairingBearerSubject("0a1b"))).toBe("0a1b");
  });

  it("reads a bearer with no pairing subject as naming no pairing", () => {
    // Bearers minted before pairing existed carry `{coreId, exp}` and nothing
    // else. They are governed by their own expiry, not by a list they are not on.
    expect(certSerialFromBearerSubject(undefined)).toBe(null);
    expect(certSerialFromBearerSubject("something-else")).toBe(null);
    expect(certSerialFromBearerSubject("pair:")).toBe(null);
  });
});

describe("one spelling of a serial", () => {
  it("folds case, separators and leading zeros", () => {
    expect(normaliseCertSerial("0a:1b:2c")).toBe("A1B2C");
    expect(normaliseCertSerial("0A1B2C")).toBe("A1B2C");
    expect(normaliseCertSerial("00a1b2c")).toBe("A1B2C");
  });

  it("does not fold a serial away to nothing", () => {
    expect(normaliseCertSerial("00")).toBe("0");
  });
});

describe("the revoked set", () => {
  it("is empty until something is revoked", () => {
    const revocations = new PairingRevocations(fakeStore([client()]));
    revocations.refresh();
    expect(revocations.isRevoked("0a1b2c")).toBe(false);
  });

  it("holds a serial once its row is stamped", () => {
    const store = fakeStore([client({ revokedAt: NOW })]);
    const revocations = new PairingRevocations(store);
    expect(revocations.refresh()).toEqual(["0a1b2c"]);
    expect(revocations.isRevoked("0a1b2c")).toBe(true);
  });

  it("matches however the serial is spelled", () => {
    const revocations = new PairingRevocations(fakeStore([client({ revokedAt: NOW })]));
    revocations.refresh();
    // `@peculiar/x509` issues lower case; Node reports the peer's upper case.
    expect(revocations.isRevoked("0A1B2C")).toBe(true);
    expect(revocations.isRevoked("A1B2C")).toBe(true);
  });

  it("reports each serial once, so a sweep acts on it once", () => {
    const store = fakeStore([client({ revokedAt: NOW })]);
    const revocations = new PairingRevocations(store);
    expect(revocations.refresh()).toEqual(["0a1b2c"]);
    expect(revocations.refresh()).toEqual([]);
  });

  it("finds a pairing revoked through its bearer's subject", () => {
    const revocations = new PairingRevocations(fakeStore([client({ revokedAt: NOW })]));
    revocations.refresh();
    expect(revocations.isBearerSubjectRevoked(pairingBearerSubject("0a1b2c"))).toBe(true);
    expect(revocations.isBearerSubjectRevoked(pairingBearerSubject("ffff"))).toBe(false);
    expect(revocations.isBearerSubjectRevoked(undefined)).toBe(false);
  });

  it("keeps what it knows when the store cannot be read", () => {
    // The one interpretation that must never be reached is "nobody is
    // revoked" — that hands a revoked client its access straight back.
    let broken = false;
    const revocations = new PairingRevocations({
      listClients: () => {
        if (broken) throw new Error("pairing.json is gone");
        return [client({ revokedAt: NOW })];
      },
    });
    revocations.refresh();
    broken = true;
    expect(revocations.refresh()).toEqual([]);
    expect(revocations.isRevoked("0a1b2c")).toBe(true);
  });

  it("says nothing about a connection with no certificate at all", () => {
    const revocations = new PairingRevocations(fakeStore([client({ revokedAt: NOW })]));
    revocations.refresh();
    expect(revocations.isRevoked(null)).toBe(false);
    expect(revocations.isRevoked("")).toBe(false);
  });
});

describe("the sweep", () => {
  it("seeds the set at boot without reporting anything to close", () => {
    // Every revocation already on file at boot was made against a link that
    // does not exist. Reporting them would ask the server to close connections
    // that were never opened.
    vi.useFakeTimers();
    try {
      const revocations = new PairingRevocations(fakeStore([client({ revokedAt: NOW })]));
      const closed: string[][] = [];
      const sweep = startPairingRevocationSweep({ revocations, onRevoked: (s) => closed.push(s) });
      expect(closed).toEqual([]);
      expect(revocations.isRevoked("0a1b2c")).toBe(true);
      vi.advanceTimersByTime(REVOCATION_SWEEP_MS * 3);
      expect(closed).toEqual([]);
      sweep.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a revocation that lands under a running daemon", () => {
    vi.useFakeTimers();
    try {
      const row = client();
      const store = fakeStore([row]);
      const revocations = new PairingRevocations(store);
      const closed: string[][] = [];
      const sweep = startPairingRevocationSweep({ revocations, onRevoked: (s) => closed.push(s) });

      // What `actana pair revoke` does, in the other process.
      store.rows[0] = client({ revokedAt: NOW });

      vi.advanceTimersByTime(REVOCATION_SWEEP_MS);
      expect(closed).toEqual([["0a1b2c"]]);
      vi.advanceTimersByTime(REVOCATION_SWEEP_MS * 3);
      expect(closed).toHaveLength(1);
      sweep.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops when the daemon does", () => {
    vi.useFakeTimers();
    try {
      const store = fakeStore([client()]);
      const revocations = new PairingRevocations(store);
      const closed: string[][] = [];
      startPairingRevocationSweep({ revocations, onRevoked: (s) => closed.push(s) }).stop();
      store.rows[0] = client({ revokedAt: NOW });
      vi.advanceTimersByTime(REVOCATION_SWEEP_MS * 5);
      expect(closed).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─── the gates ──────────────────────────────────────────────────────────────
//
// A revoked certificate is a *valid* certificate: this Core's CA signed it and
// TLS has no idea an operator took it back. So `authorized: true` is exactly
// what a revoked client arrives with, and the order these two checks run in is
// the whole of whether revocation works at the door.

describe("the client-certificate gate, with revocation", () => {
  it("refuses a revoked certificate even though the handshake accepted it", () => {
    expect(clientCertGate({ pathname: "/v1/files", authorized: true, revoked: true })).toBe("refuse");
  });

  it("still serves an unrevoked one", () => {
    expect(clientCertGate({ pathname: "/v1/files", authorized: true, revoked: false })).toBe("serve");
  });

  it("gives revocation no pre-auth exception", () => {
    // A client here to redeem a code has no certificate to have had revoked, so
    // nothing legitimate is turned away by refusing this outright.
    expect(
      clientCertGate({
        pathname: "/v1/pair/redeem",
        authorized: true,
        revoked: true,
        isPreAuthPath: (p) => p.startsWith("/v1/pair/"),
      }),
    ).toBe("refuse");
  });

  it("is unchanged for every Core that has revoked nothing", () => {
    expect(clientCertGate({ pathname: "/v1/files", authorized: true })).toBe("serve");
    expect(clientCertGate({ pathname: "/v1/files", authorized: false })).toBe("refuse");
  });
});

describe("the core-link upgrade gate, with revocation", () => {
  it("refuses a revoked certificate", () => {
    expect(coreLinkUpgradeGate(true, true)).toBe("refuse");
  });

  it("is unchanged otherwise", () => {
    expect(coreLinkUpgradeGate(true)).toBe("serve");
    expect(coreLinkUpgradeGate(false)).toBe("refuse");
  });
});
