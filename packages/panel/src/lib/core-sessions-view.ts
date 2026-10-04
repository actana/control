import { readJson, writeJson } from "~/lib/local-storage-json";

/** Sessions tab layout on a Core page (issue 560, design screen 02). */
export type CoreSessionsView = "grid" | "list";

const STORAGE_KEY = "mc:coreSessionsView";

type ViewMap = Record<string, CoreSessionsView>;

function readMap(): ViewMap {
  return readJson<ViewMap>(STORAGE_KEY, {});
}

export function readCoreSessionsView(coreId: string): CoreSessionsView {
  const stored = readMap()[coreId];
  return stored === "grid" || stored === "list" ? stored : "list";
}

export function writeCoreSessionsView(coreId: string, view: CoreSessionsView): void {
  const next = { ...readMap(), [coreId]: view };
  writeJson(STORAGE_KEY, next);
}

/** Test helper: drop every Core's remembered Sessions view. */
export function __resetCoreSessionsViewForTests(): void {
  writeJson(STORAGE_KEY, {});
}
