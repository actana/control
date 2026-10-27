import type { CoreWithDial } from "~/shared/cores";

// What the compact top bar's centre says: the place the operator is in.

export type ShellPlace = { label: string; coreId?: string; online?: boolean };

export function shellPlace({
  pathname,
  routeCoreId,
  cores,
  settingsOpen,
  usageOpen,
}: {
  pathname: string;
  routeCoreId: string | null;
  cores: readonly CoreWithDial[];
  settingsOpen: boolean;
  usageOpen: boolean;
}): ShellPlace {
  if (settingsOpen) return { label: "Settings" };
  if (usageOpen) return { label: "Usage" };
  const core = routeCoreId ? cores.find((c) => c.id === routeCoreId) : undefined;
  if (core) return { label: core.label, coreId: core.id, online: core.dial.state === "connected" };
  if (pathname === "/tasks" || pathname.startsWith("/tasks/")) return { label: "Tasks" };
  return { label: "Fleet" };
}
