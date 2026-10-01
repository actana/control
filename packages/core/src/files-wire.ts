// The two words of the Files API's wire that still name a Project.
//
// The Files API is addressed `/v1/projects/:id/files` and refuses a path that
// leaves its root with the code `outside-project-root`. Both are in the
// published `@actana/sdk` (its client builds the URL and its `CoreFilesErrorCode`
// lists the code), and a Core has no Projects (ADR 0041 D1). Re-addressing the
// surface at the workspace, with its own codes, is #557's. Until it lands the
// Core keeps answering the published words and keeps them here, and only here,
// so that deleting this file is the whole of that change on the Core's side.
import type { CoreFilesErrorCode } from "@actana/sdk/core";

/** The second path segment of `/v1/<this>/:id/files`. The id after it names nothing. */
export const FILES_ROUTE_SCOPE = "projects";

/** The code for a path that resolves outside the workspace root. */
export const OUTSIDE_ROOT_CODE = "outside-project-root" satisfies CoreFilesErrorCode;
