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
//   4. **Which address a redemption hands back is decided here, from the
//      session and the configured list, and from nothing else** (#347). See
//      {@link buildPairingEndpointResolver}: it is the second of the two places
//      the "a pairing code can only name a host this certificate covers" rule
//      is enforced, the first being `actana pair new` refusing to mint one.
import type { CoreHttpRoutes } from "./core-files-routes";
import { isConfiguredPublicHost, primaryPublicHost } from "@actana/shared/public-hosts";
import type { PairingSession } from "@actana/shared/pairing-session";
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

/** What a redemption's endpoint is built out of: this Core's own addresses. */
export type PairingEndpointOptions = {
  /**
   * Every address this Core's server certificate covers, in the operator's
   * order. The first is the primary.
   */
  publicHosts: readonly string[];
  /** The port the core link listens on — the same one for every address. */
  port: number;
};

/**
 * Build the `endpointFor` the redeem route answers with (#347).
 *
 * Two rules, and both of them are the ticket:
 *
 * **The session decides, not the request.** The only input is the stored
 * pairing session — what `actana pair new` wrote on the machine that is the
 * Core. No header, no body field and no socket address reaches this function,
 * which is what keeps the property `core-pairing-routes.ts` has always had: a
 * client pins the address this Core chose for it, never one a caller supplied.
 *
 * **A session can only ever name a configured host.** `actana pair new`
 * refuses a `--public-host` that is not in the recorded list, so a session
 * carrying one is already impossible through the supported path. It is checked
 * again here anyway, because the two ends are a file apart and time passes
 * between them: an operator can shorten `ACTANA_PUBLIC_HOST` while a code
 * minted against the longer list is still live, and by then the certificate no
 * longer covers the address that code was going to hand back. Falling back to
 * the primary sends that client somewhere it can actually verify, where
 * honouring the stale value would hand it a name TLS is about to reject.
 */
export function buildPairingEndpointResolver(
  opts: PairingEndpointOptions,
): (session: PairingSession) => string {
  const primary = primaryPublicHost(opts.publicHosts);
  return (session) => {
    const chosen = session.endpointHost ?? "";
    const host =
      chosen.length > 0 && isConfiguredPublicHost(opts.publicHosts, chosen) ? chosen : primary;
    return `wss://${host}:${opts.port}`;
  };
}
