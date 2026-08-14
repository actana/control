// A Project's flat listing, as a tree (#226).
//
// The Core streams a **flat** manifest — one line per path, `src`, `src/a.ts`,
// `src/deep/b.ts` — and it is capped (`LISTING_CAP`), because a Project with a
// `node_modules` has more paths than a browser can render. Rendering that
// manifest as it arrives is what #226 reports: every path visible at once, no
// way to close a folder, and a real Project unusable on arrival.
//
// So the shape is worked out **here, in the client**, from the paths the Core
// already sent. Nothing extra is asked of the Core: no per-folder request, no
// `depth=1` walk on expand, no second round trip when a folder opens. That is
// not laziness, it is the same rule the rest of the file view keeps — the
// filesystem is the model (ADR 0027 F1), one read of it answers the whole
// screen, and a tree assembled from that read cannot disagree with itself the
// way a folder fetched five seconds later can.
//
// ## Implied folders
//
// A node is created for every path segment, whether or not the listing named
// it. Two reasons, and both happen in practice: a listing taken at `depth` may
// name `src/a.ts` without naming `src`, and the cap can cut the manifest
// anywhere at all. A child whose parent is missing must still be reachable, so
// the parent is implied — a folder row with no entry behind it, which is
// exactly what it is: a name the paths agree on, with no `stat` to show.
import type { CoreFileEntry } from "~/lib/core-files";

/** A directory is a directory; everything else is judged by its mode bits. */
export function isDirectoryEntry(entry: CoreFileEntry): boolean {
  if (entry.kind) return entry.kind === "directory";
  // S_IFDIR. A listing that predates the `kind` field still says so in `mode`.
  return (entry.mode & 0o170000) === 0o040000;
}

export type FileTreeNode = {
  /** Project-relative path, spelled as the listing spelled it. */
  path: string;
  /** The last segment — what one row shows. */
  name: string;
  directory: boolean;
  /**
   * The manifest line this node came from, or `null` for an implied folder.
   *
   * Null is not "unknown": it means the listing never named this path, so there
   * is no size, no mtime and no mode to show for it. A row renders the name and
   * stops, rather than printing a zero the Core never said.
   */
  entry: CoreFileEntry | null;
  children: FileTreeNode[];
};

/** One rendered line: a node, how deep it sits, and whether it is open. */
export type FileTreeRow = {
  node: FileTreeNode;
  depth: number;
  /** Only meaningful for a folder; always false for a file. */
  expanded: boolean;
};

/** Folders first, then by name — the order an explorer reads in. */
function byKind(a: FileTreeNode, b: FileTreeNode): number {
  if (a.directory !== b.directory) return a.directory ? -1 : 1;
  return a.name.localeCompare(b.name);
}

/**
 * The listing's paths, as a tree.
 *
 * Order-independent by construction: the manifest may name `src/index.ts`
 * before `src` (it does — the Core walks its own way, and the panel's own
 * fixture is written that way), so a folder that arrives after its children
 * fills in the node the children already made rather than creating a second
 * one. Sorting happens once, at the end, per level.
 */
export function buildFileTree(entries: readonly CoreFileEntry[]): FileTreeNode[] {
  const roots: FileTreeNode[] = [];
  const byPath = new Map<string, FileTreeNode>();

  const nodeAt = (path: string, segments: string[]): FileTreeNode => {
    const existing = byPath.get(path);
    if (existing) return existing;
    const node: FileTreeNode = {
      path,
      name: segments[segments.length - 1]!,
      // Every node that has something below it is a folder — an implied one
      // until the listing says otherwise, which is the only thing its children
      // can prove about it.
      directory: true,
      entry: null,
      children: [],
    };
    byPath.set(path, node);
    if (segments.length === 1) roots.push(node);
    else nodeAt(segments.slice(0, -1).join("/"), segments.slice(0, -1)).children.push(node);
    return node;
  };

  for (const entry of entries) {
    // A leading or trailing slash, or a doubled one, is a spelling of the same
    // path; an empty segment is not a name and never becomes a row.
    const segments = entry.path.split("/").filter((segment) => segment !== "");
    if (segments.length === 0) continue;
    const node = nodeAt(segments.join("/"), segments);
    node.entry = entry;
    node.directory = isDirectoryEntry(entry);
  }

  const sort = (nodes: FileTreeNode[]): void => {
    nodes.sort(byKind);
    for (const node of nodes) sort(node.children);
  };
  sort(roots);
  return roots;
}

/**
 * The rows to render, given what is open.
 *
 * **Collapsed is the default**, and that is why this takes the set of expanded
 * paths rather than a set of collapsed ones: a folder nobody has opened is
 * closed, including one that appeared in a listing taken after the panel was
 * opened. The alternative — remembering what is shut — would quietly open every
 * folder an agent created while the operator was reading.
 *
 * A closed folder's children are not walked at all, so the cost of a row is a
 * row: a Project whose `node_modules` is one collapsed folder renders one line
 * for it, whatever the manifest holds underneath.
 */
export function visibleRows(
  nodes: readonly FileTreeNode[],
  expanded: ReadonlySet<string>,
  depth = 0,
): FileTreeRow[] {
  const rows: FileTreeRow[] = [];
  for (const node of nodes) {
    const open = node.directory && expanded.has(node.path);
    rows.push({ node, depth, expanded: open });
    if (open) rows.push(...visibleRows(node.children, expanded, depth + 1));
  }
  return rows;
}
