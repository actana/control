import type {
  CoreLinkProjectMutation,
  CoreLinkProjectSnapshot,
} from "@actana/shared/core-link-frames";
import { getPanelBridge } from "~/lib/panel-bridge";
import { api } from "~/lib/api";

/**
 * Route a project mutation to whichever Core owns the row (ADR 0005).
 *
 * For a Core-owned row the mutation is a frame on this tab's panel link
 * addressed to a `coreId`, and the Harness owning that Core performs the write
 * against its own SQLite (ADR 0004). Path validation happens there too — a
 * Project's path is a VM path, and the browser has no standing to judge it.
 *
 * Throws on transport failure or a Harness-side error frame so the caller can
 * surface it in the menu/toast. Returns `null` when the mutation targeted a
 * missing row.
 *
 * A null `coreId` names a row in the Panel's own database — the last rows not
 * owned by a Harness — and is written over the Panel's HTTP API instead. That
 * arm disappears with those rows.
 */
export async function mutateProjectForCore(
  coreId: string | null | undefined,
  mutation: CoreLinkProjectMutation,
): Promise<CoreLinkProjectSnapshot | null> {
  if (!coreId) return mutatePanelLocalProject(mutation);
  const bridge = getPanelBridge();
  if (!bridge) throw new Error("Not connected to the Panel — cannot mutate project");
  return bridge.mutateProject(coreId, mutation);
}

async function mutatePanelLocalProject(
  mutation: CoreLinkProjectMutation,
): Promise<CoreLinkProjectSnapshot | null> {
  // `create` has no Panel-local equivalent: a new project needs a machine to
  // live on, and the Panel is not one.
  if (mutation.op === "create") {
    throw new Error("cannot create a project that no Core owns");
  }
  const patch =
    mutation.op === "rename"
      ? { name: mutation.name }
      : mutation.op === "pin"
        ? { pinned: mutation.pinned }
        : { archived: true };
  const { project } = await api.updateProject(mutation.projectId, patch);
  if (!project) return null;
  return {
    projectId: project.id,
    name: project.name,
    path: project.path,
    icon: project.icon,
    iconColor: project.iconColor,
    pinned: project.pinned,
    updatedAt: project.updatedAt,
  };
}
