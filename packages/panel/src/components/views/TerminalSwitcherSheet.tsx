import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { Icon } from "~/components/ui/Icon";

/**
 * The phone terminal switcher (#832, M29): a bottom sheet over the user
 * terminal screen listing this Core's shells (switch / close / new) and its
 * Sessions (tap to open the Session's terminal). Dismissed by a backdrop tap,
 * Escape or the handle; focus is trapped while it is open, as in the Cores
 * drawer. Styles live in styles/mobile-terminal.css.
 */

export type SwitcherShell = { id: string; name: string };
export type SwitcherSession = { sessionId: string; title: string; agent: string; status: string };

// Above the full-screen terminal (9000), below modals (9999).
const SHEET_Z = 9500;

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

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function TerminalSwitcherSheet({
  open,
  onClose,
  shells,
  activeId,
  onSelectShell,
  onCloseShell,
  onNewShell,
  newDisabled,
  sessions,
  onOpenSession,
}: {
  open: boolean;
  onClose: () => void;
  shells: readonly SwitcherShell[];
  activeId: string | null;
  onSelectShell: (id: string) => void;
  onCloseShell: (id: string) => void;
  onNewShell: () => void;
  newDisabled?: boolean;
  sessions: readonly SwitcherSession[];
  onOpenSession: (sessionId: string) => void;
}) {
  const panelRef = useRef<HTMLElement | null>(null);
  const titleId = useId();

  // Focus moves in on open and back to whatever opened the sheet on close.
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.focus();
    return () => opener?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = panel.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && (active === first || active === panel || !panel.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !panel.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const sheet = (
    <div
      className="mc-term-switcher-backdrop"
      data-terminal-switcher-backdrop
      style={{ zIndex: SHEET_Z }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="mc-term-switcher"
        data-terminal-switcher
      >
        <button type="button" className="mc-term-switcher-handle" aria-label="Dismiss" onClick={onClose}>
          <span aria-hidden className="mc-term-switcher-grip" />
        </button>
        <h2 id={titleId} className="mc-term-switcher-title">
          Core Terminals
        </h2>
        <div className="mc-term-switcher-scroll">
          <h3 className="mc-term-switcher-section">Shells</h3>
          <ul className="mc-term-switcher-list">
            {shells.map((s) => (
              <li key={s.id} className="mc-term-switcher-row" data-active={s.id === activeId || undefined}>
                <button
                  type="button"
                  className="mc-term-switcher-main"
                  aria-current={s.id === activeId ? "true" : undefined}
                  onClick={() => onSelectShell(s.id)}
                >
                  <Icon name="terminal" size={16} />
                  <span className="mc-term-switcher-name">{s.name}</span>
                </button>
                <button
                  type="button"
                  className="mc-term-switcher-close"
                  aria-label={`Close ${s.name}`}
                  onClick={() => onCloseShell(s.id)}
                >
                  <Icon name="x" size={16} />
                </button>
              </li>
            ))}
          </ul>
          <button type="button" className="mc-term-switcher-new" disabled={newDisabled} onClick={onNewShell}>
            <Icon name="plus" size={16} />
            New Terminal
          </button>
          <h3 className="mc-term-switcher-section">Sessions</h3>
          <ul className="mc-term-switcher-list">
            {sessions.map((s) => (
              <li key={s.sessionId}>
                <button type="button" className="mc-term-switcher-session" onClick={() => onOpenSession(s.sessionId)}>
                  <i aria-hidden className="mc-term-switcher-dot" style={{ background: statusColor(s.status) }} />
                  <span className="mc-term-switcher-session-text">
                    <span className="mc-term-switcher-session-title">{s.title}</span>
                    <span className="mc-term-switcher-session-sub">
                      {STATUS_LABEL[s.status] ?? s.status} · {s.agent}
                    </span>
                  </span>
                  <Icon name="chevron-right" size={16} />
                </button>
              </li>
            ))}
          </ul>
        </div>
      </section>
    </div>
  );
  return typeof document === "undefined" ? sheet : createPortal(sheet, document.body);
}
