import type React from "react";
import { useState } from "react";
import type { Session } from "~/db/schema";
import { Btn } from "~/components/ui/Btn";
import { SessionCard } from "./SessionCard";

// Cap the number of cards a single column mounts at once. No virtualization
// library is a dependency, so this cheap window keeps the DOM (and layout cost)
// bounded on pathologically large columns; a "Show all" control reveals the
// rest. Columns under the cap are unaffected.
const WINDOW_SIZE = 200;

export function SessionColumn({
  title,
  color,
  sessions,
  activeId,
  onToggle,
  onArchive,
  onRestore,
  onDelete,
  onTogglePinned,
  pinningSessionIds,
  headerAction,
}: {
  title: string;
  color: string;
  sessions: Session[];
  activeId: string | null;
  onToggle: (id: string) => void;
  onArchive?: (id: string) => void;
  onRestore?: (id: string) => void;
  onDelete?: (id: string) => void;
  onTogglePinned?: (id: string) => Promise<void> | void;
  pinningSessionIds?: ReadonlySet<string>;
  headerAction?: React.ReactNode;
}) {
  const [showAll, setShowAll] = useState(false);
  if (sessions.length === 0) return null;

  // Always keep the selected session mounted even if it sorts past the window,
  // so windowing never hides the card the user is currently focused on. When
  // the active card sorts past the window we append just that one card rather
  // than unwindowing the whole column, keeping the mounted count bounded at
  // WINDOW_SIZE + 1.
  const windowedSessions = sessions.slice(0, WINDOW_SIZE);
  const activeIndex =
    activeId != null ? sessions.findIndex((t) => t.id === activeId) : -1;
  const activeBeyondWindow = activeIndex >= WINDOW_SIZE;
  const visibleSessions = showAll
    ? sessions
    : activeBeyondWindow
      ? [...windowedSessions, sessions[activeIndex]]
      : windowedSessions;

  const hiddenCount = sessions.length - visibleSessions.length;
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 18 }}>
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            background: color,
            boxShadow: `0 0 6px ${color}66`,
          }}
        />
        <span
          style={{
            fontFamily: "var(--mono)",
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "var(--text)",
          }}
        >
          {title}
        </span>
        <span
          style={{
            fontFamily: "var(--mono)",
            fontSize: 11,
            color: "var(--text-faint)",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {sessions.length}
        </span>
        {headerAction && <div style={{ marginLeft: "auto" }}>{headerAction}</div>}
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(360px, 1fr))",
          gap: 12,
        }}
      >
        {visibleSessions.map((t) => (
          <SessionCard
            key={t.id}
            session={t}
            selected={activeId === t.id}
            onToggle={onToggle}
            onArchive={onArchive}
            onRestore={onRestore}
            onDelete={onDelete}
            onTogglePinned={onTogglePinned}
            pinning={pinningSessionIds?.has(t.id) ?? false}
          />
        ))}
      </div>
      {hiddenCount > 0 && (
        <div style={{ marginTop: 12 }}>
          <Btn variant="ghost" onClick={() => setShowAll(true)}>
            Show all {sessions.length}
          </Btn>
        </div>
      )}
    </div>
  );
}
