// The registration blob, as a Core client reads it.
//
// `actana setup` emits one base64 artifact per machine — `{endpoint, caCert,
// clientCert, clientKey, bearer}` (CONTEXT.md "Registration blob"). It is the
// whole of what a Core client needs to reach a Core: the endpoint to dial, the
// PEM material for the mTLS handshake, and the bearer for the `auth` frame
// (#129 D1).
//
// Two deliberate boundaries.
//
// **The SDK takes a blob object, never a file** (#129 D9). Where the blob is
// kept — `~/.config/actana/cores/<name>.txt`, an environment variable, a
// Panel's encrypted store — is the caller's business, and the CLI's config
// resolution is its own ticket. Nothing here reads a path or base64-decodes a
// paste.
//
// **The shape is declared here, not imported from `@actana/shared`.**
// `packages/shared` is private and stays private ([ADR 0025][adr] D4), so an
// SDK that imported `RegistrationBlob` from it would be a published package
// with a dependency nobody outside this repository can resolve — the exact
// alternative that ADR rejected. The two declarations are structurally
// identical, so a Panel holding a `RegistrationBlob` passes it here with no
// conversion, and the field names are the wire's rather than either side's.
//
// [adr]: ../../docs/adr/0025-the-protocol-ships-with-the-client.md

import type { CoreLinkTlsMaterial } from "./core-link-socket.ts";

/**
 * A decoded registration blob. `endpoint` is the Core's `wss://host:port` core
 * link; `label` is the machine's own suggestion for an alias and is not used by
 * anything here.
 */
export type CoreRegistrationBlob = {
  endpoint: string;
  label?: string;
  caCert: string;
  clientCert: string;
  clientKey: string;
  bearer: string;
};

/**
 * Everything a blob says about how to reach one Core, unpacked into the parts a
 * client dials with — and **exposed rather than merely used**.
 *
 * `httpsBaseUrl` is the reason this type exists instead of a private helper.
 * A Core's file surface will mount on the same mTLS server the WebSocket
 * already listens on (#129 F2), and the same `tls` material authenticates both,
 * so the connection a client holds is "a Core connection" and not "a socket"
 * (#129's phase-3 guardrail 1). Naming the base URL now costs nothing and keeps
 * that from being a breaking change to a published surface later. Nothing in
 * this phase reads it.
 */
export type CoreConnection = {
  /** The `wss://` (or `ws://`) core-link URL to dial. */
  url: string;
  /**
   * The `https://` origin of the same Core, derived by swapping the scheme —
   * the server that terminates the WebSocket is the server that will answer
   * `/v1/…`. No path, no trailing slash.
   */
  httpsBaseUrl: string;
  /** The PEM material for the mTLS handshake, or null for a plain `ws://` dial. */
  tls: CoreLinkTlsMaterial | null;
  /** The signed bearer presented in the `auth` frame right after the handshake. */
  bearer: string;
};

/**
 * Unpack a registration blob into a {@link CoreConnection}.
 *
 * `ws://` is accepted here even though a blob's endpoint must be `wss://` for a
 * real Core (ADR 0002, and the Panel's decoder refuses anything else): this
 * function converts a shape, it does not police one, and a loopback endpoint is
 * how the Core's own tests and a local rig dial. A `ws://` endpoint yields
 * `tls: null` — there is no handshake to pin — and the bearer is still
 * presented, because the `auth` frame is the app-layer session either way.
 */
export function coreConnectionFromBlob(blob: CoreRegistrationBlob): CoreConnection {
  const url = blob.endpoint.trim();
  const secure = url.startsWith("wss://");
  return {
    url,
    httpsBaseUrl: httpsBaseUrlFor(url),
    tls: secure
      ? { ca: blob.caCert, cert: blob.clientCert, key: blob.clientKey }
      : null,
    bearer: blob.bearer,
  };
}

/**
 * `wss://host:port` → `https://host:port`, `ws://…` → `http://…`. Anything
 * else is returned unchanged rather than guessed at — a caller that handed this
 * a URL with no WebSocket scheme knows something about its Core that this
 * function does not.
 */
function httpsBaseUrlFor(url: string): string {
  if (url.startsWith("wss://")) return `https://${url.slice("wss://".length)}`.replace(/\/+$/, "");
  if (url.startsWith("ws://")) return `http://${url.slice("ws://".length)}`.replace(/\/+$/, "");
  return url;
}
