import { api } from "~/lib/api";
import { mutateProjectForCore } from "~/lib/mutate-project-for-core";

/** What the Edit-project dialog can produce. Every field is optional. */
export type ProjectEdits = {
  name?: string;
  icon?: string;
  iconColor?: string;
  groupId?: string | null;
  imagePath?: string | null;
  launchUrl?: string | null;
} & Record<string, unknown>;

/** The project as the dialog opened it — what "changed" is measured against. */
type EditedProject = {
  id: string;
  name: string;
  icon?: string;
  iconColor?: string;
};

/**
 * Save what the Edit-project dialog produced, to the two places a project
 * lives.
 *
 * Name, icon and icon colour are Core facts: they sit on the Core's project row
 * and every tab watching that Core should converge on them, so they travel as
 * mutation frames (ADR 0004/0005) — `rename` and `appearance`. Group, card
 * image and launch URL are Panel-local presentation that means nothing on the
 * Core; for a Core-owned project they go to its presentation row, and for a
 * Panel-owned one they keep the single PATCH they have always had.
 *
 * Only fields the operator actually changed are sent. That is not just thrift:
 * this used to fire a rename and then a PATCH that 404'd for every Core-owned
 * project, leaving the name changed and nothing else (issue 98). Fewer writes
 * is fewer ways to land half of one.
 *
 * Both edit surfaces (the rail's context menu and the project page) call this,
 * so the split moves in one place when the frame grows.
 */
export async function saveProjectEdits(
  coreId: string | null,
  project: EditedProject,
  data: ProjectEdits,
): Promise<void> {
  if (!coreId) {
    await api.updateProject(project.id, data);
    return;
  }

  const nextName = data.name?.trim();
  if (nextName && nextName !== project.name) {
    await mutateProjectForCore(coreId, {
      op: "rename",
      projectId: project.id,
      name: nextName,
    });
  }

  const appearance = changedAppearance(project, data);
  if (appearance) {
    await mutateProjectForCore(coreId, {
      op: "appearance",
      projectId: project.id,
      ...appearance,
    });
  }

  const presentation = presentationFieldsOf(data);
  if (presentation) {
    await api.updateProjectPresentation(project.id, coreId, presentation);
  }
}

/**
 * The icon fields the dialog changed, or null when it changed neither. A blank
 * value is not an erase — both columns are NOT NULL on the Core — so it reads
 * as "unchanged" here rather than travelling as a patch the Core would ignore.
 */
function changedAppearance(
  project: EditedProject,
  data: ProjectEdits,
): { icon?: string; iconColor?: string } | null {
  const patch: { icon?: string; iconColor?: string } = {};
  const icon = data.icon?.trim();
  if (icon && icon !== project.icon) patch.icon = icon;
  const iconColor = data.iconColor?.trim();
  if (iconColor && iconColor !== project.iconColor) patch.iconColor = iconColor;
  return Object.keys(patch).length > 0 ? patch : null;
}

/**
 * The Panel-local presentation fields the dialog produced, or null when it
 * produced none. `null` is a real value here (clear the group, drop the image),
 * so only `undefined` means "the dialog did not ask about this".
 */
function presentationFieldsOf(
  data: ProjectEdits,
): { groupId?: string | null; imagePath?: string | null; launchUrl?: string | null } | null {
  const patch: { groupId?: string | null; imagePath?: string | null; launchUrl?: string | null } =
    {};
  if (data.groupId !== undefined) patch.groupId = data.groupId;
  if (data.imagePath !== undefined) patch.imagePath = data.imagePath;
  if (data.launchUrl !== undefined) patch.launchUrl = data.launchUrl;
  return Object.keys(patch).length > 0 ? patch : null;
}
