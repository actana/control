import type { ReactNode } from "react";
import { PanelLeft } from "lucide-react";
import type { ShellPlace } from "~/lib/shell-place";

// The compact shell's top bar (M07/M20): menu · place · bell. The menu opens
// the Cores drawer; the place is where the operator is (a Core shows its link
// state as a dot).

export function MobileTopBar({
  place,
  onMenu,
  bell,
}: {
  place: ShellPlace;
  onMenu: () => void;
  bell: ReactNode;
}) {
  return (
    <header role="banner" className="mc-mobile-topbar">
      <button
        type="button"
        className="mc-mobile-topbar-menu"
        aria-label="Open Cores menu"
        onClick={onMenu}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          border: 0,
          background: "transparent",
          color: "var(--text)",
          cursor: "pointer",
        }}
      >
        <PanelLeft size={20} aria-hidden />
      </button>
      <div
        style={{
          minWidth: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
          fontFamily: "var(--mono)",
          fontSize: 14,
          fontWeight: 600,
          color: "var(--text)",
        }}
      >
        {place.coreId ? (
          <i
            data-testid="place-status-dot"
            aria-hidden
            style={{
              flexShrink: 0,
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: place.online ? "var(--status-ready)" : "var(--text-faint)",
            }}
          />
        ) : null}
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{place.label}</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", minWidth: 44 }}>{bell}</div>
    </header>
  );
}
