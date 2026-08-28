// How the pairing family is mounted beside the file family (#282).
//
// The composition has one decision in it and it is not cosmetic: the file
// routes claim the whole `/v1/` prefix, so asking them first would have them
// answer `/v1/pair/redeem` with the `401` a client without a bearer gets —
// which is every client that is here to be given one.
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import type { CoreHttpRoutes } from "../core-files-routes";
import { buildPairingEndpointResolver, composeCoreHttpRoutes, isPairingPath } from "../core-pairing-wiring";
import { createPairingSession, type PairingSession } from "@actana/shared/pairing-session";

/** A family that claims whatever its prefix names, and records that it did. */
function family(prefix: string, claimed: string[]): CoreHttpRoutes {
  const takes = (req: IncomingMessage): boolean => {
    if (!(req.url ?? "").startsWith(prefix)) return false;
    claimed.push(prefix);
    return true;
  };
  return {
    handle: (req) => takes(req),
    handleContinue: (req) => takes(req),
  };
}

const request = (url: string): IncomingMessage => ({ url }) as IncomingMessage;
const response = (): ServerResponse => ({}) as ServerResponse;

describe("composeCoreHttpRoutes", () => {
  it("gives a request to the first family that claims it", () => {
    const claimed: string[] = [];
    const routes = composeCoreHttpRoutes(family("/v1/pair/", claimed), family("/v1/", claimed));

    expect(routes.handle(request("/v1/pair/redeem"), response())).toBe(true);
    expect(claimed).toEqual(["/v1/pair/"]);
  });

  it("does not offer it to the families behind that one", () => {
    const claimed: string[] = [];
    const routes = composeCoreHttpRoutes(family("/v1/pair/", claimed), family("/v1/", claimed));

    routes.handle(request("/v1/pair/redeem"), response());

    expect(claimed).toHaveLength(1);
  });

  it("falls through to the next family for a path the first does not claim", () => {
    const claimed: string[] = [];
    const routes = composeCoreHttpRoutes(family("/v1/pair/", claimed), family("/v1/", claimed));

    expect(routes.handle(request("/v1/projects/p1/files"), response())).toBe(true);
    expect(claimed).toEqual(["/v1/"]);
  });

  it("leaves an unclaimed path unclaimed, so the server keeps its 404", () => {
    const claimed: string[] = [];
    const routes = composeCoreHttpRoutes(family("/v1/pair/", claimed), family("/v1/", claimed));

    expect(routes.handle(request("/healthz"), response())).toBe(false);
    expect(routes.handleContinue(request("/healthz"), response())).toBe(false);
  });

  it("composes `handleContinue` the same way", () => {
    const claimed: string[] = [];
    const routes = composeCoreHttpRoutes(family("/v1/pair/", claimed), family("/v1/", claimed));

    expect(routes.handleContinue(request("/v1/pair/redeem"), response())).toBe(true);
    expect(claimed).toEqual(["/v1/pair/"]);
  });
});

describe("isPairingPath", () => {
  it("names the pairing prefix and nothing else", () => {
    expect(isPairingPath("/v1/pair/redeem")).toBe(true);
    expect(isPairingPath("/v1/projects/p1/files")).toBe(false);
    expect(isPairingPath("/v1/pairing")).toBe(false);
    expect(isPairingPath("/")).toBe(false);
  });
});

// ─── Which address a redemption hands back (#347) ───────────────────────────
//
// One Core, several configured addresses, and a client that has to be told the
// one *it* can reach. The rule this suite pins is the constraint the whole
// design rests on: the answer comes from the stored session, and it can only
// ever be an address this Core's certificate covers.

describe("buildPairingEndpointResolver", () => {
  const session = (endpointHost?: string | null): PairingSession => ({
    ...createPairingSession({ id: "ps_1", label: "laptop", codeHash: "h", now: 0 }),
    endpointHost: endpointHost ?? null,
  });

  it("hands back the host the operator chose for this code", () => {
    const resolve = buildPairingEndpointResolver({
      publicHosts: ["core", "10.0.0.5"],
      port: 8443,
    });

    expect(resolve(session("10.0.0.5"))).toBe("wss://10.0.0.5:8443");
    expect(resolve(session("core"))).toBe("wss://core:8443");
  });

  // The default is today's behaviour, and it is what every code minted before
  // there was a choice still means.
  it("hands back the primary when the code chose nothing", () => {
    const resolve = buildPairingEndpointResolver({
      publicHosts: ["core", "10.0.0.5"],
      port: 8443,
    });

    expect(resolve(session(null))).toBe("wss://core:8443");
    // A session written before the field existed carries no `endpointHost` at
    // all, and means the same thing.
    const { endpointHost: _absent, ...legacy } = session(null);
    expect(resolve(legacy as PairingSession)).toBe("wss://core:8443");
  });

  // **A pairing code can never introduce a host the certificate has no SAN
  // for.** `actana pair new` refuses to mint one, and this is the second
  // enforcement: an operator can shorten `ACTANA_PUBLIC_HOST` while a code
  // minted against the longer list is still live, and by then the certificate
  // no longer covers the address that code was going to name. The primary is
  // an address the client can actually verify; the stale one is not.
  it("falls back to the primary for a host that is no longer configured", () => {
    const resolve = buildPairingEndpointResolver({ publicHosts: ["core"], port: 8443 });

    expect(resolve(session("10.0.0.5"))).toBe("wss://core:8443");
    expect(resolve(session("evil.example"))).toBe("wss://core:8443");
  });

  it("reads nothing but the session — there is nothing else to read", () => {
    const resolve = buildPairingEndpointResolver({ publicHosts: ["core"], port: 9443 });
    // The resolver's whole input is one `PairingSession`. A `Host` header, a
    // peer address or a body field cannot reach it, which is the property
    // `core-pairing-routes.ts` has always had and #347 did not spend.
    expect(resolve.length).toBe(1);
    expect(resolve(session("core"))).toBe("wss://core:9443");
  });
});
