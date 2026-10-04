import { useState } from "react";
import { Icon } from "~/components/ui/Icon";
import { useSharedFolder } from "~/queries";
import { baseName } from "~/shared/shared-files";

/**
 * The Shared folder's folders, recursive to any depth and read lazily: a folder is listed from S3 when it is first
 * opened (#565). Folders only; the files of the open folder are the main area's. Also the picker of the Move dialog.
 */

const ROW: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  width: "100%",
  padding: "5px 8px",
  border: 0,
  background: "transparent",
  color: "var(--text)",
  textAlign: "left",
  fontFamily: "var(--mono)",
  fontSize: 13,
  cursor: "pointer",
  borderRadius: 6,
};

function TreeNode({
  coreId,
  path,
  depth,
  count,
  current,
  onOpen,
  hidden,
  poll,
}: {
  coreId: string;
  path: string;
  depth: number;
  count?: number;
  current: string;
  onOpen: (path: string) => void;
  /** Paths that cannot be chosen, and are not shown: a moved folder and what is inside it. */
  hidden?: readonly string[];
  poll: boolean;
}) {
  const isRoot = path === "";
  // The path to the open folder is open, so the tree always shows where the operator is.
  const onTrail = current === path || current.startsWith(isRoot ? "" : `${path}/`);
  const [open, setOpen] = useState(isRoot || onTrail);
  const expanded = open || onTrail;
  const { data } = useSharedFolder(coreId, path, { enabled: expanded, poll: poll && (isRoot || onTrail) });
  const folders = (data?.entries ?? []).filter((e) => e.kind === "folder" && !(hidden ?? []).some((h) => e.path === h || e.path.startsWith(`${h}/`)));
  const active = current === path;
  return (
    <li role="treeitem" aria-expanded={expanded} aria-selected={active} style={{ listStyle: "none" }}>
      <div style={{ display: "flex", alignItems: "center", paddingLeft: depth * 14 }}>
        <button
          type="button"
          aria-label={expanded ? `Collapse ${path || "Shared folder"}` : `Expand ${path || "Shared folder"}`}
          onClick={() => setOpen(!expanded)}
          style={{ ...ROW, width: 22, padding: 4, justifyContent: "center", color: "var(--text-dim)" }}
        >
          <Icon name={expanded ? "chevron-down" : "chevron-right"} size={12} />
        </button>
        <button
          type="button"
          onClick={() => onOpen(path)}
          style={{ ...ROW, background: active ? "var(--accent-subtle-bg)" : "transparent", fontWeight: active ? 600 : 400 }}
        >
          <Icon name="folder" size={14} />
          <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{isRoot ? "Shared folder" : baseName(path)}</span>
          {count !== undefined ? <span style={{ color: "var(--text-dim)", fontSize: 12 }}>{count}</span> : null}
        </button>
      </div>
      {expanded && folders.length > 0 ? (
        <ul role="group" style={{ margin: 0, padding: 0 }}>
          {folders.map((f) => (
            <TreeNode key={f.path} coreId={coreId} path={f.path} depth={depth + 1} count={f.itemCount} current={current} onOpen={onOpen} hidden={hidden} poll={poll} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function FilesTree({
  coreId,
  current,
  onOpen,
  hidden,
  poll = true,
}: {
  coreId: string;
  current: string;
  onOpen: (path: string) => void;
  hidden?: readonly string[];
  poll?: boolean;
}) {
  const { data } = useSharedFolder(coreId, "", { poll: false });
  return (
    <ul role="tree" aria-label="Folders" style={{ margin: 0, padding: 0 }}>
      <TreeNode coreId={coreId} path="" depth={0} count={data?.entries.length} current={current} onOpen={onOpen} hidden={hidden} poll={poll} />
    </ul>
  );
}
