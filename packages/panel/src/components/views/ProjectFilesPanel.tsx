// The Project files view — a Project's files as they are on its Core (#129 F6, #169).
//
// It renders exactly what the Core's listing said and nothing it worked out for
// itself: a path, a size, a modification time, from the manifest line the Core
// streamed. There is no index behind this, no cache, and no row the Panel keeps
// — the filesystem is the model (ADR 0027 F1), and the thing an agent wrote
// thirty seconds ago is on the next refresh because the next refresh is a read
// of that disk.
//
// **Absence is a first-class state here.** Against a Core that announces no
// `files` capability the whole panel is one calm sentence rather than a spinner,
// a retry or an error, because such a Core is not broken — it predates the
// surface, which is a supported state (F9, ADR 0024 D11). The caller is expected
// to withhold the button too; this component still answers correctly if it does
// not, which is what "absent, not broken" has to mean when two places know.
//
// **Folders are closed until an operator opens them** (#226). The listing is
// flat and capped, so the shape is assembled client-side (`file-tree.ts`) and
// only what is open is rendered. Which folders are open is state — the only
// state this panel keeps, and deliberately not about the disk: it is about this
// operator's reading of it, it lives as long as the drawer is on screen, and it
// survives every refresh because it is keyed by path rather than by row.
//
// **A folder row is a drop target** (#227). A drop on one writes under that
// folder rather than at the Project root, which is the difference between
// putting a file where it belongs and putting it where it can then never be
// moved from — this view has no move. The row's own path and the dropped
// entry's own path are joined by `composeUploadPath`, both of them relative,
// and the row stops the event so the panel behind it does not take the same
// drop a second time as a write to the root.
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { Btn } from "~/components/ui/Btn";
import { EmptyState } from "~/components/ui/EmptyState";
import { Icon } from "~/components/ui/Icon";
import { Spinner } from "~/components/ui/Spinner";
import { projectFileDownloadUrl, type DroppedFile } from "~/lib/core-files";
import { buildFileTree, visibleRows } from "~/lib/file-tree";
import {
  dragCarriesFiles,
  useProjectFileListing,
  useProjectFileUploads,
  useProjectFilesAvailability,
  type UploadItem,
} from "~/lib/use-project-files";

/** Bytes as an operator reads them. Base 1024, because these are files on a disk. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** How far one level of nesting moves a row, in pixels. */
const INDENT = 12;

function uploadLabel(item: UploadItem): { text: string; color: string } {
  switch (item.state) {
    case "queued":
      return { text: "queued", color: "var(--text-dim)" };
    case "sending":
      return { text: "sending", color: "var(--text-dim)" };
    case "written":
      return { text: "written", color: "var(--ok, #4ade80)" };
    // Named, not inferred (F5). An operator who dropped a file over one that was
    // already there is told so in the same words the Core used.
    case "overwritten":
      return { text: "overwritten", color: "var(--warn, #fbbf24)" };
    case "failed":
      return { text: item.error ?? "failed", color: "var(--danger, #f87171)" };
  }
}

export function ProjectFilesPanel({
  coreId,
  projectId,
  projectName,
  pendingDrop = null,
  onPendingDropTaken,
}: {
  coreId: string | null;
  projectId: string;
  projectName: string;
  /**
   * Files dropped somewhere else on the page — on the project board itself,
   * where an operator drops without opening this panel first.
   *
   * Handed over as already-read `File` handles rather than as the `DataTransfer`
   * they came from, because a `DataTransfer` is only valid inside its own event
   * and this panel may not even be mounted when the drop happens. The `File`
   * objects stay valid, and are still unread — the browser streams them off the
   * disk when `fetch` asks.
   */
  pendingDrop?: DroppedFile[] | null;
  onPendingDropTaken?: () => void;
}) {
  const availability = useProjectFilesAvailability(coreId);
  const listing = useProjectFileListing(coreId, projectId, { enabled: availability.available });
  const uploads = useProjectFileUploads(coreId, projectId, listing.refresh);
  const [dragging, setDragging] = useState(false);
  // The folder row a drag is currently over, if any (#227). One at a time, and
  // it is what decides between the two highlights: a drop is going *into* that
  // folder or into the Project root, never ambiguously both.
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  // Taken exactly once. `send` is recreated on every render of the hook, so
  // depending on it here would re-send the same drop on the next state change —
  // which for an upload means writing the file twice and reporting the second as
  // an overwrite of the first.
  const takenDrop = useRef<DroppedFile[] | null>(null);
  useEffect(() => {
    if (!pendingDrop || pendingDrop.length === 0 || takenDrop.current === pendingDrop) return;
    takenDrop.current = pendingDrop;
    void uploads.send(pendingDrop);
    onPendingDropTaken?.();
  }, [pendingDrop, uploads, onPendingDropTaken]);

  const tree = useMemo(() => buildFileTree(listing.entries), [listing.entries]);
  // Held by path, not by node: `refresh` rebuilds every node in the tree, and a
  // set of nodes would collapse the whole view each time the listing is re-read
  // — including the re-read that follows every upload.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set<string>());
  const rows = useMemo(() => visibleRows(tree, expanded), [tree, expanded]);

  const toggle = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  }, []);

  if (!availability.available) {
    // Every one of these is a sentence, not a failure. The Core is fine; there
    // is simply nothing here to show, and saying which of the reasons applies is
    // what stops an operator debugging their network.
    return (
      <div data-testid="project-files-absent" style={{ padding: 8 }}>
        <EmptyState
          icon="folder"
          title={
            availability.reason === "offline" ? "This Core is not reachable" : "No file view here"
          }
          subtitle={availability.detail}
        />
      </div>
    );
  }

  return (
    <div
      data-testid="project-files-panel"
      // The Project root, which is where a drop lands unless a folder row
      // claimed it first — those stop the event before it reaches here (#227).
      onDragOver={(e) => {
        if (!dragCarriesFiles(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        setDragging(true);
        setDropTarget(null);
      }}
      onDragLeave={() => {
        setDragging(false);
        setDropTarget(null);
      }}
      onDrop={(e) => {
        if (!dragCarriesFiles(e)) return;
        e.preventDefault();
        setDragging(false);
        setDropTarget(null);
        void uploads.sendFromDrop(e.dataTransfer);
      }}
      style={{
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        height: "100%",
        border: dragging ? "1px dashed var(--accent, #60a5fa)" : "1px solid transparent",
        borderRadius: 8,
        background: dragging ? "color-mix(in srgb, var(--accent, #60a5fa) 8%, transparent)" : undefined,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 10px",
          borderBottom: "1px solid var(--border)",
          fontSize: 12,
          color: "var(--text-dim)",
          fontFamily: "var(--mono)",
        }}
      >
        <Icon name="folder" size={13} />
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {projectName}
        </span>
        <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 8 }}>
          {(listing.loading || uploads.busy) && <Spinner size={11} aria-hidden />}
          <Btn variant="ghost" size="sm" icon="refresh" onClick={listing.refresh}>
            Refresh
          </Btn>
        </span>
      </div>

      {uploads.items.length > 0 && (
        <ul
          data-testid="project-files-uploads"
          style={{
            listStyle: "none",
            margin: 0,
            padding: "6px 10px",
            borderBottom: "1px solid var(--border)",
            maxHeight: 160,
            overflowY: "auto",
            fontFamily: "var(--mono)",
            fontSize: 11,
          }}
        >
          {uploads.items.map((item) => {
            const label = uploadLabel(item);
            return (
              <li
                key={item.id}
                style={{ display: "flex", gap: 8, alignItems: "center", padding: "2px 0" }}
              >
                <Icon name="upload" size={11} />
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {item.path}
                </span>
                <span style={{ marginLeft: "auto", color: label.color }}>{label.text}</span>
              </li>
            );
          })}
        </ul>
      )}

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        {listing.error ? (
          <EmptyState icon="folder" title="Could not read this Project's files" subtitle={listing.error} />
        ) : rows.length === 0 && !listing.loading ? (
          <EmptyState
            icon="upload"
            title="Nothing here yet"
            subtitle="Drop a file on this Project to put it on its Core"
          />
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: "4px 0" }}>
            {rows.map(({ node, depth, expanded: open }) => (
              <li
                key={node.path}
                data-testid="project-file-row"
                data-path={node.path}
                {...(node.directory
                  ? {
                      // A folder row is a drop target, and the drop writes
                      // under it (#227). `stopPropagation` is what makes the
                      // target unambiguous: without it the panel behind this
                      // row would take the same drop as a write to the root,
                      // and the operator would get the file in both places.
                      onDragOver: (e: DragEvent<HTMLLIElement>) => {
                        if (!dragCarriesFiles(e)) return;
                        e.preventDefault();
                        e.stopPropagation();
                        e.dataTransfer.dropEffect = "copy";
                        setDragging(false);
                        setDropTarget(node.path);
                      },
                      onDragLeave: (e: DragEvent<HTMLLIElement>) => {
                        e.stopPropagation();
                        setDropTarget((prev) => (prev === node.path ? null : prev));
                      },
                      onDrop: (e: DragEvent<HTMLLIElement>) => {
                        if (!dragCarriesFiles(e)) return;
                        e.preventDefault();
                        e.stopPropagation();
                        setDragging(false);
                        setDropTarget(null);
                        // The folder's own path, exactly as the listing spelled
                        // it. What each dropped file is called under it is the
                        // drop's business, and the two are joined in one place.
                        void uploads.sendFromDrop(e.dataTransfer, node.path);
                      },
                    }
                  : {})}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "3px 10px",
                  paddingLeft: 10 + depth * INDENT,
                  fontFamily: "var(--mono)",
                  fontSize: 12,
                  ...(dropTarget === node.path
                    ? {
                        background: "color-mix(in srgb, var(--accent, #60a5fa) 18%, transparent)",
                        outline: "1px dashed var(--accent, #60a5fa)",
                        borderRadius: 4,
                      }
                    : {}),
                }}
                {...(dropTarget === node.path ? { "data-drop-target": "true" } : {})}
              >
                {node.directory ? (
                  // The whole label is the control, VS Code-style: a chevron
                  // sized for a mouse is a chevron nobody hits, and the row is
                  // the target an operator aims at anyway.
                  <button
                    type="button"
                    onClick={() => toggle(node.path)}
                    aria-expanded={open}
                    title={node.path}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      flex: 1,
                      minWidth: 0,
                      background: "none",
                      border: "none",
                      padding: 0,
                      margin: 0,
                      font: "inherit",
                      color: "inherit",
                      cursor: "pointer",
                      textAlign: "left",
                    }}
                  >
                    <Icon name={open ? "chevron-down" : "chevron-right"} size={12} />
                    <Icon name="folder" size={12} />
                    <span
                      style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                    >
                      {node.name}
                    </span>
                  </button>
                ) : (
                  <>
                    {/* Where a folder's chevron would be, so names line up. */}
                    <span style={{ width: 12, flexShrink: 0 }} aria-hidden />
                    <Icon name="file" size={12} />
                    <span
                      style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                      title={node.path}
                    >
                      {node.name}
                    </span>
                  </>
                )}
                <span style={{ marginLeft: "auto", color: "var(--text-dim)", flexShrink: 0 }}>
                  {/* No entry means an implied folder — a name the paths agree
                    * on, which the listing never described. Nothing to show. */}
                  {node.directory || !node.entry ? "" : formatBytes(node.entry.size)}
                </span>
                {!node.directory && coreId && (
                  <a
                    href={projectFileDownloadUrl(coreId, projectId, node.path)}
                    // The Panel hands back what the Core sent; the browser is
                    // what decides to save it. Nothing is read into the tab.
                    download={node.name}
                    title={`Download ${node.path}`}
                    style={{ color: "var(--text-dim)", display: "inline-flex", flexShrink: 0 }}
                  >
                    <Icon name="download" size={12} />
                  </a>
                )}
              </li>
            ))}
          </ul>
        )}
        {listing.truncated && (
          <div
            style={{
              padding: "6px 10px",
              fontFamily: "var(--mono)",
              fontSize: 11,
              color: "var(--text-dim)",
            }}
          >
            {/* The manifest's count, not the visible rows': with folders closed
              * the two differ by orders of magnitude, and what stopped is the
              * read off the Core, which is what an operator needs told. */}
            Showing the first {listing.entries.length.toLocaleString()} entries — this Project has
            more.
          </div>
        )}
      </div>
    </div>
  );
}
