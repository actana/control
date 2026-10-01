// The Files tab's wire types and the path rules both ends share (#565).
//
// A path is relative to the Core's Shared folder, `/` separated. A path that ends in `/` names a folder, any other
// path a file, and the root is `""` (the SDK's CoreShared rule). The server checks every path again with
// {@link checkSharedPath}: the browser's copy of the rule is a courtesy, never the guard.

export type SharedFileEntry = {
  /** Relative to the Shared folder, no trailing slash, even for a folder. */
  path: string;
  name: string;
  kind: "file" | "folder";
  /** Bytes; a file only. */
  size?: number;
  /** Milliseconds since the epoch; a file only (an object store has none for a folder). */
  modifiedAt?: number;
  /** A folder only: how many children it has. */
  itemCount?: number;
};

export type SharedFilesListing = { path: string; entries: SharedFileEntry[] };

/** What one file's details pane shows. `text` is set for a text-like file, cut to the preview limit. */
export type SharedFileDetails = {
  entry: SharedFileEntry;
  preview: { kind: PreviewKind; text?: string; truncated?: boolean };
};

export type SharedFilesSummary = {
  /** Where the bytes live, for the tree's footer: `SeaweedFS`. */
  backend: string;
  usedBytes: number;
  fileCount: number;
  /** Files written since `since` (the operator's last visit), by path. */
  newPaths: string[];
  /** The largest file an upload takes. */
  uploadLimitBytes: number;
};

export type SharedFilesSearchResult = { query: string; entries: SharedFileEntry[]; truncated: boolean };

export type SharedDownloadUrl = { url: string; expiresAt: number };

export type PreviewKind = "image" | "markdown" | "json" | "log" | "text" | "pdf" | "none";

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif"]);
const MARKDOWN_EXT = new Set(["md", "markdown"]);
const LOG_EXT = new Set(["log"]);
const TEXT_EXT = new Set(["txt", "text", "csv", "tsv", "yml", "yaml", "toml", "ini", "sh", "ts", "tsx", "js", "mjs", "cjs", "py", "rs", "go", "css", "html", "xml", "sql", "env", "conf", "diff", "patch"]);

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** How a file is previewed, from its name alone (the Shared folder keeps no types). SVG is never an image here. */
export function previewKindOf(name: string): PreviewKind {
  const ext = extensionOf(name);
  if (IMAGE_EXT.has(ext)) return "image";
  if (MARKDOWN_EXT.has(ext)) return "markdown";
  if (ext === "json") return "json";
  if (LOG_EXT.has(ext)) return "log";
  if (ext === "pdf") return "pdf";
  if (TEXT_EXT.has(ext)) return "text";
  return "none";
}

export const IMAGE_CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
};

/** The text preview's size, and the largest image or PDF the Panel will stream inline. */
export const PREVIEW_TEXT_BYTES = 64 * 1024;
export const INLINE_MEDIA_MAX_BYTES = 20 * 1024 * 1024;

/**
 * The upload limit until the Storage settings page (#566 part 2) stores one beside the rest of the config: the storage
 * config model of #564 has no such field, and this PR does not change it.
 */
export const DEFAULT_UPLOAD_LIMIT_BYTES = 100 * 1024 * 1024;

export type PathCheck = { ok: true; path: string } | { ok: false; reason: string };

/**
 * The same rule as the SDK's `parseSharedPath`, stated here so the server refuses a path before it is anywhere near S3:
 * no leading `/`, no `.` or `..` segment, no empty segment (`a//b`), no backslash, no control character. A trailing `/`
 * is kept (it says "folder"). `folder` says what the caller needs: a path that must name a folder or a file.
 */
export function checkSharedPath(raw: unknown, want: "file" | "folder" | "either" = "either"): PathCheck {
  if (typeof raw !== "string") return { ok: false, reason: "the path is not text" };
  if (raw.startsWith("/")) return { ok: false, reason: "the path is absolute" };
  if (/[\\\u0000-\u001f\u007f]/.test(raw)) return { ok: false, reason: "the path has a backslash or a control character" };
  if (raw.length > 1024) return { ok: false, reason: "the path is too long" };
  const folder = raw === "" || raw.endsWith("/");
  const body = raw.endsWith("/") ? raw.slice(0, -1) : raw;
  if (body !== "") {
    for (const segment of body.split("/")) {
      if (segment === "") return { ok: false, reason: "the path has an empty segment" };
      if (segment === "." || segment === "..") return { ok: false, reason: "the path has a . or .. segment" };
    }
  }
  if (want === "file" && folder) return { ok: false, reason: "the path names a folder, not a file" };
  if (want === "folder" && !folder) return { ok: false, reason: "the path names a file, not a folder" };
  return { ok: true, path: raw };
}

/** `a/b/c` → `a/b`; a top-level name → `""`. A trailing `/` is ignored. */
export function parentOf(path: string): string {
  const body = path.replace(/\/+$/, "");
  const i = body.lastIndexOf("/");
  return i < 0 ? "" : body.slice(0, i);
}

export function baseName(path: string): string {
  const body = path.replace(/\/+$/, "");
  return body.slice(body.lastIndexOf("/") + 1);
}

export function joinPath(folder: string, name: string): string {
  const base = folder.replace(/\/+$/, "");
  return base ? `${base}/${name}` : name;
}

/** The breadcrumb trail for a folder path: the root, then each ancestor down to the folder. */
export function breadcrumbs(path: string): { label: string; path: string }[] {
  const crumbs = [{ label: "Shared folder", path: "" }];
  let acc = "";
  for (const segment of path.replace(/\/+$/, "").split("/").filter(Boolean)) {
    acc = acc ? `${acc}/${segment}` : segment;
    crumbs.push({ label: segment, path: acc });
  }
  return crumbs;
}

/** What an operator copies: the path as it is on the machine, under `~/shared` (shown as `shared/…` like the design). */
export function displayPath(path: string): string {
  return path ? `shared/${path.replace(/\/+$/, "")}` : "shared";
}

/** A file or folder name an operator typed: one segment, nothing that is a path. */
export function checkEntryName(raw: string): { ok: true; name: string } | { ok: false; reason: string } {
  const name = raw.trim();
  if (!name) return { ok: false, reason: "The name is empty." };
  if (name === "." || name === "..") return { ok: false, reason: "The name cannot be . or .." };
  if (/[/\\\u0000-\u001f\u007f]/.test(name)) return { ok: false, reason: "The name cannot contain / or \\." };
  if (name.length > 255) return { ok: false, reason: "The name is too long." };
  return { ok: true, name };
}

/** `tasks/<id>` is where a Task's files live (the Tasks UI's Open folder). */
export function taskFolderPath(taskId: string): string {
  return `tasks/${taskId}`;
}

/** The Task a path belongs to, if it is under `tasks/<id>/`. */
export function taskIdOfPath(path: string): string | null {
  const m = /^tasks\/([^/]+)(?:\/|$)/.exec(path);
  return m ? m[1]! : null;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || Number.isInteger(value) ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
