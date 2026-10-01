// The two words of the Files API's wire that still name a Project.
//
// The Files API is addressed `/v1/files` (#557). Two words from before that are kept, and
// only here, for the published `@actana/sdk` (ADR 0041 D29):
//
//   - `FILES_ROUTE_SCOPE`: the SDK's Files client still builds `/v1/projects/:id/files` and
//     `/v1/projects/:id/files/list` from a Project id, and the Panel and the image smoke reach
//     the Core through it. A Core has no Projects, so `core-files-routes.ts` keeps those two
//     addresses as an alias onto the same handler, ignores the id, and answers only the
//     read, write and list the client has ever sent.
//   - `OUTSIDE_ROOT_CODE`: the SDK's `CoreFilesErrorCode` lists `outside-project-root`, and a
//     client branches on it, so the code for a path that resolves outside the home keeps that
//     spelling on every route.
//
// **Remove both with actana/client#10 part 4** (the SDK Files client re-addressed at
// `/v1/files`, with its own codes): delete this file, the alias branch of `parseRoute`, and
// the alias tests in `core-files-alias.test.ts`.
import type { CoreFilesErrorCode } from "@actana/sdk/core";

/** The second path segment of `/v1/<this>/:id/files`. The id after it names nothing. */
export const FILES_ROUTE_SCOPE = "projects";

/** The code for a path that resolves outside the home. */
export const OUTSIDE_ROOT_CODE = "outside-project-root" satisfies CoreFilesErrorCode;
