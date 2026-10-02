import { useRef, useState } from "react";
import { Btn } from "~/components/ui/Btn";
import { addPicked, type TaskAttachment } from "~/lib/task-attachments";

/**
 * The attach controls of the New Task dialog (files or a whole folder) and of the Task detail composer (a file): the
 * picked list with a remove button each. Nothing is sent from here; the caller sends the list with its request.
 */
export function TaskAttachments({ items, onChange, folder }: { items: readonly TaskAttachment[]; onChange: (next: TaskAttachment[]) => void; folder: boolean }) {
  const files = useRef<HTMLInputElement>(null);
  const dir = useRef<HTMLInputElement>(null);
  const [skipped, setSkipped] = useState<{ name: string; reason: string }[]>([]);
  const take = (input: HTMLInputElement | null) => {
    if (!input?.files) return;
    const picked = addPicked(items, input.files);
    setSkipped(picked.skipped);
    onChange(picked.items);
    input.value = "";
  };
  return (
    <div role="group" aria-label="Attachments" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <Btn variant="ghost" icon="plus" onClick={() => files.current?.click()}>
          Attach file
        </Btn>
        {folder ? (
          <Btn variant="ghost" icon="folder" onClick={() => dir.current?.click()}>
            Attach folder
          </Btn>
        ) : null}
        <input ref={files} type="file" multiple aria-label="Attach files" hidden onChange={() => take(files.current)} />
        {folder ? (
          <input
            ref={(el) => {
              dir.current = el;
              // `webkitdirectory` is not in React's types and must be an attribute, not a prop.
              el?.setAttribute("webkitdirectory", "");
            }}
            type="file"
            aria-label="Attach folder"
            hidden
            onChange={() => take(dir.current)}
          />
        ) : null}
      </div>
      {items.length > 0 ? (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 4, fontFamily: "var(--mono)", fontSize: 12 }}>
          {items.map((a) => (
            <li key={a.path} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
              <span>{a.path}</span>
              <span style={{ color: "var(--text-dim)" }}>
                {formatBytes(a.file.size)}{" "}
                <button type="button" aria-label={`Remove ${a.path}`} className="mc-btn mc-btn-ghost mc-btn-sm" onClick={() => onChange(items.filter((i) => i.path !== a.path))}>
                  ×
                </button>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {skipped.map((s) => (
        <div key={s.name} role="status" style={{ color: "var(--text-dim)", fontSize: 12 }}>
          Left out {s.name}: {s.reason}.
        </div>
      ))}
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
