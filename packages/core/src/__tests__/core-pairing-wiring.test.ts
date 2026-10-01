// How the pairing family is mounted beside the file family (#282).
//
// The composition has one decision in it and it is not cosmetic: the file
// routes claim the whole `/v1/` prefix, so asking them first would have them
// answer `/v1/pair/redeem` with the `401` a client without a bearer gets —
// which is every client that is here to be given one.
import type { IncomingMessage, ServerResponse } from "node:http";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import log from "@actana/shared/log";
import type { CoreHttpRoutes } from "../core-files-routes";
import {
  auditPairingRoutes,
  composeCoreHttpRoutes,
  reportUnreadableRevocations,
  revokedHandler,
} from "../core-pairing-wiring";

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

    expect(routes.handle(request("/v1/files"), response())).toBe(true);
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

describe("auditPairingRoutes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** A response that finishes with `status`, and a request from `peer`. */
  function exchange(peer: string | undefined) {
    const res = Object.assign(new EventEmitter(), { statusCode: 0 }) as unknown as ServerResponse & EventEmitter;
    const req = { url: "/v1/pair/redeem", socket: { remoteAddress: peer } } as unknown as IncomingMessage;
    return { req, res };
  }

  it("writes one line per attempt, when the response finishes", () => {
    const info = vi.spyOn(log, "info").mockImplementation(() => {});
    const routes = auditPairingRoutes(family("/v1/pair/", []));
    const { req, res } = exchange("203.0.113.9");

    expect(routes.handle(req, res)).toBe(true);
    expect(info).not.toHaveBeenCalled();
    res.statusCode = 403;
    res.emit("finish");

    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(
      "pairing.attempt",
      expect.objectContaining({ outcome: "refused", status: 403, peer: "203.0.113.9" }),
    );
  });

  it.each([
    [200, "issued"],
    [400, "bad-request"],
    [413, "bad-request"],
    [429, "rate-limited"],
    [500, "core-error"],
  ])("calls a %i %s", (status, outcome) => {
    const info = vi.spyOn(log, "info").mockImplementation(() => {});
    const routes = auditPairingRoutes(family("/v1/pair/", []));
    const { req, res } = exchange("203.0.113.9");
    routes.handle(req, res);
    res.statusCode = status;
    res.emit("finish");
    expect(info).toHaveBeenCalledWith("pairing.attempt", expect.objectContaining({ outcome }));
  });

  it("writes nothing for a request the pairing family does not claim", () => {
    const info = vi.spyOn(log, "info").mockImplementation(() => {});
    const routes = auditPairingRoutes(family("/v1/pair/", []));
    const { req, res } = exchange("203.0.113.9");
    req.url = "/v1/files";

    expect(routes.handle(req, res)).toBe(false);
    res.emit("finish");
    expect(info).not.toHaveBeenCalled();
  });

  it("never puts anything from the request body or headers in the line", () => {
    const info = vi.spyOn(log, "info").mockImplementation(() => {});
    const routes = auditPairingRoutes(family("/v1/pair/", []));
    const { req, res } = exchange(undefined);
    Object.assign(req, { headers: { authorization: "Bearer secret" }, body: "ABCD-EFGH" });
    routes.handle(req, res);
    res.statusCode = 200;
    res.emit("finish");

    const line = JSON.stringify(info.mock.calls[0]);
    expect(line).not.toContain("secret");
    expect(line).not.toContain("ABCD-EFGH");
    expect(line).toContain("unknown");
  });

  it("writes one line when the response finishes and then closes", () => {
    const info = vi.spyOn(log, "info").mockImplementation(() => {});
    const routes = auditPairingRoutes(family("/v1/pair/", []));
    const { req, res } = exchange("203.0.113.9");
    routes.handle(req, res);
    res.statusCode = 200;
    Object.assign(res, { writableFinished: true });
    res.emit("finish");
    res.emit("close");

    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith("pairing.attempt", expect.objectContaining({ outcome: "issued" }));
  });

  it("writes a line for a request that was destroyed or hung up, where finish never fires", () => {
    const info = vi.spyOn(log, "info").mockImplementation(() => {});
    const routes = auditPairingRoutes(family("/v1/pair/", []));
    const { req, res } = exchange("203.0.113.9");
    routes.handle(req, res);
    res.statusCode = 200;
    Object.assign(res, { writableFinished: false });
    res.emit("close");
    res.emit("close");

    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(
      "pairing.attempt",
      expect.objectContaining({ outcome: "aborted", peer: "203.0.113.9" }),
    );
  });
});

describe("the fail-closed log line", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is written when the seeding refresh could not read the store", () => {
    const error = vi.spyOn(log, "error").mockImplementation(() => {});
    expect(reportUnreadableRevocations({ ok: false, error: "pairing.json is not valid JSON" })).toBe(true);
    expect(error).toHaveBeenCalledWith("core-pairing.revocation.unreadable", {
      error: "pairing.json is not valid JSON",
      effect: "every pairing refused",
    });
  });

  it("is not written when the store was read", () => {
    const error = vi.spyOn(log, "error").mockImplementation(() => {});
    expect(reportUnreadableRevocations({ ok: true })).toBe(false);
    expect(error).not.toHaveBeenCalled();
  });

  it("is written by onRevoked when the sweep reports fail-closed, and the links are still closed", () => {
    const error = vi.spyOn(log, "error").mockImplementation(() => {});
    let closed = 0;
    revokedHandler(() => true, () => (closed += 1))();
    expect(closed).toBe(1);
    expect(error).toHaveBeenCalledWith("core-pairing.revocation.unreadable", expect.objectContaining({ effect: "every pairing refused" }));
  });

  it("is not written by onRevoked for an ordinary revocation", () => {
    const error = vi.spyOn(log, "error").mockImplementation(() => {});
    let closed = 0;
    revokedHandler(() => false, () => (closed += 1))();
    expect(closed).toBe(1);
    expect(error).not.toHaveBeenCalled();
  });
});
