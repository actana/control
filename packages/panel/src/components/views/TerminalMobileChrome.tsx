import type { ReactNode } from "react";
import { isTerminalAutoReply } from "~/lib/terminal-user-input";

/**
 * Phone chrome of the Session terminal (#832, screens M21/M22): the header
 * (Back · status dot · title · bell) and the status row (status · harness ·
 * relative time · "…" actions). The pane owns the data and the actions; these
 * are the presentational halves. Styles live in styles/mobile-terminal.css.
 */

/**
 * Sticky Ctrl for the on-screen keyboard: applied to what the user types, never
 * to terminal-generated replies (focus reports, query answers) — those ride the
 * same `onData` stream and must not consume the armed Ctrl.
 */
export function phoneTerminalInput(data: string, consumeCtrl: (data: string) => string): string {
  return isTerminalAutoReply(data) ? data : consumeCtrl(data);
}

export function MobileTerminalHeader({
  title,
  statusColor,
  onBack,
  bell,
}: {
  title: string;
  statusColor: string;
  onBack: () => void;
  bell?: ReactNode;
}) {
  return (
    <div className="mc-term-m-header" data-terminal-mobile-header>
      <button type="button" className="mc-term-m-back" aria-label="Back" onClick={onBack}>
        <span aria-hidden>←</span>
      </button>
      <span className="mc-term-m-dot" aria-hidden style={{ background: statusColor }} />
      <div className="mc-term-m-title" title={title}>
        {title}
      </div>
      {bell ? <div className="mc-term-m-bell">{bell}</div> : null}
    </div>
  );
}

export function MobileTerminalStatusRow({
  statusLabel,
  statusColor,
  harness,
  updated,
  actions,
}: {
  statusLabel: string;
  statusColor: string;
  harness: string;
  updated: string;
  actions: ReactNode;
}) {
  return (
    <div className="mc-term-m-status" data-terminal-mobile-status>
      <span className="mc-term-m-dot" aria-hidden style={{ background: statusColor }} />
      <span className="mc-term-m-status-label" style={{ color: statusColor }}>
        {statusLabel}
      </span>
      <span className="mc-term-m-status-meta">
        · {harness} · {updated}
      </span>
      <span className="mc-term-m-status-actions">{actions}</span>
    </div>
  );
}
