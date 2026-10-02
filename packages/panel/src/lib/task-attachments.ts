import { sourcesFromFileList } from "~/lib/files-upload";
import { checkAttachmentPath } from "~/shared/task-attachments";

// What the New Task dialog and the Task detail composer attach (#568, #571): a picked file or a whole picked folder,
// each with its path relative to what was picked, so a folder keeps its tree under `attachments/`. The server checks
// every path again; the check here only keeps a refused name out of the list with a reason.

export type TaskAttachment = { path: string; file: File };

/** What a pick adds to `current`: new files by path, and what was left out with why (a path the Panel would refuse, or a repeat). */
export function addPicked(current: readonly TaskAttachment[], list: ArrayLike<File>): { items: TaskAttachment[]; skipped: { name: string; reason: string }[] } {
  const items = [...current];
  const skipped: { name: string; reason: string }[] = [];
  const have = new Set(items.map((i) => i.path));
  for (const s of sourcesFromFileList(list)) {
    if (s.kind !== "file") continue;
    const checked = checkAttachmentPath(s.relPath);
    if (!checked.ok) skipped.push({ name: s.relPath, reason: checked.reason });
    else if (have.has(s.relPath)) skipped.push({ name: s.relPath, reason: "it is already attached" });
    else {
      have.add(s.relPath);
      items.push({ path: s.relPath, file: s.file });
    }
  }
  return { items, skipped };
}

/** The multipart body the Task routes take: the JSON body, then the files and, in the same order, each one's path. */
export function attachmentsForm(json: unknown, attachments: readonly TaskAttachment[]): FormData {
  const form = new FormData();
  form.set("json", JSON.stringify(json));
  form.set("paths", JSON.stringify(attachments.map((a) => a.path)));
  for (const a of attachments) form.append("files", a.file, a.file.name);
  return form;
}
