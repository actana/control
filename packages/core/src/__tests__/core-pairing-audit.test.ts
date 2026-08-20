// What the audit log is allowed to say (#282).
//
// A log line is the easiest place in this feature for a secret to end up: it is
// written on the failure path, read by people, and outlives the request by
// however long the log is kept. So the redaction is a function with a test.
import { describe, expect, it } from "vitest";
import { pairingAuditor, redactPairingAuditEvent, type PairingAuditEvent } from "../core-pairing-audit";

const attempt: PairingAuditEvent = {
  outcome: "issued",
  sessionId: "ps_1",
  label: "laptop",
  peer: "10.0.0.9",
  certSerial: "0a1b",
  at: 1_700_000_000_000,
};

describe("the audit record", () => {
  it("keeps what an operator needs to read the attempt", () => {
    expect(redactPairingAuditEvent(attempt)).toEqual({
      outcome: "issued",
      sessionId: "ps_1",
      label: "laptop",
      peer: "10.0.0.9",
      certSerial: "0a1b",
      at: 1_700_000_000_000,
    });
  });

  it("writes nothing for a field the attempt did not have", () => {
    const record = redactPairingAuditEvent({ outcome: "bad-request", peer: "10.0.0.9", at: 1 });
    expect(Object.keys(record).sort()).toEqual(["at", "outcome", "peer"]);
  });

  it("drops anything not on the list, whatever a caller attaches", () => {
    // The list is the mechanism. This is what a future field carrying the code,
    // the CSR or a key would meet — nothing is logged until somebody adds it to
    // `LOGGED_FIELDS`, which is a line in a diff a reviewer sees.
    const smuggled = {
      ...attempt,
      code: "ABCD-EFGH",
      csr: "-----BEGIN CERTIFICATE REQUEST-----",
      clientKey: "-----BEGIN PRIVATE KEY-----",
    } as PairingAuditEvent;

    const record = redactPairingAuditEvent(smuggled);

    expect(JSON.stringify(record)).not.toContain("ABCD-EFGH");
    expect(JSON.stringify(record)).not.toContain("CERTIFICATE REQUEST");
    expect(JSON.stringify(record)).not.toContain("PRIVATE KEY");
  });

  it("records a refusal's reason, which the response refuses to give", () => {
    // The distinction the wire will not draw is exactly the one the operator
    // reading their own Core's log needs.
    const record = redactPairingAuditEvent({
      outcome: "refused",
      reason: "attempts-exhausted",
      sessionId: "ps_1",
      peer: "10.0.0.9",
      attempts: 5,
      at: 1,
    });
    expect(record).toMatchObject({ reason: "attempts-exhausted", attempts: 5 });
  });
});

describe("the auditor", () => {
  it("hands the sink an already-redacted record", () => {
    const written: Record<string, unknown>[] = [];
    pairingAuditor((record) => written.push(record))(attempt);
    expect(written).toEqual([redactPairingAuditEvent(attempt)]);
  });

  it("does not let a broken sink take the request with it", () => {
    // The attempt has already been decided by the time this runs. Losing the
    // record is bad; answering a paired client with a 500 because the log was
    // unwritable is worse.
    const audit = pairingAuditor(() => {
      throw new Error("disk full");
    });
    expect(() => audit(attempt)).not.toThrow();
  });
});
