import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, lazy, Suspense } from "react";
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
import { getRailClusters, usesDirectRailProjectShortcuts } from "~/lib/rail-projects";
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
import { ProjectPicker } from "~/components/views/ProjectPicker";
import { ProjectBar } from "~/components/views/ProjectBar";
import { AddProjectProvider } from "~/lib/add-project-store";
import { GroupsDialogProvider } from "~/lib/groups-dialog-store";
import { ACTIVE_GROUP_ALL, ACTIVE_GROUP_UNGROUPED, useActiveGroup } from "~/lib/active-group";
import { GroupSwitcher } from "~/components/views/GroupSwitcher";
import { projectIdFromPath } from "~/lib/project-id-from-path";
import {
  HeaderActionsProvider,
  HeaderActionsSlot,
} from "~/components/ui/HeaderActionsSlot";
import { useSettings, useProjects } from "~/queries";
import { ProviderUsageIndicator } from "~/components/views/ProviderUsageIndicator";
import { UpdateBanner } from "~/components/views/UpdateBanner";
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
              <AddProjectProvider>
                <GroupsDialogProvider>
                  <HeaderActionsProvider>
                    {/*
                     * The entire app shell reads client-only state — react-query
                     * data seeded synchronously from localStorage (installShellQueryCache)
                     * plus direct localStorage reads (theme, minimal mode).
                     * The server has none of that, so server HTML and the first
                     * client render disagree → hydration mismatch on every data-driven
                     * node (ProjectPicker, …). ClientOnly renders the
                     * fallback on the server AND the first client render so they match,
                     * then mounts the real shell after hydration. Past this boundary
                     * there's no SSR markup to match, so children are free to show
                     * skeletons/loading states however they like. `fallback` is the
                     * slot for an app-wide skeleton if we want one later.
                     */}
                    <ClientOnly fallback={null}>
                      <Shell />
                    </ClientOnly>
                  </HeaderActionsProvider>
                </GroupsDialogProvider>
              </AddProjectProvider>
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
// object whenever that session's task row updates) is confined here, instead of
// re-rendering the whole Shell + TopBar + ProjectBar. Props are all stable
// (actions + booleans) so it re-renders only on its own subscription.
const ProjectTerminalPanel = memo(function ProjectTerminalPanel({
  projectId,
  onClose,
  onHide,
  onPtyReady,
  expanded,
  onToggleExpanded,
}: {
  projectId: string;
  onClose: (taskId: string, opts?: { activateTaskId?: string | null }) => Promise<void>;
  onHide: (projectId: string) => void;
  onPtyReady: (taskId: string, ptyId: string | null, scopeKey?: string) => void;
  expanded: boolean;
  onToggleExpanded: () => void;
}) {
  const { activeFor } = useTerminals();
  return (
    <TerminalPanel
      active={activeFor(projectId)}
      onClose={onClose}
      onHide={() => onHide(projectId)}
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
  // keydown listeners (use-hotkey, the project route) read to suppress app
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
  const { data: settings } = useSettings();
  const { data: projects } = useProjects();
  const { activeGroup, setActiveGroup, groups } = useActiveGroup();
  // Pure actions (stable identity) + narrow flip-only subscriptions, so a
  // background session-status tick doesn't re-render the whole shell. The active
  // session itself lives in the ProjectTerminalPanel leaf below.
  const { close, deselect, setPtyId } = useTerminalActions();
  const gridView = useGridView();
  const workspaceRef = useRef<HTMLDivElement>(null);
  // First digit of a group→project rail chord (Cmd held, group digit pressed,
  // awaiting the project digit or a Cmd release). Only used in "All" mode
  // when at least one real group exists.
  const pendingRailGroupRef = useRef<number | null>(null);
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
  const projectId = projectIdFromPath(path);
  // Which Core owns the currently-mounted shell (issue 08 — Singular UI across
  // Cores). Only the /projects/$id route sets `coreId`; every other route
  // implicitly means the Panel's own rows, which ProjectBar defaults to.
  const routeCoreId = useRouterState({
    select: (state) => {
      const search = state.location.search as { coreId?: unknown } | undefined;
      return typeof search?.coreId === "string" ? search.coreId : undefined;
    },
  });
  // Flip-only: true iff this project has a materialized active session. Gates
  // the expanded-terminal layout without subscribing to the churning data slice.
  const hasActiveSession = useHasActiveSession(projectId);
  const expandedKey = projectId ? `mc:terminalExpanded:${projectId}` : null;
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
    !!projectId && terminalExpanded && hasActiveSession;
  // Grid view takes over the whole workspace: the Outlet (which renders the
  // grid below the project header) spans full width and the single right-hand
  // terminal panel is hidden.
  const gridActive = !!projectId && gridView;
  // The group is the broadest context, so it leads the breadcrumb:
  // Group › Project › Scope. Omitted (not just null-rendered) when no groups
  // exist so no dangling separator renders, and absent on the app-global
  // Settings/Usage screens where a group scope is meaningless. Also omitted
  // when hidden via Settings → Interface (right-click the pill → Hide);
  // groups stay reachable through the dashboard chips and the cycle hotkey.
  const groupCrumb: Crumb[] =
    groups.length > 0 && (settings?.showGroupSwitcher ?? true)
      ? [{ label: "Group", node: <GroupSwitcher /> }]
      : [];
  const crumbs: Crumb[] = settingsOpen
    ? [{ label: "Settings" }]
    : projectId
    ? [
        ...groupCrumb,
        // The switcher is scoped to the Core that owns this shell, so it gets
        // the same `?coreId=` the rest of the shell reads its data with.
        {
          label: "Project",
          node: <ProjectPicker projectId={projectId} coreId={routeCoreId ?? null} />,
        },
      ]
      : activePanel === "usage"
        ? [{ label: "Usage" }]
      // Outside a Project there is no Project to switch away from, so no
      // switcher — the root path used to render an empty one (issue 231).
      : groupCrumb;

  const closePanel = () => setActivePanel(null);

  const goHome = () => {
    setActivePanel(null);
    if (settingsOpen) requestCloseSettings();
    router.navigate({ to: "/" });
  };

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

  // Cycle the active group context: All → each group → Ungrouped → All.
  const cycleActiveGroup = useCallback(
    (direction: 1 | -1) => {
      const order: string[] = [ACTIVE_GROUP_ALL, ...groups.map((g) => g.id)];
      if ((projects ?? []).some((p) => p.groupId == null)) order.push(ACTIVE_GROUP_UNGROUPED);
      if (order.length <= 1) return;
      const index = order.indexOf(activeGroup);
      const next = order[(index + direction + order.length) % order.length]!;
      setActiveGroup(next);
    },
    [activeGroup, groups, projects, setActiveGroup],
  );
  useHotkey("group.next", () => cycleActiveGroup(1));
  useHotkey("group.prev", () => cycleActiveGroup(-1));

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
      if (projectId && hasActiveSession) toggleTerminalExpanded();
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
      if (!e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key)) {
        if (e.repeat) {
          // Ignore auto-repeat so a held digit doesn't re-fire the chord.
          e.preventDefault();
          return;
        }
        const digit = Number(e.key);
        // Same clusters the rail renders — badges and hotkeys must agree.
        const clusters = getRailClusters(projects ?? [], groups, activeGroup);
        const navigateTo = (id: string) => {
          e.preventDefault();
          e.stopPropagation();
          router.navigate({ to: "/projects/$id", params: { id } });
        };

        // A single group is active, or no real groups exist: the rail is one
        // flat project list, so the digit addresses a project directly.
        if (usesDirectRailProjectShortcuts(groups, activeGroup)) {
          pendingRailGroupRef.current = null;
          const target = clusters[0]?.projects[digit - 1];
          if (target) navigateTo(target.id);
          else e.preventDefault();
          return;
        }

        // "All" mode: two-level chord. First digit picks the group cluster;
        // the second digit (this handler, next press) picks the project. A
        // Cmd release before the second digit jumps to the group's first
        // project (see the keyup handler below).
        e.preventDefault();
        e.stopPropagation();
        if (pendingRailGroupRef.current == null) {
          // First digit — remember the group if it exists; otherwise ignore.
          if (clusters[digit - 1]) pendingRailGroupRef.current = digit;
          return;
        }
        const groupIdx = pendingRailGroupRef.current - 1;
        pendingRailGroupRef.current = null;
        const target = clusters[groupIdx]?.projects[digit - 1];
        if (target) navigateTo(target.id);
        return;
      }
    };
    // Releasing Cmd/Ctrl with a group digit still pending jumps to that
    // group's first project (a single-digit chord).
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key !== "Meta" && e.key !== "Control") return;
      const pending = pendingRailGroupRef.current;
      pendingRailGroupRef.current = null;
      if (pending == null || usesDirectRailProjectShortcuts(groups, activeGroup)) return;
      const clusters = getRailClusters(projects ?? [], groups, activeGroup);
      const target = clusters[pending - 1]?.projects[0];
      if (target) router.navigate({ to: "/projects/$id", params: { id: target.id } });
    };
    // Losing focus mid-chord (e.g. clicking away while Cmd is held) would
    // otherwise leave a group digit pending and misread the next chord.
    const onBlur = () => {
      pendingRailGroupRef.current = null;
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [activeGroup, cycleNext, cyclePrev, groups, projects, router]);

  return (
    <>
      <div id="root">
        {/* Banner hidden for now — toggle also removed from Settings. */}
        {/* Above the top bar and across the full width: it is about the
         * deployment, not about whatever project is open below it. Renders
         * nothing at all unless a newer release exists and this browser has
         * not dismissed that release. */}
        <UpdateBanner />
        <TopBar
          crumbs={crumbs}
          onHome={goHome}
          centerActions={
            <>
              {/* Project cockpit, one grouped band: context (which project)
               * then the project actions (run, grid) portalled in by the
               * project route. */}
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
            <ProjectBar coreId={routeCoreId} />
            <div
              style={{
                position: "relative",
                flex: 1,
                // Grid view lives inside the Outlet, so the expanded-terminal
                // flag must never hide it — both can be true at once (the
                // expand flag persists per project, the grid flag globally).
                display: sessionExpanded && !gridActive ? "none" : "flex",
                flexDirection: "column",
                overflow: "hidden",
                // On the project detail view the terminal panel sits to the
                // right; floor the left panel so dragging the terminal wider
                // shrinks the terminal instead of wrapping the session columns.
                // In grid view the panel is hidden, so let the Outlet go full width.
                minWidth: projectId && !gridActive ? 640 : 0,
                minHeight: 0,
              }}
            >
              <Outlet />
            </div>
            {projectId && !gridActive && (
              <ProjectTerminalPanel
                projectId={projectId}
                onClose={close}
                onHide={deselect}
                onPtyReady={setPtyId}
                expanded={sessionExpanded}
                onToggleExpanded={toggleTerminalExpanded}
              />
            )}
          </div>
          <UserTerminalPanel coreId={routeCoreId} />
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
