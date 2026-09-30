// How `core-entry` mounts the pairing endpoint beside the file routes (#282).
//
// The pairing endpoint itself — redemption, rate limit, revocation, the
// endpoint a redemption hands back — is `@actana/sdk/pairing/server`'s, mounted
// from `core-entry` with `createPairing`. What is left here is the one decision
// about *this* server that the SDK cannot make for it, and it is a security
// property rather than plumbing:
//
//   **Order.** The pairing family is consulted before the file family. The
//   file routes claim the whole `/v1/` prefix, so a composition that asked them
//   first would have them answer `/v1/pair/redeem` — with a `401`, since they
//   require a bearer and a pairing client has none. Pairing would be
//   unreachable, and the failure would look like an auth bug rather than a
//   mounting bug.
//
// A Core without pairing material mounts nothing: no CA key, no endpoint to
// hand out — and, through the gate, no relaxation of the TLS handshake. The
// loopback Core is unchanged.
import type { IncomingMessage, ServerResponse } from "node:http";
import log from "@actana/shared/log";
import type { CoreHttpRoutes } from "./core-files-routes";

/**
 * What the pairing surface signs as. The certificate names are the ones
 * `generateCertMaterial` has always minted for a Core (they are how an
 * operator's `openssl x509` recognises one), and the bearer's `iss` is
 * `core:<coreId>` (#282) — the SDK's neutral defaults would change all three.
 */
export const CORE_PAIRING_NAMES = {
  caCommonName: "mission-control-core-ca",
  clientCommonName: "mission-control-panel",
  organizationName: "Mission Control",
  issPrefix: "core:",
} as const;

/**
 * Compose several route families into the one surface the server mounts.
 *
 * First to claim a request answers it; a family that returns `false` has said
 * the path is none of its business, which is the contract `CoreHttpRoutes`
 * already documents. Everything nobody claims still falls through to the
 * server's own 404, so the Core's HTTP surface stays a closed list.
 *
 * **Order is the argument order**, and the note at the top of this file is why
 * that matters here rather than being a detail.
 */
export function composeCoreHttpRoutes(...families: CoreHttpRoutes[]): CoreHttpRoutes {
  return {
    handle: (req, res) => families.some((family) => family.handle(req, res)),
    handleContinue: (req, res) => families.some((family) => family.handleContinue(req, res)),
  };
}

/** What became of one redemption attempt, as far as its HTTP status can say. */
function attemptOutcome(status: number): string {
  if (status === 200) return "issued";
  if (status === 429) return "rate-limited";
  if (status >= 500) return "core-error";
  if (status === 403) return "refused";
  return "bad-request";
}

/**
 * Write one `pairing.attempt` line for every request the pairing surface
 * answers, to the same log the Core has always used for it.
 *
 * `createPairing` in the SDK takes no audit sink, so the record the 0.4.x route
 * wrote itself is written here from outside, from what is observable: when the
 * response finishes, its status and the peer that asked. That is a narrower
 * record than before — no internal `reason` (`wrong-code` against `expired`),
 * no session id or label — and it is the whole of what a wrapper can see. What
 * it keeps is the property that matters most: **every attempt leaves a line,
 * and no line can hold the code or the CSR**, because neither the body nor the
 * headers are read.
 */
export function auditPairingRoutes(routes: CoreHttpRoutes): CoreHttpRoutes {
  const audited =
    (inner: (req: IncomingMessage, res: ServerResponse) => boolean) =>
    (req: IncomingMessage, res: ServerResponse): boolean => {
      const claimed = inner(req, res);
      if (claimed) {
        res.once("finish", () => {
          log.info("pairing.attempt", {
            outcome: attemptOutcome(res.statusCode),
            status: res.statusCode,
            peer: req.socket?.remoteAddress ?? "unknown",
            at: Date.now(),
          });
        });
      }
      return claimed;
    };
  return { handle: audited(routes.handle), handleContinue: audited(routes.handleContinue) };
}
