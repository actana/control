import type { CoreFilesFetch } from "@actana/sdk/core";

/**
 * Empty the Shared folder on a Core's machine, `~/shared` in the Core's home (#564, ADR 0041 D12, D38), through the
 * Core's own Files API: the same mTLS fetch and bearer the Task watcher reads results with.
 *
 * **What it touches.** The children of `shared`, nothing else: each one is a `DELETE` of `shared/<name>`, and the
 * folder itself stays. A name is taken from a depth-1 listing of `shared` and refused unless it is one plain segment
 * under `shared/`, so a listing cannot name a path elsewhere in the home.
 *
 * **No symlink is followed.**
 * - The folder itself is looked at first, in a listing of the home: when `shared` is a symlink (or is not a folder)
 *   nothing is deleted, because every path under a link would resolve to wherever it points in the home.
 * - A symlink *inside* the folder is listed as a link and deleted as a link (no trailing `/`): the Core removes the
 *   link and never what it points at.
 *
 * A listing that does not finish, that skipped anything or that names an entry that is not a plain child, a home that is
 * not there, or a delete that is refused, stops the purge and is reported as `kept` with the reason; what was removed stays
 * removed. `emptied` is said only of a listing that was read in full and found nothing left.
 */
export type MachineFolderResult =
  | { state: "emptied"; removed: number }
  | { state: "kept"; reason: string; removed: number };

type ListedEntry = { path: string; kind: string };

const FOLDER = "shared";
/** One listing is a page of the folder's direct children: list again until it is empty. */
const MAX_PASSES = 100;

export type MachineFolderTarget = {
  /** `https://host:port`, no trailing slash. */
  baseUrl: string;
  bearer: string;
  fetch: CoreFilesFetch;
  /** Waits between retries of a delete the Core answered `transfer-in-progress`. A test passes one that does not wait. */
  sleep?: (ms: number) => Promise<void>;
};

/**
 * The Core's Files API runs one write at a time and answers a second with 409 `transfer-in-progress` (`core-files-routes.ts`),
 * and its lease is released just after the answer is sent, so even the next delete of a strictly serial caller can meet it, as can a
 * write of the Core's own sync. The same delete is retried, waiting longer each time, up to this many attempts in all.
 */
export const DELETE_ATTEMPTS = 8;
const RETRY_BASE_MS = 100;
const RETRY_MAX_MS = 2_000;

export async function emptyMachineFolder(target: MachineFolderTarget): Promise<MachineFolderResult> {
  let removed = 0;
  try {
    // A home that cannot be listed (a Core without the Files route answers 404) says nothing about `shared`: kept, never emptied.
    const home = await list(target, "", false);
    const folder = home.entries.find((e) => e.path === FOLDER);
    if (!folder) {
      if (home.skipped > 0) throw new Error("the home could not be read in full, so ~/shared was not found");
      return { state: "emptied", removed };
    }
    if (folder.kind !== "directory") {
      return { state: "kept", reason: `~/${FOLDER} on the machine is a ${folder.kind}, not a folder, so it was left alone`, removed };
    }
    for (let pass = 0; ; pass += 1) {
      const listed = await list(target, FOLDER, true);
      // Anything the listing skipped or named oddly is unknown, not gone: the folder is not reported as emptied.
      if (listed.skipped > 0) throw new Error("part of the folder could not be read");
      const children = listed.entries.filter((e) => e.path !== FOLDER);
      const refused = children.filter((e) => !isChildOfFolder(e));
      if (refused.length > 0) throw new Error(`the listing named an entry that is not a plain child of ~/${FOLDER}`);
      if (children.length === 0) return { state: "emptied", removed };
      if (pass >= MAX_PASSES) throw new Error("the folder is not getting empty");
      for (const child of children) {
        // A folder is deleted with its trailing slash and everything in it; a file or a link without one.
        removed += await remove(target, child.kind === "directory" ? `${child.path}/` : child.path);
      }
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : "unknown error";
    return { state: "kept", reason: `~/${FOLDER} on the machine could not be emptied: ${reason}`, removed };
  }
}

/** `shared/<one segment>`: never the folder itself, a deeper path, or anything with a `.` or `..` segment. */
function isChildOfFolder(entry: ListedEntry): boolean {
  if (!entry.path.startsWith(`${FOLDER}/`)) return false;
  const name = entry.path.slice(FOLDER.length + 1);
  return name !== "" && name !== "." && name !== ".." && !name.includes("/") && !name.includes("\\") && !name.includes("\0");
}

function headers(target: MachineFolderTarget): Record<string, string> {
  return { authorization: `Bearer ${target.bearer}` };
}

async function list(
  target: MachineFolderTarget,
  homePath: string,
  missingOk: boolean,
): Promise<{ entries: ListedEntry[]; skipped: number }> {
  const url = new URL(`${target.baseUrl}/v1/files/list`);
  url.searchParams.set("path", homePath);
  url.searchParams.set("depth", "1");
  const res = await target.fetch({ method: "GET", url: url.toString(), headers: { ...headers(target), accept: "application/x-ndjson" } });
  if (res.status === 404) {
    if (missingOk) return { entries: [], skipped: 0 };
    throw new Error(`${homePath || "the home"} was not found on the Core`);
  }
  if (!res.ok) throw new Error(`listing ${homePath || "the home"} was refused (${res.status})`);
  const entries: ListedEntry[] = [];
  let done = false;
  let skipped = 0;
  for (const raw of (await res.text()).split("\n")) {
    if (raw.trim() === "") continue;
    let line: { type?: unknown; path?: unknown; kind?: unknown; message?: unknown };
    try {
      line = JSON.parse(raw);
    } catch {
      throw new Error(`the listing of ${homePath || "the home"} was not readable`);
    }
    if (line.type === "error") throw new Error(typeof line.message === "string" ? line.message : "the listing failed");
    if (line.type === "done") done = true;
    if (line.type === "skipped") skipped += 1;
    if (line.type === "entry" && typeof line.path === "string" && typeof line.kind === "string") {
      entries.push({ path: line.path, kind: line.kind });
    }
  }
  // A listing that did not end stopped early: what is missing from it is unknown, not gone.
  if (!done) throw new Error(`the listing of ${homePath || "the home"} did not finish`);
  return { entries, skipped };
}

/**
 * One delete, awaited to its answer. 1 when this call removed the entry; 0 for a 404 (someone else already did). A 409
 * `transfer-in-progress` waits and sends the same delete again, up to {@link DELETE_ATTEMPTS}; any other refusal throws.
 */
async function remove(target: MachineFolderTarget, homePath: string): Promise<number> {
  const sleep = target.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const url = new URL(`${target.baseUrl}/v1/files`);
  url.searchParams.set("path", homePath);
  for (let attempt = 1; ; attempt += 1) {
    const res = await target.fetch({ method: "DELETE", url: url.toString(), headers: { ...headers(target), accept: "application/json" } });
    const body = await res.text().catch(() => "");
    if (res.status === 404) return 0;
    if (res.ok) return 1;
    if (res.status === 409 && isTransferInProgress(body) && attempt < DELETE_ATTEMPTS) {
      await sleep(Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_MAX_MS));
      continue;
    }
    throw new Error(`deleting ${homePath} was refused (${res.status}${isTransferInProgress(body) ? ", transfer-in-progress, still after " + attempt + " attempts" : ""})`);
  }
}

function isTransferInProgress(body: string): boolean {
  try {
    return (JSON.parse(body) as { code?: unknown }).code === "transfer-in-progress";
  } catch {
    return false;
  }
}
