// Dropping files on a Project, and watching them land (#129 F6/F11, #169).
//
// Two hooks and one rule between them: **the Panel holds no file state.** There
// is no cache of a Project's tree, no optimistic row inserted on drop, no
// upload queue persisted anywhere. The filesystem on the Core is the model (F1,
// ADR 0027) and an index of it is stale the moment an agent writes — which, on
// a machine whose whole purpose is running agents unattended, is constantly. So
// a listing is a read, a drop is a write, and a write is followed by a re-read.
//
// This is also the boundary ADR 0022 draws, from the other side. A Core-owned
// Project's *presentation* — its group, its card image, its launch URL — is
// Panel-local, lives in `project_presentation`, and is joined client-side. A
// file view is none of those things: it is the Core's disk, read live, and
// putting any of it in that row would be the Panel keeping state about a machine
// it does not own. Nothing in this file touches that table.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CoreFilesApiError,
  composeUploadPath,
  filesFromDrop,
  listProjectFiles,
  uploadProjectFile,
  type CoreFileEntry,
  type DroppedFile,
} from "~/lib/core-files";
import { useCores } from "~/lib/use-fleet";

/** Whether this Core can show a file view at all, and why not when it cannot. */
export type ProjectFilesAvailability =
  | { available: true }
  | { available: false; reason: "not-core-owned" | "unknown-core" | "unsupported" | "offline"; detail: string };

/**
 * Can this Project's files be reached, right now?
 *
 * Read off the dial status the service pushes, which carries the `files`
 * capability from the Core's last `ready` frame (F9). Three of the four answers
 * are *absent, not broken* — a Panel-owned Project has no Core behind it, a Core
 * that announces no file surface predates the feature, and neither is a fault to
 * report. Only `offline` is a Core that would have one if it were reachable, and
 * that is the one worth saying out loud rather than hiding, because it comes
 * back on its own.
 */
export function useProjectFilesAvailability(coreId: string | null): ProjectFilesAvailability {
  const { cores } = useCores();
  return useMemo(() => {
    if (!coreId) {
      return {
        available: false as const,
        reason: "not-core-owned" as const,
        detail: "this Project lives in the Panel's own registry, not on a Core",
      };
    }
    const core = cores.find((c) => c.id === coreId);
    if (!core) {
      return {
        available: false as const,
        reason: "unknown-core" as const,
        detail: "this Project's Core is not registered with this Panel",
      };
    }
    // The capability first, because it is the one that means *nothing to show*.
    // A Core that never announces `files` is a Core that predates them, and it
    // should read the same whether or not it happens to be reachable this second.
    if (!core.dial.files) {
      return {
        available: false as const,
        reason: "unsupported" as const,
        detail: `${core.label} announces no file surface`,
      };
    }
    if (core.dial.state !== "connected") {
      return {
        available: false as const,
        reason: "offline" as const,
        detail: `${core.label} is ${core.dial.state}`,
      };
    }
    return { available: true as const };
  }, [cores, coreId]);
}

/** One file's journey, as the progress list shows it. */
export type UploadItem = {
  id: string;
  path: string;
  size: number;
  state: "queued" | "sending" | "written" | "overwritten" | "failed";
  /** Set on `failed` — the Core's message, not a Panel paraphrase. */
  error?: string;
};

let uploadSeq = 0;

export type ProjectFileUploads = {
  items: UploadItem[];
  busy: boolean;
  /**
   * Upload everything in a drop, in order. Resolves when the last one settles.
   *
   * `destination` is the Project-relative folder the drop landed on — a folder
   * row's own path (#227), or the empty string for the Project root, which is
   * where a drop on the panel itself goes.
   */
  send(dropped: DroppedFile[], destination?: string): Promise<void>;
  /** Read the files out of a `drop` event and send them under `destination`. */
  sendFromDrop(dataTransfer: DataTransfer, destination?: string): Promise<void>;
  clear(): void;
};

/**
 * The upload queue for one Project.
 *
 * **Strictly sequential**, and that is the Core's rule rather than a UI choice:
 * one write transfer per Project at a time, refused immediately rather than
 * queued (F8). Firing a folder's files off in parallel would turn a drop into a
 * burst of `409 transfer-in-progress` with one arbitrary winner, so the queue
 * lives here — the one place that knows the whole drop — instead of being
 * discovered a file at a time.
 *
 * A failure stops that file and not the drop: the rest still go, and the one
 * that failed keeps the Core's own message beside it. A drop where the tenth
 * file is unreadable should still land the other nine.
 */
export function useProjectFileUploads(
  coreId: string | null,
  projectId: string,
  onSettled?: () => void,
): ProjectFileUploads {
  const [items, setItems] = useState<UploadItem[]>([]);
  const [busy, setBusy] = useState(false);
  const aborts = useRef(new AbortController());

  // An unmounted view must not leave an upload writing into a Project nobody is
  // watching — the write lease it holds would block the next drop.
  useEffect(() => {
    const controller = aborts.current;
    return () => controller.abort();
  }, []);

  const patch = useCallback((id: string, next: Partial<UploadItem>) => {
    setItems((prev) => prev.map((item) => (item.id === id ? { ...item, ...next } : item)));
  }, []);

  const send = useCallback(
    async (dropped: DroppedFile[], destination = "") => {
      if (!coreId || dropped.length === 0) return;
      const queued: UploadItem[] = dropped.map(({ path, file }) => ({
        id: `up-${(uploadSeq += 1)}`,
        // The folder dropped on, joined to the path the drop gave the file —
        // both Project-relative, neither of them ever absolute (#227).
        path: composeUploadPath(destination, path),
        size: file.size,
        state: "queued",
      }));
      setItems((prev) => [...prev, ...queued]);
      setBusy(true);
      try {
        for (const [index, item] of queued.entries()) {
          patch(item.id, { state: "sending" });
          try {
            const progress = uploadProjectFile({
              coreId,
              projectId,
              path: item.path,
              file: dropped[index]!.file,
              signal: aborts.current.signal,
            });
            // Every line is read, and the `entry` line is what names the
            // overwrite (F5). Draining to `done` also matters for a reason that
            // is not display: an abandoned progress stream leaves the Core's
            // handler parked with this Project's write lease still held.
            for await (const line of progress) {
              if (line.type === "entry") {
                patch(item.id, { state: line.result, size: line.size });
              }
            }
          } catch (err) {
            patch(item.id, {
              state: "failed",
              error:
                err instanceof CoreFilesApiError || err instanceof Error
                  ? err.message
                  : String(err),
            });
          }
        }
      } finally {
        setBusy(false);
        onSettled?.();
      }
    },
    [coreId, projectId, patch, onSettled],
  );

  const sendFromDrop = useCallback(
    async (dataTransfer: DataTransfer, destination = "") => {
      await send(await filesFromDrop(dataTransfer), destination);
    },
    [send],
  );

  return {
    items,
    busy,
    send,
    sendFromDrop,
    clear: useCallback(() => setItems([]), []),
  };
}

export type ProjectFileListing = {
  entries: CoreFileEntry[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
};

/** How many entries one view will render before it stops asking for more. */
const LISTING_CAP = 5_000;

/**
 * One Project's tree, read live off its Core.
 *
 * Capped, and the cap is visible rather than silent: `entries` stops at
 * {@link LISTING_CAP} and the view says so. A Project with a `node_modules` has
 * hundreds of thousands of paths, and a browser asked to render all of them
 * stops being a browser — but a listing that quietly showed the first few
 * thousand as if they were all of them would be worse than one that says where
 * it stopped. Breaking out of the `for await` cancels the read, so the Core
 * stops walking too.
 */
export function useProjectFileListing(
  coreId: string | null,
  projectId: string,
  opts: { path?: string; enabled?: boolean } = {},
): ProjectFileListing & { truncated: boolean } {
  const { path = "", enabled = true } = opts;
  const [entries, setEntries] = useState<CoreFileEntry[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!coreId || !enabled) {
      setEntries([]);
      setError(null);
      return;
    }
    const controller = new AbortController();
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      const collected: CoreFileEntry[] = [];
      let hitCap = false;
      try {
        for await (const entry of listProjectFiles(coreId, projectId, {
          path,
          signal: controller.signal,
        })) {
          collected.push(entry);
          if (collected.length >= LISTING_CAP) {
            hitCap = true;
            break;
          }
        }
        if (cancelled) return;
        setEntries(collected);
        setTruncated(hitCap);
      } catch (err) {
        if (cancelled || controller.signal.aborted) return;
        setEntries([]);
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [coreId, projectId, path, enabled, nonce]);

  return {
    entries,
    truncated,
    loading,
    error,
    refresh: useCallback(() => setNonce((n) => n + 1), []),
  };
}

/**
 * Whether a drag carries files from the operator's desktop.
 *
 * `types` rather than `items` on purpose: during a `dragover` the browser
 * deliberately withholds the contents of a drag, so `items[i].getAsFile()` is
 * null until the drop. `types.includes("Files")` is the one thing that *is*
 * readable, and it is what decides whether to accept the drop at all — a drag of
 * a project path from the Panel's own rail must fall through to the handler that
 * already understands it (`project-path-drag.ts`).
 */
export function dragCarriesFiles(event: { dataTransfer: DataTransfer | null }): boolean {
  return event.dataTransfer?.types.includes("Files") ?? false;
}
