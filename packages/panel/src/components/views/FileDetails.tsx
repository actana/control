import { useRouter } from "@tanstack/react-router";
import { toast } from "sonner";
import { Btn } from "~/components/ui/Btn";
import { FormErrorBox } from "~/components/ui/FormErrorBox";
import { api, sharedFileMediaUrl } from "~/lib/api";
import { formatRelativeTime } from "~/lib/format-relative-time";
import { prettyJson } from "~/lib/files-preview-text";
import { useCoreAgents, useSessions, useSharedFileDetails, useTask } from "~/queries";
import { SafeMarkdown } from "~/components/views/SafeMarkdown";
import { displayPath, formatBytes, pullRequestLabel, sessionIdOfPath, syncStateOf, taskIdOfPath } from "~/shared/shared-files";
import type { CoreFileChange, SharedFileEntry } from "~/shared/shared-files";

/** The phone's secondary actions are outlined, as in M25: a ghost button alone does not read as a button there. */
const OUTLINED: React.CSSProperties = { border: "1px solid var(--border-strong)", color: "var(--text)" };

/**
 * The selected file's details (#565): a preview, where it is, how big, when it changed, and the actions. Download asks
 * the Panel for a URL for this one file, good for five minutes, and follows it; nothing here holds a key.
 */
export function FileDetails({
  coreId,
  path,
  isNew,
  coreChange,
  coreLive = false,
  layout = "pane",
  onRename,
  onMove,
  onDelete,
}: {
  coreId: string;
  path: string;
  isNew: boolean;
  /** What the Core's change feed last said about this path (#561): the sync state is read off it. */
  coreChange?: CoreFileChange;
  /** Whether the Core is connected, so "in storage" can say why nothing more is known. */
  coreLive?: boolean;
  /** "pane" beside the folder on desktop; "screen" is the phone's opened file (#833, M25): rows stacked, actions full width. */
  layout?: "pane" | "screen";
  onRename: (entry: SharedFileEntry) => void;
  onMove: (entry: SharedFileEntry) => void;
  onDelete: (entry: SharedFileEntry) => void;
}) {
  const { data, error } = useSharedFileDetails(coreId, path);
  const entry = data?.entry;
  const preview = data?.preview;
  const taskId = taskIdOfPath(path);
  const sessionId = sessionIdOfPath(path);
  // A Core's Sessions and a Task are records the Panel already holds: the path names which one, the record names who.
  const router = useRouter({ warn: false });
  const sessions = useSessions(coreId);
  const session = sessionId ? sessions.data?.find((x) => x.id === sessionId) : undefined;
  const task = useTask(taskId ?? "").data?.task;
  const { data: agents = [] } = useCoreAgents(task?.coreId ?? "");
  const taskAgent = task ? (agents.find((a) => a.id === task.agent)?.name ?? task.agent) : null;

  const download = async () => {
    try {
      const { url } = await api.sharedFileDownloadUrl(coreId, path);
      // The URL is on the storage endpoint, not the Panel's origin: browsers ignore `download` on a cross-origin link and
      // navigate to it, which would replace this tab (and abort uploads in progress). So it opens in a new tab and the
      // store decides whether the browser shows or saves the file; forcing a save needs `response-content-disposition`
      // in the SDK's presign (a later change).
      const a = document.createElement("a");
      a.href = url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };
  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(displayPath(path));
      toast.success("Path copied");
    } catch {
      toast.error("The browser would not copy it.");
    }
  };

  const sync = entry ? syncStateOf(entry, coreChange, coreLive) : null;
  const pullRequests = data?.links.pullRequests ?? [];
  const taskHref = taskId ? `/tasks?task=${encodeURIComponent(taskId)}` : null;
  const linkedTo: React.ReactNode[] = [
    ...pullRequests.map((url) => (
      <a key={url} href={url} target="_blank" rel="noopener noreferrer nofollow">
        PR {pullRequestLabel(url)}
      </a>
    )),
    ...(taskId && taskHref
      ? [
          <a
            key="task"
            href={taskHref}
            onClick={(e) => {
              // A plain click stays in the app; a modified click or a missing router is the browser's own link.
              if (!router || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
              e.preventDefault();
              void router.navigate({ to: "/tasks", search: { task: taskId } as never });
            }}
          >
            Task {task?.title ?? taskId}
          </a>,
        ]
      : []),
  ];
  const writtenBy = session
    ? `Session ${session.id} · ${session.agent}`
    : sessionId
      ? `Session ${sessionId}`
      : task
        ? `Task ${task.id}${taskAgent ? ` · agent ${taskAgent}` : ""}`
        : null;

  const rows: [string, React.ReactNode][] = entry
    ? [
        ["Path", displayPath(path)],
        ["Size", formatBytes(entry.size ?? 0)],
        ["Modified", `${entry.modifiedAt ? formatRelativeTime(entry.modifiedAt) : "unknown"} · ${sync!.label}`],
        ...(writtenBy ? ([["Written by", writtenBy]] as [string, React.ReactNode][]) : []),
        ...(linkedTo.length > 0
          ? ([["Linked to", <span key="links" style={{ display: "inline-flex", flexWrap: "wrap", gap: "2px 10px" }}>{linkedTo}</span>]] as [string, React.ReactNode][])
          : []),
      ]
    : [];

  const screen = layout === "screen";
  return (
    <aside aria-label="File details" style={{ display: "flex", flexDirection: "column", gap: 12, padding: 16, overflowY: screen ? undefined : "auto" }}>
      <h2 style={{ margin: 0, fontFamily: "var(--mono)", fontSize: screen ? 16 : 18, wordBreak: "break-all" }}>
        {entry?.name ?? path.slice(path.lastIndexOf("/") + 1)}
        {isNew ? (
          <span
            style={
              screen
                ? { marginLeft: 8, padding: "2px 6px", borderRadius: 4, fontSize: 12, fontWeight: 400, verticalAlign: "middle", background: "var(--accent-subtle-bg)", border: "1px solid var(--accent-subtle-border)", color: "var(--accent-ink)" }
                : { marginLeft: 8, fontSize: 12, color: "var(--brand-accent)" }
            }
          >
            new
          </span>
        ) : null}
      </h2>
      {error ? <FormErrorBox error={error instanceof Error ? error.message : String(error)} /> : null}
      {preview ? (
        <div style={{ background: screen ? "var(--surface-card)" : "var(--surface-1)", border: "1px solid var(--border)", borderRadius: 8, padding: 12, maxHeight: screen ? "60dvh" : 280, overflow: "auto" }}>
          {preview.kind === "image" ? (
            <img src={sharedFileMediaUrl(coreId, path)} alt={entry?.name ?? ""} style={{ maxWidth: "100%", display: "block" }} />
          ) : preview.kind === "pdf" ? (
            <object data={sharedFileMediaUrl(coreId, path)} type="application/pdf" aria-label="PDF preview" style={{ width: "100%", height: 260 }}>
              PDF preview is not available in this browser: download the file.
            </object>
          ) : preview.text !== undefined && preview.kind === "markdown" ? (
            <>
              <SafeMarkdown>{preview.text}</SafeMarkdown>
              {preview.truncated ? <div style={{ color: "var(--text-dim)", fontSize: 12 }}>… the rest is in the download.</div> : null}
            </>
          ) : preview.text !== undefined ? (
            <pre data-testid="file-preview" style={{ margin: 0, fontFamily: "var(--mono)", fontSize: 12, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
              {preview.truncated ? (preview.kind === "log" ? "… (tail)\n" : "") : ""}
              {preview.kind === "json" ? prettyJson(preview.text, !!preview.truncated) : preview.text}
              {preview.truncated && preview.kind !== "log" ? "\n…" : ""}
            </pre>
          ) : (
            <div style={{ color: "var(--text-dim)", fontSize: 13 }}>{preview.truncated ? "Too large to preview: download it." : "No preview for this kind of file."}</div>
          )}
        </div>
      ) : null}
      {screen ? (
        rows.length > 0 ? (
          <dl style={{ margin: 0, fontSize: 13, background: "var(--surface-1)", border: "1px solid var(--border)", borderRadius: 8 }}>
            {rows.map(([k, v], i) => (
              <div key={k} style={{ display: "flex", flexDirection: "column", gap: 6, padding: "12px 12px", borderTop: i > 0 ? "1px solid var(--border)" : undefined }}>
                <dt style={{ color: "var(--text-dim)", fontFamily: "var(--mono)" }}>{k}</dt>
                <dd style={{ margin: 0, fontFamily: "var(--mono)", wordBreak: "break-all" }}>{v}</dd>
              </div>
            ))}
          </dl>
        ) : null
      ) : (
        <dl style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "6px 14px", margin: 0, fontSize: 13 }}>
          {rows.map(([k, v]) => (
            <div key={k} style={{ display: "contents" }}>
              <dt style={{ color: "var(--text-dim)", fontFamily: "var(--mono)" }}>{k}</dt>
              <dd style={{ margin: 0, fontFamily: "var(--mono)", wordBreak: "break-all" }}>{v}</dd>
            </div>
          ))}
        </dl>
      )}
      {screen ? (
        <div data-testid="file-actions" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <Btn variant="primary" icon="download" disabled={!entry} style={{ width: "100%", justifyContent: "center" }} onClick={() => void download()}>Download</Btn>
          <Btn variant="ghost" icon="copy" style={{ ...OUTLINED, width: "100%", justifyContent: "center" }} onClick={() => void copyPath()}>Copy path</Btn>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8 }}>
            <Btn variant="ghost" icon="pencil" disabled={!entry} style={{ ...OUTLINED, justifyContent: "center" }} onClick={() => entry && onRename(entry)}>Rename</Btn>
            <Btn variant="ghost" icon="arrow-up-right" disabled={!entry} style={{ ...OUTLINED, justifyContent: "center" }} onClick={() => entry && onMove(entry)}>Move</Btn>
            <Btn variant="danger" icon="trash" disabled={!entry} style={{ justifyContent: "center" }} onClick={() => entry && onDelete(entry)}>Delete</Btn>
          </div>
        </div>
      ) : (
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <Btn variant="primary" icon="download" disabled={!entry} onClick={() => void download()}>Download</Btn>
        <Btn variant="ghost" icon="copy" onClick={() => void copyPath()}>Copy path</Btn>
        <Btn variant="ghost" icon="pencil" disabled={!entry} onClick={() => entry && onRename(entry)}>Rename</Btn>
        <Btn variant="ghost" icon="arrow-up-right" disabled={!entry} onClick={() => entry && onMove(entry)}>Move</Btn>
        <Btn variant="danger" icon="trash" disabled={!entry} onClick={() => entry && onDelete(entry)}>Delete</Btn>
      </div>
      )}
    </aside>
  );
}
