import { sharedFileUploadUrl, api } from "~/lib/api";
import { filesDrive } from "~/lib/files-drive-store";
import { checkSharedPath, joinPath } from "~/shared/shared-files";

// Uploads for the Files tab (#565): what a pick or a drop becomes, and how each file is sent.
//
// A folder keeps its tree because every file travels with its path relative to the folder that was picked or dropped
// (`brand/src/a.ts`), joined to where it is going; the server makes the folders in between. A folder with nothing in it
// has no file to carry its name, so it is made with its own call.

export type UploadSource = { kind: "file"; file: File; relPath: string } | { kind: "folder"; relPath: string };

export type UploadPlan = {
  files: { path: string; file: File }[];
  /** Folders to make: the empty ones a drop carried. A folder with files in it comes into being with them. */
  folders: string[];
  /** What was left out, with why: a path the Panel would refuse anyway. */
  skipped: { name: string; reason: string }[];
};

/** The sources of a file picker: `webkitRelativePath` is set when a folder was picked (`<input webkitdirectory>`). */
export function sourcesFromFileList(list: ArrayLike<File>): UploadSource[] {
  return Array.from(list).map((file) => ({
    kind: "file" as const,
    file,
    relPath: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
  }));
}

type FsEntry = {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  fullPath: string;
  file?: (ok: (f: File) => void, err: (e: unknown) => void) => void;
  createReader?: () => { readEntries: (ok: (e: FsEntry[]) => void, err: (e: unknown) => void) => void };
};

/** One directory's entries; a reader hands them over in batches until it returns none. */
async function readAll(dir: FsEntry): Promise<FsEntry[]> {
  const reader = dir.createReader!();
  const out: FsEntry[] = [];
  for (;;) {
    const batch = await new Promise<FsEntry[]>((ok, err) => reader.readEntries(ok, err));
    if (batch.length === 0) return out;
    out.push(...batch);
  }
}

async function walk(entry: FsEntry, base: string, into: UploadSource[]): Promise<void> {
  const relPath = base ? `${base}/${entry.name}` : entry.name;
  if (entry.isFile) {
    const file = await new Promise<File>((ok, err) => entry.file!(ok, err));
    into.push({ kind: "file", file, relPath });
    return;
  }
  if (!entry.isDirectory) return;
  const children = await readAll(entry);
  if (children.length === 0) into.push({ kind: "folder", relPath });
  for (const child of children) await walk(child, relPath, into);
}

/** The sources of a drop: files and whole folders, walked with their empty folders. Must be called inside the drop event. */
export async function sourcesFromDrop(dt: DataTransfer): Promise<UploadSource[]> {
  // The entries are only readable during the event: take them all before the first await.
  const entries = Array.from(dt.items ?? [])
    .filter((i) => i.kind === "file")
    .map((i) => ({ entry: (i as DataTransferItem & { webkitGetAsEntry?: () => FsEntry | null }).webkitGetAsEntry?.() ?? null, file: i.getAsFile() }));
  const out: UploadSource[] = [];
  for (const { entry, file } of entries) {
    if (entry) await walk(entry, "", out);
    else if (file) out.push({ kind: "file", file, relPath: file.name });
  }
  if (entries.length === 0) out.push(...sourcesFromFileList(dt.files));
  return out;
}

/** Where each source goes under `destination` (a folder path, `""` for the root), and what cannot go. */
export function planUploads(destination: string, sources: readonly UploadSource[]): UploadPlan {
  const plan: UploadPlan = { files: [], folders: [], skipped: [] };
  const seen = new Set<string>();
  for (const s of sources) {
    const path = joinPath(destination, s.relPath);
    const checked = checkSharedPath(s.kind === "folder" ? `${path}/` : path, s.kind === "folder" ? "folder" : "file");
    if (!checked.ok) {
      plan.skipped.push({ name: s.relPath, reason: checked.reason });
      continue;
    }
    if (seen.has(path)) continue;
    seen.add(path);
    if (s.kind === "folder") plan.folders.push(path);
    else plan.files.push({ path, file: s.file });
  }
  return plan;
}

/** Send one file with progress. `XMLHttpRequest`, because `fetch` cannot report how much of a body has gone. */
export function uploadFile(
  coreId: string,
  path: string,
  file: File,
  onProgress: (loaded: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", sharedFileUploadUrl(coreId, path));
    xhr.withCredentials = true;
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onerror = () => reject(new Error("The upload could not reach the Panel."));
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      let message = `The upload failed (${xhr.status}).`;
      try {
        const body = JSON.parse(xhr.responseText) as { error?: string };
        if (body.error) message = body.error;
      } catch {
        // not JSON: the status says it
      }
      reject(new Error(message));
    };
    xhr.send(file);
  });
}

const CONCURRENCY = 3;

/**
 * Upload a plan, three files at a time, each with its own progress row. A file that fails is marked and the rest go on.
 * Resolves when all have settled, with whether every one was sent.
 */
export async function runUploads(
  coreId: string,
  plan: UploadPlan,
  opts: { send?: typeof uploadFile; onSettled?: () => void } = {},
): Promise<boolean> {
  const send = opts.send ?? uploadFile;
  const ids = filesDrive.addUploads(plan.files.map((f) => ({ coreId, path: f.path, size: f.file.size })));
  let ok = true;
  for (const s of plan.skipped) {
    const [id] = filesDrive.addUploads([{ coreId, path: s.name, size: 0 }]);
    filesDrive.updateUpload(id!, { status: "error", error: `Not uploaded: ${s.reason}` });
    ok = false;
  }
  for (const folder of plan.folders) {
    try {
      await api.makeSharedFolder(coreId, `${folder}/`);
    } catch {
      ok = false;
    }
  }
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      const item = plan.files[i];
      if (!item) return;
      const id = ids[i]!;
      filesDrive.updateUpload(id, { status: "uploading" });
      try {
        await send(coreId, item.path, item.file, (loaded) => filesDrive.updateUpload(id, { loaded }));
        filesDrive.updateUpload(id, { status: "done", loaded: item.file.size });
      } catch (e) {
        ok = false;
        filesDrive.updateUpload(id, { status: "error", error: e instanceof Error ? e.message : String(e) });
      }
      opts.onSettled?.();
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, plan.files.length) }, worker));
  opts.onSettled?.();
  return ok;
}
