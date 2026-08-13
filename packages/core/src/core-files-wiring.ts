// How `core-entry` wires the `/v1/…` file routes onto its core-link server.
//
// This is one function and it exists to be **tested**. The wiring it holds used
// to live inline in `core-entry.ts`, which cannot be imported by a test — the
// module boots a Core the moment it is loaded — so nothing covered it, and the
// one decision in it was wrong: the routes were handed a bearer verifier that
// was always present and always said no, so the default loopback Core
// announced a `files` capability on `ready` and then answered `401` to every
// request against it.
//
// That is the precise failure ADR 0028 D4 names — announcing a capability whose
// routes are not answering is worse than announcing nothing, because a client
// that reads the field stops feature-detecting and starts calling — and it
// contradicted the same ADR's consequence that the loopback `ws://` Core gets
// the routes too, over plain HTTP.
//
// So the rule is stated here, once, where a test can reach it:
//
//   **The file routes are gated by a bearer when, and only when, the core link
//   on the same server is.**
//
// A remote Core has a verifier and the routes require it. A loopback Core has
// none — its core link does not authenticate either, it binds 127.0.0.1, and
// the file surface is exactly as trusted as the rest of that Core, which is
// the trade ADR 0004 already made for every other frame. Either way the routes
// answer, so either way the capability may be announced.
import {
  createCoreFilesRequestHandler,
  type CoreFilesPort,
  type CoreHttpRoutes,
  type FilesAuthVerifier,
} from "./core-files-routes";
import type { ProjectWriteLocks } from "./files-transfer-locks";

export type CoreFileRoutesWiring = {
  /** The Project-root lookup the routes read (ADR 0027: the filesystem is the model). */
  filesPort: CoreFilesPort;
  /**
   * The core-link server's own bearer verifier, or `undefined` on a loopback
   * Core.
   *
   * Pass the value, not a closure that reaches for it later. A late-bound
   * closure is what made the "omitted" case unreachable: it was never absent,
   * it just answered `{ ok: false }`, which is a 401 rather than an open
   * surface. Build the routes *after* the material is resolved instead — which
   * is what `core-entry` now does.
   */
  authVerifier?: FilesAuthVerifier;
};

/**
 * Build the Core's HTTP surface, gated exactly as its core link is.
 *
 * Returns the routes the server factory mounts, plus the write-lease table so a
 * caller (and a test) can see what is in flight.
 */
export function buildCoreFileRoutes(
  wiring: CoreFileRoutesWiring,
): CoreHttpRoutes & { locks: ProjectWriteLocks } {
  return createCoreFilesRequestHandler({
    filesPort: wiring.filesPort,
    // Spread rather than `authVerifier: wiring.authVerifier`, so that "no
    // verifier" reaches the routes as an absent key. It reads the same to
    // `createCoreFilesRequestHandler`'s truthiness check today; it is written
    // this way because the distinction between "no bearer is required here"
    // and "a bearer is required and nothing can satisfy it" is the whole of
    // the defect this module exists to prevent, and a reader should not have
    // to re-derive which one an `undefined` means.
    ...(wiring.authVerifier ? { authVerifier: wiring.authVerifier } : {}),
  });
}

/**
 * Should this Core put `files: { version: 1 }` on its `ready` frame?
 *
 * Yes when the routes are mounted, because after {@link buildCoreFileRoutes}
 * mounted routes are answering routes — which is the only thing the capability
 * claims. Kept as a named function rather than left to
 * `PtyCoreLinkServerOptions.announceFiles`'s `Boolean(httpRoutes)` default so
 * that the claim has somewhere to be asserted, and so a future surface that
 * mounts routes it cannot answer has to come here and say so.
 */
export function shouldAnnounceFiles(routes: CoreHttpRoutes | undefined): boolean {
  return Boolean(routes);
}
