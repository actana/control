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
 * What this Core announces: `local` until a controller has attached it to S3
 * (`sharedAttach`, #562), `s3` from then until it detaches. Claiming `s3` before
 * would be a lie a client acts on.
 */
export function sharedCapability(backend: CoreSharedBackend = "local"): CoreSharedCapability {
  return { version: 1, backend };
}

/**
 * What `ready.shared` says right now: `s3` while a controller has the Core attached
 * (the sync works whether or not the watcher is up), otherwise whatever the folder's
 * watcher announces, which is `local` or nothing.
 */
export function announceShared(attached: boolean, watcher: CoreSharedCapability | null): CoreSharedCapability | null {
  return attached ? sharedCapability("s3") : watcher;
}
