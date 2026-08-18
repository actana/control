// The refusal vocabulary of the Core's file surface — one definition, for both
// ends of the wire (#224).
//
// ## Why this file exists rather than a union in each package
//
// This union was written out twice, verbatim and in the same order: once in
// `packages/core/src/core-files-routes.ts`, which is the side that *sends* the
// codes, and once in `packages/sdk/src/core-files-http.ts`, which is the side
// that *reads* them. The two agreed, member for member, the whole time they
// existed — so nothing here is a repair. What made it worth a ticket is that
// the two copies were not equally load-bearing, and the asymmetry ran the wrong
// way round:
//
// - The Core's copy is **checked**. `Refusal` types every refusal the routes
//   send, so a code outside the union is a compile error, and the two narrower
//   lists inside that package — `TarRefusalCode` in `files-tar.ts` and
//   `FileConfinementRefusal` in `files-confinement.ts` — are pinned as subsets
//   by assignment. Inside the Core, a copy cannot drift.
// - The SDK's copy was **not checked, deliberately**. Every use site widens it
//   to `CoreFilesErrorCode | string`, because a client that meets a Core newer
//   than itself has to survive a code it has never heard of. That widening is
//   correct and it survives this change (see `core-files-http.ts`) — but it
//   also means a member missing from the SDK's list was a type error nowhere.
//
// So the one place the copy could drift was the one place nothing would notice,
// and the drift would not surface as a break. It would surface as two processes
// disagreeing on a wire while each typechecks cleanly: the Core answers a code
// the client cannot name, every consumer's `catch` still compiles because of the
// `| string`, and the operator gets a refusal their tooling has no word for.
//
// That is not a hypothetical about this seam. #218/#219 is the same seam doing
// exactly this: the SDK targeted `?list=1`, the Core served `/files/list`, each
// side documented its choice at length, neither knew, and **both suites passed
// the whole time** — because each proved itself against its own idea of the
// other. And the review that raised this ticket produced the maintenance cost
// while it was still running: the commit that added `root-entry-path`, the 22nd
// member, had to edit both packages to do it, with nothing pointing the author
// at the second file.
//
// ## Why the SDK owns it, and why that arrow is not upside-down
//
// The Core is the *server* answering these codes and it now imports their
// definition from the *client* package. That reads backwards and is the same
// trade [ADR 0025](../../../docs/adr/0025-the-protocol-ships-with-the-client.md)
// already made for the core-link frames, for the same reason: **what the Core
// depends on is the protocol, not the client.** D2 rules that arrow is not a
// layering violation, and D3 states the rule this file exists to satisfy —
// "there is exactly one definition of every frame type, and a mirror is never
// the answer", because a mirror "does not fail; it disagrees, at runtime, on a
// wire, between two processes that each believe they are correct."
//
// ADR 0025 D1 scoped that record to `core-link-frames.ts`, so this union sat
// just outside its subject. #224 moves the scope rather than re-deriving the
// argument: D2's rule now names this module too, and the ADR's consequences say
// so, so the next reviewer meets the widened rule where the rule lives.
//
// ## Why a module of its own, and not `core-files-http.ts`
//
// `core-files-http.ts` is a transport: it imports `undici` and builds
// dispatchers. An `import type` erases, so parking the union there would have
// created no runtime edge for the Core either — but it would have pointed the
// Core's source at a file full of client machinery to read a vocabulary, and
// D2's rule is only reviewable if what the Core may import is a module a
// reviewer can see holds nothing else. This file imports nothing, exactly as
// `core-link-frames.ts` imports nothing, and that is the property that makes it
// safe to depend on from the server.
//
// **It is public API.** `packages/sdk/package.json` exports `./*`, so this is
// the published subpath `@actana/sdk/core-files-error-codes` on the next
// publish. That is a release decision and it is taken here deliberately rather
// than fallen into: the refusal vocabulary is precisely the thing a third party
// writing a `catch` wants to type against, so it is better named than hidden.
// `core-files-http.ts` re-exports the type as well, so the specifier that
// already worked keeps working and nothing published moves.
//
// ## Why the codes are a value and not only a type
//
// A union of string literals erases at compile time, which leaves nothing for a
// test to read. The list below is therefore a `const` tuple and the type is
// derived from it, so the vocabulary is enumerable at runtime and the *third*
// copy of it — the operator-facing table in `docs/external-api.md` — can be
// pinned to this one by a test rather than by somebody remembering.
// `core-files-error-codes.test.ts` is that test. Nothing shipped imports the
// array, and nothing has to: `import type` erases in the Core's bundle, so the
// server still carries no runtime edge into this package.

/**
 * Every machine-readable refusal code the Core's file routes can answer with.
 *
 * Order is not meaning — nothing reads these by index. Keep it grouped as it is
 * (request, then path, then transfer, then tar entry, then I/O) because that is
 * the order `docs/external-api.md` explains them in, and two lists a reader
 * compares by eye are easier to compare when they run the same way.
 *
 * **Adding one is a one-file change**: append it here, and the Core's `Refusal`
 * type and the SDK's error classes both accept it with no further edit. The
 * docs table is the one copy left, and it is not a copy you can forget —
 * `core-files-error-codes.test.ts` goes red until it names the new code too.
 */
export const CORE_FILES_ERROR_CODES = [
  "unauthorized",
  "not-found",
  "project-not-found",
  "method-not-allowed",
  "bad-request",
  "absolute-path",
  "dot-dot-segment",
  "outside-project-root",
  "malformed-path",
  "transfer-in-progress",
  "insufficient-storage",
  "corrupt-archive",
  "absolute-entry-path",
  "dot-dot-entry-path",
  "root-entry-path",
  "entry-outside-root",
  "unsupported-entry-type",
  "hardlink-outside-root",
  "symlink-outside-root",
  "directory-in-the-way",
  "write-failed",
  "read-failed",
] as const;

/**
 * Machine-readable refusal codes. The Panel forwards them; it reads none of them.
 *
 * Derived from {@link CORE_FILES_ERROR_CODES} rather than written out a second
 * time — a hand-kept type beside the array would be the same mirror this module
 * exists to remove, one file further in.
 */
export type CoreFilesErrorCode = (typeof CORE_FILES_ERROR_CODES)[number];
