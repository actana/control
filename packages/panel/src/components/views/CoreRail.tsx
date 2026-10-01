import { memo } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { CircleAlert } from "lucide-react";
import { useFleet } from "~/lib/fleet-context";
import { useBinding } from "~/lib/keybindings/store";
import { formatBinding } from "~/lib/keybindings/format";
import {
  CORE_HOTKEY_LIMIT,
  coreActivity,
  coreHue,
  coreInitials,
  coreLinkLabel,
  railCores,
} from "~/lib/core-rail";
import { getPinnedProjectStatusDots } from "./project-bar-status-dots";

// The left rail: one tile per Core, in label order, ⌘1 to ⌘9 addressing the
// first nine. It replaces the project rail; there is nothing else on it.

const TILE = 44;

function routeCoreId(state: {
  location: { pathname: string; search: unknown };
}): string | null {
  const m = /^\/cores\/([^/]+)/.exec(state.location.pathname);
  if (m) return decodeURIComponent(m[1]!);
  const search = state.location.search as { coreId?: unknown } | undefined;
  return typeof search?.coreId === "string" ? search.coreId : null;
}

export const CoreRail = memo(function CoreRail() {
  const { cores, fleet } = useFleet();
  const activeCoreId = useRouterState({ select: routeCoreId });
  const slotBase = useBinding("project.pinnedSlot");
  const ordered = railCores(cores);

  return (
    <nav
      aria-label="Cores"
      style={{
        width: 64,
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 10,
        padding: "12px 0",
        overflowY: "auto",
      }}
    >
      <div
        style={{
          fontFamily: "var(--mono)",
          fontSize: 10,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: "var(--text-dim)",
        }}
      >
        {ordered.length} {ordered.length === 1 ? "Core" : "Cores"}
      </div>
      {ordered.map((core, index) => {
        const slot = index + 1;
        const hotkey = slot <= CORE_HOTKEY_LIMIT ? slot : null;
        const activity = coreActivity(fleet.rows, core.id);
        const dots = getPinnedProjectStatusDots({
          running: activity.running,
          finished: 0,
        });
        const online = core.dial.state === "connected";
        const active = activeCoreId === core.id;
        const hue = coreHue(core.id);
        const link = coreLinkLabel(core.dial);
        return (
          <Link
            key={core.id}
            to="/cores/$coreId"
            params={{ coreId: core.id }}
            aria-label={`${core.label}, ${link}`}
            aria-current={active ? "page" : undefined}
            data-core-tile={core.id}
            data-core-slot={hotkey ?? undefined}
            title={
              hotkey
                ? `${core.label} · ${link} · ${formatBinding({ ...slotBase, key: String(hotkey) })}`
                : `${core.label} · ${link}`
            }
            style={{
              position: "relative",
              width: TILE,
              height: TILE,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 10,
              textDecoration: "none",
              fontFamily: "var(--mono)",
              fontWeight: 600,
              fontSize: 14,
              color: `hsl(${hue} 80% 70%)`,
              background: `hsl(${hue} 40% 16%)`,
              border: `1.5px solid ${active ? "var(--accent)" : `hsl(${hue} 55% 45%)`}`,
              boxShadow: active ? "0 0 0 2px color-mix(in srgb, var(--accent) 35%, transparent)" : undefined,
              opacity: online ? 1 : 0.55,
            }}
          >
            {coreInitials(core.label)}
            <span
              aria-hidden
              style={{
                position: "absolute",
                left: -9,
                top: 0,
                bottom: 0,
                display: "flex",
                flexDirection: "column",
                justifyContent: "center",
                gap: 3,
              }}
            >
              {dots.length === 0 && !online ? (
                <i data-core-dot="offline" style={dotStyle("var(--text-faint)")} />
              ) : null}
              {dots.map((_, i) => (
                <i key={i} data-core-dot="running" style={dotStyle("var(--status-running)")} />
              ))}
              {activity.needsInput > 0 ? (
                <i data-core-dot="needs-input" style={dotStyle("var(--status-needs-input)")} />
              ) : null}
            </span>
            {activity.needsInput > 0 ? (
              <CircleAlert
                size={12}
                aria-label="Needs input"
                style={{ position: "absolute", top: -4, right: -4, color: "var(--status-needs-input)" }}
              />
            ) : null}
            {hotkey ? (
              <span
                data-core-hotkey={hotkey}
                style={{
                  position: "absolute",
                  right: -5,
                  bottom: -5,
                  minWidth: 14,
                  padding: "0 3px",
                  textAlign: "center",
                  fontSize: 10,
                  borderRadius: 3,
                  background: "var(--surface-1)",
                  color: "var(--text)",
                  border: "1px solid var(--border-strong)",
                }}
              >
                {hotkey}
              </span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
});

function dotStyle(color: string) {
  return { display: "block", width: 6, height: 6, borderRadius: "50%", background: color } as const;
}
