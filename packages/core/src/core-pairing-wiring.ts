// How `core-entry` mounts the pairing endpoint beside the file routes, and what
// the mTLS gate is told about it (#282).
//
// `core-files-wiring.ts` exists because the one decision in the file routes'
// wiring — are they gated by a bearer? — was got wrong when it lived inline in
// `core-entry.ts`, which no test can import. This module exists for the same
// reason and holds three decisions of its own, each of which is a security
// property rather than plumbing:
//
//   1. **Order.** The pairing family is consulted before the file family. The
//      file routes claim the whole `/v1/` prefix, so a composition that asked
//      them first would have them answer `/v1/pair/redeem` — with a `401`,
//      since they require a bearer and a pairing client has none. Pairing would
//      be unreachable, and the failure would look like an auth bug rather than
//      a mounting bug.
//   2. **Exactly one path is pre-auth.** {@link isPairingPath} is the predicate
//      `core-preauth-gate.ts` consults, and it names the pairing prefix and
//      nothing else. It is a function here rather than a string in the server
//      so that the set of pre-auth paths has one definition.
//   3. **A Core without pairing material mounts nothing.** No CA key, no
//      endpoint to hand out — and, through the gate, no relaxation of the TLS
//      handshake. The loopback Core is unchanged by this ticket.
import type { CoreHttpRoutes } from "./core-files-routes";
import {
  CORE_PAIRING_ROUTE_PREFIX,
  createCorePairingRequestHandler,
  type CorePairingRoutesOptions,
} from "./core-pairing-routes";

/** Is this pathname the Core's pre-auth surface? The whole of it, and only it. */
export function isPairingPath(pathname: string): boolean {
  return pathname.startsWith(CORE_PAIRING_ROUTE_PREFIX);
}

/**
 * Build the pairing route family.
 *
 * A thin pass-through today, and kept anyway: `core-entry` reaches for a
 * wiring module rather than a route factory for every other surface it mounts,
 * and the day pairing grows a second decision this is where it goes.
 */
export function buildCorePairingRoutes(opts: CorePairingRoutesOptions): CoreHttpRoutes {
  return createCorePairingRequestHandler(opts);
}

/**
 * Compose several route families into the one surface the server mounts.
 *
 * First to claim a request answers it; a family that returns `false` has said
 * the path is none of its business, which is the contract `CoreHttpRoutes`
 * already documents. Everything nobody claims still falls through to the
 * server's own 404, so the Core's HTTP surface stays a closed list.
 *
 * **Order is the argument order**, and decision 1 in this file's header is why
 * that matters here rather than being a detail.
 */
export function composeCoreHttpRoutes(...families: CoreHttpRoutes[]): CoreHttpRoutes {
  return {
    handle: (req, res) => families.some((family) => family.handle(req, res)),
    handleContinue: (req, res) => families.some((family) => family.handleContinue(req, res)),
  };
}
