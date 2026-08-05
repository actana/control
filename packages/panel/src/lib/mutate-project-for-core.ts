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
 * addressed to a `coreId`, and the Core owning that Core performs the write
 * against its own SQLite (ADR 0004). Path validation happens there too — a
 * Project's path is a VM path, and the browser has no standing to judge it.
 *
 * Throws on transport failure or a Core-side error frame so the caller can
 * surface it in the menu/toast. Returns `null` when the mutation targeted a
 * missing row.
 *
 * A null `coreId` names a row in the Panel's own database — the last rows not
 * owned by a Core — and is written over the Panel's HTTP API instead. That
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
  // `archive` is a destructive delete at the protocol layer (see
  // CoreLinkProjectMutation), and the Panel's own row has no archived column —
  // so it maps to the DELETE endpoint, which answers with no body. A snapshot
  // of a row that no longer exists would be a fiction; `null` is the honest
  // answer and no archive caller reads one.
  if (mutation.op === "archive") {
    await api.deleteProject(mutation.projectId);
    return null;
  }
  const patch =
    mutation.op === "rename"
      ? { name: mutation.name }
      : mutation.op === "pin"
        ? { pinned: mutation.pinned }
        : definedFieldsOf(mutation);
  const { project } = await api.updateProject(mutation.projectId, patch);
  if (!project) return null;
  return {
    projectId: project.id,
    name: project.name,
    path: project.path,
    icon: project.icon,
    iconColor: project.iconColor,
    pinned: project.pinned,
    rememberHarnessSettings: !!project.rememberHarnessSettings,
    savedHarness: project.savedHarness ?? null,
    savedSkipPermissions: !!project.savedSkipPermissions,
    savedBareSession: !!project.savedBareSession,
    defaultGridView: !!project.defaultGridView,
    updatedAt: project.updatedAt,
  };
}

/**
 * A field-carrying op (`settings`, `appearance`) as the Panel's own PATCH
 * body: every field the op names, minus its routing keys. Undefined fields are
 * dropped rather than sent as `undefined` so a partial patch stays partial on
 * this arm too — the Core-side helpers have the same rule.
 */
function definedFieldsOf(
  mutation: Extract<CoreLinkProjectMutation, { op: "settings" | "appearance" }>,
): Record<string, unknown> {
  const { op: _op, projectId: _projectId, ...fields } = mutation;
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  );
}
