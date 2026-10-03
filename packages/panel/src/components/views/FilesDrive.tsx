import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Banner } from "~/components/ui/Banner";
import { Btn } from "~/components/ui/Btn";
import { ConfirmDialog } from "~/components/ui/ConfirmDialog";
import { EmptyState } from "~/components/ui/EmptyState";
import { Icon } from "~/components/ui/Icon";
import { FileDetails } from "~/components/views/FileDetails";
import { MoveDialog, NameDialog } from "~/components/views/FilesDialogs";
import { FilesMain } from "~/components/views/FilesMain";
import { FilesTree } from "~/components/views/FilesTree";
import { api } from "~/lib/api";
import { filesDrive, useFilesDrive, type UploadItem } from "~/lib/files-drive-store";
import { readLastVisit, writeLastVisit } from "~/lib/files-last-visit";
import { useSharedFeed } from "~/lib/shared-feed";
import { planUploads, runUploads, sourcesFromDrop, sourcesFromFileList, type UploadSource } from "~/lib/files-upload";
import { formatRelativeTime } from "~/lib/format-relative-time";
import { queryKeys, useSharedFilesSearch, useSharedFilesSummary, useSharedFolder } from "~/queries";
import type { CoreWithDial } from "~/shared/cores";
import { baseName, breadcrumbs, displayPath, formatBytes, joinPath, parentOf } from "~/shared/shared-files";

type Dialog =
  | { kind: "newFolder" }
  | { kind: "newText" }
  | { kind: "rename"; path: string }
  | { kind: "move"; path: string }
  | { kind: "delete"; path: string };

const isFolderPath = (p: string): boolean => p.endsWith("/");

/**
 * A Core's Files tab (#565): its Shared folder as a Drive. Everything here reads and writes S3 through the Panel's
 * `/shared/files` routes, never the Core, so it works while the Core is offline (the banner says so) and a file put in
 * here reaches the Core through the Core's own sync. The open folder is `path`, owned by the route's search string, so
 * the tree, the breadcrumbs, the grid and a link from a Task all share one path.
 */
export function FilesDrive({ core, path, onPath }: { core: CoreWithDial; path: string; onPath: (path: string) => void }) {
  // Where this Core's folder stands is decided before any of the hooks below read S3: no folder, nothing is asked.
  if (!core.sharedFolder || core.sharedFolder.state === "pending") {
    return (
      <EmptyState
        title="No Shared folder yet"
        subtitle={
          core.sharedFolder
            ? "This Core's pairing is not finished: attach its Shared folder from the pairing, then come back."
            : "This Core was paired before the Shared folder existed. Pair it again from a Panel with storage set up."
        }
        icon="folder"
      />
    );
  }
  return <FilesDriveOfCore core={core} sharedFolder={core.sharedFolder} path={path} onPath={onPath} />;
}

function FilesDriveOfCore({
  core,
  sharedFolder,
  path,
  onPath,
}: {
  core: CoreWithDial;
  sharedFolder: NonNullable<CoreWithDial["sharedFolder"]>;
  path: string;
  onPath: (path: string) => void;
}) {
  const coreId = core.id;
  const queryClient = useQueryClient();
  const view = useFilesDrive((s) => s.view);
  const selected = useFilesDrive((s) => s.selected);
  const uploads = useFilesDrive((s) => s.uploads);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [menu, setMenu] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [search, setSearch] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  // The badges are the files written since the operator was last here; the visit is stamped when they leave.
  const since = useMemo(() => readLastVisit(coreId), [coreId]);
  useEffect(() => {
    const stamp = () => writeLastVisit(coreId);
    window.addEventListener("pagehide", stamp);
    return () => {
      window.removeEventListener("pagehide", stamp);
      stamp();
    };
  }, [coreId]);

  useEffect(() => {
    filesDrive.select(null);
  }, [coreId, path]);

  // The Core's change feed (#561) refreshes the folder and marks what is new; S3 is listed on a timer only while the Core
  // is offline, when the feed has nothing to say.
  const offline = core.dial.state !== "connected";
  const feed = useSharedFeed(coreId, since);
  const folder = useSharedFolder(coreId, path, { poll: offline });
  const summary = useSharedFilesSummary(coreId, since, { poll: offline });
  const searching = search.trim().length > 0;
  const results = useSharedFilesSearch(coreId, search.trim());
  // Files written while no tab was open come from the one listing at load; everything since comes from the feed, which
  // also knows what the Core has deleted since that listing.
  const newPaths = useMemo(() => {
    const out = new Set<string>();
    for (const p of summary.data?.newPaths ?? []) if (feed.changes.get(p)?.deleted !== true) out.add(p);
    for (const p of feed.newPaths) out.add(p);
    return out;
  }, [summary.data, feed]);
  const entries = searching ? (results.data?.entries ?? []) : (folder.data?.entries ?? []);

  const refresh = useCallback(() => queryClient.invalidateQueries({ queryKey: queryKeys.sharedFiles(coreId) }), [queryClient, coreId]);
  const fail = (e: unknown) => toast.error(e instanceof Error ? e.message : String(e));

  const upload = useCallback(
    async (sources: readonly UploadSource[], destination = path) => {
      if (sources.length === 0) return;
      const plan = planUploads(destination, sources);
      const limit = summary.data?.uploadLimitBytes;
      const tooBig = limit ? plan.files.filter((f) => f.file.size > limit) : [];
      const files = plan.files.filter((f) => !tooBig.includes(f));
      for (const f of tooBig) plan.skipped.push({ name: f.path, reason: `larger than the upload limit of ${formatBytes(limit!)}` });
      await runUploads(coreId, { ...plan, files }, { onSettled: () => void refresh() });
      void refresh();
    },
    [coreId, path, refresh, summary.data?.uploadLimitBytes],
  );

  // ─── Dialog actions ──────────────────────────────────────────────────────
  const afterMove = async (from: string, to: string) => {
    await refresh();
    if (selected === from) filesDrive.select(to);
    const f = from.replace(/\/+$/, "");
    if (path === f || path.startsWith(`${f}/`)) onPath(to + path.slice(f.length));
  };
  const rename = async (target: string, name: string) => {
    const { path: to } = await api.renameSharedFile(coreId, target, name);
    await afterMove(target, to);
  };
  const move = async (target: string, toFolder: string) => {
    const { path: to } = await api.moveSharedFile(coreId, target, toFolder);
    await afterMove(target, to);
  };
  const remove = async (target: string) => {
    try {
      await api.deleteSharedFile(coreId, target);
      const f = target.replace(/\/+$/, "");
      if (selected === target) filesDrive.select(null);
      if (path === f || path.startsWith(`${f}/`)) onPath(parentOf(f));
      await refresh();
      setDialog(null);
    } catch (e) {
      fail(e);
      setDialog(null);
    }
  };

  const crumbs = breadcrumbs(path);
  const selectedIsNew = selected ? newPaths.has(selected) : false;
  const finished = uploads.some((u) => u.status === "done" || u.status === "error");

  return (
    <div
      aria-label="Shared folder"
      onDragOver={(e) => {
        if (!Array.from(e.dataTransfer.types).includes("Files")) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={(e) => {
        if (!Array.from(e.dataTransfer.types).includes("Files")) return;
        e.preventDefault();
        setDragging(false);
        void sourcesFromDrop(e.dataTransfer).then((sources) => upload(sources)).catch(fail);
      }}
      style={{ position: "relative", display: "flex", flexDirection: "column", gap: 10, minHeight: 0, flex: 1 }}
    >
      {offline ? (
        <Banner variant="warning">
          This Core is offline{core.dial.lastSeenAt ? ` (last seen ${formatRelativeTime(core.dial.lastSeenAt)})` : ""}. The Shared folder is read from storage
          directly, so you can keep working here; what you change reaches the Core when it is back.
        </Banner>
      ) : null}
      {sharedFolder.error ? <Banner variant="danger">The Core's key could not be renewed: {sharedFolder.error}</Banner> : null}

      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <div style={{ position: "relative" }} onClick={(e) => e.stopPropagation()}>
          <Btn variant="primary" icon="plus" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}>New</Btn>
          {menu ? (
            <div
              role="menu"
              style={{ position: "absolute", top: "100%", left: 0, marginTop: 4, zIndex: 50, minWidth: 190, padding: 6, background: "var(--surface-card)", border: "1px solid var(--border)", borderRadius: 8, display: "flex", flexDirection: "column" }}
            >
              {(
                [
                  ["New folder", "folder", () => setDialog({ kind: "newFolder" })],
                  ["Upload files", "upload", () => fileInput.current?.click()],
                  ["Upload folder", "upload", () => folderInput.current?.click()],
                  ["New text file", "file", () => setDialog({ kind: "newText" })],
                ] as const
              ).map(([label, icon, run]) => (
                <button
                  key={label}
                  role="menuitem"
                  type="button"
                  className="mc-btn mc-btn-ghost mc-btn-md"
                  style={{ justifyContent: "flex-start" }}
                  onClick={() => {
                    setMenu(false);
                    run();
                  }}
                >
                  <span className="mc-btn-content"><Icon name={icon} size={13} /> {label}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <nav aria-label="Breadcrumbs" style={{ display: "flex", alignItems: "center", gap: 6, fontFamily: "var(--mono)", fontSize: 13, flex: 1, minWidth: 0 }}>
          {crumbs.map((c, i) => (
            <span key={c.path} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              {i > 0 ? <Icon name="chevron-right" size={11} /> : null}
              {i === crumbs.length - 1 ? (
                <strong aria-current="page">{c.label}</strong>
              ) : (
                <button type="button" className="mc-btn mc-btn-ghost mc-btn-sm" onClick={() => { setSearch(""); onPath(c.path); }}>{c.label}</button>
              )}
            </span>
          ))}
          {path ? (
            <span style={{ marginLeft: 8, display: "inline-flex", gap: 2 }}>
              <Btn size="sm" variant="ghost" icon="pencil" aria-label="Rename this folder" onClick={() => setDialog({ kind: "rename", path: `${path}/` })} />
              <Btn size="sm" variant="ghost" icon="arrow-up-right" aria-label="Move this folder" onClick={() => setDialog({ kind: "move", path: `${path}/` })} />
              <Btn size="sm" variant="ghost" icon="trash" aria-label="Delete this folder" onClick={() => setDialog({ kind: "delete", path: `${path}/` })} />
            </span>
          ) : null}
        </nav>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6, border: "1px solid var(--border)", borderRadius: 8, padding: "4px 10px", fontFamily: "var(--mono)", fontSize: 13 }}>
          <Icon name="search" size={13} />
          <input
            type="search"
            aria-label="Search in Shared folder"
            placeholder="Search in Shared folder"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ background: "transparent", border: 0, outline: 0, color: "var(--text)", fontFamily: "inherit", width: 190 }}
          />
        </label>
        <Btn variant={view === "grid" ? "frame" : "ghost"} icon="grid" aria-pressed={view === "grid"} onClick={() => filesDrive.setView("grid")}>Grid</Btn>
        <Btn variant={view === "list" ? "frame" : "ghost"} icon="list" aria-pressed={view === "list"} onClick={() => filesDrive.setView("list")}>List</Btn>
      </div>

      <input ref={fileInput} type="file" multiple hidden aria-label="Upload files" onChange={(e) => { void upload(sourcesFromFileList(e.target.files ?? [])); e.target.value = ""; }} />
      <input
        ref={(el) => {
          folderInput.current = el;
          el?.setAttribute("webkitdirectory", "");
        }}
        type="file"
        multiple
        hidden
        aria-label="Upload folder"
        onChange={(e) => { void upload(sourcesFromFileList(e.target.files ?? [])); e.target.value = ""; }}
      />

      <div style={{ display: "grid", gridTemplateColumns: `260px minmax(0, 1fr)${selected ? " 340px" : ""}`, gap: 12, flex: 1, minHeight: 0 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 10, overflowY: "auto", borderRight: "1px solid var(--border)", paddingRight: 8 }}>
          <FilesTree coreId={coreId} current={path} poll={offline} onOpen={(p) => { setSearch(""); onPath(p); }} />
          {summary.data ? (
            <div style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--text-dim)", marginTop: "auto" }}>
              {formatBytes(summary.data.usedBytes)} used · {summary.data.backend}
            </div>
          ) : null}
        </div>
        <div style={{ overflowY: "auto", minWidth: 0 }}>
          {folder.error && !searching ? (
            <EmptyState title="The Shared folder could not be read" subtitle={folder.error instanceof Error ? folder.error.message : String(folder.error)} icon="folder" />
          ) : folder.isPending && !searching ? (
            <div style={{ color: "var(--text-dim)", padding: 16 }}>Loading…</div>
          ) : searching ? (
            <FilesMain
              coreId={coreId}
              view="list"
              entries={entries}
              selected={selected}
              newPaths={newPaths}
              onOpenFolder={(p) => { setSearch(""); onPath(p); }}
              onSelect={(p) => { setSearch(""); onPath(parentOf(p)); filesDrive.select(p); }}
            />
          ) : (
            <FilesMain
              coreId={coreId}
              view={view}
              entries={entries}
              selected={selected}
              newPaths={newPaths}
              onOpenFolder={onPath}
              onSelect={(p) => filesDrive.select(p)}
              onNewFolder={() => setDialog({ kind: "newFolder" })}
            />
          )}
        </div>
        {selected ? (
          <div style={{ borderLeft: "1px solid var(--border)", minHeight: 0, overflowY: "auto" }}>
            <FileDetails
              coreId={coreId}
              path={selected}
              isNew={selectedIsNew}
              coreChange={feed.changes.get(selected)}
              coreLive={!offline}
              onRename={() => setDialog({ kind: "rename", path: selected })}
              onMove={() => setDialog({ kind: "move", path: selected })}
              onDelete={() => setDialog({ kind: "delete", path: selected })}
            />
          </div>
        ) : null}
      </div>

      {dragging ? (
        <div aria-hidden style={{ position: "absolute", inset: 0, border: "2px dashed var(--brand-accent)", borderRadius: 10, background: "rgba(56,189,248,0.08)", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "var(--mono)", pointerEvents: "none" }}>
          Drop to upload into {displayPath(path)}
        </div>
      ) : null}

      {uploads.length > 0 ? (
        <section aria-label="Uploads" style={{ position: "absolute", right: 8, bottom: 8, width: 340, maxHeight: 260, overflowY: "auto", background: "var(--surface-card)", border: "1px solid var(--border)", borderRadius: 8, padding: 10, display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontFamily: "var(--mono)", fontSize: 12 }}>
            <strong>Uploads</strong>
            {finished ? <button type="button" className="mc-btn mc-btn-ghost mc-btn-sm" onClick={() => filesDrive.clearFinishedUploads()}>Clear</button> : null}
          </div>
          {uploads.map((u) => <UploadRow key={u.id} item={u} />)}
        </section>
      ) : null}

      <NameDialog
        open={dialog?.kind === "newFolder"}
        title="New folder"
        label="Folder name"
        initial=""
        confirmLabel="Create"
        onClose={() => setDialog(null)}
        onSubmit={async (name) => {
          await api.makeSharedFolder(coreId, `${joinPath(path, name)}/`);
          await refresh();
        }}
      />
      <NameDialog
        open={dialog?.kind === "newText"}
        title="New text file"
        label="File name"
        initial="untitled.txt"
        confirmLabel="Create"
        onClose={() => setDialog(null)}
        onSubmit={async (name) => {
          await upload([{ kind: "file", file: new File([""], name, { type: "text/plain" }), relPath: name }]);
        }}
      />
      <NameDialog
        open={dialog?.kind === "rename"}
        title={dialog?.kind === "rename" && isFolderPath(dialog.path) ? "Rename folder" : "Rename file"}
        label="New name"
        initial={dialog?.kind === "rename" ? baseName(dialog.path) : ""}
        confirmLabel="Rename"
        onClose={() => setDialog(null)}
        onSubmit={(name) => (dialog?.kind === "rename" ? rename(dialog.path, name) : Promise.resolve())}
      />
      <MoveDialog
        open={dialog?.kind === "move"}
        coreId={coreId}
        path={dialog?.kind === "move" ? dialog.path : ""}
        isFolder={dialog?.kind === "move" && isFolderPath(dialog.path)}
        onClose={() => setDialog(null)}
        onMove={(to) => (dialog?.kind === "move" ? move(dialog.path, to) : Promise.resolve())}
      />
      <ConfirmDialog
        open={dialog?.kind === "delete"}
        title={dialog?.kind === "delete" && isFolderPath(dialog.path) ? "Delete this folder?" : "Delete this file?"}
        confirmLabel="Delete"
        variant="danger"
        icon="trash"
        onClose={() => setDialog(null)}
        onConfirm={() => (dialog?.kind === "delete" ? remove(dialog.path) : undefined)}
      >
        {dialog?.kind === "delete" ? (
          <p style={{ margin: 0 }}>
            <code>{displayPath(dialog.path)}</code>
            {isFolderPath(dialog.path) ? " and everything in it" : ""} will be deleted from the Shared folder, and from the Core at its next sync. This cannot be undone.
          </p>
        ) : null}
      </ConfirmDialog>
    </div>
  );
}

function UploadRow({ item }: { item: UploadItem }) {
  const pct = item.size > 0 ? Math.min(100, Math.round((item.loaded / item.size) * 100)) : item.status === "done" ? 100 : 0;
  return (
    <div style={{ fontFamily: "var(--mono)", fontSize: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.path}</span>
        <span style={{ color: item.status === "error" ? "var(--danger, #ef4444)" : "var(--text-dim)" }}>
          {item.status === "done" ? "done" : item.status === "error" ? "failed" : item.status === "queued" ? "queued" : `${pct}%`}
        </span>
      </div>
      <progress aria-label={`Upload ${item.path}`} value={pct} max={100} style={{ width: "100%", height: 6 }} />
      {item.error ? <div style={{ color: "var(--danger, #ef4444)" }}>{item.error}</div> : null}
    </div>
  );
}
