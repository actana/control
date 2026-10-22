import { formatRelativeTime } from "~/lib/format-relative-time";

type CardRow = { sessionId: string; title: string; agent: string; status: string; updatedAt: number };

const STATUS_LABEL: Record<string, string> = {
  running: "Running",
  "needs-input": "Needs-input",
  done: "Done",
  ready: "Ready",
};

function statusColor(status: string): string {
  if (status === "running") return "var(--accent)";
  if (status === "needs-input") return "var(--warning, #f5a524)";
  if (status === "done") return "var(--text-faint)";
  return "var(--text-dim)";
}

/** Compact (phone and tablet) Session card: the whole card is one button. */
export function CoreSessionCard({ row, onOpen }: { row: CardRow; onOpen: () => void }) {
  return (
    <button type="button" data-session-card className="mc-session-card" onClick={onOpen}>
      <span className="mc-session-card-head">
        <i aria-hidden className="mc-session-card-dot" style={{ background: statusColor(row.status) }} />
        <span>{STATUS_LABEL[row.status] ?? row.status}</span>
        <span className="mc-session-card-agent">{row.agent}</span>
      </span>
      <span className="mc-session-card-title">{row.title}</span>
      <span className="mc-session-card-time">{formatRelativeTime(row.updatedAt)}</span>
    </button>
  );
}
