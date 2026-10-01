import { CoreSharedError, parseSharedPath, type CoreShared, type SharedEntry } from "@actana/sdk/shared";
import { scopeReaches } from "./services/api-keys";
import { getCore } from "./services/cores";
import { SharedChangeFeed, createThroughCoreFactory } from "./task-dispatch/shared-factory";
import type { ApiKeyPrincipal, ToolOutcome } from "./mcp-tools";

/**
 * `list_shared` and `get_shared` (#573): a Core's Shared folder, read-only, for
 * the results a Task's Agent writes there. Reads go through the Core's Files API
 * (the `CoreShared` through-the-Core mode the dispatcher's result watcher also
 * reads with), so the Core, not the Panel, resolves a path against its disk.
 *
 * What stands between a key and a file, in order: the key must reach the Core
 * (403), the Core must be the owner's (404), the path must parse as a path under
 * the Shared folder (the SDK's `parseSharedPath`: no `..`, no `.`, no leading
 * `/`, no backslash, no empty segment, no control character), and the answer
 * is capped. Nothing here writes.
 */

/** A listing past this many entries is cut, and says so. */
export const MAX_LIST_ENTRIES = 500;
/** A file over this many bytes is refused rather than cut, so a model never reasons over half a report. */
export const MAX_FILE_BYTES = 256 * 1024;

export type SharedResolver = (ownerId: number, coreId: string) => Promise<CoreShared>;

const feed = new SharedChangeFeed();
// Reads need no change feed: the through-the-Core mode only uses it for `watch`.
const defaultResolver: SharedResolver = (ownerId, coreId) => createThroughCoreFactory(feed, ownerId)(coreId);

let resolver: SharedResolver = defaultResolver;

/** @internal — a stand-in Core for suites that have no Core to dial; `null` restores the real one. */
export function setSharedResolverForTests(replacement: SharedResolver | null): void {
  resolver = replacement ?? defaultResolver;
}

const refusal = (status: number, message: string): ToolOutcome => ({ ok: false, message: `${status} ${message}` });

const SHARED_STATUS: Partial<Record<CoreSharedError["code"], number>> = {
  "invalid-path": 400,
  "invalid-argument": 400,
  "not-found": 404,
  "is-folder": 400,
  "not-folder": 400,
  forbidden: 403,
  unavailable: 502,
};

function failure(err: unknown): ToolOutcome {
  if (err instanceof CoreSharedError) return refusal(SHARED_STATUS[err.code] ?? 502, err.message);
  console.error(`[mcp] shared read failed: ${err instanceof Error ? err.name : "error"}`);
  // Anything else (no credentials, no link) says nothing the model can act on, and its text can carry a URL.
  return refusal(502, "the Core's Shared folder could not be reached");
}

/** Everything that must hold before a Core is dialed: the key reaches it, the owner has it. */
async function reachable(principal: ApiKeyPrincipal, coreId: string): Promise<ToolOutcome | null> {
  if (!scopeReaches(principal.scope, coreId)) return refusal(403, "this API key does not reach that Core");
  if (!(await getCore(coreId, principal.ownerId))) return refusal(404, "no such Core");
  return null;
}

function entryDto(e: SharedEntry) {
  return {
    path: e.path,
    kind: e.kind,
    ...(e.size === undefined ? {} : { size: e.size }),
    ...(e.modifiedAt === undefined ? {} : { modifiedAt: e.modifiedAt.toISOString() }),
  };
}

export async function listShared(
  principal: ApiKeyPrincipal,
  { coreId, path = "" }: { coreId: string; path?: string },
): Promise<ToolOutcome> {
  const denied = await reachable(principal, coreId);
  if (denied) return denied;
  try {
    const parsed = parseSharedPath(path);
    const folder = parsed.relative === "" ? "" : `${parsed.relative}/`;
    const entries = await (await resolver(principal.ownerId, coreId)).list(folder);
    return {
      ok: true,
      data: {
        path: parsed.relative,
        entries: entries.slice(0, MAX_LIST_ENTRIES).map(entryDto),
        truncated: entries.length > MAX_LIST_ENTRIES,
      },
    };
  } catch (err) {
    return failure(err);
  }
}

export async function getShared(
  principal: ApiKeyPrincipal,
  { coreId, path }: { coreId: string; path: string },
): Promise<ToolOutcome> {
  const denied = await reachable(principal, coreId);
  if (denied) return denied;
  try {
    const parsed = parseSharedPath(path);
    if (parsed.segments.length === 0) throw new CoreSharedError("invalid-path", "the top of the Shared folder is not a file");
    if (parsed.folder) throw new CoreSharedError("is-folder", "that path names a folder (it ends in /), a file is needed");
    const shared = await resolver(principal.ownerId, coreId);
    // The listing decides what may be read, before anything is: a path it does not show is a 404, and a folder
    // named without its trailing slash is refused here, because the Core answers a read of a folder with a tar of
    // everything under it, which the SDK buffers whole before it says `is-folder`. A file's size is checked for the
    // same reason: a huge file is refused without being read into memory.
    const parent = parsed.segments.slice(0, -1).join("/");
    const listed = (await shared.list(parent === "" ? "" : `${parent}/`)).find((e) => e.path === parsed.relative);
    if (!listed) throw new CoreSharedError("not-found", "no such file");
    if (listed.kind === "folder") {
      throw new CoreSharedError("is-folder", "that path is a folder; use list_shared, a file is needed here");
    }
    if (listed.size !== undefined && listed.size > MAX_FILE_BYTES) return tooLarge(listed.size);
    const file = await shared.get(parsed.relative);
    if (file.body.byteLength > MAX_FILE_BYTES) return tooLarge(file.body.byteLength);
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(file.body);
    } catch {
      return refusal(400, "that file is not UTF-8 text");
    }
    return {
      ok: true,
      data: {
        path: parsed.relative,
        size: file.size,
        ...(file.modifiedAt === undefined ? {} : { modifiedAt: file.modifiedAt.toISOString() }),
        content,
      },
    };
  } catch (err) {
    return failure(err);
  }
}

const tooLarge = (size: number): ToolOutcome =>
  refusal(413, `that file is ${size} bytes, over the ${MAX_FILE_BYTES}-byte limit for a read`);
