// The one hole in the mTLS wall, asserted as a rule rather than as a route
// (#282). The end-to-end proof that a real server behaves this way is in
// `core-pairing-redeem.test.ts`; this is the rule that server applies.
import { describe, expect, it } from "vitest";
import { createPairing } from "@actana/sdk/pairing/server";
import {
  clientCertGate,
  coreLinkUpgradeGate,
  rejectUnauthorizedAtHandshake,
} from "../core-preauth-gate";
// The predicate production hands the server: the one `createPairing` builds for
// the Core (`core-entry.ts` mounts `pairing.gate.isPreAuthPath`). It is the
// exact redemption path, tighter than 0.4.5's `/v1/pair/` prefix.
const isPairingPath = createPairing({
  store: {} as unknown as Parameters<typeof createPairing>[0]["store"],
  material: {
    caCert: "", caKey: "", serverCert: "", serverKey: "", clientCert: "", clientKey: "",
    bearerSecret: "preauth-suite-secret-at-least-32-bytes",
    coreId: "core-1",
    coreUuid: "3f6d0f0a-6c1f-4a5e-9c2f-1d0a5b7e9c31",
    serverHosts: ["127.0.0.1"],
  },
  endpointScheme: "wss",
  onRevoked: () => {},
}).gate.isPreAuthPath;

describe("the production pre-auth predicate", () => {
  it("names the redemption path and nothing else", () => {
    expect(isPairingPath("/v1/pair/redeem")).toBe(true);
    expect(isPairingPath("/v1/pair/other")).toBe(false);
    expect(isPairingPath("/v1/pair/")).toBe(false);
    expect(isPairingPath("/v1/pair/redeem/extra")).toBe(false);
    expect(isPairingPath("/v1/files")).toBe(false);
  });

  it("refuses an uncertificated client on /v1/pair/other", () => {
    expect(clientCertGate({ pathname: "/v1/pair/other", authorized: false, isPreAuthPath: isPairingPath })).toBe(
      "refuse",
    );
  });
});

describe("clientCertGate", () => {
  it("serves anything to a connection that presented a verified certificate", () => {
    expect(clientCertGate({ pathname: "/v1/files", authorized: true })).toBe("serve");
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
    for (const pathname of ["/v1/files", "/v1/files/list", "/healthz", "/"]) {
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
