import { useEffect, useRef, useState } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { ChevronRight, Settings } from "lucide-react";
import { api } from "~/lib/api";
import { coreActivity, coreHue, coreInitials, coreLinkLabel, railCores } from "~/lib/core-rail";
import { Z_INDEX } from "~/lib/z-index";
import type { CoreWithDial } from "~/shared/cores";
import type { SettingsPanelId } from "~/components/views/settings-panel-ids";

// The Cores drawer (M08): what the rail is on a desktop, as a left sheet on
// compact screens. Fleet, every Core with its status, Settings, the Operator.

const TILE = 44;
const rowStyle = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  minHeight: 44,
  padding: "8px 12px",
  borderRadius: 10,
  textDecoration: "none",
  color: "var(--text)",
  background: "transparent",
  border: 0,
  width: "100%",
  textAlign: "left",
  cursor: "pointer",
  font: "inherit",
} as const;

export function CoresDrawer({
  open,
  onClose,
  cores,
  fleet,
  activeCoreId,
  onOpenSettings,
}: {
  open: boolean;
  onClose: () => void;
  cores: readonly CoreWithDial[];
  fleet: { rows: readonly { coreId: string; status: string }[] };
  activeCoreId: string | null;
  onOpenSettings: (panel?: SettingsPanelId | null) => void;
}) {
  const panelRef = useRef<HTMLElement | null>(null);
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const [operatorName, setOperatorName] = useState<string | null>(null);
  const fetchedOperator = useRef(false);

  // Focus moves in on open and back to whatever opened the drawer on close.
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.focus();
    return () => opener?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  // Any navigation (a row, a hotkey, the back button) leaves the drawer.
  const openedAt = useRef(pathname);
  useEffect(() => {
    if (open) openedAt.current = pathname;
  }, [open]);
  useEffect(() => {
    if (open && pathname !== openedAt.current) onClose();
  }, [pathname]);

  useEffect(() => {
    if (!open || fetchedOperator.current) return;
    fetchedOperator.current = true;
    api
      .getAuthState()
      .then((state) => setOperatorName(state.operator?.name ?? null))
      .catch(() => {});
  }, [open]);

  if (!open) return null;

  const ordered = railCores(cores);
  const activeCount = fleet.rows.filter((r) => r.status === "running" || r.status === "needs-input").length;

  return (
    <>
      <div
        data-testid="cores-drawer-backdrop"
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: Z_INDEX.settings - 2,
          background: "color-mix(in srgb, var(--bg) 55%, transparent)",
        }}
      />
      <aside
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Cores"
        tabIndex={-1}
        className="mc-cores-drawer"
        style={{
          position: "fixed",
          top: 0,
          bottom: 0,
          left: 0,
          zIndex: Z_INDEX.settings - 1,
          width: "min(320px, 85vw)",
          display: "flex",
          flexDirection: "column",
          background: "var(--surface-1)",
          borderRight: "1px solid var(--border)",
          padding:
            "calc(16px + env(safe-area-inset-top)) 12px calc(12px + env(safe-area-inset-bottom)) calc(12px + env(safe-area-inset-left))",
          overflowY: "auto",
          outline: "none",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "4px 8px 16px",
            fontFamily: "var(--mono)",
            fontSize: 13,
            fontWeight: 700,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
          }}
        >
          <img src="/images/actana-mark.png" alt="" width={22} height={22} style={{ borderRadius: 5 }} />
          <span>Actana</span>
          <span aria-hidden style={{ width: 4, height: 4, borderRadius: "50%", background: "var(--accent)" }} />
          <span style={{ color: "var(--accent-ink)" }}>Control</span>
        </div>

        <Link
          to="/"
          onClick={onClose}
          aria-current={pathname === "/" || pathname === "/fleet" ? "page" : undefined}
          className="mc-cores-drawer-row"
          style={{
            ...rowStyle,
            justifyContent: "space-between",
            fontWeight: 600,
            background: pathname === "/" || pathname === "/fleet" ? "var(--surface-2)" : "transparent",
          }}
        >
          <span>Fleet</span>
          <span style={{ fontFamily: "var(--mono)", fontSize: 12, fontWeight: 400, color: "var(--text-dim)" }}>
            {activeCount} active
          </span>
        </Link>

        <div
          style={{
            padding: "16px 12px 6px",
            fontFamily: "var(--mono)",
            fontSize: 11,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "var(--text-dim)",
          }}
        >
          {ordered.length} {ordered.length === 1 ? "CORE" : "CORES"}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {ordered.map((core) => {
            const activity = coreActivity(fleet.rows, core.id);
            const online = core.dial.state === "connected";
            const active = activeCoreId === core.id;
            const hue = coreHue(core.id);
            return (
              <Link
                key={core.id}
                to="/cores/$coreId"
                params={{ coreId: core.id }}
                onClick={onClose}
                aria-current={active ? "page" : undefined}
                className="mc-cores-drawer-row"
                style={{ ...rowStyle, background: active ? "var(--surface-2)" : "transparent" }}
              >
                <span
                  aria-hidden
                  style={{
                    flexShrink: 0,
                    width: TILE,
                    height: TILE,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    borderRadius: 10,
                    fontFamily: "var(--mono)",
                    fontWeight: 600,
                    fontSize: 14,
                    color: `hsl(${hue} 80% 70%)`,
                    background: `hsl(${hue} 40% 16%)`,
                    border: `1.5px solid ${active ? "var(--accent)" : `hsl(${hue} 55% 45%)`}`,
                    opacity: online ? 1 : 0.55,
                  }}
                >
                  {coreInitials(core.label)}
                </span>
                <span style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                  <span style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {core.label}
                  </span>
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      fontFamily: "var(--mono)",
                      fontSize: 12,
                      color: "var(--text-dim)",
                    }}
                  >
                    <i
                      aria-hidden
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: "50%",
                        background: online ? "var(--status-ready)" : "var(--text-faint)",
                      }}
                    />
                    {coreLinkLabel(core.dial)} · {activity.total} {activity.total === 1 ? "session" : "sessions"}
                  </span>
                  {activity.needsInput > 0 ? (
                    <span
                      style={{
                        alignSelf: "flex-start",
                        padding: "1px 6px",
                        borderRadius: 4,
                        fontFamily: "var(--mono)",
                        fontSize: 11,
                        color: "var(--status-needs)",
                        background: "color-mix(in srgb, var(--status-needs) 18%, transparent)",
                      }}
                    >
                      {activity.needsInput} needs input
                    </span>
                  ) : null}
                </span>
              </Link>
            );
          })}
        </div>

        <div style={{ flex: 1 }} />

        <button
          type="button"
          className="mc-cores-drawer-row"
          style={rowStyle}
          onClick={() => {
            onClose();
            onOpenSettings(null);
          }}
        >
          <Settings size={18} aria-hidden style={{ margin: "0 13px" }} />
          <span style={{ fontWeight: 600 }}>Settings</span>
          <ChevronRight size={16} aria-hidden style={{ marginLeft: "auto", color: "var(--text-faint)" }} />
        </button>
        <button
          type="button"
          className="mc-cores-drawer-row"
          style={rowStyle}
          onClick={() => {
            onClose();
            onOpenSettings("operator");
          }}
        >
          <span
            aria-hidden
            style={{
              width: 30,
              height: 30,
              margin: "0 7px",
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: "50%",
              border: "1px solid var(--border-strong)",
              fontSize: 12,
              color: "var(--text-dim)",
            }}
          >
            {(operatorName ?? "?").slice(0, 1).toUpperCase()}
          </span>
          <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <span style={{ fontWeight: 600 }}>{operatorName ?? "Operator"}</span>
            {operatorName ? (
              <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--text-dim)" }}>Operator</span>
            ) : null}
          </span>
        </button>
      </aside>
    </>
  );
}
