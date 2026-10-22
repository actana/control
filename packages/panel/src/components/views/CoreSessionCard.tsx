import { STATUS_META } from "~/lib/design-meta";
import { formatRelativeTime } from "~/lib/format-relative-time";

type CardRow = { sessionId: string; title: string; agent: string; status: string; updatedAt: number };

/** Compact (phone and tablet) Session card: the whole card is one button. */
export function CoreSessionCard({ row, onOpen }: { row: CardRow; onOpen: () => void }) {
  return (
    <button type="button" data-session-card className="mc-session-card" onClick={onOpen}>
      <span className="mc-session-card-head">
        <i aria-hidden className="mc-session-card-dot" style={{ background: STATUS_META[row.status as keyof typeof STATUS_META]?.color ?? "var(--text-dim)" }} />
        <span>{STATUS_META[row.status as keyof typeof STATUS_META]?.label ?? row.status}</span>
        <span className="mc-session-card-agent">{row.agent}</span>
      </span>
      <span className="mc-session-card-title">{row.title}</span>
      <span className="mc-session-card-time">{formatRelativeTime(row.updatedAt)}</span>
    </button>
  );
}
