// How the pairing family is mounted beside the file family (#282).
//
// The composition has one decision in it and it is not cosmetic: the file
// routes claim the whole `/v1/` prefix, so asking them first would have them
// answer `/v1/pair/redeem` with the `401` a client without a bearer gets —
// which is every client that is here to be given one.
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import type { CoreHttpRoutes } from "../core-files-routes";
import { composeCoreHttpRoutes, isPairingPath } from "../core-pairing-wiring";

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
