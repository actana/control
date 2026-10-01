import { showRequestedSession } from "~/lib/open-requested-session";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { Btn } from "~/components/ui/Btn";
import { CardFrame } from "~/components/ui/CardFrame";
import { DropdownMenuItem } from "~/components/ui/DropdownMenuItem";
import { Icon } from "~/components/ui/Icon";
import { GridViewToggleIcon } from "~/components/ui/GridViewToggleIcon";
import { Z_INDEX } from "~/lib/z-index";
import { EmptyState } from "~/components/ui/EmptyState";
import { SessionColumn } from "~/components/views/SessionColumn";
import { NewHarnessDialog } from "~/components/views/NewHarnessDialog";
import {
  CodexHooksNoticeDialog,
  hasSeenCodexHooksNotice,
  markCodexHooksNoticeSeen,
} from "~/components/views/CodexHooksNoticeDialog";
import { HarnessUpdateRequiredDialog } from "~/components/views/HarnessUpdateRequiredDialog";
import { GridLayoutButton } from "~/components/views/GridLayoutButton";
import { SessionGrid } from "~/components/views/SessionGrid";
import { archiveOpenSession, invalidateSessionQueries } from "~/lib/archive-session";
import { openClickedSession } from "~/lib/open-clicked-session";
import {
  activeSessionWentAway,
  rememberActiveSession,
  type LastActiveSession,
} from "~/lib/active-session-memory";
import { coreWorkspaceProject } from "~/lib/core-workspace-project";
type ProjectOnboardIntent = { gridView?: boolean };
import { readCoreRemember, writeCoreRemember } from "~/lib/core-remember";
import { useCores } from "~/lib/use-fleet";
import { useHideableMenu } from "~/lib/hideable-elements";
import { DEFAULT_HEADER_BUTTON_VISIBILITY } from "~/shared/header-buttons";
import { NewHarnessButton } from "~/components/views/NewHarnessButton";
import { CursorGlow } from "~/components/ui/CursorGlow";
import { HotkeyTooltip } from "~/components/ui/Tooltip";
import { ConfirmDialog } from "~/components/ui/ConfirmDialog";
import { isEditableTarget, useHotkey } from "~/lib/use-hotkey";
import { api } from "~/lib/api";

import { mutateSessionForCore } from "~/lib/mutate-session-for-core";
import { newSessionId } from "~/lib/claude-command";
import { TITLE_WAITING } from "~/lib/session-sentinels";
import {
  appendOptimisticSession,
  buildOptimisticSession,
  removeOptimisticSession,
  removeSessionFromCache,
  removeSessionsFromCache,
  replaceOptimisticSession,
  restoreSessionsCache,
  setSessionArchivedInCache,
  setSessionPinnedInCache,
  setSessionsArchivedInCache,
} from "~/lib/optimistic-session";
import { prefetchTerminalModules } from "~/lib/prefetch-terminal-modules";
import { newClientId } from "@actana/shared/client-id";
import {
  defaultSessionPayload,
  sessionCreateSignature,
  type SessionCreatePayload,
} from "~/lib/session-warm-pool";
import { useServerEvents } from "~/lib/use-events";
import { useDebouncedCallback } from "~/lib/use-debounced-callback";
import { applyQuestionServerEvent } from "~/lib/harness-question-store";
import {
  setPendingInitialInput,
  takePendingInitialInput,
} from "~/lib/pending-initial-input";
import {
  clearPendingSessionModel,
  peekPendingSessionModel,
  setPendingSessionModel,
} from "~/lib/session-model-overrides";
import { DEFAULT_SHIP_PROMPT } from "~/shared/ship-defaults";
import type { AiModelId } from "@actana/shared/ai-runtime-defaults";
import { useTerminals } from "~/lib/terminal-store";
import { useUserTerminals } from "~/lib/user-terminal-store";
import {
  groupActiveListSessionsForDisplay,
  groupArchivedSessionsForDisplay,
  groupSessionsByStatusForDisplay,
} from "~/lib/session-display-order";
import {
  STATUS_DISPLAY_ORDER,
} from "@actana/shared/domain";
import { harnessLaunchesWithSkipPermissions } from "@actana/shared/harnesses";
import {
  queryKeys,
  remoteSessionFromSnapshot,
  sessionsCacheKey,
  useArchivedSessions,
  useCoreArchivedSessionCount,
  useHookToken,
  useSettings,
  useSessions,
} from "~/queries";
import { useCoreLiveQueries } from "~/lib/use-core-live-queries";
import {
  availabilityFor,
  type CliAvailability,
  useCliAvailability,
} from "~/lib/cli-availability";
import {
  SESSION_NOTIFICATION_OPEN_EVENT,
  clearPendingSessionOpen,
  readPendingSessionOpen,
  type PendingSessionOpen,
} from "~/lib/session-notification-store";
import type { Session } from "~/db/schema";

import { projectScopeKey, scopeKeyForProject } from "~/lib/scoped-project";
import {
  ARCHIVE_ACTIVE_SESSION_EVENT,
  DUPLICATE_ACTIVE_SESSION_EVENT,
  pickByPriority,
  STATUS_META,
  type ArchiveActiveSessionEventDetail,
} from "~/lib/design-meta";

// Session workspace for a Core (issue 560). Replaces the legacy /projects/$id
// route: Sessions belong to the Core and always start in ~ (ADR 0041 D1, D2).
export const Route = createFileRoute("/cores/$coreId/workspace")({
  component: CoreWorkspacePage,
});

type SessionView = "active" | "pinned" | "archived";

/** The session id of the grid cell whose terminal currently holds focus (the pane
 *  the user is looking at), or null outside grid view / when nothing is focused.
 *  Clone and "new session" both anchor a fresh session on this so it lands
 *  beside — and takes the caret from — the active pane. */
function readFocusedGridSessionId(): string | null {
  if (typeof document === "undefined") return null;
  const cell = document.activeElement?.closest("[data-grid-cell]") as HTMLElement | null;
  return cell?.getAttribute("data-session-id") ?? null;
}

function CoreWorkspacePage() {
  const { coreId: routeCoreId } = Route.useParams();
  const coreId = routeCoreId;
  const id = coreId; // terminal/session caches still key off a scope id = Core id
  const router = useRouter();
  const queryClient = useQueryClient();
  const { data: settings } = useSettings();
  const { hideableMenu } = useHideableMenu();
  const { cores } = useCores();
  const coreLabel = cores.find((c) => c.id === coreId)?.label || coreId;
  // Which discretionary header buttons are shown (Settings → Interface).
  const headerButtons = settings?.headerButtons ?? DEFAULT_HEADER_BUTTON_VISIBILITY;
  const [rememberTick, setRememberTick] = useState(0);
  const remembered = useMemo(() => {
    void rememberTick;
    return readCoreRemember(coreId);
  }, [coreId, rememberTick]);
  const project = useMemo(
    () => coreWorkspaceProject(coreId, coreLabel),
    [coreId, coreLabel, remembered.rememberHarnessSettings, remembered.savedHarness],
  );
  const selectedScopeKey = projectScopeKey(id);
  const scopedProject = project;
  // Every Session starts in ~ on this Core — there is no path to verify (ADR 0041 D2).
  const projectPathReady = true;
  const terminalProject = scopedProject;
  const defaultWarmPayload = useMemo(
    () => (project ? defaultSessionPayload(project) : null),
    [
      project?.rememberHarnessSettings,
      project?.savedHarness,
      project?.savedSkipPermissions,
      project?.savedBareSession,
    ],
  );
  const warmPrepareKey =
    terminalProject && defaultWarmPayload
      ? `${terminalProject.id}:${terminalProject.path}:${sessionCreateSignature(coreId ?? "", defaultWarmPayload, terminalProject.path)}`
      : null;
  // Read the latest inputs through a ref so a project-query refetch that returns
  // a new `project` reference with identical data doesn't change the effect deps
  // and churn the warm slot (kill + respawn a full agent PTY). `warmPrepareKey`
  // already encodes everything that should trigger teardown/re-prepare.
  const warmInputRef = useRef({ terminalProject, defaultWarmPayload });
  warmInputRef.current = { terminalProject, defaultWarmPayload };
  useEffect(() => {
    const { terminalProject, defaultWarmPayload } = warmInputRef.current;
    if (!terminalProject || !defaultWarmPayload || !warmPrepareKey) return;
    void prefetchTerminalModules();
    // No warm-slot pre-spawn any more: the pool spawned through the in-process
    // Core's core-link and persisted its session over the Panel's local HTTP
    // API, and a session's row belongs to the Core that runs it (ADR 0004).
    // Sessions take the one cold path, which is a mutation frame.
    // Depend only on warmPrepareKey (the stable logical key); inputs come from the ref.
  }, [warmPrepareKey]);
  const sessionsQuery = useSessions(id, { coreId });
  // A remote Core's projects and sessions change on the Core, not in the
  // Panel's own database, so the SSE stream that keeps the rest of this route
  // fresh says nothing about them. Core events over the panel link do.
  useCoreLiveQueries(coreId, id);
  const sessions = sessionsQuery.data ?? [];
  // Live pinned-session ids for the grid's "Pinned" filter — derived from the
  // session query (not the store's open-time snapshot) so a pin toggle reflects
  // immediately. Memoized so SessionGrid's filter doesn't churn every render.
  const pinnedSessionIds = useMemo(
    () => new Set(sessions.filter((t) => !t.archived && t.pinned).map((t) => t.id)),
    [sessions],
  );
  useHookToken();
  const [showNewHarness, setShowNewHarness] = useState(false);
  // Where the session created from the New Harness dialog should land in the grid:
  // "newRow" is set by the grid's "New row" button so the result starts a fresh
  // row; "default" (the New session button / hotkey) uses the current row.
  const [newHarnessTarget, setNewHarnessTarget] = useState<"default" | "newRow">("default");
  const [sessionView, setSessionView] = useState<SessionView>("active");
  const showArchived = sessionView === "archived";
  const showPinned = sessionView === "pinned";
  // Where the Archived view's contents come from differs by owner (ADR 0019).
  // A Panel-owned project's session list already carries its archived rows, so
  // both the rows and the count are a filter away. A Core's list carries none
  // of them: the count rides the `sessionRowsList` answer as a scalar, and the rows
  // arrive over their own frame — fetched only once this view is open.
  const archivedSessionsQuery = useArchivedSessions(id, { coreId, enabled: showArchived });
  const coreArchivedCount = useCoreArchivedSessionCount(id, coreId);
  const archivedSessions = coreId ? (archivedSessionsQuery.data ?? []) : sessions.filter((t) => t.archived);
  // Count, not `archivedSessions.length` — for a Core the rows are absent until
  // the view opens, and the tab has to be gated and labelled before that.
  const archivedCount = coreId ? coreArchivedCount : archivedSessions.length;
  const hasArchivedSessions = archivedCount > 0;
  const [pinningSessionIds, setPinningSessionIds] = useState<Set<string>>(() => new Set());
  const pinRequestSeqRef = useRef<Record<string, number>>({});
  // Stable callback identities for the memoized SessionCard: the real handlers are
  // defined far below (after this render's early returns), so we forward through
  // a ref that's refreshed each render. This keeps the props SessionCard sees
  // referentially stable so a single session update re-renders only its card,
  // while every click still runs the latest handler closure.
  const sessionCardHandlersRef = useRef<{
    onToggle: (sessionId: string) => void;
    onArchive: (sessionId: string) => void;
    onRestore: (sessionId: string) => void;
    onDelete: (sessionId: string) => void;
    onTogglePinned: (sessionId: string) => Promise<void> | void;
  }>({
    onToggle: () => {},
    onArchive: () => {},
    onRestore: () => {},
    onDelete: () => {},
    onTogglePinned: () => {},
  });
  const stableSelectTerminal = useCallback(
    (sessionId: string) => sessionCardHandlersRef.current.onToggle(sessionId),
    [],
  );
  const stableArchiveSession = useCallback(
    (sessionId: string) => sessionCardHandlersRef.current.onArchive(sessionId),
    [],
  );
  const stableRestoreSession = useCallback(
    (sessionId: string) => sessionCardHandlersRef.current.onRestore(sessionId),
    [],
  );
  const stableDeleteSession = useCallback(
    (sessionId: string) => sessionCardHandlersRef.current.onDelete(sessionId),
    [],
  );
  const stableToggleSessionPinned = useCallback(
    (sessionId: string) => sessionCardHandlersRef.current.onTogglePinned(sessionId),
    [],
  );
  const [confirmDeleteArchived, setConfirmDeleteArchived] = useState(false);
  const [confirmArchiveAll, setConfirmArchiveAll] = useState(false);
  const [archivingAll, setArchivingAll] = useState(false);
  // Leave the archived view automatically once it empties (last one restored
  // or deleted) so the toggle never strands the user on a blank list.
  useEffect(() => {
    if (sessionView === "archived" && !hasArchivedSessions) setSessionView("active");
  }, [sessionView, hasArchivedSessions]);
  const [cleanupStatus, setCleanupStatus] = useState<string | null>(null);
  const cliAvailability = useCliAvailability(coreId);

  const [overflowOpen, setOverflowOpen] = useState(false);
  const [overflowMenuRect, setOverflowMenuRect] = useState<{
    top: number;
    left: number;
    minWidth: number;
  } | null>(null);
  const overflowRef = useRef<HTMLDivElement | null>(null);
  const overflowDropdownRef = useRef<HTMLElement>(null);
  const updateOverflowMenuRect = useCallback(() => {
    const anchor = overflowRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    setOverflowMenuRect({
      top: rect.bottom + 6,
      left: rect.left,
      minWidth: 220,
    });
  }, []);
  useLayoutEffect(() => {
    if (!overflowOpen) {
      setOverflowMenuRect(null);
      return;
    }
    updateOverflowMenuRect();
    window.addEventListener("resize", updateOverflowMenuRect);
    window.addEventListener("scroll", updateOverflowMenuRect, true);
    return () => {
      window.removeEventListener("resize", updateOverflowMenuRect);
      window.removeEventListener("scroll", updateOverflowMenuRect, true);
    };
  }, [overflowOpen, updateOverflowMenuRect]);
  useEffect(() => {
    if (!overflowOpen) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (overflowRef.current?.contains(target)) return;
      if (overflowDropdownRef.current?.contains(target)) return;
      setOverflowOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOverflowOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [overflowOpen]);

  const terminals = useTerminals();
  const gridViewActive = terminals.gridView;

  // How many sessions the current scope's grid shows (drives "Archive all").
  const gridScopeSessionCount = useMemo(
    () =>
      terminals.sessions.filter((s) => scopeKeyForProject(s.project) === selectedScopeKey).length,
    [terminals.sessions, selectedScopeKey],
  );
  // The grid only takes over the workspace once the scope has a session to show.
  // With none, we fall back to the normal sessions view so an empty grid matches
  // the single-panel empty state exactly (header and all) instead of a bare
  // centered message. Archived is a list-only management view (no live terminals
  // to grid), so selecting it drops back to the list; the grid filters only
  // between Active and Pinned (SessionGrid handles the empty-Pinned state).
  const showGrid =
    gridViewActive && sessionView !== "archived" && gridScopeSessionCount > 0;
  // The Active/Pinned/Archived scope toggle must stay mounted even while the
  // archived list is showing. Archived is a list-only view, so selecting it drops
  // showGrid to false — gating the toggle on showGrid would unmount the very
  // control the user needs to get back to Active/Pinned, stranding them in the
  // archived list. Keep it visible whenever grid mode is engaged for this scope.
  const showSessionScopeToggle = gridViewActive && gridScopeSessionCount > 0;
  const syncSession = terminals.syncSession;
  const rehydrateTerminal = terminals.rehydrate;
  const toggleTerminalSession = terminals.toggle;
  const setVisibleTerminalScope = terminals.setVisibleScope;
  // "Grid view — show all sessions": entering the grid materializes every
  // active session for the visible scope, not just the already-open
  // ones. TerminalPane's spawn queue staggers the agent launches.
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const enterGridView = useCallback(() => {
    // Keep any open Review Changes diff open across the switch — the grid docks
    // it as a side panel rather than fighting for the slot, so switching views
    // shouldn't dismiss the review.
    terminals.setGridView(true);
    if (!terminalProject) return;
    for (const session of sessionsRef.current) {
      if (session.archived) continue;
      rehydrateTerminal(terminalProject, session, { coreId });
    }
    // Focus the session that was active in normal view so entering the grid keeps
    // the same session current instead of landing on an arbitrary cell.
    // focusGridSession retries until that cell's pane mounts.
    const activeSessionId = terminals.activeSessionIdFor(selectedScopeKey);
    if (activeSessionId) terminals.focusGridSession(activeSessionId);
  }, [terminals, terminalProject, rehydrateTerminal, selectedScopeKey, coreId]);
  const toggleGridViewShowingAll = useCallback(() => {
    if (terminals.gridView) {
      // Carry the grid's focused session into normal view so leaving the grid
      // shows the pane you were looking at, not whatever was active before.
      // DOM focus first (hotkey exit, cell still focused); then the grid's
      // last-focused cell reported to the store (a header-button click moved
      // focus off the grid).
      const focused = readFocusedGridSessionId() ?? terminals.getGridFocusedSessionId();
      terminals.setGridView(false);
      if (focused && terminalProject && sessions.some((t) => t.id === focused)) {
        terminals.setActiveSession(terminalProject, focused);
        // setActiveSession only picks which session docks in normal view; the
        // cached terminal surface reattaches blurred, so without this the pane
        // is shown but drops keystrokes until a click. Post the focus request
        // in the same (batched) update that leaves grid view — SessionGrid is
        // unmounting so it won't consume the nonce; the now-mounting
        // TerminalPanel picks it up and retries until the pane settles.
        terminals.focusGridSession(focused);
      }
      // List view no longer has the Active/Pinned/Archived scope toggle — pinned
      // is grid-only, so drop back to the active list when leaving the grid.
      setSessionView((prev) => (prev === "pinned" ? "active" : prev));
    } else {
      enterGridView();
    }
  }, [terminals, enterGridView, terminalProject, sessions]);
  const {
    setProject: setActiveUserTerminalProject,
  } = useUserTerminals();

  useEffect(() => {
    if (terminalProject) setActiveUserTerminalProject(terminalProject, coreId);
  }, [terminalProject, coreId, setActiveUserTerminalProject]);

  useLayoutEffect(() => {
    setVisibleTerminalScope(id, selectedScopeKey);
    return () => setVisibleTerminalScope(id, null);
  }, [id, selectedScopeKey, setVisibleTerminalScope]);

  useEffect(() => {
    for (const session of sessions) syncSession(session);
  }, [sessions, syncSession]);

  // When the active session is deleted/archived, jump to the next
  // highest-priority card. Plain deselect (Cmd+L, X) leaves the panel closed.
  // We hold the prev active id across renders until the sessions query catches
  // up — only then can we tell deletion (session gone) from deselect (still there).
  // Scope the ref to {projectId, sessionId} so the route component being reused
  // across project switches doesn't make a stale ref look like a deletion in
  // the new project (which would auto-open a session there).
  const lastActiveRef = useRef<LastActiveSession | null>(null);
  const activeSessionId = terminals.activeSessionIdFor(selectedScopeKey);
  const lastHiddenSessionRef = useRef<{ projectId: string; sessionId: string } | null>(null);
  const archiveSessionRef = useRef<(sessionId: string) => void>(() => undefined);
  useEffect(() => {
    const onArchiveRequest = (e: Event) => {
      const sessionId = (e as CustomEvent<ArchiveActiveSessionEventDetail>).detail?.sessionId;
      if (typeof sessionId !== "string") return;
      archiveSessionRef.current(sessionId);
    };
    window.addEventListener(ARCHIVE_ACTIVE_SESSION_EVENT, onArchiveRequest);
    return () => window.removeEventListener(ARCHIVE_ACTIVE_SESSION_EVENT, onArchiveRequest);
  }, []);
  // Tell "the active session was deleted" from "the operator deselected it":
  // only the first hands the scope a replacement session. `archivedSessions` joins
  // the inputs because an archived row is never in the visible list, so without
  // it every deselect on one reads as a deletion — see `active-session-memory`.
  useEffect(() => {
    if (activeSessionId !== null) {
      lastActiveRef.current = rememberActiveSession(activeSessionId, selectedScopeKey, {
        sessions,
        archivedSessions,
        previous: lastActiveRef.current,
      });
      return;
    }
    const prev = lastActiveRef.current;
    if (!prev || prev.projectId !== selectedScopeKey || !terminalProject) return;
    const visible = sessions.filter((t) => !t.archived);
    if (!activeSessionWentAway(prev, selectedScopeKey, visible)) {
      // An archived row leaving the slot is always a deselect, and it can never
      // turn up in `visible` later — forget it instead of re-deciding it every
      // time the session list moves. A live row still on screen is kept, so its
      // deletion while deselected is still caught.
      if (prev.archived) lastActiveRef.current = null;
      return;
    }
    lastActiveRef.current = null;
    const next = pickByPriority(visible);
    if (next) toggleTerminalSession(terminalProject, next);
  }, [
    activeSessionId,
    sessions,
    archivedSessions,
    terminalProject,
    toggleTerminalSession,
    selectedScopeKey,
  ]);

  // Rehydrate after reload: if a persisted activeSessionId resolves to an
  // existing session for this project, materialize a session entry so the panel
  // reopens without requiring a click.
  useEffect(() => {
    if (!terminalProject) return;
    if (!activeSessionId) return;
    const session = sessions.find((t) => t.id === activeSessionId);
    if (session) rehydrateTerminal(terminalProject, session);
  }, [activeSessionId, terminalProject, sessions, rehydrateTerminal]);

  // The rehydrate above re-shows the active session on a project switch,
  // but its cached terminal surface reattaches blurred (it doesn't self-focus),
  // so the newly-shown session drops keystrokes until a manual click. Re-assert
  // keyboard focus once per scope switch — guarded by scope so it fires on the
  // switch (and first mount), not on every session refetch, which would yank the
  // caret while the user is typing. focusGridSession retries until the pane
  // mounts and is consumed by both SessionGrid (grid view) and TerminalPanel
  // (normal view), so a single call covers both layouts.
  const focusedScopeRef = useRef<string | null>(null);
  useEffect(() => {
    if (!terminalProject) return;
    if (focusedScopeRef.current === selectedScopeKey) return;
    if (!activeSessionId) return;
    focusedScopeRef.current = selectedScopeKey;
    terminals.focusGridSession(activeSessionId);
  }, [selectedScopeKey, terminalProject, activeSessionId, terminals]);

  const openRequestedSession = useCallback(
    (request: PendingSessionOpen) => {
      void (async () => {
        if (!terminalProject || request.projectId !== id) return;
        // A pending open is Core-scoped: same project id on two Cores is two
        // different projects. Leave requests for another Core untouched — the
        // navigation that enqueued them lands on `?coreId=<theirs>` and the
        // remounted route consumes them there.
        if (request.coreId !== coreId) return;
        // In grid view every open session is already on screen regardless of the
        // selected scope, so the panel-switching logic below does
        // nothing visible. If the target session is live, just spotlight its cell
        // so the user can pick it out; the scope guards would otherwise no-op.
        if (terminals.gridView && terminals.sessions.some((s) => s.sessionId === request.sessionId)) {
          terminals.focusGridSession(request.sessionId);
          clearPendingSessionOpen(request);
          return;
        }

        let session = sessions.find((entry) => entry.id === request.sessionId && !entry.archived) ?? null;

        if (!session) {
          if (sessionsQuery.isLoading) return;
          if (coreId) {
            // A Core's sessions only travel as core-link snapshots (already in
            // `sessions`); `api.getSession` reads the Panel's own rows and could
            // resolve a colliding id. Absent from the snapshot list ⇒ stale.
            clearPendingSessionOpen(request);
            return;
          }
          try {
            const { session: remoteSession } = await api.getSession(request.sessionId);
            if (!remoteSession || remoteSession.projectId !== id || remoteSession.archived) {
              clearPendingSessionOpen(request);
              return;
            }
            session = remoteSession;
          } catch {
            clearPendingSessionOpen(request);
            return;
          }
        }

        showRequestedSession({
          terminals,
          scopeKey: selectedScopeKey,
          project: terminalProject,
          session,
          coreId,
        });
        // Now that the session is materialized in the grid, spotlight its cell.
        if (terminals.gridView) terminals.focusGridSession(session.id);
        clearPendingSessionOpen(request);
      })();
    },
    [
      id,
      coreId,
      terminalProject,
      selectedScopeKey,
      sessions,
      sessionsQuery.isLoading,
      terminals,
    ],
  );

  useEffect(() => {
    const pending = readPendingSessionOpen(id);
    if (pending) openRequestedSession(pending);
  }, [id, openRequestedSession]);

  useEffect(() => {
    const onOpenRequest = (event: Event) => {
      const request = (event as CustomEvent<PendingSessionOpen>).detail;
      if (request) openRequestedSession(request);
    };
    window.addEventListener(SESSION_NOTIFICATION_OPEN_EVENT, onOpenRequest);
    return () => {
      window.removeEventListener(SESSION_NOTIFICATION_OPEN_EVENT, onOpenRequest);
    };
  }, [openRequestedSession]);

  const invalidateProject = useCallback(
    () => queryClient.invalidateQueries({ queryKey: queryKeys.project(id) }),
    [queryClient, id],
  );
  const invalidateSessions = useCallback(
    () =>
      queryClient.invalidateQueries({
        queryKey: sessionsCacheKey(id, coreId),
      }),
    [queryClient, id, coreId]
  );
  // The archived list lives in its own bucket outside the project key (ADR
  // 0019), so nothing else's invalidation reaches it — anything that can move
  // a row across the archived line has to say so.
  const invalidateArchivedSessions = useCallback(
    () =>
      coreId
        ? queryClient.invalidateQueries({
            queryKey: queryKeys.coreArchivedSessions(id, coreId),
          })
        : Promise.resolve(),
    [queryClient, id, coreId],
  );
  const invalidateProjects = useCallback(
    () => queryClient.invalidateQueries({ queryKey: queryKeys.projects }),
    [queryClient]
  );
  const refresh = useCallback(async () => {
    await Promise.all([
      invalidateProject(),
      invalidateSessions(),
      invalidateArchivedSessions(),
      invalidateProjects(),
    ]);
  }, [invalidateProject, invalidateSessions, invalidateArchivedSessions, invalidateProjects]);

  const [showCodexHooksNotice, setShowCodexHooksNotice] = useState(false);
  const [harnessUpdateRequired, setHarnessUpdateRequired] = useState<{
    agent: Session["agent"];
    availability: CliAvailability;
  } | null>(null);

  const showHarnessUpdateRequired = useCallback(
    (agent: Session["agent"], availability?: CliAvailability) => {
      setShowNewHarness(false);
      setHarnessUpdateRequired({
        agent,
        availability: availability ?? availabilityFor(cliAvailability, agent),
      });
    },
    [cliAvailability],
  );

  const createSession = useCallback(
    async (
      payload: SessionCreatePayload,
      opts?: { initialInput?: string; focusOnCreate?: boolean; model?: AiModelId | null },
    ) => {
      if (!project || !terminalProject) return;
      const selectedAvailability = availabilityFor(cliAvailability, payload.agent);
      if (selectedAvailability.status === "outdated") {
        showHarnessUpdateRequired(payload.agent, selectedAvailability);
        return;
      }
      if (selectedAvailability.status === "missing") {
        setShowNewHarness(true);
        return;
      }

      const sessionsKey = sessionsCacheKey(project.id, coreId);
      void queryClient.cancelQueries({ queryKey: sessionsKey });

      const usesPersistedSession =
        payload.agent === "claude-code" ||
        payload.agent === "cursor-cli";
      const claudeSessionId = usesPersistedSession ? newSessionId() : null;
      // Client-minted id so the optimistic card and the PTY agree on a session id
      // before the row exists.
      const clientSessionId = newClientId("t");
      const optimisticSession = buildOptimisticSession({
        id: clientSessionId,
        projectId: project.id,
        agent: payload.agent,
        claudeSessionId,
        claudeSkipPermissions: harnessLaunchesWithSkipPermissions(payload.agent),
        claudeBareSession: payload.agent === "claude-code" ? payload.bareSession : undefined,
      });
      appendOptimisticSession(queryClient, project.id, optimisticSession, coreId);
      if (opts?.initialInput) {
        // TerminalPane consumes this once, at the first spawn, as the PTY's
        // initialInput — the main process writes it after the agent TUI is ready.
        setPendingInitialInput(optimisticSession.id, opts.initialInput);
      }
      if (opts?.model) {
        setPendingSessionModel(optimisticSession.id, opts.model);
      }
      terminals.toggle(terminalProject, optimisticSession, {
        awaitCreate: false,
        coreId,
      });
      // Clone/new-session focus: put the caret in the just-added grid cell so the
      // user can type immediately. focusGridSession retries until the pane mounts
      // (and re-asserts across the awaitingCreate→persisted rebuild), so calling
      // it here — before the surface exists — is fine.
      if (opts?.focusOnCreate && terminals.gridView) {
        terminals.focusGridSession(optimisticSession.id);
      }

      void (async () => {
        try {
          // The Core owns the row (ADR-0004/0005), so starting a session is
          // a mutation frame to the Core the project lives on — there is no
          // Panel-side session table to write to instead. The frame doesn't carry
          // claudeSessionId / bareSession today, so a session creates as a
          // plain Harness session without those fields: no persisted-claude-session
          // resume until the protocol grows them. Skip-permissions is not a row
          // field any launch path reads — it is derived from the Harness
          // (issue 22).
          // A 0.5.0 Core refuses projectId on create (ADR 0041 D27). The published
          // SDK types still name it until actana/client#10 ships — cast away.
          const snapshot = await mutateSessionForCore(coreId, {
            op: "create",
            sessionId: clientSessionId,
            title: TITLE_WAITING,
            agent: payload.agent,
          } as Parameters<typeof mutateSessionForCore>[1]);
          if (!snapshot) throw new Error("Core did not return a session snapshot");
          const createdSession: Session = {
            ...remoteSessionFromSnapshot(snapshot),
            projectId: project.id,
          };
          replaceOptimisticSession(
            queryClient,
            project.id,
            optimisticSession.id,
            createdSession,
            coreId,
          );
          if (clientSessionId && createdSession.id === clientSessionId) {
            terminals.openSession(terminalProject, createdSession, { coreId });
          } else {
            const pendingModel = peekPendingSessionModel(optimisticSession.id);
            if (pendingModel) {
              clearPendingSessionModel(optimisticSession.id);
              setPendingSessionModel(createdSession.id, pendingModel);
            }
            terminals.adoptSessionId(optimisticSession.id, createdSession);
          }
          void Promise.all([invalidateProject(), invalidateSessions(), invalidateProjects()]);
          if (payload.agent === "codex" && !hasSeenCodexHooksNotice()) {
            setShowCodexHooksNotice(true);
          }
        } catch (e: unknown) {
          // The session never spawned — discard any staged prompt / model.
          takePendingInitialInput(optimisticSession.id);
          clearPendingSessionModel(optimisticSession.id);
          removeOptimisticSession(queryClient, project.id, optimisticSession.id, coreId);
          await terminals.close(optimisticSession.id);
          toast.error(e instanceof Error ? e.message : "Could not create session");
        }
      })();
    },
    [
      project,
      terminalProject,
      queryClient,
      invalidateProject,
      invalidateSessions,
      invalidateProjects,
      terminals,
      cliAvailability,
      showHarnessUpdateRequired,
    ]
  );

  // The session a fresh one should anchor on: the grid cell the user is looking
  // at, falling back to the scope's active session. Clone and "new session" both
  // use it so a new session lands beside — and takes focus from — that pane.
  const anchorSessionId = useCallback((): string | undefined => {
    // Live DOM focus first (a hotkey fires with a cell focused); then the grid's
    // last-focused cell reported to the store (a header-button click moved DOM
    // focus to the button); finally the scope's active session.
    for (const candidate of [readFocusedGridSessionId(), terminals.getGridFocusedSessionId()]) {
      if (candidate && sessions.some((t) => t.id === candidate)) return candidate;
    }
    return terminals.activeFor(selectedScopeKey)?.sessionId ?? undefined;
  }, [sessions, terminals, selectedScopeKey]);

  const startWithSaved = useCallback(() => {
    if (!project) return;
    if (!(project.rememberHarnessSettings && project.savedHarness)) return;
    const savedAvailability = availabilityFor(cliAvailability, project.savedHarness);
    if (savedAvailability.status === "outdated") {
      showHarnessUpdateRequired(project.savedHarness, savedAvailability);
      return;
    }
    if (savedAvailability.status === "missing") {
      setShowNewHarness(true);
      return;
    }
    // Drop the new session beside the active one and focus it, like Clone.
    const anchor = anchorSessionId();
    if (anchor) terminals.requestCloneInsertAfter(anchor);
    // void: `createSession` reports a failed create as a toast.
    void createSession(
      {
        agent: project.savedHarness,
        bareSession: project.savedHarness === "claude-code" ? !!project.savedBareSession : false,
      },
      { focusOnCreate: true },
    );
  }, [project, createSession, cliAvailability, showHarnessUpdateRequired, anchorSessionId, terminals]);

  const startWithSavedInNewRow = useCallback(() => {
    if (!project) return;
    if (!(project.rememberHarnessSettings && project.savedHarness)) return;
    const savedAvailability = availabilityFor(cliAvailability, project.savedHarness);
    if (savedAvailability.status === "outdated") {
      showHarnessUpdateRequired(project.savedHarness, savedAvailability);
      return;
    }
    if (savedAvailability.status === "missing") {
      setShowNewHarness(true);
      return;
    }
    // Start session in a fresh grid row instead of beside the active one.
    terminals.requestNewRow();
    // void: `createSession` reports a failed create as a toast.
    void createSession(
      {
        agent: project.savedHarness,
        bareSession: project.savedHarness === "claude-code" ? !!project.savedBareSession : false,
      },
      { focusOnCreate: true },
    );
  }, [project, createSession, cliAvailability, showHarnessUpdateRequired, terminals]);

  const onNewHarnessPrimary = useCallback(() => {
    if (!projectPathReady) return;
    if (showNewHarness) return;
    if (project?.rememberHarnessSettings && project.savedHarness) {
      void startWithSaved();
      return;
    }
    setShowNewHarness(true);
  }, [project, projectPathReady, showNewHarness, startWithSaved]);

  useHotkey("agent.new", onNewHarnessPrimary, { ignoreEditable: true });

  // Create-then-start onboarding: the Add-project flow hands off a one-shot
  // intent (see project-onboard-intent). On first render for the new project we
  // consume it, apply the chosen layout immediately, and — once the working
  // directory is ready — launch the saved agent so the user lands in a live
  // session instead of a dead empty page.
  const onboardConsumedForRef = useRef<string | null>(null);
  const onboardIntentRef = useRef<ProjectOnboardIntent | null>(null);
  const onboardStartedRef = useRef(false);
  const gridDefaultAppliedForRef = useRef<string | null>(null);
  useEffect(() => {
    if (onboardConsumedForRef.current === id) return;
    onboardConsumedForRef.current = id;
    onboardStartedRef.current = false;
    const intent = null as ProjectOnboardIntent | null;
    onboardIntentRef.current = intent;
    if (intent?.gridView != null) {
      terminals.setGridView(intent.gridView);
      // The intent already carries the layout for this first navigation; don't
      // re-apply the stored default on top of it.
      gridDefaultAppliedForRef.current = id;
    }
  }, [id, terminals]);
  // The layout the project was created with is a Core fact on the project row
  // (issue 22), so it applies on every later visit too — the one-shot onboard
  // intent above only covers the navigation that created the project.
  //
  // Two things this deliberately does not do. It does not persist: grid view is
  // one global preference shared by every project, and a project asserting its
  // own layout must not overwrite what the operator last chose everywhere else.
  // And it only ever turns the grid *on* — a project whose default is off says
  // nothing about the layout, so the operator's standing preference wins, which
  // is what Panel-owned projects (whose default is off) keep doing today.
  //
  // Applied once per project rather than on every render, so toggling the grid
  // off during a visit sticks.
  useEffect(() => {
    if (!project) return;
    if (gridDefaultAppliedForRef.current === id) return;
    gridDefaultAppliedForRef.current = id;
    if (project.defaultGridView) terminals.setGridView(true, { persist: false });
  }, [id, project, terminals]);
  useEffect(() => {
    const intent = onboardIntentRef.current;
    if (!intent || onboardStartedRef.current) return;
    if (!project || !projectPathReady) return;
    onboardStartedRef.current = true;
    onNewHarnessPrimary();
  }, [project, projectPathReady, onNewHarnessPrimary]);

  // New-row variant of agent.new: the session lands in a fresh grid row at the
  // bottom instead of beside the active one. Grid-only — rows don't exist
  // outside the grid.
  const onNewRowPrimary = useCallback(() => {
    if (!projectPathReady) return;
    if (showNewHarness) return;
    if (project?.rememberHarnessSettings && project.savedHarness) {
      void startWithSavedInNewRow();
      return;
    }
    setNewHarnessTarget("newRow");
    setShowNewHarness(true);
  }, [project, projectPathReady, showNewHarness, startWithSavedInNewRow]);

  // Ship: open an AI session that pushes/syncs with remote using Settings → Defaults → Ship.
  const startShipSession = useCallback(() => {
    if (!project || !projectPathReady) return;
    const payload = defaultSessionPayload(project);
    const anchor = anchorSessionId();
    if (anchor) terminals.requestCloneInsertAfter(anchor);
    void createSession(
      {
        ...payload,
        agent: settings?.shipHarness ?? "claude-code",
        bareSession: false,
      },
      {
        initialInput: settings?.shipPrompt ?? DEFAULT_SHIP_PROMPT,
        focusOnCreate: true,
        model: settings?.shipModel ?? null,
      },
    );
  }, [
    project,
    projectPathReady,
    createSession,
    settings?.shipHarness,
    settings?.shipModel,
    settings?.shipPrompt,
    anchorSessionId,
    terminals,
  ]);

  const anyBlockingDialogOpen =
    showNewHarness ||
    confirmDeleteArchived ||
    showCodexHooksNotice ||
    harnessUpdateRequired !== null;

  const cycleSession = useCallback(
    (direction: 1 | -1) => {
      if (!project || !terminalProject) return;
      if (anyBlockingDialogOpen) return;
      // When the grid is on screen it cycles by moving the focused cell through
      // the on-screen layout, which SessionGrid owns (it tracks "current" via
      // terminal focus, not the scope's active-session state that toggle() below
      // mutates). Let its own session.cycleNext/cyclePrev handlers drive it so
      // cycling is visible. Guard on showGrid (not gridViewActive) so the
      // empty-grid fallback — where SessionGrid isn't mounted — still falls
      // through to the normal cycle here. The grid stays mounted alongside the
      // docked diff panel, so cycling stays grid-owned while reviewing changes.
      if (showGrid) return;
      const visible = sessions.filter((t) => !t.archived);
      if (visible.length === 0) return;
      const ordered: Session[] = [];
      for (const status of STATUS_DISPLAY_ORDER) {
        for (const t of visible) if (t.status === status) ordered.push(t);
      }
      if (ordered.length === 0) return;
      const currentId = terminals.activeSessionIdFor(selectedScopeKey);
      // Panel closed: open the highest-priority card instead of cycling.
      if (!currentId) {
        const firstByPriority = pickByPriority(visible);
        if (!firstByPriority) return;
        terminals.toggle(terminalProject, firstByPriority);
        // Focus the terminal so the keyboard drives the newly-opened session
        // instead of leaving it blurred (see selectTerminal).
        terminals.focusGridSession(firstByPriority.id);
        return;
      }
      const idx = ordered.findIndex((t) => t.id === currentId);
      if (idx === -1) return;
      const nextIdx = (idx + direction + ordered.length) % ordered.length;
      const nextSession = ordered[nextIdx];
      if (!nextSession || nextSession.id === currentId) return;
      terminals.toggle(terminalProject, nextSession);
      // Carry keyboard focus into the session we cycled to, so successive
      // presses keep cycling and the caret is ready to type (see selectTerminal).
      terminals.focusGridSession(nextSession.id);
    },
    [
      project,
      terminalProject,
      selectedScopeKey,
      sessions,
      terminals,
      anyBlockingDialogOpen,
      showGrid,
    ],
  );

  const duplicateActiveSession = useCallback(
    (sourceSessionId?: string) => {
      if (!project) return;
      if (anyBlockingDialogOpen) return;
      // Resolve which session to clone, most-specific first:
      //  1. The session whose "Clone" button fired the event (menu path).
      //  2. The grid cell that currently holds focus — the pane the user is
      //     actually looking at when they hit Cmd+D. Without this the
      //     keyboard path anchors on the scope's tracked-active session, which
      //     in a multi-pane grid is often a different cell, so the clone lands
      //     beside the "wrong" session (or, if that session isn't in the
      //     rendered layout, in a seemingly random spot).
      //  3. The scope's active session (non-grid view / no cell focused).
      const focusedGridSessionId = readFocusedGridSessionId();
      const sourceSession =
        (sourceSessionId && sessions.find((t) => t.id === sourceSessionId)) ||
        (focusedGridSessionId && sessions.find((t) => t.id === focusedGridSessionId)) ||
        (() => {
          const active = terminals.activeFor(selectedScopeKey);
          return active ? sessions.find((t) => t.id === active.sessionId) : undefined;
        })();
      if (!sourceSession) return;
      // In grid view, drop the clone directly beside the session it came from
      // rather than at the end of the grid.
      terminals.requestCloneInsertAfter(sourceSession.id);
      void createSession(
        {
          agent: sourceSession.agent,
          bareSession: sourceSession.agent === "claude-code" ? !!sourceSession.claudeBareSession : false,
        },
        { focusOnCreate: true },
      );
    },
    [project, selectedScopeKey, sessions, terminals, createSession, anyBlockingDialogOpen],
  );
  const duplicateActiveSessionRef = useRef(duplicateActiveSession);
  duplicateActiveSessionRef.current = duplicateActiveSession;

  // Session cycling + clone go through the rebindable registry so a rebind in
  // Keybindings settings actually takes effect here (matches focus mode, which
  // wires the same actions via useHotkey). Capture phase mirrors the old direct
  // listener — a focused xterm textarea would otherwise swallow the chord first.
  // The shifted-bracket combos (Cmd+Shift+] → e.key "}") are resolved by
  // matchBinding's e.code fallback, so no manual e.code handling is needed.
  // List view only (cycleSession bails when the grid is on screen, which owns
  // these chords via SessionGrid): the chords are intentionally inverted here —
  // in the list the status-ordered cycle runs opposite to the visual direction
  // users expect, so "next" walks the order backwards. Grid view is unaffected.
  useHotkey("session.cycleNext", () => cycleSession(-1), { capture: true });
  useHotkey("session.cyclePrev", () => cycleSession(1), { capture: true });
  useHotkey("session.clone", () => duplicateActiveSession(), { capture: true });
  useHotkey(
    "session.newRow",
    () => {
      if (anyBlockingDialogOpen) return;
      onNewRowPrimary();
    },
    { capture: true, enabled: gridViewActive },
  );

  // The per-session "Clone" menu button dispatches this to clone a specific
  // session by id (registered once, so it reads the latest handler via a ref).
  useEffect(() => {
    const onDuplicateRequest = (e: Event) => {
      const sessionId = (e as CustomEvent<{ sessionId?: string }>).detail?.sessionId;
      duplicateActiveSessionRef.current(sessionId);
    };
    window.addEventListener(DUPLICATE_ACTIVE_SESSION_EVENT, onDuplicateRequest);
    return () => window.removeEventListener(DUPLICATE_ACTIVE_SESSION_EVENT, onDuplicateRequest);
  }, []);

  // Ship: open the commit/push/sync AI session. Capture phase so a focused
  // session terminal can't swallow the chord first; startShipSession itself
  // guards project/path-ready and the local-scope requirement.
  useHotkey(
    "project.ship",
    () => {
      if (anyBlockingDialogOpen || !projectPathReady) return;
      startShipSession();
    },
    { capture: true },
  );

  // Capture phase so a focused session terminal can't swallow the key first —
  // this must flip in/out of the grid even while typing in a session.
  useHotkey(
    "session.gridView",
    () => {
      if (anyBlockingDialogOpen) return;
      toggleGridViewShowingAll();
    },
    { capture: true },
  );

  const hiddenSession = lastHiddenSessionRef.current;
  const canRestoreHiddenSession =
    !!project &&
    hiddenSession?.projectId === selectedScopeKey &&
    terminals.sessions.some(
      (s) =>
        s.sessionId === hiddenSession.sessionId &&
        scopeKeyForProject(s.project) === selectedScopeKey,
    ) &&
    sessions.some((t) => t.id === hiddenSession.sessionId && !t.archived);
  const closePanelEnabled =
    !anyBlockingDialogOpen && !!project
      ? terminals.activeFor(selectedScopeKey) !== null || canRestoreHiddenSession
      : false;

  // Capture phase so xterm.js (focused terminal) can't swallow the key first.
  useHotkey(
    "terminal.close",
    () => {
      if (!project) return;
      // On screen, the grid owns terminal.close: it hides the focused cell's
      // session (SessionGrid's handleHideIntent) instead of toggling the single
      // active panel this handler tracks. Guard on showGrid (not gridViewActive)
      // so the empty-grid fallback — where SessionGrid isn't mounted — still
      // falls through to the panel hide here. Mirrors cycleSession.
      if (showGrid) return;
      const active = terminals.activeFor(selectedScopeKey);
      if (active) {
        lastHiddenSessionRef.current = { projectId: selectedScopeKey, sessionId: active.sessionId };
        terminals.deselect(selectedScopeKey);
        return;
      }
      const hidden = lastHiddenSessionRef.current;
      if (!hidden || hidden.projectId !== selectedScopeKey) return;
      const sessionStillOpen = terminals.sessions.some(
        (s) =>
          s.sessionId === hidden.sessionId &&
          scopeKeyForProject(s.project) === selectedScopeKey,
      );
      if (!sessionStillOpen) return;
      const session = sessions.find((t) => t.id === hidden.sessionId && !t.archived);
      if (!session) return;
      if (terminalProject) terminals.toggle(terminalProject, session);
    },
    {
      enabled: closePanelEnabled,
      capture: true,
    },
  );

  // Coalesce bursts of session events for THIS project into a single refetch. A
  // running agent emits many session:updated events per second; each used to
  // refetch this project's sessions + detail + the global projects list. The
  // sidebar (ProjectBar / ProjectPicker) owns the projects-list refresh, so
  // this route only refetches its own sessions + detail — and ignores session events
  // for other projects entirely.
  // maxWait bounds staleness under a sustained event storm: without it a
  // continuous <150ms stream would defer the refetch indefinitely.
  const invalidateThisProjectSessions = useDebouncedCallback(() => {
    void invalidateSessions();
    void invalidateProject();
  }, 150, 400);

  useServerEvents(
    useCallback(
      (e) => {
        applyQuestionServerEvent(e);
        if (e.type.startsWith("session:")) {
          if (e.projectId === id) {
            invalidateThisProjectSessions();
          }
        } else if (e.type.startsWith("project:")) {
          void invalidateProject();
          void invalidateProjects();
        }
      },
      [id, invalidateThisProjectSessions, invalidateProject, invalidateProjects, queryClient]
    )
  );

  // Auto-focus the board when a project's board first loads (and on every Cmd+U
  // project switch). Without this, focus can land on / remain inside a session
  // terminal's xterm <textarea> after the switch — which swallows bubble-phase
  // hotkeys and trips useHotkey's ignoreEditable guard — so shortcuts do nothing
  // until the user clicks the board background to blur the terminal. Moving focus
  // to the (non-editable) board container restores every shortcut immediately.
  const boardRef = useRef<HTMLDivElement>(null);
  const lastAutoFocusedProjectIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!project) return; // board not mounted yet (loading / error state)
    if (anyBlockingDialogOpen) return; // a dialog/overlay owns focus — don't fight it
    if (lastAutoFocusedProjectIdRef.current === id) return; // already handled this project
    const board = boardRef.current;
    if (!board) return;
    lastAutoFocusedProjectIdRef.current = id;
    // rAF so we win the parked-terminal reattach that happens on the same commit.
    const raf = requestAnimationFrame(() => {
      const active = document.activeElement;
      // Claim focus only from the states that actually eat shortcuts: a focused
      // session terminal (xterm) or a loose body/null focus. Never yank focus out
      // of a real form field the user may be typing in (search box, rename input,
      // the bottom user terminal).
      const onXterm = active instanceof HTMLElement && !!active.closest(".xterm");
      if (isEditableTarget(active) && !onXterm) return;
      board.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(raf);
  }, [id, project, anyBlockingDialogOpen]);

  const activeSessions = sessions.filter((t) => !t.archived);
  const pinnedSessions = activeSessions.filter((t) => t.pinned);
  const visibleSessions = showArchived ? archivedSessions : showPinned ? pinnedSessions : activeSessions;
  // Active list peels pinned into a top "Pinned" section; Pinned tab keeps
  // normal status grouping (already all-pinned). Archived folds every live
  // status into the single Archived column (no Interrupted/Running/etc.).
  const activeListGroups =
    !showArchived && !showPinned ? groupActiveListSessionsForDisplay(visibleSessions) : null;
  const sessionsByStatus = activeListGroups
    ? activeListGroups.byStatus
    : showArchived
      ? groupArchivedSessionsForDisplay(visibleSessions)
      : groupSessionsByStatusForDisplay(visibleSessions);
  const pinnedListSessions = activeListGroups?.pinned ?? [];

  const activeId = terminals.activeSessionIdFor(selectedScopeKey);
  const setSessionPinning = (sessionId: string, pinning: boolean) => {
    setPinningSessionIds((current) => {
      if (pinning && current.has(sessionId)) return current;
      if (!pinning && !current.has(sessionId)) return current;
      const next = new Set(current);
      if (pinning) next.add(sessionId);
      else next.delete(sessionId);
      return next;
    });
  };

  // Card click opens/focuses a session. Re-clicking the active card must not
  // hide the panel — only the session panel close button (or terminal.close
  // hotkey) deselects.
  const selectTerminal = (sessionId: string) => {
    openClickedSession(sessionId, {
      sessions,
      archivedSessions,
      project: terminalProject,
      coreId,
      terminals,
    });
  };

  const toggleSessionPinned = async (sessionId: string) => {
    if (!project) return;
    const session = sessions.find((t) => t.id === sessionId);
    if (!session || session.archived) return;
    const nextPinned = !session.pinned;
    const previousPinned = session.pinned;
    const requestId = (pinRequestSeqRef.current[sessionId] ?? 0) + 1;
    pinRequestSeqRef.current[sessionId] = requestId;
    setSessionPinning(sessionId, true);

    const sessionsKey = sessionsCacheKey(project.id, coreId);
    await queryClient.cancelQueries({ queryKey: sessionsKey });
    setSessionPinnedInCache(queryClient, project.id, sessionId, nextPinned, coreId);

    try {
      // Session pin is Core-owned state; the mutation goes over the coreId-
      // parameterised core-link surface (ADR-0005). For a Panel-owned row
      // this replaces the previous local-HTTP `api.updateSession({pinned})`
      // path — the DB row still moves, but the write travels through the
      // in-process core-link so two Panels connected to the same Core (once
      // that lands for a Panel-owned row) see the same pin state.
      const saved = await mutateSessionForCore(coreId, {
        op: "update",
        sessionId,
        pinned: nextPinned,
      });
      if (pinRequestSeqRef.current[sessionId] !== requestId) return;
      if (saved) {
        queryClient.setQueryData<Session[]>(sessionsKey, (current) =>
          (current ?? []).map((t) =>
            t.id === sessionId
              ? {
                  ...t,
                  pinned: saved.pinned,
                  updatedAt: saved.updatedAt,
                }
              : t,
          ),
        );
      }
      void invalidateSessions();
    } catch (e: unknown) {
      if (pinRequestSeqRef.current[sessionId] === requestId) {
        const currentSession = queryClient.getQueryData<Session[]>(sessionsKey)?.find((t) => t.id === sessionId);
        if (currentSession?.pinned === nextPinned) {
          setSessionPinnedInCache(queryClient, project.id, sessionId, previousPinned, coreId);
        }
        void invalidateSessions();
        toast.error(e instanceof Error ? e.message : "Could not update pinned session");
      }
    } finally {
      if (pinRequestSeqRef.current[sessionId] === requestId) {
        delete pinRequestSeqRef.current[sessionId];
        setSessionPinning(sessionId, false);
      }
    }
  };

  const deleteSession = (sessionId: string) => {
    const session = sessions.find((t) => t.id === sessionId);
    if (!session || !project) return;

    const sessionsKey = sessionsCacheKey(project.id, coreId);
    void queryClient.cancelQueries({ queryKey: sessionsKey });
    const previousSessions = queryClient.getQueryData<Session[]>(sessionsKey);

    const isActive = terminals.activeSessionIdFor(selectedScopeKey) === sessionId;
    const next = isActive
      ? pickByPriority(sessions.filter((t) => !t.archived && t.id !== sessionId))
      : undefined;

    // Point the panel at the replacement session before the deleted row disappears
    // or its PTY is torn down — otherwise close() briefly clears active and the
    // panel unmounts before the auto-select effect catches up.
    if (isActive && terminalProject) {
      if (next) terminals.openSession(terminalProject, next, { coreId });
      else terminals.deselect(selectedScopeKey);
    }

    removeSessionFromCache(queryClient, project.id, sessionId, coreId);

    void (async () => {
      try {
        await terminals.close(
          sessionId,
          isActive ? { activateSessionId: next?.id ?? null } : undefined,
        );
        // Route to the Core that owns the row (ADR 0005) — the Panel's own
        // delete endpoint only knows Panel-owned rows.
        await mutateSessionForCore(coreId, { op: "delete", sessionId });
        void refresh();
      } catch (e: unknown) {
        if (previousSessions) {
          restoreSessionsCache(queryClient, project.id, previousSessions, coreId);
        }
        toast.error(e instanceof Error ? e.message : "Could not delete session");
      } finally {
        setCleanupStatus(null);
      }
    })();
  };

  // Archive one or more active sessions: kill each tty, flip the archived flag,
  // and repoint the terminal panel if the active session is being archived.
  // No confirmation — archiving is reversible via Restore, for a Core-owned
  // row as much as a Panel-owned one: the Core lists its archived rows over
  // their own frame (ADR 0019), so the row reappears under Archived.
  const archiveSessions = (targets: Session[]) => {
    if (!project || targets.length === 0) return;
    const ids = new Set(targets.map((t) => t.id));

    const sessionsKey = sessionsCacheKey(project.id, coreId);
    void queryClient.cancelQueries({ queryKey: sessionsKey });
    const previousSessions = queryClient.getQueryData<Session[]>(sessionsKey);

    const activeSessionId = terminals.activeSessionIdFor(selectedScopeKey);
    const archivingActive = !!activeSessionId && ids.has(activeSessionId);
    const next = archivingActive
      ? pickByPriority(sessions.filter((t) => !t.archived && !ids.has(t.id)))
      : undefined;

    // Repoint the panel at the replacement session before the PTY is torn down,
    // mirroring deleteSession so the panel doesn't briefly unmount.
    if (archivingActive && terminalProject) {
      if (next) terminals.openSession(terminalProject, next, { coreId });
      else terminals.deselect(selectedScopeKey);
    }

    setSessionsArchivedInCache(queryClient, project.id, ids, true, coreId);
    // Bump the count the Archived tab is gated on, so the tab appears with the
    // row rather than one refetch later — the mirror of what restore does when
    // it takes a row back out (ADR 0019). A Panel-owned project counts its own
    // rows and needs no bucket.
    const countKey = coreId ? queryKeys.coreArchivedSessionCount(project.id, coreId) : null;
    const previousCount = countKey ? queryClient.getQueryData<number>(countKey) : undefined;
    if (countKey) {
      queryClient.setQueryData<number>(countKey, (current) => (current ?? 0) + ids.size);
    }

    void (async () => {
      try {
        await Promise.all(
          targets.map(async (t) => {
            await terminals
              .close(
                t.id,
                t.id === activeSessionId ? { activateSessionId: next?.id ?? null } : undefined,
              )
              .catch(() => undefined);
            // Route to the Core that owns the row (ADR 0005) — the Panel's
            // own archive endpoint only knows Panel-owned rows.
            await mutateSessionForCore(coreId, {
              op: "update",
              sessionId: t.id,
              archived: true,
            });
          }),
        );
        void refresh();
      } catch (e: unknown) {
        if (previousSessions) {
          restoreSessionsCache(queryClient, project.id, previousSessions, coreId);
        }
        if (countKey && previousCount !== undefined) {
          queryClient.setQueryData<number>(countKey, previousCount);
        }
        toast.error(e instanceof Error ? e.message : "Could not archive session");
      }
    })();
  };

  const archiveSession = (sessionId: string) => {
    const session = sessions.find((t) => t.id === sessionId);
    if (session) archiveSessions([session]);
  };
  archiveSessionRef.current = archiveSession;

  // Archive every open session shown in the grid (across all projects). Used by
  // the grid-view header's "Archive all" action. Plain function (not a hook)
  // because it lives after this component's early returns.
  const archiveAllGridSessions = async () => {
    // Only archive the sessions shown in this project/scope's grid, not every
    // open session across all projects.
    const openSessions = terminals.sessions.filter(
      (s) => scopeKeyForProject(s.project) === selectedScopeKey,
    );
    if (openSessions.length === 0) return;
    const results = await Promise.allSettled(
      openSessions.map((session) =>
        archiveOpenSession(session, terminals.close, queryClient, { skipInvalidate: true }),
      ),
    );
    // One deduped invalidation pass instead of a per-session fan-out (the
    // global projects key alone would otherwise be invalidated N times).
    await invalidateSessionQueries(queryClient, openSessions);
    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed > 0) {
      toast.error(
        failed === openSessions.length
          ? "Could not archive sessions"
          : `Archived ${openSessions.length - failed} of ${openSessions.length} sessions`,
      );
    }
  };

  // Un-archive one session, routed by owner like every other session mutation.
  //
  // The two owners keep their rows in different buckets, so the optimistic
  // move differs. A Panel-owned row is already in the session list with
  // `archived: true` — clearing the flag there moves it between the two
  // views. A Core's archived rows live in their own list (ADR 0019), so the
  // row leaves that one and the count that gates the tab drops with it; the
  // refetch behind `refresh()` is what puts it back in the active list.
  const restoreSession = (sessionId: string) => {
    if (!project) return;
    const session = archivedSessions.find((t) => t.id === sessionId) ?? sessions.find((t) => t.id === sessionId);
    if (!session) return;

    const sessionsKey = sessionsCacheKey(project.id, coreId);
    void queryClient.cancelQueries({ queryKey: sessionsKey });
    const previousSessions = queryClient.getQueryData<Session[]>(sessionsKey);
    const archivedKey = coreId ? queryKeys.coreArchivedSessions(project.id, coreId) : null;
    const previousArchived = archivedKey
      ? queryClient.getQueryData<Session[]>(archivedKey)
      : undefined;
    const countKey = coreId ? queryKeys.coreArchivedSessionCount(project.id, coreId) : null;
    const previousCount = countKey ? queryClient.getQueryData<number>(countKey) : undefined;

    if (archivedKey && countKey) {
      void queryClient.cancelQueries({ queryKey: archivedKey });
      queryClient.setQueryData<Session[]>(archivedKey, (current) =>
        (current ?? []).filter((t) => t.id !== sessionId),
      );
      queryClient.setQueryData<number>(countKey, (current) => Math.max(0, (current ?? 1) - 1));
    } else {
      setSessionArchivedInCache(queryClient, project.id, sessionId, false, coreId);
    }

    void (async () => {
      try {
        await mutateSessionForCore(coreId, { op: "update", sessionId, archived: false });
        void refresh();
      } catch (e: unknown) {
        if (previousSessions) {
          restoreSessionsCache(queryClient, project.id, previousSessions, coreId);
        }
        if (archivedKey && previousArchived) {
          queryClient.setQueryData<Session[]>(archivedKey, previousArchived);
        }
        if (countKey && previousCount !== undefined) {
          queryClient.setQueryData<number>(countKey, previousCount);
        }
        toast.error(e instanceof Error ? e.message : "Could not restore session");
      }
    })();
  };

  // Refresh the stable SessionCard handler wrappers with this render's closures so
  // the memoized cards always invoke the latest logic without changing identity.
  sessionCardHandlersRef.current = {
    onToggle: selectTerminal,
    onArchive: archiveSession,
    onRestore: restoreSession,
    onDelete: deleteSession,
    onTogglePinned: toggleSessionPinned,
  };

  // Delete every archived row shown for this project. Routed by owner like
  // every other session mutation; the rows come from wherever this project's
  // Archived view sources them (ADR 0019), which for a Core is its own list.
  const deleteAllArchived = () => {
    setConfirmDeleteArchived(false);
    if (!project) return;
    const archived = archivedSessions;
    if (archived.length === 0) return;

    const sessionsKey = sessionsCacheKey(project.id, coreId);
    void queryClient.cancelQueries({ queryKey: sessionsKey });
    const previousSessions = queryClient.getQueryData<Session[]>(sessionsKey);
    const archivedIds = new Set(archived.map((t) => t.id));
    removeSessionsFromCache(queryClient, project.id, archivedIds, coreId);
    if (coreId) {
      queryClient.setQueryData<Session[]>(queryKeys.coreArchivedSessions(project.id, coreId), []);
      queryClient.setQueryData<number>(queryKeys.coreArchivedSessionCount(project.id, coreId), 0);
    }

    void (async () => {
      try {
        await Promise.all(
          archived.map(async (t) => {
            await terminals.close(t.id).catch(() => undefined);
            await mutateSessionForCore(coreId, { op: "delete", sessionId: t.id });
          }),
        );
        void refresh();
      } catch (e: unknown) {
        if (previousSessions) {
          restoreSessionsCache(queryClient, project.id, previousSessions, coreId);
        }
        if (coreId) {
          queryClient.setQueryData<Session[]>(
            queryKeys.coreArchivedSessions(project.id, coreId),
            archived,
          );
          queryClient.setQueryData<number>(
            queryKeys.coreArchivedSessionCount(project.id, coreId),
            archived.length,
          );
        }
        toast.error(e instanceof Error ? e.message : "Could not delete archived sessions");
      } finally {
        setCleanupStatus(null);
      }
    })();
  };

  const startHarness = (data: {
    agent: Session["agent"];
    title: string;
    prompt: string;
    bareSession: boolean;
  }) => {
    setShowNewHarness(false);
    if (newHarnessTarget === "newRow") {
      terminals.requestNewRow();
    } else {
      const anchor = anchorSessionId();
      if (anchor) terminals.requestCloneInsertAfter(anchor);
    }
    setNewHarnessTarget("default");
    void createSession(
      {
        agent: data.agent,
        bareSession: data.bareSession,
      },
      {
        focusOnCreate: true,
        initialInput: data.prompt || undefined,
      },
    );
  };

  // Grid-view toggle lives in the project header beside the other session
  // controls — a session view mode, not app chrome, so it left the top bar.
  const gridViewToggle = (
    <HotkeyTooltip
      action="session.gridView"
      label={terminals.gridView ? "Exit grid view" : "Grid view — show all sessions"}
    >
      <Btn
        variant="ghost"
        onClick={toggleGridViewShowingAll}
        aria-label={terminals.gridView ? "Exit grid view" : "Grid view — show all sessions"}
        aria-pressed={terminals.gridView}
        style={{
          width: 40,
          minWidth: 40,
          paddingInline: 0,
          background: terminals.gridView ? "var(--surface-2)" : undefined,
          color: terminals.gridView ? "var(--text)" : undefined,
        }}
      >
        <GridViewToggleIcon gridView={terminals.gridView} />
      </Btn>
    </HotkeyTooltip>
  );

  return (
    <>
      <CursorGlow />
      <div
        ref={boardRef}
        tabIndex={-1}
        style={{
          flex: 1,
          minHeight: 0,
          overflow: showGrid ? "hidden" : "auto",
          padding: 0,
          display: "flex",
          flexDirection: "column",
        }}
        className="dot-grid-bg"
      >
      <CardFrame
        className="mc-project-frame"
        style={{
          width: "100%",
          minHeight: showGrid ? 0 : "100%",
          flex: showGrid ? 1 : undefined,
          flexShrink: showGrid ? undefined : 0,
          boxSizing: "border-box",
          padding: 8,
          display: showGrid ? "flex" : undefined,
          flexDirection: showGrid ? "column" : undefined,
          overflow: showGrid ? "hidden" : undefined,
        }}
      >
        <div
          className="mc-project-header"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            rowGap: 10,
            flexWrap: "wrap",
            margin: showGrid ? "-8px -8px 12px" : "-8px -8px 32px",
            padding: "22px 24px 18px",
            position: "relative",
            isolation: "isolate",
            zIndex: 2,
          }}
        >
          <Btn
            variant="ghost"
            icon="chevron-left"
            onClick={() =>
              void router.navigate({
                to: "/cores/$coreId",
                params: { coreId },
                search: { tab: "sessions" },
              })
            }
            title="Back to this Core's Sessions"
          >
            Sessions
          </Btn>
          {showGrid && gridScopeSessionCount > 0 && (
            <div ref={overflowRef} style={{ position: "relative", flex: "0 0 auto", display: "inline-flex" }}>
              <Btn
                variant="ghost"
                icon="more"
                onClick={() => setOverflowOpen((v) => !v)}
                aria-haspopup="menu"
                aria-expanded={overflowOpen}
                aria-label="Session actions"
              />
              {overflowOpen &&
                overflowMenuRect &&
                createPortal(
                  <CardFrame
                    ref={overflowDropdownRef}
                    role="menu"
                    solid
                    className="mc-project-actions-menu"
                    style={{
                      position: "fixed",
                      top: overflowMenuRect.top,
                      left: overflowMenuRect.left,
                      minWidth: overflowMenuRect.minWidth,
                      boxShadow: "0 14px 32px rgba(0,0,0,0.42)",
                      zIndex: Z_INDEX.popover,
                    }}
                  >
                    <DropdownMenuItem
                      icon="archive"
                      onClick={() => {
                        setOverflowOpen(false);
                        setConfirmArchiveAll(true);
                      }}
                      title="Archive all open sessions in this grid"
                    >
                      Archive all sessions
                    </DropdownMenuItem>
                  </CardFrame>,
                  document.body,
                )}
            </div>
          )}
          {hideableMenu}
          {showSessionScopeToggle && (
            <SessionScopeToggle
              view={sessionView}
              activeCount={activeSessions.length}
              pinnedCount={pinnedSessions.length}
              archivedCount={archivedCount}
              showArchivedTab={hasArchivedSessions || showArchived}
              onChange={setSessionView}
            />
          )}
          {/* Grid arrangement (row width lock + sort) edits the persisted Active
           * layout, so it hides in the read-through Pinned tab — mirrors how the
           * grid disables reorder/resize there. */}
          {showGrid && !showPinned && (
            <GridLayoutButton scopeKey={selectedScopeKey} />
          )}
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "flex-end",
              gap: 6,
              flexWrap: "wrap",
              marginLeft: "auto",
              minWidth: 0,
            }}
          >
            {headerButtons.gridView && gridViewToggle}
            {!showArchived && (
              <NewHarnessButton
                remembered={!!(project.rememberHarnessSettings && project.savedHarness)}
                savedHarness={project.savedHarness}
                onPrimary={onNewHarnessPrimary}
                onNewRow={showGrid ? onNewRowPrimary : undefined}
                disabled={!projectPathReady}
                onConfigure={() => {
                  if (projectPathReady) setShowNewHarness(true);
                }}
              />
            )}
            {showArchived && archivedSessions.length > 0 && (
              <Btn
                variant="danger"
                icon="trash"
                onClick={() => setConfirmDeleteArchived(true)}
                title="Permanently delete all archived sessions"
              >
                Delete all
              </Btn>
            )}
          </div>
        </div>

        {showGrid ? (
          <SessionGrid
            scopeKey={selectedScopeKey}
            coreId={coreId}
            filter={showPinned ? "pinned" : "active"}
            pinnedSessionIds={pinnedSessionIds}
            onTogglePinned={(id) => void toggleSessionPinned(id)}
            pinningSessionIds={pinningSessionIds}
          />
        ) : (
        <>
        {cleanupStatus && (
          <div
            role="status"
            aria-live="polite"
            aria-atomic="true"
            style={{
              margin: "0 12px 28px",
              padding: "10px 12px",
              border: "1px solid var(--border)",
              borderRadius: 8,
              background: "var(--surface-1)",
              color: "var(--text-dim)",
              fontSize: 12,
              fontFamily: "var(--mono)",
            }}
          >
            {cleanupStatus}
          </div>
        )}

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 48,
            paddingInline: 12,
            boxSizing: "border-box",
          }}
        >
          {sessionsQuery.isLoading ? (
            <EmptyState
              title="Loading sessions"
              subtitle="Fetching the hosted session list and terminal state."
              icon="sparkles"
            />
          ) : sessionsQuery.isError ? (
            <EmptyState
              title="Could not load sessions"
              subtitle="Actana Control could not load sessions for this Core. Retry before starting new work."
              icon="shield"
              action={
                <Btn variant="primary" icon="refresh" onClick={() => void sessionsQuery.refetch()}>
                  Retry
                </Btn>
              }
            />
          ) : showArchived && archivedSessionsQuery.isLoading ? (
            // A Core fetches its archived rows over their own frame when this
            // view opens (ADR 0019), so unlike the active list there is a real
            // wait here. Both branches stay dark for a Panel-owned project,
            // whose query is disabled and so never pending-and-fetching.
            <EmptyState
              title="Loading archived sessions"
              subtitle="Fetching this Core's archived sessions."
              icon="sparkles"
            />
          ) : showArchived && archivedSessionsQuery.isError ? (
            <EmptyState
              title="Could not load archived sessions"
              subtitle="Actana Control could not reach the Core that owns these sessions. Retry to see them."
              icon="shield"
              action={
                <Btn
                  variant="primary"
                  icon="refresh"
                  onClick={() => void archivedSessionsQuery.refetch()}
                >
                  Retry
                </Btn>
              }
            />
          ) : showArchived && visibleSessions.length === 0 ? (
            <EmptyState
              title="No archived sessions"
              subtitle="Archive a finished session to keep it around without cluttering your active list."
              icon="archive"
              action={
                <Btn variant="primary" icon="list" onClick={() => setSessionView("active")}>
                  View active
                </Btn>
              }
            />
          ) : showPinned && visibleSessions.length === 0 ? (
            <EmptyState
              title="No pinned sessions"
              subtitle="Pin sessions you want to keep an eye on, like loop runs."
              icon="pin"
              action={
                <Btn variant="primary" icon="terminal" onClick={() => setSessionView("active")}>
                  Back to active
                </Btn>
              }
            />
          ) : visibleSessions.length === 0 ? (
            <EmptyState
              title="No active sessions"
              subtitle="Start a new session on this Core."
              action={
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <NewHarnessButton
                    remembered={!!(project.rememberHarnessSettings && project.savedHarness)}
                    savedHarness={project.savedHarness}
                    onPrimary={onNewHarnessPrimary}
                    disabled={!projectPathReady}
                    onConfigure={() => {
                      if (projectPathReady) setShowNewHarness(true);
                    }}
                  />
                  {hasArchivedSessions && (
                    <Btn variant="ghost" icon="archive" onClick={() => setSessionView("archived")}>
                      View archived
                    </Btn>
                  )}
                </div>
              }
            />
          ) : (
            <>
              {pinnedListSessions.length > 0 && (
                <SessionColumn
                  key={`${id}:pinned`}
                  title="Pinned"
                  color="var(--accent)"
                  sessions={pinnedListSessions}
                  activeId={activeId}
                  onToggle={stableSelectTerminal}
                  onArchive={stableArchiveSession}
                  onTogglePinned={stableToggleSessionPinned}
                  pinningSessionIds={pinningSessionIds}
                />
              )}
              {STATUS_DISPLAY_ORDER.filter((s) => sessionsByStatus[s].length > 0).map((status) => {
                const isArchivedTitleRow = showArchived && status === "finished";
                const firstArchivedStatus = showArchived
                  ? STATUS_DISPLAY_ORDER.find((s) => sessionsByStatus[s].length > 0)
                  : undefined;
                // Prefer the "Archived" (finished) row; otherwise put the exit
                // control on the first visible archived status column.
                const showViewActive =
                  showArchived &&
                  (isArchivedTitleRow ||
                    (sessionsByStatus.finished.length === 0 && status === firstArchivedStatus));
                return (
                <SessionColumn
                  key={`${id}:${status}`}
                  title={
                    isArchivedTitleRow
                      ? "Archived"
                      : STATUS_META[status].label
                  }
                  color={STATUS_META[status].color}
                  sessions={sessionsByStatus[status]}
                  activeId={activeId}
                  onToggle={stableSelectTerminal}
                  onArchive={showArchived ? undefined : stableArchiveSession}
                  onRestore={showArchived ? stableRestoreSession : undefined}
                  onDelete={showArchived ? stableDeleteSession : undefined}
                  onTogglePinned={showArchived ? undefined : stableToggleSessionPinned}
                  pinningSessionIds={showArchived ? undefined : pinningSessionIds}
                  headerAction={
                    showViewActive ? (
                      <Btn
                        variant="ghost"
                        icon="list"
                        onClick={() => setSessionView("active")}
                        title="Back to active sessions"
                      >
                        View active
                      </Btn>
                    ) : !showArchived && status === "finished" && sessionsByStatus.finished.length > 0 ? (
                      <Btn
                        variant="ghost"
                        icon="archive"
                        onClick={() => archiveSessions(sessionsByStatus.finished)}
                        title="Archive all finished sessions"
                      >
                        Archive all
                      </Btn>
                    ) : !showArchived &&
                      status === "disconnected" &&
                      sessionsByStatus.disconnected.length > 0 ? (
                      <Btn
                        variant="ghost"
                        icon="archive"
                        onClick={() => archiveSessions(sessionsByStatus.disconnected)}
                        title="Archive all disconnected sessions"
                      >
                        Archive all
                      </Btn>
                    ) : undefined
                  }
                />
                );
              })}
              {!showArchived && hasArchivedSessions && (
                <div
                  style={{
                    display: "flex",
                    justifyContent: "center",
                    paddingTop: 4,
                    paddingBottom: 12,
                  }}
                >
                  <Btn
                    variant="ghost"
                    icon="archive"
                    onClick={() => setSessionView("archived")}
                    title={`View ${archivedCount} archived session${archivedCount === 1 ? "" : "s"}`}
                  >
                    View archived
                  </Btn>
                </div>
              )}
            </>
          )}
        </div>
        </>
        )}
      </CardFrame>

      <CodexHooksNoticeDialog
        open={showCodexHooksNotice}
        onClose={() => {
          setShowCodexHooksNotice(false);
          markCodexHooksNoticeSeen();
        }}
      />

      <HarnessUpdateRequiredDialog
        open={harnessUpdateRequired !== null}
        agent={harnessUpdateRequired?.agent ?? null}
        availability={harnessUpdateRequired?.availability ?? null}
        onClose={() => setHarnessUpdateRequired(null)}
      />

      <NewHarnessDialog
        open={showNewHarness}
        coreId={coreId}
        coreLabel={coreLabel}
        initialRemember={{
          rememberHarnessSettings: project.rememberHarnessSettings,
          savedHarness: project.savedHarness,
        }}
        onClose={() => {
          setShowNewHarness(false);
          setNewHarnessTarget("default");
        }}
        onStart={startHarness}
        onHarnessUpdateRequired={showHarnessUpdateRequired}
        onPersistRemember={(patch) => {
          writeCoreRemember(coreId, patch);
          setRememberTick((n) => n + 1);
        }}
      />

      <ConfirmDialog
        open={confirmDeleteArchived}
        onClose={() => setConfirmDeleteArchived(false)}
        onConfirm={deleteAllArchived}
        title="Delete archived sessions"
        confirmLabel="Delete all"
        icon="trash"
        width={460}
      >
        <div style={{ fontSize: 13, color: "var(--text)", marginBottom: 8 }}>
          Permanently delete all archived sessions on &ldquo;{coreLabel}&rdquo;?
        </div>
        <div style={{ fontSize: 12, color: "var(--text-dim)" }}>
          {archivedCount} archived session{archivedCount === 1 ? "" : "s"} will be deleted. This cannot be undone. Active sessions are unaffected.
        </div>
      </ConfirmDialog>

      <ConfirmDialog
        open={confirmArchiveAll}
        onClose={() => setConfirmArchiveAll(false)}
        onConfirm={async () => {
          setArchivingAll(true);
          try {
            await archiveAllGridSessions();
          } finally {
            setArchivingAll(false);
            setConfirmArchiveAll(false);
          }
        }}
        title="Archive all sessions?"
        confirmLabel="Archive all"
        variant="danger"
        icon="archive"
        loading={archivingAll}
        width={460}
      >
        <div style={{ fontSize: 13, color: "var(--text)", marginBottom: 8 }}>
          Archive all {gridScopeSessionCount} open session
          {gridScopeSessionCount === 1 ? "" : "s"} on &ldquo;{coreLabel}&rdquo;?
        </div>
        <div style={{ fontSize: 12, color: "var(--text-dim)" }}>
          Any running sessions will be disconnected and their agents stopped. You
          can restore archived sessions later, but in-progress runs won&rsquo;t resume.
        </div>
      </ConfirmDialog>

      </div>
    </>
  );
}

function SessionScopeToggle({
  view,
  activeCount,
  pinnedCount,
  archivedCount,
  showArchivedTab,
  onChange,
}: {
  view: SessionView;
  activeCount: number;
  pinnedCount: number;
  archivedCount: number;
  showArchivedTab: boolean;
  onChange: (view: SessionView) => void;
}) {
  const [open, setOpen] = useState(false);
  const [menuRect, setMenuRect] = useState<{ top: number; left: number } | null>(null);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLElement>(null);

  const tabs: Array<{
    view: SessionView;
    label: string;
    count: number;
    icon: "terminal" | "pin-fill" | "archive";
  }> = [
    { view: "active", label: "Active", count: activeCount, icon: "terminal" },
    { view: "pinned", label: "Pinned", count: pinnedCount, icon: "pin-fill" },
  ];
  if (showArchivedTab) {
    tabs.push({ view: "archived", label: "Archived", count: archivedCount, icon: "archive" });
  }
  const current = tabs.find((tab) => tab.view === view) ?? tabs[0]!;

  const updateMenuRect = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    setMenuRect({ top: rect.bottom + 6, left: rect.left });
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      setMenuRect(null);
      return;
    }
    updateMenuRect();
    window.addEventListener("resize", updateMenuRect);
    window.addEventListener("scroll", updateMenuRect, true);
    return () => {
      window.removeEventListener("resize", updateMenuRect);
      window.removeEventListener("scroll", updateMenuRect, true);
    };
  }, [open, updateMenuRect]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (anchorRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // If archived empties while that view is selected, the parent flips back to
  // active — close the menu so it doesn't linger over a removed option.
  useEffect(() => {
    if (!showArchivedTab && view !== "archived") setOpen(false);
  }, [showArchivedTab, view]);

  const select = (next: SessionView) => {
    setOpen(false);
    onChange(next);
  };

  return (
    <div ref={anchorRef} style={{ position: "relative", display: "inline-flex" }}>
      <Btn
        type="button"
        variant="ghost"
        icon={current.icon}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Show ${current.label.toLowerCase()} sessions, ${current.count}. Change session filter`}
        title={`${current.label} · ${current.count}`}
        onClick={() => setOpen((v) => !v)}
        style={{ paddingInline: 8 }}
      >
        <Icon
          name="chevron-down"
          size={11}
          style={{
            color: "var(--text-faint)",
            flexShrink: 0,
            transform: open ? "rotate(180deg)" : undefined,
            transition: "transform 120ms ease",
          }}
        />
      </Btn>
      {open &&
        menuRect &&
        createPortal(
          <CardFrame
            ref={menuRef}
            role="menu"
            aria-label="Show sessions by type"
            solid
            className="mc-project-actions-menu"
            style={{
              position: "fixed",
              top: menuRect.top,
              left: menuRect.left,
              minWidth: 180,
              boxShadow: "0 14px 32px rgba(0,0,0,0.42)",
              zIndex: Z_INDEX.popover,
            }}
          >
            {tabs.map((tab) => {
              const selected = view === tab.view;
              return (
                <DropdownMenuItem
                  key={tab.view}
                  icon={tab.icon}
                  aria-current={selected ? "true" : undefined}
                  onClick={() => select(tab.view)}
                  style={
                    selected
                      ? { background: "color-mix(in srgb, var(--accent) 14%, transparent)" }
                      : undefined
                  }
                >
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 8, width: "100%" }}>
                    <span style={{ flex: 1 }}>{tab.label}</span>
                    <span
                      style={{
                        fontFamily: "var(--mono)",
                        fontSize: 11,
                        color: "var(--text-dim)",
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {tab.count}
                    </span>
                  </span>
                </DropdownMenuItem>
              );
            })}
          </CardFrame>,
          document.body,
        )}
    </div>
  );
}

