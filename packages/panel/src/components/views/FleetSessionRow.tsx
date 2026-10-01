import { Icon } from "~/components/ui/Icon";
import { formatRelativeTime } from "~/lib/format-relative-time";

export function FleetSessionRow({
  row,
  onOpen,
}: {
  row: { coreId: string; coreLabel: string; sessionId: string; projectId?: string; title: string; agent: string; status: string; updatedAt: number };
  onOpen: () => void;
}) {
  return (
    <button
      onClick={onOpen}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "10px 14px",
        background: "var(--surface-0)",
        border: "1px solid var(--border)",
        borderRadius: 7,
        cursor: "pointer",
        textAlign: "left",
        width: "100%",
      }}
    >
      <StatusBadge status={row.status} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {row.title}
          </span>
        </div>
        <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-dim)", marginTop: 2 }}>
          {row.agent} · {formatRelativeTime(row.updatedAt)}
        </div>
      </div>
      {/* Core label lives on the section heading now — the per-row badge
          would just repeat what's above the group. */}
      <Icon name="chevron-right" size={12} style={{ color: "var(--text-faint)" }} />
    </button>
  );
}

function StatusBadge({ status }: { status: string }) {
  const color =
    status === "running"
      ? "var(--accent)"
      : status === "needs-input"
        ? "var(--warning, #f5a524)"
        : status === "done"
          ? "var(--text-faint)"
          : "var(--text-dim)";
  return (
    <span
      style={{
        width: 8,
        height: 8,
        borderRadius: "50%",
        background: color,
        flexShrink: 0,
        animation: status === "running" ? "pulse-dot 1.5s ease-in-out infinite" : undefined,
      }}
    />
  );
}

