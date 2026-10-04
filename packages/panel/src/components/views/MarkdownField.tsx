import { useRef } from "react";

type Edit = { before: string; after: string; fallback: string };

const TOOLS: readonly { label: string; edit: Edit }[] = [
  { label: "B", edit: { before: "**", after: "**", fallback: "bold" } },
  { label: "I", edit: { before: "_", after: "_", fallback: "italic" } },
  { label: "`code`", edit: { before: "`", after: "`", fallback: "code" } },
  { label: "• list", edit: { before: "- ", after: "", fallback: "item" } },
  { label: "☐ checklist", edit: { before: "- [ ] ", after: "", fallback: "item" } },
  { label: "link", edit: { before: "[", after: "](https://)", fallback: "text" } },
];

/**
 * A markdown text area with the design's toolbar (screen 06b). The toolbar only
 * inserts markdown around the selection: what is stored is the text itself.
 * `agents` are the names `@agent` offers, one click inserts `@name`.
 */
export function MarkdownField({
  value,
  onChange,
  ariaLabel,
  placeholder,
  minRows = 8,
  agentNames = [],
  toolbar = true,
  autoFocus = false,
}: {
  value: string;
  onChange: (v: string) => void;
  ariaLabel: string;
  placeholder?: string;
  minRows?: number;
  agentNames?: readonly string[];
  toolbar?: boolean;
  autoFocus?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const apply = ({ before, after, fallback }: Edit) => {
    const el = ref.current;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    const picked = value.slice(start, end) || fallback;
    onChange(value.slice(0, start) + before + picked + after + value.slice(end));
    el?.focus();
  };
  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
      {toolbar ? (
        <div role="toolbar" aria-label="Markdown" style={{ display: "flex", gap: 12, padding: "6px 10px", fontFamily: "var(--mono)", fontSize: 12, borderBottom: "1px solid var(--border)", flexWrap: "wrap" }}>
          {TOOLS.map((t) => (
            <button key={t.label} type="button" className="mc-btn mc-btn-ghost mc-btn-sm" onClick={() => apply(t.edit)}>
              {t.label}
            </button>
          ))}
          <button
            type="button"
            className="mc-btn mc-btn-ghost mc-btn-sm"
            disabled={agentNames.length === 0}
            onClick={() => apply({ before: `@${agentNames[0] ?? "agent"}`, after: "", fallback: "" })}
          >
            @agent
          </button>
        </div>
      ) : null}
      <textarea
        ref={ref}
        autoFocus={autoFocus}
        aria-label={ariaLabel}
        value={value}
        placeholder={placeholder}
        rows={minRows}
        onChange={(e) => onChange(e.target.value)}
        style={{ display: "block", width: "100%", boxSizing: "border-box", resize: "vertical", border: 0, outline: 0, padding: 12, background: "transparent", color: "inherit", font: "inherit", fontFamily: "var(--mono)", fontSize: 13 }}
      />
    </div>
  );
}
