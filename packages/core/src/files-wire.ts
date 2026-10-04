// The one word of the Files API's wire that still names a Project.
//
// The Files API is addressed `/v1/files` (#557), and the old `/v1/projects/:id/files` alias is
// gone (#580 T-404). One word from before that is kept, for the published `@actana/sdk`
// (ADR 0041 D29):
//
//   - `OUTSIDE_ROOT_CODE`: the SDK's `CoreFilesErrorCode` lists `outside-project-root`, and a
//     client branches on it, so the code for a path that resolves outside the home keeps that
//     spelling on every route.
//
// **Remove it with actana/client#10 part 4** (the SDK's Files client with its own codes).
import type { CoreFilesErrorCode } from "@actana/sdk/core";

/** The code for a path that resolves outside the home. */
export const OUTSIDE_ROOT_CODE = "outside-project-root" satisfies CoreFilesErrorCode;
