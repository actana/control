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
import { PairingStore, type PairedClient } from "@actana/shared/pairing-store";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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

/**
 * A store double, so a test can revoke a row between two reads.
 *
 * `readStrict` and not `listClients`, because that is the seam the real
 * `PairingStore` is injected through — and the difference between the two is
 * the whole subject of the fail-closed tests below. The suite also drives the
 * *real* store over a deliberately corrupted file, so the guarantee is not
 * pinned against a double that behaves differently from the collaborator.
 */
function fakeStore(rows: PairedClient[] = []) {
  return { rows, readStrict: () => ({ clients: rows }) };
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
    expect(revocations.refresh()).toEqual({ ok: true, revoked: [] });
    expect(revocations.isRevoked("0a1b2c")).toBe(false);
    expect(revocations.isFailClosed()).toBe(false);
  });

  it("holds a serial once its row is stamped", () => {
    const store = fakeStore([client({ revokedAt: NOW })]);
    const revocations = new PairingRevocations(store);
    expect(revocations.refresh()).toEqual({ ok: true, revoked: ["0a1b2c"] });
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
    expect(revocations.refresh()).toEqual({ ok: true, revoked: ["0a1b2c"] });
    expect(revocations.refresh()).toEqual({ ok: true, revoked: [] });
  });

  it("finds a pairing revoked through its bearer's subject", () => {
    const revocations = new PairingRevocations(fakeStore([client({ revokedAt: NOW })]));
    revocations.refresh();
    expect(revocations.isBearerSubjectRevoked(pairingBearerSubject("0a1b2c"))).toBe(true);
    expect(revocations.isBearerSubjectRevoked(pairingBearerSubject("ffff"))).toBe(false);
    expect(revocations.isBearerSubjectRevoked(undefined)).toBe(false);
  });

  it("revokes everything when the store cannot be read", () => {
    // Not "nobody is revoked", and not "whatever we knew last time" — both of
    // those serve a certificate the operator has taken back.
    let broken = false;
    const revocations = new PairingRevocations({
      readStrict: () => {
        if (broken) throw new Error("pairing.json is not valid JSON");
        return { clients: [client({ revokedAt: NOW })] };
      },
    });
    revocations.refresh();
    expect(revocations.isRevoked("never-seen-before")).toBe(false);

    broken = true;
    expect(revocations.refresh()).toEqual({ ok: false, error: expect.stringContaining("not valid JSON") });
    expect(revocations.isFailClosed()).toBe(true);
    expect(revocations.isRevoked("0a1b2c")).toBe(true);
    expect(revocations.isRevoked("never-seen-before")).toBe(true);
    expect(revocations.isBearerSubjectRevoked(pairingBearerSubject("never-seen-before"))).toBe(true);
  });

  it("fails closed at boot, where there is no last time to fall back on", () => {
    // The failure the review named: a truncated write is renamed into place and
    // the daemon restarts. The seeding read is the first thing that happens, and
    // if it read "nobody is revoked" every revoked certificate would be served
    // again from the first request.
    const revocations = new PairingRevocations({
      readStrict: () => {
        throw new Error("pairing.json is not valid JSON");
      },
    });
    revocations.refresh();
    expect(revocations.isRevoked("0a1b2c")).toBe(true);
  });

  it("stops failing closed once the store is readable again", () => {
    // A fact about the store as it is now, not a latch an operator has to reset.
    let broken = true;
    const revocations = new PairingRevocations({
      readStrict: () => {
        if (broken) throw new Error("unreadable");
        return { clients: [client()] };
      },
    });
    revocations.refresh();
    expect(revocations.isRevoked("0a1b2c")).toBe(true);
    broken = false;
    expect(revocations.refresh()).toEqual({ ok: true, revoked: [] });
    expect(revocations.isFailClosed()).toBe(false);
    expect(revocations.isRevoked("0a1b2c")).toBe(false);
  });

  it("leaves a bearer that names no pairing alone, even while failing closed", () => {
    // The hand-carried registration blob's bearer is not a pairing, so no row
    // about it could have gone unread — and it is the credential the operator's
    // own Panel is holding while they go and repair the file.
    const revocations = new PairingRevocations({
      readStrict: () => {
        throw new Error("unreadable");
      },
    });
    revocations.refresh();
    expect(revocations.isBearerSubjectRevoked(undefined)).toBe(false);
    expect(revocations.isBearerSubjectRevoked("something-else")).toBe(false);
    expect(revocations.isRevoked(null)).toBe(false);
  });

  it("says nothing about a connection with no certificate at all", () => {
    const revocations = new PairingRevocations(fakeStore([client({ revokedAt: NOW })]));
    revocations.refresh();
    expect(revocations.isRevoked(null)).toBe(false);
    expect(revocations.isRevoked("")).toBe(false);
  });

  it("reads a real corrupted pairing.json as everything-revoked", () => {
    // Driven through `PairingStore` itself rather than a double, because the
    // defect this closes was precisely that the real collaborator never threw:
    // `read()` swallows a parse failure and answers with an empty store.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "actana-revocation-"));
    try {
      const file = path.join(dir, "pairing.json");
      fs.writeFileSync(file, '{"version":1,"sessions":[],"clients":[{"certSerial":"0a1b2c"');
      const store = new PairingStore(file);
      // The lenient reader is what made this invisible — kept here so the two
      // answers sit side by side.
      expect(store.read().clients).toEqual([]);

      const revocations = new PairingRevocations(store);
      expect(revocations.refresh().ok).toBe(false);
      expect(revocations.isRevoked("0a1b2c")).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads a pairing.json that is simply absent as nobody-revoked", () => {
    // A Core that has never paired anything has no file. Failing closed on its
    // absence would refuse every client on every fresh Core.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "actana-revocation-"));
    try {
      const revocations = new PairingRevocations(new PairingStore(path.join(dir, "pairing.json")));
      expect(revocations.refresh()).toEqual({ ok: true, revoked: [] });
      expect(revocations.isRevoked("0a1b2c")).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads a row whose shape it does not recognise as everything-revoked", () => {
    // The lenient reader drops such a row silently, and a dropped row is
    // exactly what a revoked client's row would look like to a reader that
    // must not miss one.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "actana-revocation-"));
    try {
      const file = path.join(dir, "pairing.json");
      fs.writeFileSync(file, JSON.stringify({ version: 1, sessions: [], clients: [{ certSerial: 7 }] }));
      const revocations = new PairingRevocations(new PairingStore(file));
      expect(revocations.refresh().ok).toBe(false);
      expect(revocations.isRevoked("anything")).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
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
      let closes = 0;
      const sweep = startPairingRevocationSweep({ revocations, onRevoked: () => (closes += 1) });
      expect(closes).toBe(0);
      expect(revocations.isRevoked("0a1b2c")).toBe(true);
      vi.advanceTimersByTime(REVOCATION_SWEEP_MS * 3);
      expect(closes).toBe(0);
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
      let closes = 0;
      const sweep = startPairingRevocationSweep({ revocations, onRevoked: () => (closes += 1) });

      // What `actana pair revoke` does, in the other process.
      store.rows[0] = client({ revokedAt: NOW });

      vi.advanceTimersByTime(REVOCATION_SWEEP_MS);
      expect(closes).toBe(1);
      vi.advanceTimersByTime(REVOCATION_SWEEP_MS * 3);
      expect(closes).toBe(1);
      sweep.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("calls back when the store becomes unreadable, and only on the crossing", () => {
    // The change a list of serials could not have expressed: nothing was newly
    // *named*, but every pairing is now revoked, so the links already open have
    // to be re-checked.
    vi.useFakeTimers();
    try {
      let broken = false;
      let closes = 0;
      const revocations = new PairingRevocations({
        readStrict: () => {
          if (broken) throw new Error("unreadable");
          return { clients: [client()] };
        },
      });
      const sweep = startPairingRevocationSweep({ revocations, onRevoked: () => (closes += 1) });
      vi.advanceTimersByTime(REVOCATION_SWEEP_MS);
      expect(closes).toBe(0);

      broken = true;
      vi.advanceTimersByTime(REVOCATION_SWEEP_MS);
      expect(closes).toBe(1);
      // Still unreadable is not a new event — the gates are already refusing.
      vi.advanceTimersByTime(REVOCATION_SWEEP_MS * 3);
      expect(closes).toBe(1);

      // And coming back is not one either: nothing became revoked by the file
      // becoming readable again.
      broken = false;
      vi.advanceTimersByTime(REVOCATION_SWEEP_MS);
      expect(closes).toBe(1);
      sweep.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("seeds fail-closed at boot before the first request is served", () => {
    vi.useFakeTimers();
    try {
      const revocations = new PairingRevocations({
        readStrict: () => {
          throw new Error("unreadable");
        },
      });
      let closes = 0;
      const sweep = startPairingRevocationSweep({ revocations, onRevoked: () => (closes += 1) });
      // Seeded, and no callback: at boot there are no connections to close.
      expect(revocations.isFailClosed()).toBe(true);
      expect(closes).toBe(0);
      vi.advanceTimersByTime(REVOCATION_SWEEP_MS * 3);
      expect(closes).toBe(0);
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
      let closes = 0;
      startPairingRevocationSweep({ revocations, onRevoked: () => (closes += 1) }).stop();
      store.rows[0] = client({ revokedAt: NOW });
      vi.advanceTimersByTime(REVOCATION_SWEEP_MS * 5);
      expect(closes).toBe(0);
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
