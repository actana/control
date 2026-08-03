import { api } from "~/lib/api";
import { mutateProjectForCore } from "~/lib/mutate-project-for-core";

/**
 * Save what the Edit-project dialog produced, to the two places a project
 * currently lives.
 *
 * The name is a Harness fact: it sits on the Core's project row, and every tab
 * watching that Core should converge on it, so it travels as a mutation frame
 * (ADR 0004/0005). The rest of the dialog's fields — group, image, launch URL —
 * are Panel-local presentation with no frame to carry them, and keep their
 * patch. Both edit surfaces (the rail's context menu and the project page) call
 * this, so the split moves in one place when the frame grows.
 */
export async function saveProjectEdits(
  coreId: string | null,
  project: { id: string; name: string },
  data: { name?: string } & Record<string, unknown>,
): Promise<void> {
  const nextName = data.name?.trim();
  if (nextName && nextName !== project.name) {
    await mutateProjectForCore(coreId, {
      op: "rename",
      projectId: project.id,
      name: nextName,
    });
  }
  await api.updateProject(project.id, data);
}
