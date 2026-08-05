import { api } from "~/lib/api";
import { mutateProjectForCore } from "~/lib/mutate-project-for-core";
import { pruneStoredSessionFinishNotifications } from "~/lib/session-notification-store";

/**
 * Remove a project, wherever it lives, and forget what the Panel kept about it.
 *
 * A Core-owned Project has no row in the Panel's database, so the Panel's own
 * DELETE endpoint 404s on it (issue 97) — the removal is a mutation frame
 * addressed to the owning Core, whose `archive` op deletes the row and lets
 * SQLite cascade the sessions under it. Every Panel watching that Core learns of
 * it through the `project:archived` event the Core appends.
 *
 * The Core's delete knows nothing about what this Panel kept on its own side,
 * and that outlives the project unless it is swept here: the stored
 * session-finish notifications, and the presentation row (group, card image,
 * launch URL) together with the image bytes on this disk. The Panel's own DELETE
 * already does both for a Panel-owned project.
 *
 * Throws on a transport or Core-side failure so the caller can put it in front
 * of the operator rather than closing a dialog over a project that is still
 * there.
 */
export async function removeProject(
  coreId: string | null | undefined,
  projectId: string,
): Promise<void> {
  // A null `coreId` lands on the Panel's own DELETE, which already sweeps both
  // of the leftovers below.
  await mutateProjectForCore(coreId, { op: "archive", projectId });
  if (!coreId) return;
  pruneStoredSessionFinishNotifications({ type: "project", projectId });
  // Best-effort, and after the notifications: the project is already gone on
  // its Core, so a failure here must not turn a completed removal into an error
  // the operator reads as "it didn't work". The lazy prune on the next project
  // read collects the row instead.
  await api.deleteProjectPresentation(projectId).catch(() => undefined);
}
