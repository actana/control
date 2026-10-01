import type { Project } from "~/db/schema";
import { readCoreRemember } from "~/lib/core-remember";

/**
 * A Project-shaped stand-in for a Core's workspace (issue 560).
 *
 * Terminals, the session grid and optimistic caches still key off a project
 * id. With no Projects on the Core (ADR 0041 D1), the Core itself is that
 * scope: id = coreId, path = `~`. Remembered harness settings come from
 * localStorage ({@link readCoreRemember}), not a Project row.
 */
export function coreWorkspaceProject(coreId: string, label: string): Project {
  const remembered = readCoreRemember(coreId);
  const now = Date.now();
  return {
    id: coreId,
    name: label || coreId,
    path: "~",
    icon: "server",
    iconColor: "#5b8def",
    imagePath: null,
    groupId: null,
    pinned: false,
    pinnedOrder: null,
    launchUrl: null,
    rememberHarnessSettings: remembered.rememberHarnessSettings,
    savedHarness: remembered.savedHarness,
    savedSkipPermissions: false,
    savedBareSession: false,
    defaultGridView: false,
    createdAt: now,
    updatedAt: now,
  };
}
