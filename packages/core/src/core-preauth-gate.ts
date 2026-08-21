// The one hole in the Core's mTLS wall, and the wall around it (#282).
//
// Every route on a remote Core and the core link itself sit behind the mutual
// TLS handshake: `pty-core-link-server.ts` builds its `https.Server` with
// `requestCert: true, rejectUnauthorized: true`, so a client with no
// certificate is refused by TLS before a byte of HTTP is parsed. Pairing is the
// one exchange where that cannot hold — the client is posting a CSR precisely
// *because* it has no certificate yet — and this module is how the exception is
// made without becoming a hole.
//
// **Why the TLS flag has to move at all.** There is no per-route TLS. A
// server either demands a verified client certificate to complete a handshake
// or it does not, and the decision is made before the request line exists. So
// a Core that serves a pre-auth route completes the handshake without one
// (`rejectUnauthorized: false`, with `requestCert` still true so a certificate
// that *is* presented is still parsed and verified) and enforces the same rule
// one layer up, per request, from `socket.authorized`.
//
// **What that costs, stated plainly.** Refusal moves from the TLS layer to the
// HTTP layer: an unauthenticated caller now gets a `403` where they used to get
// a handshake failure. What it does not cost is access — the gate below is
// applied to every request and every WebSocket upgrade, and it defaults to
// refusing.
//
// **And a Core with no pairing surface does not pay it.** No pre-auth path
// means the server keeps `rejectUnauthorized: true` and behaves exactly as it
// did before this ticket, TLS refusal and all. The relaxation is scoped to the
// Cores that mount the endpoint, which is what "without weakening the mTLS
// posture of every other route" means here.

/** Does this pathname name the pre-auth surface? See `core-pairing-wiring.ts`. */
export type PreAuthPathPredicate = (pathname: string) => boolean;

/** What the gate decides. There is no third answer. */
export type ClientCertVerdict = "serve" | "refuse";

/** The status a refused request gets, and the body that explains it. */
export const CLIENT_CERT_REFUSAL_STATUS = 403;
export const CLIENT_CERT_REFUSAL_CODE = "client-certificate-required";
export const CLIENT_CERT_REFUSAL_MESSAGE =
  "this Core requires a client certificate on every route but its pairing endpoint";

/**
 * May this request be served on a connection that presented no verified client
 * certificate?
 *
 * The default is `refuse`, and every argument has to line up to get anything
 * else: an authorized connection is served whatever it asked for, and an
 * unauthorized one is served only what the predicate names.
 *
 * `isPreAuthPath` absent means no pre-auth surface is mounted, which is the
 * loopback Core and every Core built before #282. Such a server keeps
 * `rejectUnauthorized: true` and never reaches this function with
 * `authorized: false` — but it answers `refuse` if it does, because a gate
 * whose safety depends on a flag set somewhere else is not a gate.
 *
 * **`revoked` is checked before anything else, `authorized` included** (#283).
 * A revoked client's certificate is still signed by this Core's CA and still
 * completes the handshake — TLS has no idea an operator took it back — so
 * `authorized: true` is exactly what a revoked client arrives with, and a gate
 * that read it first would serve every one of them. Revocation is also the one
 * refusal with no pre-auth exception: a client here to *redeem a code* has no
 * certificate to have had revoked, so nothing legitimate is turned away.
 */
export function clientCertGate(opts: {
  pathname: string;
  authorized: boolean;
  /** Did this connection present a certificate `actana pair revoke` took back? */
  revoked?: boolean;
  isPreAuthPath?: PreAuthPathPredicate;
}): ClientCertVerdict {
  if (opts.revoked) return "refuse";
  if (opts.authorized) return "serve";
  if (!opts.isPreAuthPath) return "refuse";
  return opts.isPreAuthPath(opts.pathname) ? "serve" : "refuse";
}

/**
 * May this connection be upgraded to the core link?
 *
 * Separate from {@link clientCertGate} because the answer is not a function of
 * the path: the core link is the Panel's authenticated session with this Core,
 * and no pairing exception reaches it. A pre-auth WebSocket would be a socket
 * that could ask this Core to spawn a PTY without ever proving who it was.
 *
 * `revoked` refuses for the reason spelled out on {@link clientCertGate}: a
 * revoked certificate is a valid certificate, and this is the layer that knows
 * the difference.
 */
export function coreLinkUpgradeGate(authorized: boolean, revoked = false): ClientCertVerdict {
  if (revoked) return "refuse";
  return authorized ? "serve" : "refuse";
}

/**
 * Should the TLS server demand a verified client certificate to complete the
 * handshake at all?
 *
 * Yes unless a pre-auth surface is mounted — see the header. Written as a named
 * function rather than inlined at the `https.createServer` call so that the one
 * line that relaxes this Core's TLS posture is a line with a name, a reason and
 * a test, rather than a ternary inside an options object.
 */
export function rejectUnauthorizedAtHandshake(isPreAuthPath: PreAuthPathPredicate | undefined): boolean {
  return isPreAuthPath === undefined;
}
