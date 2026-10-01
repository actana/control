// The `shared` capability on the core-link `ready` frame (#561, ADR 0041 D5).
//
// **Core-local type, on purpose.** The shape is owned by the client's side of the
// contract (actana/client#4, delivered by client PR 33), which is not in a
// published SDK yet. This file declares it here so the Core can announce it
// without overriding or bumping the SDK; when the SDK ships the type, this file
// is replaced by an import and the announcement does not change on the wire.
//
// Absence is a supported state, as with `files` and `multiConnection`: a Core
// that omits the field predates the Shared folder and is not "needs update".

/** Where the Shared folder's bytes live: here only, or mirrored to S3 (#562). */
export type CoreSharedBackend = "local" | "s3";

/** `ready.shared`. */
export type CoreSharedCapability = { version: 1; backend: CoreSharedBackend };

/**
 * What this Core announces. Always `local` until the S3 mount exists (#562):
 * nothing in this Core configures S3, so claiming it would be a lie a client
 * acts on.
 */
export function sharedCapability(backend: CoreSharedBackend = "local"): CoreSharedCapability {
  return { version: 1, backend };
}
