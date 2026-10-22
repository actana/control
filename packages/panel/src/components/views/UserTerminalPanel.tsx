import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "@tanstack/react-router";
import { Btn } from "~/components/ui/Btn";
import { CardFrame } from "~/components/ui/CardFrame";
import { EmptyState } from "~/components/ui/EmptyState";
import { Icon } from "~/components/ui/Icon";
import { HotkeyTooltip } from "~/components/ui/Tooltip";
import { useResizablePanel } from "~/lib/use-resizable-panel";
import { useUserTerminals } from "~/lib/user-terminal-store";
import { ConfirmDialog } from "~/components/ui/ConfirmDialog";
import { useIsCompact } from "~/lib/breakpoint";
import { useFleet } from "~/lib/fleet-context";
import { useVisualViewport } from "~/lib/use-visual-viewport";
import { requestSessionOpen } from "~/lib/session-notification-store";
import { terminalSurfaceCache, type PaneTerminalSurface } from "~/lib/terminal-surface-cache";
import { UserTerminalPane } from "./UserTerminalPane";
import { MobileTerminalHeader, phoneTerminalInput } from "./TerminalMobileChrome";
import { TerminalKeyRow, useStickyCtrl } from "./TerminalKeyRow";
import { TerminalSwitcherSheet } from "./TerminalSwitcherSheet";

// Above the compact top bar and tab bar (z 20), below the switcher sheet (9500)
// and modals (9999).
const PHONE_SCREEN_Z = 9000;
const MIN_HEIGHT = 160;
const MIN_PANE_WIDTH = 200;
const PANE_WEIGHTS_STORAGE_KEY = "mc:userTerminalPaneWeights";
/** Viewport chrome above the maximised drawer (top bar + Core header). */
const MAXIMISED_VIEWPORT_CHROME_PX = 120;

type PaneWeights = Record<string, number>;

function readStoredWeights(): PaneWeights {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(PANE_WEIGHTS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const out: PaneWeights = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v) && v > 0) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * The terminal panel, and the one control that fills it (issue 266).
 *
 * There used to be two: a `+ New` in the toolbar and a `New terminal` in the
 * empty state, both opening a shell confined to one folder, plus a third
 * `New VM shell` beside the second. Two of those three answered a question
 * nobody asks — *you are in a Core, so a terminal means a shell in that Core;
 * there is nothing else it could sensibly mean.* So each location keeps exactly
 * one button, it is called **New Terminal**, and it opens a VM Shell Session.
 *
 * That does not make a VM shell automatic. CONTEXT.md requires an explicit open
 * gesture and forbids auto-spawning; a button click is that gesture, and making
 * it the only button does not change which gesture it is. The warm pool that
 * *did* pre-spawn a PTY on navigation went with the removed path and is
 * deliberately not reintroduced under a new name.
 *
 * The shell opens on the Core the current route is on (see `setCore` in the store);
 * without one there is no machine to open a shell on and the control is disabled.
 */
export function UserTerminalPanel() {
  const {
    coreId,
    panelOpen,
    setPanelOpen,
    panelMaximized,
    setPanelMaximized,
    sessions,
    focusedId,
    focusTerminal,
    createVmShellTerminal,
    killTerminal,
    hiddenIds,
    toggleHidden,
    renameTerminal,
    setPtyId,
  } = useUserTerminals();

  const compact = useIsCompact();
  // The panel shows a Core's terminals; `active` is true whenever a Core is in scope.
  const active = !!coreId;

  const visibleSessions = sessions.filter((s) => !hiddenIds.has(s.terminal.id));

  const { size: storedHeight, onMouseDown: onResizeMouseDown } = useResizablePanel({
    storageKey: "mc:userTerminalsPanelHeight",
    axis: "y",
    defaultSize: 320,
    minSize: MIN_HEIGHT,
    maxSize: (vh) => vh - 160,
  });
  // Maximise fills the viewport minus the Core header chrome (issue 560); the
  // stored height returns when maximise is cleared, so resize still sticks.
  const height: number | string = panelMaximized
    ? `calc(100vh - ${MAXIMISED_VIEWPORT_CHROME_PX}px)`
    : storedHeight;

  const paneRowRef = useRef<HTMLDivElement | null>(null);
  const [paneWeights, setPaneWeights] = useState<PaneWeights>(() => readStoredWeights());

  useEffect(() => {
    try {
      window.localStorage.setItem(
        PANE_WEIGHTS_STORAGE_KEY,
        JSON.stringify(paneWeights),
      );
    } catch {
      // ignore quota / privacy-mode errors
    }
  }, [paneWeights]);

  const onTerminalTabClick = useCallback(
    (id: string, hidden: boolean) => {
      if (!panelOpen) {
        if (hidden) toggleHidden(id);
        focusTerminal(id);
        setPanelOpen(true);
        return;
      }

      if (hidden) {
        toggleHidden(id);
        focusTerminal(id);
      } else {
        toggleHidden(id);
      }
    },
    [focusTerminal, panelOpen, setPanelOpen, toggleHidden],
  );

  const onSplitterDrag = useCallback(
    (leftId: string, rightId: string, event: React.MouseEvent) => {
      event.preventDefault();
      const row = paneRowRef.current;
      if (!row) return;
      const containerWidth = row.getBoundingClientRect().width;
      if (containerWidth <= 0) return;

      const startX = event.clientX;
      // Snapshot weights so the math is stable across the drag.
      const startLeft = paneWeights[leftId] ?? 1;
      const startRight = paneWeights[rightId] ?? 1;
      const pairSum = startLeft + startRight;

      // Read the two panes' actual pixel widths at drag start so the math
      // works whether or not the user has resized this pair before.
      const leftEl = row.querySelector<HTMLElement>(`[data-pane-id="${CSS.escape(leftId)}"]`);
      const rightEl = row.querySelector<HTMLElement>(`[data-pane-id="${CSS.escape(rightId)}"]`);
      if (!leftEl || !rightEl) return;
      const startLeftWidth = leftEl.getBoundingClientRect().width;
      const startRightWidth = rightEl.getBoundingClientRect().width;
      const pairWidth = startLeftWidth + startRightWidth;
      if (pairWidth <= 0) return;

      const onMove = (ev: MouseEvent) => {
        const dx = ev.clientX - startX;
        const maxLeft = pairWidth - MIN_PANE_WIDTH;
        const nextLeftWidth = Math.max(
          MIN_PANE_WIDTH,
          Math.min(maxLeft, startLeftWidth + dx),
        );
        const nextRightWidth = pairWidth - nextLeftWidth;
        const nextLeftWeight = (nextLeftWidth / pairWidth) * pairSum;
        const nextRightWeight = (nextRightWidth / pairWidth) * pairSum;
        setPaneWeights((prev) => ({
          ...prev,
          [leftId]: nextLeftWeight,
          [rightId]: nextRightWeight,
        }));
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [paneWeights],
  );

  if (!active) return null;

  // Phone and tablet (#832, M28/M29): the open panel is a full-screen view of
  // one shell at a time; closed, it is not on screen at all (the Sessions
  // toolbar and the Core header toggle it).
  if (compact) return panelOpen ? <UserTerminalPhoneScreen /> : null;

  // The collapsible body is always mounted so the panel can slide open AND
  // closed; `panelOpen` just drives the grid-rows transition (see the
  // `.mc-userterm-body` CSS). The inner content keeps its concrete height so
  // the terminals' flex layout still has something to fill.
  return (
    <CardFrame
      data-user-terminal-panel
      style={{
        width: "100%",
        // Height is driven by the header plus the animated body wrapper rather
        // than pinned here, so opening/closing eases instead of snapping.
        height: "auto",
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        flexShrink: 0,
        overflow: "visible",
      }}
    >
      {panelOpen && !panelMaximized && (
        <div
          onMouseDown={onResizeMouseDown}
          title="Drag to resize"
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: -13,
            height: 16,
            cursor: "row-resize",
            zIndex: 10,
          }}
        />
      )}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          padding: "8px 14px",
          flexShrink: 0,
          width: "100%",
          color: "inherit",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            flex: "1 1 auto",
            minWidth: 0,
          }}
        >
          <Icon name="terminal" size={13} style={{ color: "var(--accent-ink)" }} />
          <span
            style={{
              fontFamily: "var(--mono)",
              fontSize: 11.5,
              fontWeight: 600,
              letterSpacing: "0.02em",
              flex: "0 0 auto",
            }}
          >
            Core Terminals
          </span>
          {sessions.length > 0 && (
            <span
              style={{
                width: 1,
                height: 14,
                background: "var(--border)",
                marginLeft: 4,
                flex: "0 0 auto",
              }}
            />
          )}
          {sessions.length > 0 && (
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 4,
                marginLeft: 8,
                alignItems: "center",
                flex: "1 1 auto",
                minWidth: 0,
              }}
            >
              {sessions.map((s) => {
                const hidden = hiddenIds.has(s.terminal.id);
                const focused = focusedId === s.terminal.id;
                const active = panelOpen ? !hidden && focused : focused;
                const dimmed = panelOpen && hidden;
                return (
                  <button
                    key={s.terminal.id}
                    onClick={() => onTerminalTabClick(s.terminal.id, hidden)}
                    title={
                      panelOpen
                        ? hidden
                          ? "Show terminal"
                          : "Hide terminal"
                        : "Open terminal"
                    }
                    aria-label={
                      panelOpen
                        ? hidden
                          ? `Show terminal ${s.terminal.name}`
                          : `Hide terminal ${s.terminal.name}`
                        : `Open terminal ${s.terminal.name}`
                    }
                    aria-pressed={panelOpen ? !hidden : undefined}
                    className="mc-terminal-tab"
                    data-active={active || undefined}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      padding: "3px 9px",
                      fontFamily: "var(--mono)",
                      fontSize: 11,
                      color: dimmed ? "var(--text-faint)" : "var(--text)",
                      opacity: dimmed ? 0.6 : 1,
                      cursor: "pointer",
                      maxWidth: 154,
                      minWidth: 0,
                    }}
                  >
                    <Icon name="terminal" size={10} style={{ color: "var(--text-faint)" }} />
                    <span
                      style={{
                        maxWidth: 120,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {s.terminal.name}
                    </span>
                    {s.ptyId && (
                      <span
                        style={{
                          width: 6,
                          height: 6,
                          borderRadius: "50%",
                          background: "var(--accent)",
                        }}
                      />
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center", flex: "0 0 auto" }}>
          <HotkeyTooltip action="terminal.newTab" label="New Terminal">
            <Btn
              variant="ghost"
              size="sm"
              icon="plus"
              disabled={!active || !coreId}
              onClick={() => {
                if (active && coreId) void createVmShellTerminal(coreId);
              }}
            >
              New Terminal
            </Btn>
          </HotkeyTooltip>
          <Btn
            variant="ghost"
            size="sm"
            icon={panelMaximized ? "minimize" : "maximize"}
            aria-label="Maximise terminal"
            aria-pressed={panelMaximized}
            onClick={() => setPanelMaximized(!panelMaximized)}
          >
            maximise
          </Btn>
          <HotkeyTooltip
            action="terminal.toggle"
            label={panelOpen ? "Collapse panel" : "Expand panel"}
          >
            <Btn
              variant="ghost"
              size="sm"
              icon={panelOpen ? "chevron-down" : "chevron-up"}
              aria-label={panelOpen ? "Collapse panel" : "Expand panel"}
              onClick={() => setPanelOpen(!panelOpen)}
            />
          </HotkeyTooltip>
        </div>
      </div>
      <div className="mc-userterm-body" data-open={panelOpen ? "true" : undefined}>
        <div className="mc-userterm-body-inner">
          <div
            style={{
              height,
              display: "flex",
              flexDirection: "column",
              minHeight: 0,
              overflow: "hidden",
            }}
          >
            <div
              ref={paneRowRef}
              style={{
                flex: 1,
                display: "flex",
                flexDirection: "row",
                overflow: "hidden",
                // gap removed when we have splitters between panes — the splitter
                // provides its own visual spacing/hit area.
                gap: visibleSessions.length > 1 ? 0 : 8,
                padding: 8,
              }}
            >
              {visibleSessions.length === 0 ? (
          <div
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--text-dim)",
              fontFamily: "var(--mono)",
              fontSize: 12,
            }}
          >
            {active ? (
              <EmptyState
                icon="terminal"
                title={sessions.length === 0 ? "No terminals yet" : "All terminals hidden"}
                subtitle={
                  sessions.length === 0
                    ? "Open a shell on this Core's machine."
                    : "Click a tab above to bring a terminal back into view."
                }
                action={
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <HotkeyTooltip action="terminal.newTab" label="New Terminal">
                      <Btn
                        variant="ghost"
                        size="sm"
                        icon="plus"
                        disabled={!coreId}
                        onClick={() => {
                          if (coreId) void createVmShellTerminal(coreId);
                        }}
                      >
                        New Terminal
                      </Btn>
                    </HotkeyTooltip>
                  </div>
                }
              />
            ) : (
              "Open a Core to use terminals."
            )}
          </div>
        ) : (
          visibleSessions.map((s, i) => {
            const onlyVisible = visibleSessions.length === 1;
            const weight = paneWeights[s.terminal.id] ?? 1;
            const prev = visibleSessions[i - 1];
            // A session's own Core wins: a restored one carries the Core its
            // identity recorded (issue 394), and a freshly opened one the Core
            // it was opened on.
            const sessionCoreId = s.coreId;
            return (
              <Fragment key={s.terminal.id}>
                {prev && (
                  <PaneSplitter
                    onMouseDown={(e) => onSplitterDrag(prev.terminal.id, s.terminal.id, e)}
                  />
                )}
                <div
                  data-pane-id={s.terminal.id}
                  style={{
                    flex: onlyVisible ? "1 1 100%" : `${weight} 1 0`,
                    width: onlyVisible ? "100%" : undefined,
                    minWidth: MIN_PANE_WIDTH,
                    display: "flex",
                    flexDirection: "column",
                    minHeight: 0,
                    overflow: "hidden",
                  }}
                >
                  <UserTerminalPane
                    terminal={s.terminal}
                    ptyId={s.ptyId}
                    coreId={sessionCoreId}
                    focused={focusedId === s.terminal.id}
                    onFocus={() => focusTerminal(s.terminal.id)}
                    onPtyReady={(ptyId) => setPtyId(s.terminal.id, ptyId, sessionCoreId)}
                    onPtyExit={() => setPtyId(s.terminal.id, null)}
                    onHide={() => toggleHidden(s.terminal.id)}
                    onDelete={() => void killTerminal(s.terminal.id)}
                    onRename={(name) => void renameTerminal(s.terminal.id, name)}
                    isLast={i === visibleSessions.length - 1}
                  />
                </div>
              </Fragment>
            );
          })
        )}
            </div>
          </div>
        </div>
      </div>
    </CardFrame>
  );
}

function PaneSplitter({
  onMouseDown,
}: {
  onMouseDown: (e: React.MouseEvent) => void;
}) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      title="Drag to resize"
      onMouseDown={onMouseDown}
      style={{
        flex: "0 0 8px",
        alignSelf: "stretch",
        cursor: "col-resize",
        position: "relative",
        background: "transparent",
      }}
    >
      <div
        aria-hidden
        style={{
          position: "absolute",
          left: "50%",
          top: 0,
          bottom: 0,
          width: 1,
          background: "var(--border)",
          transform: "translateX(-0.5px)",
        }}
      />
    </div>
  );
}

const PHONE_STATUS_COLOR: Record<string, string> = {
  connected: "var(--status-running, #2db47d)",
  connecting: "var(--warning, #f5a524)",
};

/**
 * The phone user terminal screen (M28): Back · Core status + name, a scrolling
 * tab strip (one tab per shell, "+", and the switcher button), the active shell
 * filling the rest and the key row docked at the bottom. Portalled out of the
 * shell and sized to the visual viewport, like the Session terminal.
 */
function UserTerminalPhoneScreen() {
  const {
    coreId,
    setPanelOpen,
    sessions,
    focusedId,
    focusTerminal,
    createVmShellTerminal,
    killTerminal,
    renameTerminal,
    setPtyId,
  } = useUserTerminals();
  const router = useRouter();
  const { cores, fleet } = useFleet();
  const { height: viewportHeight, offsetTop: viewportTop } = useVisualViewport();
  const stickyCtrl = useStickyCtrl();
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [closing, setClosing] = useState<{ id: string; name: string } | null>(null);

  const core = cores.find((c) => c.id === coreId);
  const active = sessions.find((s) => s.terminal.id === focusedId) ?? sessions[0] ?? null;
  const activeId = active?.terminal.id ?? null;
  const coreRows = fleet.rows.filter((r) => r.coreId === coreId);

  const stripRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    // Keep the active tab in view when the strip scrolls.
    const tab = stripRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    tab?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [activeId]);

  const newTerminal = () => {
    if (coreId) void createVmShellTerminal(coreId);
  };
  const consumeCtrl = stickyCtrl.consume;
  const transformInput = useCallback(
    (data: string) => phoneTerminalInput(data, consumeCtrl),
    [consumeCtrl],
  );
  const openSession = (sessionId: string) => {
    if (!coreId) return;
    setSwitcherOpen(false);
    setPanelOpen(false);
    requestSessionOpen(coreId, sessionId);
    void router.navigate({ to: "/cores/$coreId/workspace", params: { coreId } });
  };

  const screen = (
    <section
      data-user-terminal-panel
      data-user-terminal-screen
      className="mc-terminal-screen mc-userterm-m-screen"
      style={{
        position: "fixed",
        left: 0,
        right: 0,
        top: viewportTop,
        height: viewportHeight === null ? "100dvh" : `${viewportHeight}px`,
        zIndex: PHONE_SCREEN_Z,
        display: "flex",
        flexDirection: "column",
        background: "var(--surface-1)",
        overflow: "hidden",
      }}
    >
      <MobileTerminalHeader
        title={core?.label ?? "Terminals"}
        statusColor={PHONE_STATUS_COLOR[core?.dial.state ?? ""] ?? "var(--text-faint)"}
        onBack={() => setPanelOpen(false)}
      />
      <div className="mc-userterm-m-strip-row">
        <div ref={stripRef} className="mc-userterm-m-strip" role="tablist" aria-label="Terminals">
          {sessions.map((s) => {
            const isActive = s.terminal.id === activeId;
            return (
              <div key={s.terminal.id} className="mc-userterm-m-tab" data-active={isActive}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  className="mc-userterm-m-tab-main"
                  onClick={() => focusTerminal(s.terminal.id)}
                >
                  <Icon name="terminal" size={14} />
                  <span className="mc-userterm-m-tab-name">{s.terminal.name}</span>
                </button>
                <button
                  type="button"
                  className="mc-userterm-m-tab-close"
                  aria-label={`Close ${s.terminal.name}`}
                  onClick={() => setClosing({ id: s.terminal.id, name: s.terminal.name })}
                >
                  <Icon name="x" size={14} />
                </button>
              </div>
            );
          })}
          <button
            type="button"
            className="mc-userterm-m-new"
            aria-label="New Terminal"
            disabled={!coreId}
            onClick={newTerminal}
          >
            <Icon name="plus" size={16} />
          </button>
        </div>
        <button
          type="button"
          className="mc-userterm-m-switch"
          aria-label="All terminals"
          aria-haspopup="dialog"
          onClick={() => setSwitcherOpen(true)}
        >
          <Icon name="grid" size={16} />
        </button>
      </div>
      <div className="mc-userterm-m-body">
        {active ? (
          <UserTerminalPane
            key={active.terminal.id}
            terminal={active.terminal}
            ptyId={active.ptyId}
            coreId={active.coreId}
            focused
            phone
            transformInput={transformInput}
            onFocus={() => focusTerminal(active.terminal.id)}
            onPtyReady={(ptyId) => setPtyId(active.terminal.id, ptyId, active.coreId)}
            onPtyExit={() => setPtyId(active.terminal.id, null)}
            onHide={() => setPanelOpen(false)}
            onDelete={() => void killTerminal(active.terminal.id)}
            onRename={(name) => void renameTerminal(active.terminal.id, name)}
            isLast
          />
        ) : (
          <EmptyState
            icon="terminal"
            title="No terminals yet"
            subtitle="Open a shell on this Core's machine."
          />
        )}
      </div>
      {active && (
        <div className="mc-term-m-keydock">
          <TerminalKeyRow
            ctrl={stickyCtrl}
            onSend={(data) =>
              (terminalSurfaceCache.get(active.terminal.id) as PaneTerminalSurface | null)?.controls?.writeToPty?.(data)
            }
            applicationCursor={() =>
              (terminalSurfaceCache.get(active.terminal.id) as PaneTerminalSurface | null)?.controls
                ?.applicationCursorKeys?.() ?? false
            }
            onPaste={(text) =>
              (terminalSurfaceCache.get(active.terminal.id) as PaneTerminalSurface | null)?.controls?.paste?.(text)
            }
          />
        </div>
      )}
      <ConfirmDialog
        open={closing !== null}
        onClose={() => setClosing(null)}
        onConfirm={() => {
          if (closing) void killTerminal(closing.id);
          setClosing(null);
        }}
        title={`Close terminal "${closing?.name ?? ""}"?`}
        confirmLabel="Close"
        variant="danger"
        icon="trash"
      >
        This will kill the running process and remove the terminal. This can&apos;t be undone.
      </ConfirmDialog>
    </section>
  );
  return (
    <>
      {typeof document === "undefined" ? screen : createPortal(screen, document.body)}
      <TerminalSwitcherSheet
        open={switcherOpen}
        onClose={() => setSwitcherOpen(false)}
        shells={sessions.map((s) => ({ id: s.terminal.id, name: s.terminal.name }))}
        activeId={activeId}
        onSelectShell={(id) => {
          focusTerminal(id);
          setSwitcherOpen(false);
        }}
        onCloseShell={(id) => {
          const shell = sessions.find((s) => s.terminal.id === id);
          if (!shell) return;
          // The confirmation is a modal of its own; the sheet's focus trap
          // must not fight it.
          setSwitcherOpen(false);
          setClosing({ id, name: shell.terminal.name });
        }}
        onNewShell={() => {
          newTerminal();
          setSwitcherOpen(false);
        }}
        newDisabled={!coreId}
        sessions={coreRows}
        onOpenSession={openSession}
      />
    </>
  );
}
