import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, lazy, Suspense } from "react";
import {
  ClientOnly,
  Outlet,
  createRootRouteWithContext,
  HeadContent,
  Scripts,
  useRouter,
  useRouterState,
} from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";
import { FleetProvider, useFleet } from "~/lib/fleet-context";
import { useCoreHotkeys } from "~/lib/use-core-hotkeys";
import { isAuthPath } from "~/lib/auth-paths";
import { TopBar, type Crumb } from "~/components/ui/TopBar";
import { Btn } from "~/components/ui/Btn";
import { ConfirmDialog } from "~/components/ui/ConfirmDialog";
import { useHotkey } from "~/lib/use-hotkey";
import { KeybindingsProvider } from "~/lib/keybindings/store";
import { useTheme } from "~/lib/use-theme";
import { PRE_HYDRATION_THEME_SCRIPT } from "~/lib/pre-hydration-theme-script";
import { useWindowIdleController } from "~/lib/window-idle";
import {
  TerminalProvider,
  useTerminals,
  useTerminalActions,
  useGridView,
  useHasActiveSession,
} from "~/lib/terminal-store";
import { Z_INDEX } from "~/lib/z-index";
import {
  UserTerminalProvider,
  useUserTerminals,
} from "~/lib/user-terminal-store";
import { TerminalPanel } from "~/components/views/TerminalPanel";
import { UserTerminalPanel } from "~/components/views/UserTerminalPanel";
import { CoreRail } from "~/components/views/CoreRail";
import { routeCoreIdFromLocation, workspaceCoreIdFromPath } from "~/lib/workspace-core-id";
import {
  HeaderActionsProvider,
  HeaderActionsSlot,
} from "~/components/ui/HeaderActionsSlot";
import { ProviderUsageIndicator } from "~/components/views/ProviderUsageIndicator";
import { UpdateBanner } from "~/components/views/UpdateBanner";
import { FirstRunGate } from "~/components/views/FirstRunGate";
import {
  normalizeSettingsPanelId,
  type SettingsPanelId,
} from "~/components/views/settings-panel-ids";
// Lazy: the settings overlay is conditionally rendered (settingsOpen) inside
// ClientOnly, so hydration never touches it — deferring its module keeps the
// dozen settings pages (and the pet cluster they pin) out of the entry chunk.
const SettingsPanel = lazy(() =>
  import("~/components/views/SettingsPanel").then((m) => ({
    default: m.SettingsPanel,
  })),
);
import { OPEN_SETTINGS_EVENT } from "~/lib/design-meta";
import {
  requestCloseSettings,
  setSettingsOverlayOpen,
} from "~/lib/settings-navigation";

import { UsagePanel } from "~/components/views/UsagePanel";
import { SessionNotificationsButton } from "~/components/views/SessionNotificationsButton";
import { Toaster } from "sonner";
import { MC_TOAST_CLASS_NAMES, MC_TOAST_CLOSE_ICON } from "~/lib/mc-toast";
import { useSessionFinishNotifications } from "~/lib/use-session-finish-notifications";
import { useEventStreamReconcile } from "~/lib/use-event-stream-reconcile";
import {
  clearAppNotification,
  clearAppNotifications,
  type AppNotification,
} from "~/lib/session-notification-store";
import { isUserTerminalXtermFocused, isTerminalXtermFocused, terminalZoomIntentFromKeyboard } from "~/lib/terminal-pane-helpers";
import {
  CLEAR_USER_TERMINAL_EVENT,
  GRID_EXPAND_TOGGLE_EVENT,
  TERMINAL_ZOOM_IN_EVENT,
  TERMINAL_ZOOM_OUT_EVENT,
  TERMINAL_ZOOM_RESET_EVENT,
} from "~/lib/design-meta";
import "~/styles.css";

const TOP_BAR_CONTENT_TOP_INSET = 2;
const useThemeLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Actana Control" },
    ],
  }),
  component: RootComponent,
});

function RootComponent() {
  const path = useRouterState({ select: (state) => state.location.pathname });
  // The login and setup pages render outside the app shell: they are what an
  // anonymous browser is allowed to see, and every provider below assumes an
  // authenticated session's data behind it. Both server and client derive this
  // from the same pathname, so hydration matches.
  if (isAuthPath(path)) {
    return (
      <html suppressHydrationWarning>
        <head>
          <script dangerouslySetInnerHTML={{ __html: PRE_HYDRATION_THEME_SCRIPT }} />
          <HeadContent />
        </head>
        <body>
          <Outlet />
          <Scripts />
        </body>
      </html>
    );
  }
  return (
    <html suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{ __html: PRE_HYDRATION_THEME_SCRIPT }}
        />
        <HeadContent />
      </head>
      <body>
        <KeybindingsProvider>
          <TerminalProvider>
            <UserTerminalProvider>
                  <HeaderActionsProvider>
                    {/*
                     * The entire app shell reads client-only state — react-query
                     * data seeded synchronously from localStorage (installShellQueryCache)
                     * plus direct localStorage reads (theme, minimal mode).
                     * The server has none of that, so server HTML and the first
                     * client render disagree → hydration mismatch on every data-driven
                     * node (CoreRail, …). ClientOnly renders the
                     * fallback on the server AND the first client render so they match,
                     * then mounts the real shell after hydration. Past this boundary
                     * there's no SSR markup to match, so children are free to show
                     * skeletons/loading states however they like. `fallback` is the
                     * slot for an app-wide skeleton if we want one later.
                     */}
                    <ClientOnly fallback={null}>
                      {/*
                       * The pairing gate (#358). A Panel that knows no Cores
                       * has nothing to draw, so it draws the wizard *instead
                       * of* the shell rather than over it: no top bar, no
                       * rail, no outlet, and so no route or keystroke that
                       * reaches a dead dashboard. It sits inside ClientOnly
                       * because the registry read is a client read like every
                       * other, and inside the providers because the pairing
                       * form it mounts is the same one Settings mounts.
                       */}
                      <FirstRunGate>
                        <FleetProvider>
                          <Shell />
                        </FleetProvider>
                      </FirstRunGate>
                    </ClientOnly>
                  </HeaderActionsProvider>
            </UserTerminalProvider>
          </TerminalProvider>
        </KeybindingsProvider>
        <Scripts />
      </body>
    </html>
  );
}

// The active-session tail lives in its own leaf so the per-tick re-render from
// subscribing to the terminal data slice (`activeFor` returns a fresh session
// object whenever that session's session row updates) is confined here, instead of
// re-rendering the whole Shell + TopBar + CoreRail. Props are all stable
// (actions + booleans) so it re-renders only on its own subscription.
const CoreTerminalPanel = memo(function CoreTerminalPanel({
  coreId,
  onClose,
  onHide,
  onPtyReady,
  expanded,
  onToggleExpanded,
}: {
  coreId: string;
  onClose: (sessionId: string, opts?: { activateSessionId?: string | null }) => Promise<void>;
  onHide: (coreId: string) => void;
  onPtyReady: (sessionId: string, ptyId: string | null, scopeKey?: string) => void;
  expanded: boolean;
  onToggleExpanded: () => void;
}) {
  const { activeFor } = useTerminals();
  return (
    <TerminalPanel
      active={activeFor(coreId)}
      onClose={onClose}
      onHide={() => onHide(coreId)}
      onPtyReady={onPtyReady}
      expanded={expanded}
      onToggleExpanded={onToggleExpanded}
    />
  );
});

function Shell() {
  const router = useRouter();
  const [activePanel, setActivePanel] = useState<"usage" | null>(null);
  // Settings renders as a Shell-level overlay (see <SettingsPanel> below) rather
  // than a route, so the live app stays mounted behind it and the sliding panels
  // reveal the app instead of a black void. `settingsRequest` is non-null
  // exactly when the overlay is open; its `panel` is the explicitly requested
  // tab (deep link, a leaf's settings shortcut) or null for a generic open,
  // which lets SettingsPanel restore the last-visited tab instead.
  const [settingsRequest, setSettingsRequest] = useState<{
    panel: SettingsPanelId | null;
  } | null>(null);
  const settingsOpen = settingsRequest !== null;
  const openSettings = (initial: SettingsPanelId | null = null) => {
    setSettingsRequest((current) => current ?? { panel: initial });
  };
  const closeSettingsPanel = () => setSettingsRequest(null);

  // Mirror the React open-state into the module flag that non-React global
  // keydown listeners (use-hotkey, the Core workspace route) read to suppress app
  // shortcuts while the modal-style overlay is open.
  useEffect(() => {
    setSettingsOverlayOpen(settingsOpen);
    return () => setSettingsOverlayOpen(false);
  }, [settingsOpen]);

  // Leaf components dispatch OPEN_SETTINGS_EVENT to request the Settings panel
  // without prop-drilling through every parent.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ panel?: string }>).detail;
      openSettings(normalizeSettingsPanelId(detail?.panel));
    };
    window.addEventListener(OPEN_SETTINGS_EVENT, handler);
    return () => window.removeEventListener(OPEN_SETTINGS_EVENT, handler);
  }, [router]);
  useTheme();
  // Window idle: freezes decorative per-frame animations while the window is
  // blurred/hidden (see src/lib/window-idle.ts).
  useWindowIdleController();
  // The Panel's SSE stream has no replay: a drop is a hole in what this tab
  // knows, not a pause (issue 484). Re-read on the way back rather than trust
  // rows last heard about before the gap. Mounted here, once, for the whole
  // shell — the stream is shared, and so is everything it feeds.
  useEventStreamReconcile();
  const { cores } = useFleet();
  // Pure actions (stable identity) + narrow flip-only subscriptions, so a
  // background session-status tick doesn't re-render the whole shell. The active
  // session itself lives in the CoreTerminalPanel leaf below.
  const { close, deselect, setPtyId } = useTerminalActions();
  const gridView = useGridView();
  const workspaceRef = useRef<HTMLDivElement>(null);
  const userTerminals = useUserTerminals();
  const {
    togglePanel,
    createVmShellTerminal,
    cyclePrev,
    cycleNext,
    panelOpen: userTerminalPanelOpen,
    killTerminal: killUserTerminal,
    sessions: userTerminalSessions,
  } = userTerminals;
  const topBarContentTopInset = TOP_BAR_CONTENT_TOP_INSET;
  const [closeIntentTargetId, setCloseIntentTargetId] = useState<string | null>(null);
  const closeIntentTarget = closeIntentTargetId
    ? userTerminalSessions.find((s) => s.terminal.id === closeIntentTargetId)?.terminal ?? null
    : null;

  const sessionNotifications = useSessionFinishNotifications();
  const appNotifications = sessionNotifications.notifications;
  const clearAppNotificationItem = useCallback((notification: AppNotification) => {
    clearAppNotification(notification);
  }, []);
  const clearAllAppNotifications = useCallback(() => {
    clearAppNotifications();
  }, []);
  // Issue 11: the boot-time IPC probe is retired. Per-Core availability is
  // hydrated on first `useCliAvailability(coreId)` mount + kept fresh by
  // `agents:availabilityChanged` events from each Core's Core — no root-
  // level pre-warm needed.

  const path = useRouterState({ select: (state) => state.location.pathname });
  const workspaceCoreId = workspaceCoreIdFromPath(path);
  // Which Core owns the currently-mounted shell (issue 08 — Singular UI across
  // Cores): the Core page names it in the path, the session workspace in the
  // `coreId` search param; every other route has none.
  const routeCoreId = useRouterState({
    select: (state) => routeCoreIdFromLocation(state.location),
  });

  // The Core drawer's terminals belong to whichever Core this route is on.
  const { setCore: setUserTerminalCore } = userTerminals;
  useEffect(() => {
    setUserTerminalCore(routeCoreId ?? null);
  }, [routeCoreId, setUserTerminalCore]);

  // Flip-only: true iff this Core has a materialized active session. Gates
  // the expanded-terminal layout without subscribing to the churning data slice.
  const hasActiveSession = useHasActiveSession(workspaceCoreId);
  const expandedKey = workspaceCoreId ? `mc:terminalExpanded:${workspaceCoreId}` : null;
  const [terminalExpanded, setTerminalExpanded] = useState<boolean>(false);
  useEffect(() => {
    if (!expandedKey) {
      setTerminalExpanded(false);
      return;
    }
    try {
      setTerminalExpanded(window.localStorage.getItem(expandedKey) === "1");
    } catch {
      setTerminalExpanded(false);
    }
  }, [expandedKey]);
  const toggleTerminalExpanded = useCallback(() => {
    if (!expandedKey) return;
    setTerminalExpanded((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(expandedKey, next ? "1" : "0");
      } catch {
        // ignore quota / privacy-mode errors
      }
      return next;
    });
  }, [expandedKey]);
  const sessionExpanded =
    !!workspaceCoreId && terminalExpanded && hasActiveSession;
  // Grid view takes over the whole workspace: the Outlet (which renders the
  // grid below the Core header) spans full width and the single right-hand
  // terminal panel is hidden.
  const gridActive = !!workspaceCoreId && gridView;
  const goHome = () => {
    setActivePanel(null);
    if (settingsOpen) requestCloseSettings();
    // void: a failed navigation shows in the router's own error state.
    void router.navigate({ to: "/" });
  };

  // Cores › <Core>. The Core's own switcher lives in its header (screen 02);
  // the breadcrumb only says where we are.
  const crumbCore = routeCoreId ? cores.find((c) => c.id === routeCoreId) : undefined;
  const crumbs: Crumb[] = settingsOpen
    ? [{ label: "Settings" }]
    : activePanel === "usage"
      ? [{ label: "Usage" }]
      : crumbCore
        ? [
            { label: "Cores", onClick: goHome },
            { label: crumbCore.label },
          ]
        : [];

  const closePanel = () => setActivePanel(null);

  // Recompute + re-observe the workspace bounds whenever the workspace div is
  // (un)mounted.
  useEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace) return;

    const updateWorkspaceBounds = () => {
      const rect = workspace.getBoundingClientRect();
      document.documentElement.style.setProperty("--mc-workspace-top", `${rect.top}px`);
      document.documentElement.style.setProperty("--mc-workspace-left", `${rect.left}px`);
      document.documentElement.style.setProperty(
        "--mc-workspace-right",
        `${window.innerWidth - rect.right}px`,
      );
      document.documentElement.style.setProperty(
        "--mc-workspace-bottom",
        `${window.innerHeight - rect.bottom}px`,
      );
    };

    updateWorkspaceBounds();
    const observer = new ResizeObserver(updateWorkspaceBounds);
    observer.observe(workspace);
    window.addEventListener("resize", updateWorkspaceBounds);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateWorkspaceBounds);
      document.documentElement.style.removeProperty("--mc-workspace-top");
      document.documentElement.style.removeProperty("--mc-workspace-left");
      document.documentElement.style.removeProperty("--mc-workspace-right");
      document.documentElement.style.removeProperty("--mc-workspace-bottom");
    };
  }, []);

  useHotkey("terminal.toggle", () => togglePanel());
  // `terminal.newTab` (⌘T by default) opens the same thing the panel's one
  // "New Terminal" button opens: a VM Shell Session on the Core this route is
  // on (issue 266). It was advertised in two `HotkeyTooltip`s and bound to a
  // hard-coded, non-rebindable listener next to ⌘[ / ⌘] — so the tooltip named
  // an action the keybindings editor could not actually rebind. It is a real
  // action now.
  //
  // Capture, like the shortcuts it moved out of: a focused xterm textarea
  // swallows this on bubble.
  useHotkey(
    "terminal.newTab",
    () => {
      if (routeCoreId) void createVmShellTerminal(routeCoreId);
    },
    { capture: true },
  );
  useHotkey(
    "terminal.expandToggle",
    () => {
      if (userTerminalPanelOpen && isUserTerminalXtermFocused()) {
        window.dispatchEvent(new Event(CLEAR_USER_TERMINAL_EVENT));
        return;
      }
      // While the grid owns the workspace there's no single-session panel; hand
      // the shortcut to SessionGrid so it expands/collapses the focused cell.
      if (gridActive) {
        window.dispatchEvent(new Event(GRID_EXPAND_TOGGLE_EVENT));
        return;
      }
      if (workspaceCoreId && hasActiveSession) toggleTerminalExpanded();
    },
    { capture: true },
  );
  useHotkey("nav.toggle", goHome);
  // Cmd/Ctrl + =/-/0 zoom or reset the focused terminal; otherwise leave browser
  // zoom alone.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const intent = terminalZoomIntentFromKeyboard(e);
      if (intent === null) return;
      if (!isTerminalXtermFocused()) return;
      e.preventDefault();
      e.stopPropagation();
      const event =
        intent === "in"
          ? TERMINAL_ZOOM_IN_EVENT
          : intent === "out"
            ? TERMINAL_ZOOM_OUT_EVENT
            : TERMINAL_ZOOM_RESET_EVENT;
      window.dispatchEvent(new Event(event));
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);
  const openCore = useCallback(
    (coreId: string) => {
      // void: a failed navigation shows in the router's own error state.
      void router.navigate({ to: "/cores/$coreId", params: { coreId } });
    },
    [router],
  );
  useCoreHotkeys(cores, openCore);
  // Cmd/Ctrl + [ / ] are non-rebindable terminal-focused shortcuts.
  // Capture phase: a focused xterm textarea swallows these on bubble.
  // ⌘T used to be in here too; it is `terminal.newTab` above now, so the
  // tooltip that advertises it and the keybindings editor that lists it both
  // describe something real (issue 266).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === "[" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        cyclePrev();
        return;
      }
      if (e.key === "]" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        cycleNext();
        return;
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [cycleNext, cyclePrev]);

  return (
    <>
      <div id="root">
        {/* Banner hidden for now — toggle also removed from Settings. */}
        {/* Above the top bar and across the full width: it is about the
         * deployment, not about whatever Core is open below it. Renders
         * nothing at all unless a newer release exists and this browser has
         * not dismissed that release. */}
        <UpdateBanner />
        <TopBar
          crumbs={crumbs}
          onHome={goHome}
          centerActions={
            <>
              {/* One grouped band of the Core's actions (grid), portalled in
               * by the Core workspace route. */}
              <HeaderActionsSlot />
            </>
          }
          contentTopInset={topBarContentTopInset}
          right={
            <>
              <ProviderUsageIndicator />
              <SessionNotificationsButton
                notifications={appNotifications}
                onClearNotification={clearAppNotificationItem}
                onClearNotifications={clearAllAppNotifications}
              />
              <Btn
                variant="ghost"
                icon="settings"
                onClick={() =>
                  settingsOpen ? requestCloseSettings() : openSettings()
                }
                aria-label={settingsOpen ? "Close settings" : "Open settings"}
                title={settingsOpen ? "Close settings" : "Open settings"}
              />
            </>
          }
        />
        <div
          ref={workspaceRef}
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            minHeight: 0,
          }}
        >
          <div style={{ flex: 1, display: "flex", overflow: "hidden", minHeight: 0 }}>
            <CoreRail />
            <div
              style={{
                position: "relative",
                flex: 1,
                // Grid view lives inside the Outlet, so the expanded-terminal
                // flag must never hide it — both can be true at once (the
                // expand flag persists per Core, the grid flag globally).
                display: sessionExpanded && !gridActive ? "none" : "flex",
                flexDirection: "column",
                overflow: "hidden",
                // On the Core workspace the terminal panel sits to the
                // right; floor the left panel so dragging the terminal wider
                // shrinks the terminal instead of wrapping the session columns.
                // In grid view the panel is hidden, so let the Outlet go full width.
                minWidth: workspaceCoreId && !gridActive ? 640 : 0,
                minHeight: 0,
              }}
            >
              <Outlet />
            </div>
            {workspaceCoreId && !gridActive && (
              <CoreTerminalPanel
                coreId={workspaceCoreId}
                onClose={close}
                onHide={deselect}
                onPtyReady={setPtyId}
                expanded={sessionExpanded}
                onToggleExpanded={toggleTerminalExpanded}
              />
            )}
          </div>
          <UserTerminalPanel />
        </div>
        {activePanel === "usage" && <UsagePanel onBack={closePanel} />}
        {settingsOpen && (
          <Suspense fallback={null}>
            <SettingsPanel
              initialPanel={settingsRequest?.panel ?? null}
              onBack={closeSettingsPanel}
            />
          </Suspense>
        )}
        <Toaster
          position="bottom-right"
          theme="dark"
          closeButton
          offset={16}
          style={{ zIndex: Z_INDEX.toast }}
          icons={{ close: MC_TOAST_CLOSE_ICON }}
          toastOptions={{
            unstyled: true,
            closeButton: true,
            closeButtonAriaLabel: "Close",
            classNames: MC_TOAST_CLASS_NAMES,
          }}
        />
      </div>
      <ConfirmDialog
        open={!!closeIntentTarget}
        onClose={() => setCloseIntentTargetId(null)}
        onConfirm={() => {
          const id = closeIntentTargetId;
          setCloseIntentTargetId(null);
          if (id) void killUserTerminal(id);
        }}
        title={
          closeIntentTarget
            ? `Delete terminal "${closeIntentTarget.name}"?`
            : "Delete terminal?"
        }
        confirmLabel="Delete"
        variant="danger"
        icon="trash"
      >
        This will kill the running process and remove the terminal. This can&apos;t be undone.
      </ConfirmDialog>
    </>
  );
}
