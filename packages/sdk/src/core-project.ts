// A Project, as a client holds one (#167).
//
// The SDK's levels so far have been transport (`CoreLinkTransport`), connection
// (`CoreClient`) and Session (`CoreSession`). A Project is the noun the file
// surface hangs off, and it exists as a handle rather than as three methods on
// `CoreClient` for one reason: **every file call needs the same projectId**, and
// threading it through `client.listFiles(projectId, …)`,
// `client.uploadFile(projectId, …)` is the shape where a caller eventually
// passes the wrong one to the middle call of three.
//
//     const project = client.project(projectId);
//     for await (const entry of project.files.list()) …
//
// Deliberately thin. A handle is not a fetch — `client.project(id)` opens no
// connection, checks nothing and costs nothing, so holding one for an id that
// turns out not to exist is not an error until a call is made. The Core is the
// authority on which Projects exist and it says so per request (`404
// project-not-found`); a constructor that validated the id here would need a
// round trip to be honest and would still be stale by the time it returned.
import { CoreFiles, type CoreFilesAvailability } from "./core-files.ts";
import type { CoreFilesFetch } from "./core-files-http.ts";

export type CoreProjectOptions = {
  id: string;
  /** The Core's HTTPS origin — `CoreConnection.httpsBaseUrl`. */
  baseUrl: string;
  bearer: string | null;
  availability: () => CoreFilesAvailability;
  fetch: CoreFilesFetch;
};

/** One Project on one Core. Reached as `client.project(id)`. */
export class CoreProject {
  /** The Project's id, as the Core knows it. */
  readonly id: string;
  /** This Project's files, over the Core's HTTPS routes (#129 F12). */
  readonly files: CoreFiles;

  constructor(opts: CoreProjectOptions) {
    this.id = opts.id;
    this.files = new CoreFiles({
      projectId: opts.id,
      baseUrl: opts.baseUrl,
      bearer: opts.bearer,
      availability: opts.availability,
      fetch: opts.fetch,
    });
  }
}
