// The one hole in the mTLS wall, asserted as a rule rather than as a route
// (#282). The end-to-end proof that a real server behaves this way is in
// `core-pairing-redeem.test.ts`; this is the rule that server applies.
import { describe, expect, it } from "vitest";
import {
  clientCertGate,
  coreLinkUpgradeGate,
  rejectUnauthorizedAtHandshake,
} from "../core-preauth-gate";
import { isPairingPath } from "../core-pairing-wiring";

describe("clientCertGate", () => {
  it("serves anything to a connection that presented a verified certificate", () => {
    expect(clientCertGate({ pathname: "/v1/projects/p1/files", authorized: true })).toBe("serve");
    expect(clientCertGate({ pathname: "/v1/pair/redeem", authorized: true, isPreAuthPath: isPairingPath })).toBe(
      "serve",
    );
  });

  it("serves the pairing path to a connection that presented none", () => {
    expect(clientCertGate({ pathname: "/v1/pair/redeem", authorized: false, isPreAuthPath: isPairingPath })).toBe(
      "serve",
    );
  });

  it("refuses every other path to that connection", () => {
    for (const pathname of ["/v1/projects/p1/files", "/v1/projects/p1/files/list", "/healthz", "/"]) {
      expect(clientCertGate({ pathname, authorized: false, isPreAuthPath: isPairingPath })).toBe("refuse");
    }
  });

  it("refuses everything when no pre-auth surface is configured", () => {
    // A gate whose safety depends on a TLS flag set somewhere else is not a
    // gate. This is the answer even on the Cores where it is unreachable.
    expect(clientCertGate({ pathname: "/v1/pair/redeem", authorized: false })).toBe("refuse");
  });

  it("is not fooled by a path that merely starts like the pairing prefix", () => {
    expect(
      clientCertGate({ pathname: "/v1/pairing-secrets", authorized: false, isPreAuthPath: isPairingPath }),
    ).toBe("refuse");
  });
});

describe("coreLinkUpgradeGate", () => {
  it("has no pairing exception at all", () => {
    // A pre-auth WebSocket would be a socket that can ask this Core to spawn a
    // PTY without ever having said who it is.
    expect(coreLinkUpgradeGate(true)).toBe("serve");
    expect(coreLinkUpgradeGate(false)).toBe("refuse");
  });
});

describe("rejectUnauthorizedAtHandshake", () => {
  it("keeps the TLS refusal for a Core that mounts no pre-auth surface", () => {
    // Which is every Core built before #282, and every loopback Core after it:
    // the relaxation is scoped to the Cores that actually pair.
    expect(rejectUnauthorizedAtHandshake(undefined)).toBe(true);
  });

  it("relaxes it only where a pre-auth surface exists", () => {
    expect(rejectUnauthorizedAtHandshake(isPairingPath)).toBe(false);
  });
});
