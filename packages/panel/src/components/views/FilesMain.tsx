import { Icon } from "~/components/ui/Icon";
import { sharedFileMediaUrl } from "~/lib/api";
import { formatRelativeTime } from "~/lib/format-relative-time";
import { useSharedFileDetails } from "~/queries";
import { formatBytes, previewKindOf } from "~/shared/shared-files";
import type { SharedFileEntry } from "~/shared/shared-files";
import type { FilesView } from "~/lib/files-drive-store";

/** A text preview is fetched for a card only when the file is small: a snippet is not worth a megabyte. */
const CARD_TEXT_MAX_BYTES = 256 * 1024;

const NEW_BADGE: React.CSSProperties = { color: "var(--brand-accent)", fontWeight: 600 };

function Snippet({ coreId, entry }: { coreId: string; entry: SharedFileEntry }) {
  const { data } = useSharedFileDetails(coreId, entry.path);
  const text = data?.preview.text;
  return (
    <pre style={{ margin: 0, padding: 10, fontFamily: "var(--mono)", fontSize: 11, lineHeight: 1.4, overflow: "hidden", whiteSpace: "pre-wrap", wordBreak: "break-word", height: "100%" }}>
      {text ? text.split("\n").slice(0, 9).join("\n") : ""}
    </pre>
  );
}

function CardPreview({ coreId, entry }: { coreId: string; entry: SharedFileEntry }) {
  const kind = previewKindOf(entry.name);
  const small = (entry.size ?? 0) <= CARD_TEXT_MAX_BYTES;
  const box: React.CSSProperties = { height: 110, background: "var(--surface-1)", overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)" };
  if (kind === "image" && (entry.size ?? 0) <= 5 * 1024 * 1024) {
    return (
      <div style={box}>
        <img src={sharedFileMediaUrl(coreId, entry.path)} alt="" loading="lazy" style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "cover", width: "100%", height: "100%" }} />
      </div>
    );
  }
  if ((kind === "markdown" || kind === "json" || kind === "log" || kind === "text") && small) {
    return (
      <div style={{ ...box, alignItems: "stretch", justifyContent: "flex-start", display: "block", color: "var(--text)" }}>
        <Snippet coreId={coreId} entry={entry} />
      </div>
    );
  }
  return (
    <div style={box}>
      <Icon name="file" size={38} />
    </div>
  );
}

export function FilesMain({
  coreId,
  view,
  entries,
  selected,
  newPaths,
  onOpenFolder,
  onSelect,
  onNewFolder,
}: {
  coreId: string;
  view: FilesView;
  entries: readonly SharedFileEntry[];
  selected: string | null;
  newPaths: ReadonlySet<string>;
  onOpenFolder: (path: string) => void;
  onSelect: (path: string) => void;
  onNewFolder?: () => void;
}) {
  const folders = entries.filter((e) => e.kind === "folder");
  const files = entries.filter((e) => e.kind === "file");
  const hasNew = (e: SharedFileEntry): boolean =>
    e.kind === "file" ? newPaths.has(e.path) : [...newPaths].some((p) => p.startsWith(`${e.path}/`));
  const label = (t: string) => (
    <h3 style={{ fontFamily: "var(--mono)", fontSize: 12, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--text-dim)", margin: "4px 0 10px" }}>{t}</h3>
  );

  if (view === "list") {
    return (
      <div role="table" aria-label="Files" style={{ display: "flex", flexDirection: "column" }}>
        {entries.map((e) => (
          <button
            key={e.path}
            type="button"
            role="row"
            aria-selected={selected === e.path}
            onClick={() => (e.kind === "folder" ? onOpenFolder(e.path) : onSelect(e.path))}
            style={{ display: "grid", gridTemplateColumns: "24px 1fr 90px 130px", gap: 10, alignItems: "center", padding: "8px 10px", border: 0, borderBottom: "1px solid var(--border)", background: selected === e.path ? "var(--accent-subtle-bg)" : "transparent", color: "var(--text)", textAlign: "left", fontFamily: "var(--mono)", fontSize: 13, cursor: "pointer" }}
          >
            <Icon name={e.kind === "folder" ? "folder" : "file"} />
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {e.name} {hasNew(e) ? <span style={NEW_BADGE}>· new</span> : null}
            </span>
            <span style={{ color: "var(--text-dim)" }}>{e.kind === "folder" ? (e.itemCount === undefined ? "" : `${e.itemCount} ${e.itemCount === 1 ? "item" : "items"}`) : formatBytes(e.size ?? 0)}</span>
            <span style={{ color: "var(--text-dim)" }}>{e.modifiedAt ? formatRelativeTime(e.modifiedAt) : ""}</span>
          </button>
        ))}
        {entries.length === 0 ? <div style={{ color: "var(--text-dim)", padding: 16 }}>This folder is empty.</div> : null}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <section aria-label="Folders">
        {label("Folders")}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))", gap: 12 }}>
          {folders.map((f) => (
            <button
              key={f.path}
              type="button"
              onClick={() => onOpenFolder(f.path)}
              style={{ display: "flex", alignItems: "center", gap: 10, padding: 14, border: "1px solid var(--border)", borderRadius: 8, background: "var(--surface-card)", color: "var(--text)", textAlign: "left", cursor: "pointer", fontFamily: "var(--mono)" }}
            >
              <Icon name="folder" size={18} />
              <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                <strong style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.name}</strong>
                <span style={{ fontSize: 12, color: "var(--text-dim)" }}>
                  {f.itemCount !== undefined ? `${f.itemCount} ${f.itemCount === 1 ? "item" : "items"}` : ""}
                  {hasNew(f) ? <span style={NEW_BADGE}> · new</span> : null}
                </span>
              </span>
            </button>
          ))}
          {onNewFolder ? (
            <button type="button" onClick={onNewFolder} style={{ display: "flex", alignItems: "center", gap: 10, padding: 14, border: "1px dashed var(--border)", borderRadius: 8, background: "transparent", color: "var(--text-dim)", cursor: "pointer", fontFamily: "var(--mono)" }}>
              <Icon name="folder" size={18} /> New folder
            </button>
          ) : null}
        </div>
      </section>
      {files.length > 0 ? (
        <section aria-label="Files">
          {label("Files")}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))", gap: 12 }}>
            {files.map((f) => (
              <button
                key={f.path}
                type="button"
                aria-pressed={selected === f.path}
                onClick={() => onSelect(f.path)}
                style={{ display: "flex", flexDirection: "column", padding: 0, overflow: "hidden", border: selected === f.path ? "2px solid var(--brand-accent)" : "1px solid var(--border)", borderRadius: 8, background: "var(--surface-card)", color: "var(--text)", textAlign: "left", cursor: "pointer", fontFamily: "var(--mono)" }}
              >
                <CardPreview coreId={coreId} entry={f} />
                <span style={{ display: "flex", flexDirection: "column", padding: "8px 10px", minWidth: 0 }}>
                  <strong style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 13 }}>{f.name}</strong>
                  <span style={{ fontSize: 12, color: "var(--text-dim)" }}>
                    {formatBytes(f.size ?? 0)} · {f.modifiedAt ? formatRelativeTime(f.modifiedAt) : ""}
                    {hasNew(f) ? <span style={NEW_BADGE}> · new</span> : null}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </section>
      ) : null}
      <p style={{ color: "var(--text-dim)", fontFamily: "var(--mono)", fontSize: 12, margin: 0 }}>
        Drop files or folders anywhere here — folders upload with everything inside them.
      </p>
    </div>
  );
}
