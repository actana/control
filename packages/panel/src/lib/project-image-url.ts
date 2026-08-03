/**
 * Where the browser reads a project's card image from.
 *
 * The Panel service serves the bytes over HTTP — there is no `app://` protocol
 * and no filesystem the browser can reach (ADR 0010).
 *
 * `version` is any value that changes when the image does — the project's
 * `updatedAt` for a row read back from the server, or that plus a local counter
 * while a dialog replaces the image without refetching. The response is cached
 * immutably, so a stale `version` shows a stale image: whoever changes the
 * bytes must change this too.
 */
export function projectImageUrl(projectId: string, version?: number): string {
  return `/api/projects/${encodeURIComponent(projectId)}/image?v=${version ?? 0}`;
}
