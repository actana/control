import { Link } from "@tanstack/react-router";
import { Icon } from "~/components/ui/Icon";
import { coreHue, coreInitials, corePillParts, railCores } from "~/lib/core-rail";
import type { CoreWithDial } from "~/shared/cores";

export type CoreTab = "sessions" | "files" | "tasks";

export const CORE_TABS: readonly { id: CoreTab; label: string; icon: "terminal" | "folder" | "check" }[] = [
  { id: "sessions", label: "Sessions", icon: "terminal" },
  { id: "files", label: "Files", icon: "folder" },
  { id: "tasks", label: "Tasks", icon: "check" },
];

/**
 * The Core page's header (screen 02): the Core switcher, the one status pill
 * (online or offline, version, Shared folder), the three tabs, and the
 * Terminal drawer's icon. The Terminal is a drawer, not a tab, so it is not in
 * CORE_TABS: the icon only opens and closes the drawer.
 */
export function CoreHeader({
  core,
  cores,
  tab,
  onSwitchCore,
  onTab,
  onToggleTerminal,
  terminalOpen,
}: {
  core: CoreWithDial;
  cores: readonly CoreWithDial[];
  tab: CoreTab;
  onSwitchCore: (coreId: string) => void;
  onTab: (tab: CoreTab) => void;
  onToggleTerminal: () => void;
  terminalOpen: boolean;
}) {
  const pill = corePillParts(core.dial, core.sharedFolder, core.dial.coreVersion);
  const hue = coreHue(core.id);
  const online = core.dial.state === "connected";
  return (
    <header
      style={{
        display: "flex",
        alignItems: "center",
        gap: 14,
        flexWrap: "wrap",
        padding: "10px 16px",
        borderBottom: "1px solid var(--border)",
      }}
    >
      <span
        aria-hidden
        style={{
          width: 32,
          height: 32,
          borderRadius: 8,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "var(--mono)",
          fontSize: 12,
          fontWeight: 600,
          color: `hsl(${hue} 80% 70%)`,
          background: `hsl(${hue} 40% 16%)`,
          border: `1.5px solid hsl(${hue} 55% 45%)`,
        }}
      >
        {coreInitials(core.label)}
      </span>
      <label style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
        <span style={{ position: "absolute", width: 1, height: 1, overflow: "hidden" }}>Switch Core</span>
        <select
          aria-label="Switch Core"
          value={core.id}
          onChange={(e) => onSwitchCore(e.target.value)}
          style={{
            background: "transparent",
            border: 0,
            outline: 0,
            color: "var(--text)",
            fontFamily: "var(--mono)",
            fontSize: 16,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          {railCores(cores).map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
      <span
        data-core-pill
        title={core.dial.detail ?? undefined}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          padding: "3px 12px",
          borderRadius: 999,
          border: "1px solid var(--border-strong)",
          fontFamily: "var(--mono)",
          fontSize: 12,
          color: "var(--text-dim)",
        }}
      >
        <i
          aria-hidden
          style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            background: online ? "var(--status-ready)" : "var(--text-faint)",
          }}
        />
        <span>{pill.link}</span>
        {pill.version ? <span>· {pill.version}</span> : null}
        <span>· {pill.shared}</span>
      </span>
      <nav role="tablist" aria-label="Core sections" style={{ display: "inline-flex", gap: 4 }}>
        {CORE_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => onTab(t.id)}
            className={`mc-btn mc-btn-${tab === t.id ? "frame" : "ghost"} mc-btn-md`}
          >
            <span className="mc-btn-content">
              <Icon name={t.icon} size={13} />
              {t.label}
            </span>
          </button>
        ))}
      </nav>
      <button
        type="button"
        onClick={onToggleTerminal}
        aria-pressed={terminalOpen}
        aria-label="Toggle terminal"
        title="Terminal (ctrl+`)"
        className="mc-btn mc-btn-ghost mc-btn-md"
      >
        <span className="mc-btn-content">
          <Icon name="terminal" size={13} />
        </span>
      </button>
      <Link to="/" style={{ marginLeft: "auto", fontSize: 12, color: "var(--text-dim)" }}>
        Fleet
      </Link>
    </header>
  );
}
