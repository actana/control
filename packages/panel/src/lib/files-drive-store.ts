import { useSyncExternalStore } from "react";
import { readJson, writeJson } from "~/lib/local-storage-json";

// The Files tab's UI state (#565): grid or list, the selected file, and the uploads in flight. Server data (folders,
// details, the summary) is React Query's; this is only what the operator is doing. The Panel keeps its small stores on
// `useSyncExternalStore` (see `selected-core-store.ts`), and so does this one: no new dependency for a few fields.

export type FilesView = "grid" | "list";

export type UploadStatus = "queued" | "uploading" | "done" | "error";

export type UploadItem = {
  id: number;
  coreId: string;
  /** The file's path in the Shared folder, which is what the row shows. */
  path: string;
  size: number;
  /** Bytes sent so far. */
  loaded: number;
  status: UploadStatus;
  error?: string;
};

type FilesDriveState = {
  view: FilesView;
  /** The selected entry's path; a file's details show in the pane. Not kept across Cores or folders. */
  selected: string | null;
  uploads: readonly UploadItem[];
};

const VIEW_KEY = "mc:files-view";

function initialView(): FilesView {
  return readJson<FilesView>(VIEW_KEY, "grid") === "list" ? "list" : "grid";
}

let state: FilesDriveState = { view: "grid", selected: null, uploads: [] };
let hydrated = false;
let nextUploadId = 1;
const listeners = new Set<() => void>();

function set(next: Partial<FilesDriveState>): void {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

function hydrate(): void {
  if (hydrated) return;
  hydrated = true;
  state = { ...state, view: initialView() };
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useFilesDrive<T>(select: (s: FilesDriveState) => T): T {
  hydrate();
  return useSyncExternalStore(
    subscribe,
    () => select(state),
    () => select({ view: "grid", selected: null, uploads: [] }),
  );
}

export const filesDrive = {
  get: (): FilesDriveState => {
    hydrate();
    return state;
  },
  setView(view: FilesView): void {
    writeJson(VIEW_KEY, view);
    set({ view });
  },
  select(path: string | null): void {
    set({ selected: path });
  },
  addUploads(items: readonly Omit<UploadItem, "id" | "loaded" | "status">[]): number[] {
    const added = items.map((i) => ({ ...i, id: nextUploadId++, loaded: 0, status: "queued" as const }));
    set({ uploads: [...state.uploads, ...added] });
    return added.map((a) => a.id);
  },
  updateUpload(id: number, patch: Partial<Pick<UploadItem, "loaded" | "status" | "error">>): void {
    set({ uploads: state.uploads.map((u) => (u.id === id ? { ...u, ...patch } : u)) });
  },
  /** Drop the finished ones from the list; what is still going stays. */
  clearFinishedUploads(): void {
    set({ uploads: state.uploads.filter((u) => u.status === "queued" || u.status === "uploading") });
  },
  reset(): void {
    hydrated = false;
    state = { view: "grid", selected: null, uploads: [] };
    for (const l of listeners) l();
  },
};
