import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { Btn } from "~/components/ui/Btn";
import { CardFrame } from "~/components/ui/CardFrame";
import { DropdownMenuItem, DropdownMenuSeparator } from "~/components/ui/DropdownMenuItem";
import { Icon } from "~/components/ui/Icon";
import { GridViewToggleIcon } from "~/components/ui/GridViewToggleIcon";
import { Z_INDEX } from "~/lib/z-index";
import { openExternal } from "~/lib/open-external";
import { ProjectIcon } from "~/components/ui/ProjectIcon";
import { EmptyState } from "~/components/ui/EmptyState";
import { TaskColumn } from "~/components/views/TaskColumn";
import { NewHarnessDialog } from "~/components/views/NewHarnessDialog";
import {
  CodexHooksNoticeDialog,
  hasSeenCodexHooksNotice,
  markCodexHooksNoticeSeen,
} from "~/components/views/CodexHooksNoticeDialog";
import { HarnessUpdateRequiredDialog } from "~/components/views/HarnessUpdateRequiredDialog";
import { ProjectDialog } from "~/components/views/ProjectDialog";
import { GridLayoutButton } from "~/components/views/GridLayoutButton";
import { SessionGrid } from "~/components/views/SessionGrid";
import { archiveOpenSession, invalidateSessionQueries } from "~/lib/archive-session";
import { consumeProjectOnboardIntent, type ProjectOnboardIntent } from "~/lib/project-onboard-intent";
import { useHideableMenu } from "~/lib/hideable-elements";
import { DEFAULT_HEADER_BUTTON_VISIBILITY } from "~/shared/header-buttons";
import { NewHarnessButton } from "~/components/views/NewHarnessButton";
import { CursorGlow } from "~/components/ui/CursorGlow";
import { HotkeyTooltip, StaticHotkeyTooltip } from "~/components/ui/Tooltip";
import { Modal } from "~/components/ui/Modal";
import { ConfirmDialog } from "~/components/ui/ConfirmDialog";
import { RemoveProjectConfirmDialog } from "~/components/views/RemoveProjectConfirmDialog";
import { isEditableTarget, useHotkey } from "~/lib/use-hotkey";
import { api } from "~/lib/api";
import { mutateProjectForCore } from "~/lib/mutate-project-for-core";
import { saveProjectEdits } from "~/lib/save-project-edits";
import { mutateTaskForCore } from "~/lib/mutate-task-for-core";
import { newSessionId } from "~/lib/claude-command";
import { TITLE_WAITING } from "~/lib/task-sentinels";
import {
  appendOptimisticTask,
  buildOptimisticTask,
  removeOptimisticTask,
  removeTaskFromCache,
  removeTasksFromCache,
  replaceOptimisticTask,
  restoreTasksCache,
  setTaskArchivedInCache,
  setTaskPinnedInCache,
  setTasksArchivedInCache,
} from "~/lib/optimistic-task";
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
  groupActiveListTasksForDisplay,
  groupArchivedTasksForDisplay,
  groupTasksByStatusForDisplay,
} from "~/lib/task-display-order";
import {
  DEFAULT_BRANCH,
  type Harness,
  STATUS_DISPLAY_ORDER,
} from "@actana/shared/domain";
import { harnessLaunchesWithSkipPermissions } from "@actana/shared/harnesses";
import {
  queryKeys,
  remoteTaskFromSnapshot,
  tasksCacheKey,
  useHookToken,
  useGroups,
  useProject,
  useSettings,
  useTasks,
} from "~/queries";
import { useActiveGroup } from "~/lib/active-group";
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
import type { Group, Task, TaskStatus } from "~/db/schema";
import type { ProjectPathStatus } from "~/shared/projects";
import { projectScopeKey, scopeKeyForProject } from "~/lib/scoped-project";
import {
  ARCHIVE_ACTIVE_SESSION_EVENT,
  DUPLICATE_ACTIVE_SESSION_EVENT,
  pickByPriority,
  STATUS_META,
  type ArchiveActiveSessionEventDetail,
} from "~/lib/design-meta";

// Hand-rolled to keep zod out of the eager chunk (matches /settings). The route
// accepts an optional `coreId` search param so the shell knows which Core owns
// the project — the Panel's own rows are implied when absent. See
// issue 08 (Singular UI across Cores).
function validateProjectSearch(
  search: Record<string, unknown>,
): { coreId?: string } {
  const raw = search.coreId;
  if (typeof raw !== "string" || raw.length === 0) return {};
  return { coreId: raw };
}

export const Route = createFileRoute("/projects/$id")({
  validateSearch: validateProjectSearch,
  component: ProjectPage,
});

type SessionView = "active" | "pinned" | "archived";

type ProjectPathCheck =
  | { state: "idle" | "checking" | "valid" }
  | { state: "invalid"; status: Extract<ProjectPathStatus, { ok: false }> }
  | { state: "error"; message: string };

/** The task id of the grid cell whose terminal currently holds focus (the pane
 *  the user is looking at), or null outside grid view / when nothing is focused.
 *  Clone and "new session" both anchor a fresh session on this so it lands
 *  beside — and takes the caret from — the active pane. */
function readFocusedGridTaskId(): string | null {
  if (typeof document === "undefined") return null;
  const cell = document.activeElement?.closest("[data-grid-cell]") as HTMLElement | null;
  return cell?.getAttribute("data-task-id") ?? null;
}

function ProjectPage() {
  const { id } = Route.useParams();
  // Which Core owns this shell instance (Singular UI across Cores). Absent
  // means the Panel's own rows, which have no machine behind them.
  const { coreId: routeCoreId } = Route.useSearch();
  const coreId = routeCoreId ?? null;
  const router = useRouter();
  const queryClient = useQueryClient();
  const { data: settings } = useSettings();
  const settingsLoaded = settings !== undefined;
  const { hideElementContextMenu, hideableMenu } = useHideableMenu();
  // Which discretionary project-header buttons are shown (Settings → Interface,
  // or right-click → Hide on the button itself).
  const headerButtons = settings?.headerButtons ?? DEFAULT_HEADER_BUTTON_VISIBILITY;
  const projectQuery = useProject(id, { coreId });
  const { setActiveGroup } = useActiveGroup();
  const groupsQuery = useGroups();
  const project = projectQuery.data;
  const selectedScopeKey = projectScopeKey(id);
  const scopedProject = project ?? null;
  const [projectPathCheck, setProjectPathCheck] = useState<ProjectPathCheck>({
    state: "idle",
  });
  const pathScopeKey = `${project?.id ?? ""}:${project?.path ?? ""}`;
  const pathScopeRef = useRef(pathScopeKey);
  useEffect(() => {
    if (!project) {
      setProjectPathCheck({ state: "idle" });
      pathScopeRef.current = pathScopeKey;
      return;
    }
    // Filesystem checks are Core-owned — the path lives on the Core's
    // machine. There's no core-link frame for it yet; treat a Core's path as
    // valid so launch controls & terminals unblock.
    if (coreId) {
      pathScopeRef.current = pathScopeKey;
      setProjectPathCheck({ state: "valid" });
      return;
    }
    const scopeChanged = pathScopeRef.current !== pathScopeKey;
    pathScopeRef.current = pathScopeKey;
    let cancelled = false;
    // Keep the last-known-good path while revalidating the same scope so
    // launch controls don't flicker on unrelated cache refreshes (e.g.
    // deleting a session only touches tasks, not the project path).
    setProjectPathCheck((prev) => {
      if (scopeChanged || prev.state === "idle") return { state: "checking" };
      if (prev.state === "valid") return prev;
      return { state: "checking" };
    });
    void api
      .getProjectPathStatus(project.id)
      .then(({ status }) => {
        if (cancelled) return;
        setProjectPathCheck(status.ok ? { state: "valid" } : { state: "invalid", status });
      })
      .catch((error) => {
        if (cancelled) return;
        setProjectPathCheck({
          state: "error",
          message: error?.message || "Could not verify this project path.",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [coreId, pathScopeKey, project]);
  const projectPathReady = projectPathCheck.state === "valid";
  const projectPathBlocked =
    projectPathCheck.state === "invalid" || projectPathCheck.state === "error";
  const projectPathUsable = projectPathReady || projectPathCheck.state === "checking";
  const projectPathIssue =
    projectPathCheck.state === "invalid" ? projectPathCheck.status : null;
  const terminalProject = projectPathReady ? scopedProject : null;
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
    // Core's core-link and persisted its task over the Panel's local HTTP
    // API, and a session's row belongs to the Core that runs it (ADR 0004).
    // Sessions take the one cold path, which is a mutation frame.
    // Depend only on warmPrepareKey (the stable logical key); inputs come from the ref.
  }, [warmPrepareKey]);
  const tasksQuery = useTasks(id, { coreId });
  // A remote Core's projects and tasks change on the Core, not in the
  // Panel's own database, so the SSE stream that keeps the rest of this route
  // fresh says nothing about them. Core events over the panel link do.
  useCoreLiveQueries(coreId, id);
  const tasks = tasksQuery.data ?? [];
  const hasArchivedTasks = tasks.some((t) => t.archived);
  // Live pinned-session ids for the grid's "Pinned" filter — derived from the
  // task query (not the store's open-time snapshot) so a pin toggle reflects
  // immediately. Memoized so SessionGrid's filter doesn't churn every render.
  const pinnedTaskIds = useMemo(
    () => new Set(tasks.filter((t) => !t.archived && t.pinned).map((t) => t.id)),
    [tasks],
  );
  const groups = groupsQuery.data ?? [];
  useHookToken();
  const [showNewHarness, setShowNewHarness] = useState(false);
  // Where the session created from the New Harness dialog should land in the grid:
  // "newRow" is set by the grid's "New row" button so the result starts a fresh
  // row; "default" (the New session button / hotkey) uses the current row.
  const [newHarnessTarget, setNewHarnessTarget] = useState<"default" | "newRow">("default");
  const [showEdit, setShowEdit] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [sessionView, setSessionView] = useState<SessionView>("active");
  const showArchived = sessionView === "archived";
  const showPinned = sessionView === "pinned";
  const [pinningTaskIds, setPinningTaskIds] = useState<Set<string>>(() => new Set());
  const pinRequestSeqRef = useRef<Record<string, number>>({});
  // Stable callback identities for the memoized TaskCard: the real handlers are
  // defined far below (after this render's early returns), so we forward through
  // a ref that's refreshed each render. This keeps the props TaskCard sees
  // referentially stable so a single session update re-renders only its card,
  // while every click still runs the latest handler closure.
  const taskCardHandlersRef = useRef<{
    onToggle: (taskId: string) => void;
    onArchive: (taskId: string) => void;
    onRestore: (taskId: string) => void;
    onDelete: (taskId: string) => void;
    onTogglePinned: (taskId: string) => Promise<void> | void;
  }>({
    onToggle: () => {},
    onArchive: () => {},
    onRestore: () => {},
    onDelete: () => {},
    onTogglePinned: () => {},
  });
  const stableSelectTerminal = useCallback(
    (taskId: string) => taskCardHandlersRef.current.onToggle(taskId),
    [],
  );
  const stableArchiveSession = useCallback(
    (taskId: string) => taskCardHandlersRef.current.onArchive(taskId),
    [],
  );
  const stableRestoreSession = useCallback(
    (taskId: string) => taskCardHandlersRef.current.onRestore(taskId),
    [],
  );
  const stableDeleteTask = useCallback(
    (taskId: string) => taskCardHandlersRef.current.onDelete(taskId),
    [],
  );
  const stableToggleSessionPinned = useCallback(
    (taskId: string) => taskCardHandlersRef.current.onTogglePinned(taskId),
    [],
  );
  const [confirmDeleteArchived, setConfirmDeleteArchived] = useState(false);
  const [confirmArchiveAll, setConfirmArchiveAll] = useState(false);
  const [archivingAll, setArchivingAll] = useState(false);
  // Leave the archived view automatically once it empties (last one restored
  // or deleted) so the toggle never strands the user on a blank list.
  useEffect(() => {
    if (sessionView === "archived" && !hasArchivedTasks) setSessionView("active");
  }, [sessionView, hasArchivedTasks]);
  const [pinning, setPinning] = useState(false);
  const [cleanupStatus, setCleanupStatus] = useState<string | null>(null);
  const [removingMissingProject, setRemovingMissingProject] = useState(false);
  const [retryingProjectPath, setRetryingProjectPath] = useState(false);
  const [projectPathActionError, setProjectPathActionError] = useState<string | null>(null);
  useEffect(() => {
    setProjectPathActionError(null);
  }, [projectPathCheck.state, projectPathIssue?.path]);
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
  const syncTask = terminals.syncTask;
  const rehydrateTerminal = terminals.rehydrate;
  const toggleTerminalSession = terminals.toggle;
  const setVisibleTerminalScope = terminals.setVisibleScope;
  // "Grid view — show all sessions": entering the grid materializes every
  // active session for the visible scope, not just the already-open
  // ones. TerminalPane's spawn queue staggers the agent launches.
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  const enterGridView = useCallback(() => {
    // Keep any open Review Changes diff open across the switch — the grid docks
    // it as a side panel rather than fighting for the slot, so switching views
    // shouldn't dismiss the review.
    terminals.setGridView(true);
    if (!terminalProject) return;
    for (const task of tasksRef.current) {
      if (task.archived) continue;
      rehydrateTerminal(terminalProject, task, { coreId });
    }
    // Focus the session that was active in normal view so entering the grid keeps
    // the same session current instead of landing on an arbitrary cell.
    // focusGridSession retries until that cell's pane mounts.
    const activeTaskId = terminals.activeTaskIdFor(selectedScopeKey);
    if (activeTaskId) terminals.focusGridSession(activeTaskId);
  }, [terminals, terminalProject, rehydrateTerminal, selectedScopeKey, coreId]);
  const toggleGridViewShowingAll = useCallback(() => {
    if (terminals.gridView) {
      // Carry the grid's focused session into normal view so leaving the grid
      // shows the pane you were looking at, not whatever was active before.
      // DOM focus first (hotkey exit, cell still focused); then the grid's
      // last-focused cell reported to the store (a header-button click moved
      // focus off the grid).
      const focused = readFocusedGridTaskId() ?? terminals.getGridFocusedTaskId();
      terminals.setGridView(false);
      if (focused && terminalProject && tasks.some((t) => t.id === focused)) {
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
  }, [terminals, enterGridView, terminalProject, tasks]);
  const {
    setProject: setActiveUserTerminalProject,
    setPanelOpen,
  } = useUserTerminals();

  useEffect(() => {
    if (terminalProject) setActiveUserTerminalProject(terminalProject, coreId);
  }, [terminalProject, coreId, setActiveUserTerminalProject]);

  useLayoutEffect(() => {
    setVisibleTerminalScope(id, selectedScopeKey);
    return () => setVisibleTerminalScope(id, null);
  }, [id, selectedScopeKey, setVisibleTerminalScope]);

  useEffect(() => {
    for (const task of tasks) syncTask(task);
  }, [tasks, syncTask]);

  // When the active session is deleted/archived, jump to the next
  // highest-priority card. Plain deselect (Cmd+L, X) leaves the panel closed.
  // We hold the prev active id across renders until the tasks query catches
  // up — only then can we tell deletion (task gone) from deselect (still there).
  // Scope the ref to {projectId, taskId} so the route component being reused
  // across project switches doesn't make a stale ref look like a deletion in
  // the new project (which would auto-open a session there).
  const lastActiveRef = useRef<{ projectId: string; taskId: string } | null>(null);
  const activeTaskId = terminals.activeTaskIdFor(selectedScopeKey);
  const lastHiddenSessionRef = useRef<{ projectId: string; taskId: string } | null>(null);
  const archiveSessionRef = useRef<(taskId: string) => void>(() => undefined);
  useEffect(() => {
    const onArchiveRequest = (e: Event) => {
      const taskId = (e as CustomEvent<ArchiveActiveSessionEventDetail>).detail?.taskId;
      if (typeof taskId !== "string") return;
      archiveSessionRef.current(taskId);
    };
    window.addEventListener(ARCHIVE_ACTIVE_SESSION_EVENT, onArchiveRequest);
    return () => window.removeEventListener(ARCHIVE_ACTIVE_SESSION_EVENT, onArchiveRequest);
  }, []);
  useEffect(() => {
    if (activeTaskId !== null) {
      lastActiveRef.current = { projectId: selectedScopeKey, taskId: activeTaskId };
      return;
    }
    const prev = lastActiveRef.current;
    if (!prev || prev.projectId !== selectedScopeKey || !terminalProject) return;
    const visible = tasks.filter((t) => !t.archived);
    if (visible.some((t) => t.id === prev.taskId)) return;
    lastActiveRef.current = null;
    const next = pickByPriority(visible);
    if (next) toggleTerminalSession(terminalProject, next);
  }, [activeTaskId, tasks, terminalProject, toggleTerminalSession, selectedScopeKey]);

  // Rehydrate after reload: if a persisted activeTaskId resolves to an
  // existing task for this project, materialize a session entry so the panel
  // reopens without requiring a click.
  useEffect(() => {
    if (!terminalProject) return;
    if (!activeTaskId) return;
    const task = tasks.find((t) => t.id === activeTaskId);
    if (task) rehydrateTerminal(terminalProject, task);
  }, [activeTaskId, terminalProject, tasks, rehydrateTerminal]);

  // The rehydrate above re-shows the active session on a project switch,
  // but its cached terminal surface reattaches blurred (it doesn't self-focus),
  // so the newly-shown session drops keystrokes until a manual click. Re-assert
  // keyboard focus once per scope switch — guarded by scope so it fires on the
  // switch (and first mount), not on every task refetch, which would yank the
  // caret while the user is typing. focusGridSession retries until the pane
  // mounts and is consumed by both SessionGrid (grid view) and TerminalPanel
  // (normal view), so a single call covers both layouts.
  const focusedScopeRef = useRef<string | null>(null);
  useEffect(() => {
    if (!terminalProject) return;
    if (focusedScopeRef.current === selectedScopeKey) return;
    if (!activeTaskId) return;
    focusedScopeRef.current = selectedScopeKey;
    terminals.focusGridSession(activeTaskId);
  }, [selectedScopeKey, terminalProject, activeTaskId, terminals]);

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
        if (terminals.gridView && terminals.sessions.some((s) => s.taskId === request.taskId)) {
          terminals.focusGridSession(request.taskId);
          clearPendingSessionOpen(request);
          return;
        }

        let task = tasks.find((entry) => entry.id === request.taskId && !entry.archived) ?? null;

        if (!task) {
          if (tasksQuery.isLoading) return;
          if (coreId) {
            // A Core's tasks only travel as core-link snapshots (already in
            // `tasks`); `api.getTask` reads the Panel's own rows and could
            // resolve a colliding id. Absent from the snapshot list ⇒ stale.
            clearPendingSessionOpen(request);
            return;
          }
          try {
            const { task: remoteTask } = await api.getTask(request.taskId);
            if (!remoteTask || remoteTask.projectId !== id || remoteTask.archived) {
              clearPendingSessionOpen(request);
              return;
            }
            task = remoteTask;
          } catch {
            clearPendingSessionOpen(request);
            return;
          }
        }

        const active = terminals.activeFor(selectedScopeKey);
        if (active?.taskId !== task.id) {
          const activeTaskId = terminals.activeTaskIdFor(selectedScopeKey);
          if (activeTaskId === task.id) terminals.rehydrate(terminalProject, task, { coreId });
          else terminals.toggle(terminalProject, task);
        }
        // Now that the session is materialized in the grid, spotlight its cell.
        if (terminals.gridView) terminals.focusGridSession(task.id);
        clearPendingSessionOpen(request);
      })();
    },
    [
      id,
      coreId,
      terminalProject,
      selectedScopeKey,
      tasks,
      tasksQuery.isLoading,
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
  const invalidateTasks = useCallback(
    () =>
      queryClient.invalidateQueries({
        queryKey: tasksCacheKey(id, coreId),
      }),
    [queryClient, id, coreId]
  );
  const invalidateProjects = useCallback(
    () => queryClient.invalidateQueries({ queryKey: queryKeys.projects }),
    [queryClient]
  );
  const invalidateGroups = useCallback(
    () => queryClient.invalidateQueries({ queryKey: queryKeys.groups }),
    [queryClient],
  );
  const createGroupForSelection = useCallback(
    async (name: string) => {
      const { group } = await api.createGroup({ name });
      queryClient.setQueryData<Group[]>(queryKeys.groups, (current) =>
        current ? [...current, group] : [group],
      );
      await invalidateGroups();
      return group;
    },
    [invalidateGroups, queryClient],
  );
  const refresh = useCallback(async () => {
    await Promise.all([invalidateProject(), invalidateTasks(), invalidateProjects()]);
  }, [invalidateProject, invalidateTasks, invalidateProjects]);

  const toggleProjectPin = useCallback(async () => {
    if (!project || pinning) return;
    setOverflowOpen(false);
    setPinning(true);
    try {
      // Pin is Core-owned state; the mutation goes over the coreId-
      // parameterised core-link surface (issue 10, ADR-0005), never through
      // the local HTTP server. Every Core shares the same call
      // shape via {@link mutateProjectForCore}.
      await mutateProjectForCore(coreId, {
        op: "pin",
        projectId: project.id,
        pinned: project.pinned !== true,
      });
      await Promise.all([invalidateProject(), invalidateProjects()]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update project pin");
    } finally {
      setPinning(false);
    }
  }, [project, pinning, invalidateProject, invalidateProjects, coreId]);

  const [showCodexHooksNotice, setShowCodexHooksNotice] = useState(false);
  const [harnessUpdateRequired, setHarnessUpdateRequired] = useState<{
    agent: Task["agent"];
    availability: CliAvailability;
  } | null>(null);

  const showHarnessUpdateRequired = useCallback(
    (agent: Task["agent"], availability?: CliAvailability) => {
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

      const tasksKey = queryKeys.tasks(project.id);
      void queryClient.cancelQueries({ queryKey: tasksKey });

      const usesPersistedSession =
        payload.agent === "claude-code" ||
        payload.agent === "cursor-cli";
      const claudeSessionId = usesPersistedSession ? newSessionId() : null;
      // Client-minted id so the optimistic card and the PTY agree on a task id
      // before the row exists.
      const clientTaskId = newClientId("t");
      const optimisticTask = buildOptimisticTask({
        id: clientTaskId,
        projectId: project.id,
        agent: payload.agent,
        claudeSessionId,
        claudeSkipPermissions: harnessLaunchesWithSkipPermissions(payload.agent),
        claudeBareSession: payload.agent === "claude-code" ? payload.bareSession : undefined,
      });
      appendOptimisticTask(queryClient, project.id, optimisticTask, coreId);
      if (opts?.initialInput) {
        // TerminalPane consumes this once, at the first spawn, as the PTY's
        // initialInput — the main process writes it after the agent TUI is ready.
        setPendingInitialInput(optimisticTask.id, opts.initialInput);
      }
      if (opts?.model) {
        setPendingSessionModel(optimisticTask.id, opts.model);
      }
      terminals.toggle(terminalProject, optimisticTask, {
        awaitCreate: false,
        coreId,
      });
      // Clone/new-session focus: put the caret in the just-added grid cell so the
      // user can type immediately. focusGridSession retries until the pane mounts
      // (and re-asserts across the awaitingCreate→persisted rebuild), so calling
      // it here — before the surface exists — is fine.
      if (opts?.focusOnCreate && terminals.gridView) {
        terminals.focusGridSession(optimisticTask.id);
      }

      void (async () => {
        try {
          // The Core owns the row (ADR-0004/0005), so starting a session is
          // a mutation frame to the Core the project lives on — there is no
          // Panel-side task table to write to instead. The frame doesn't carry
          // claudeSessionId / bareSession today, so a session creates as a
          // plain Harness task without those fields: no persisted-claude-session
          // resume until the protocol grows them. Skip-permissions is not a row
          // field any launch path reads — it is derived from the Harness
          // (issue 22).
          const snapshot = await mutateTaskForCore(coreId, {
            op: "create",
            taskId: clientTaskId,
            projectId: project.id,
            title: TITLE_WAITING,
            agent: payload.agent,
          });
          if (!snapshot) throw new Error("Core did not return a task snapshot");
          const createdTask: Task = remoteTaskFromSnapshot(snapshot);
          replaceOptimisticTask(
            queryClient,
            project.id,
            optimisticTask.id,
            createdTask,
            coreId,
          );
          if (clientTaskId && createdTask.id === clientTaskId) {
            terminals.openSession(terminalProject, createdTask, { coreId });
          } else {
            const pendingModel = peekPendingSessionModel(optimisticTask.id);
            if (pendingModel) {
              clearPendingSessionModel(optimisticTask.id);
              setPendingSessionModel(createdTask.id, pendingModel);
            }
            terminals.adoptTaskId(optimisticTask.id, createdTask);
          }
          void Promise.all([invalidateProject(), invalidateTasks(), invalidateProjects()]);
          if (payload.agent === "codex" && !hasSeenCodexHooksNotice()) {
            setShowCodexHooksNotice(true);
          }
        } catch (e: unknown) {
          // The session never spawned — discard any staged prompt / model.
          takePendingInitialInput(optimisticTask.id);
          clearPendingSessionModel(optimisticTask.id);
          removeOptimisticTask(queryClient, project.id, optimisticTask.id, coreId);
          await terminals.close(optimisticTask.id);
          toast.error(e instanceof Error ? e.message : "Could not create session");
        }
      })();
    },
    [
      project,
      terminalProject,
      queryClient,
      invalidateProject,
      invalidateTasks,
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
    for (const candidate of [readFocusedGridTaskId(), terminals.getGridFocusedTaskId()]) {
      if (candidate && tasks.some((t) => t.id === candidate)) return candidate;
    }
    return terminals.activeFor(selectedScopeKey)?.taskId ?? undefined;
  }, [tasks, terminals, selectedScopeKey]);

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
    createSession(
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
    createSession(
      {
        agent: project.savedHarness,
        bareSession: project.savedHarness === "claude-code" ? !!project.savedBareSession : false,
      },
      { focusOnCreate: true },
    );
  }, [project, createSession, cliAvailability, showHarnessUpdateRequired, terminals]);

  const onNewHarnessPrimary = useCallback(() => {
    if (!projectPathReady) return;
    if (showNewHarness || showEdit) return;
    if (project?.rememberHarnessSettings && project.savedHarness) {
      void startWithSaved();
      return;
    }
    setShowNewHarness(true);
  }, [project, projectPathReady, showNewHarness, showEdit, startWithSaved]);

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
    const intent = consumeProjectOnboardIntent(id);
    onboardIntentRef.current = intent;
    if (intent) {
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
    if (!intent?.autoStart || onboardStartedRef.current) return;
    if (!project || !projectPathReady) return;
    onboardStartedRef.current = true;
    onNewHarnessPrimary();
  }, [project, projectPathReady, onNewHarnessPrimary]);

  // New-row variant of agent.new: the session lands in a fresh grid row at the
  // bottom instead of beside the active one. Grid-only — rows don't exist
  // outside the grid.
  const onNewRowPrimary = useCallback(() => {
    if (!projectPathReady) return;
    if (showNewHarness || showEdit) return;
    if (project?.rememberHarnessSettings && project.savedHarness) {
      void startWithSavedInNewRow();
      return;
    }
    setNewHarnessTarget("newRow");
    setShowNewHarness(true);
  }, [project, projectPathReady, showNewHarness, showEdit, startWithSavedInNewRow]);

  useHotkey("project.edit", () => {
    if (showNewHarness || projectPathIssue || projectPathCheck.state === "error") return;
    setShowEdit((v) => !v);
  });

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
    showEdit ||
    confirmRemove ||
    confirmDeleteArchived ||
    !!projectPathIssue ||
    projectPathCheck.state === "error" ||
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
      const visible = tasks.filter((t) => !t.archived);
      if (visible.length === 0) return;
      const ordered: Task[] = [];
      for (const status of STATUS_DISPLAY_ORDER) {
        for (const t of visible) if (t.status === status) ordered.push(t);
      }
      if (ordered.length === 0) return;
      const currentId = terminals.activeTaskIdFor(selectedScopeKey);
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
      const nextTask = ordered[nextIdx];
      if (!nextTask || nextTask.id === currentId) return;
      terminals.toggle(terminalProject, nextTask);
      // Carry keyboard focus into the session we cycled to, so successive
      // presses keep cycling and the caret is ready to type (see selectTerminal).
      terminals.focusGridSession(nextTask.id);
    },
    [
      project,
      terminalProject,
      selectedScopeKey,
      tasks,
      terminals,
      anyBlockingDialogOpen,
      showGrid,
    ],
  );

  const duplicateActiveSession = useCallback(
    (sourceTaskId?: string) => {
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
      const focusedGridTaskId = readFocusedGridTaskId();
      const sourceTask =
        (sourceTaskId && tasks.find((t) => t.id === sourceTaskId)) ||
        (focusedGridTaskId && tasks.find((t) => t.id === focusedGridTaskId)) ||
        (() => {
          const active = terminals.activeFor(selectedScopeKey);
          return active ? tasks.find((t) => t.id === active.taskId) : undefined;
        })();
      if (!sourceTask) return;
      // In grid view, drop the clone directly beside the session it came from
      // rather than at the end of the grid.
      terminals.requestCloneInsertAfter(sourceTask.id);
      void createSession(
        {
          agent: sourceTask.agent,
          bareSession: sourceTask.agent === "claude-code" ? !!sourceTask.claudeBareSession : false,
        },
        { focusOnCreate: true },
      );
    },
    [project, selectedScopeKey, tasks, terminals, createSession, anyBlockingDialogOpen],
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
      const taskId = (e as CustomEvent<{ taskId?: string }>).detail?.taskId;
      duplicateActiveSessionRef.current(taskId);
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
        s.taskId === hiddenSession.taskId &&
        scopeKeyForProject(s.project) === selectedScopeKey,
    ) &&
    tasks.some((t) => t.id === hiddenSession.taskId && !t.archived);
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
        lastHiddenSessionRef.current = { projectId: selectedScopeKey, taskId: active.taskId };
        terminals.deselect(selectedScopeKey);
        return;
      }
      const hidden = lastHiddenSessionRef.current;
      if (!hidden || hidden.projectId !== selectedScopeKey) return;
      const sessionStillOpen = terminals.sessions.some(
        (s) =>
          s.taskId === hidden.taskId &&
          scopeKeyForProject(s.project) === selectedScopeKey,
      );
      if (!sessionStillOpen) return;
      const task = tasks.find((t) => t.id === hidden.taskId && !t.archived);
      if (!task) return;
      if (terminalProject) terminals.toggle(terminalProject, task);
    },
    {
      enabled: closePanelEnabled,
      capture: true,
    },
  );

  // Coalesce bursts of task events for THIS project into a single refetch. A
  // running agent emits many task:updated events per second; each used to
  // refetch this project's tasks + detail + the global projects list. The
  // sidebar (ProjectBar / ProjectPicker) owns the projects-list refresh, so
  // this route only refetches its own tasks + detail — and ignores task events
  // for other projects entirely.
  // maxWait bounds staleness under a sustained event storm: without it a
  // continuous <150ms stream would defer the refetch indefinitely.
  const invalidateThisProjectTasks = useDebouncedCallback(() => {
    void invalidateTasks();
    void invalidateProject();
  }, 150, 400);

  useServerEvents(
    useCallback(
      (e) => {
        applyQuestionServerEvent(e);
        if (e.type.startsWith("task:")) {
          if (e.projectId === id) {
            invalidateThisProjectTasks();
          }
        } else if (e.type.startsWith("project:")) {
          void invalidateProject();
          void invalidateProjects();
        }
      },
      [id, invalidateThisProjectTasks, invalidateProject, invalidateProjects, queryClient]
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

  if (projectQuery.isError) {
    return (
      <div style={{ flex: 1, padding: 32 }}>
        <EmptyState
          title="Could not load project"
          subtitle="Actana Control could not load this hosted project. Check your connection, then retry."
          icon="shield"
          action={
            <div style={{ display: "flex", gap: 8 }}>
              <Btn variant="primary" icon="refresh" onClick={() => void projectQuery.refetch()}>
                Retry
              </Btn>
              <Btn variant="ghost" onClick={() => router.navigate({ to: "/" })}>
                Back to projects
              </Btn>
            </div>
          }
        />
      </div>
    );
  }

  if (!project) {
    return (
      <div style={{ flex: 1, padding: 32 }}>
        <EmptyState
          title="Loading project"
          subtitle="Fetching the hosted project, sessions, terminals, and runtime state."
          icon="sparkles"
        />
      </div>
    );
  }

  const activeTasks = tasks.filter((t) => !t.archived);
  const pinnedTasks = activeTasks.filter((t) => t.pinned);
  const archivedTasks = tasks.filter((t) => t.archived);
  const visibleTasks = showArchived ? archivedTasks : showPinned ? pinnedTasks : activeTasks;
  // Active list peels pinned into a top "Pinned" section; Pinned tab keeps
  // normal status grouping (already all-pinned). Archived folds every live
  // status into the single Archived column (no Interrupted/Running/etc.).
  const activeListGroups =
    !showArchived && !showPinned ? groupActiveListTasksForDisplay(visibleTasks) : null;
  const tasksByStatus = activeListGroups
    ? activeListGroups.byStatus
    : showArchived
      ? groupArchivedTasksForDisplay(visibleTasks)
      : groupTasksByStatusForDisplay(visibleTasks);
  const pinnedListTasks = activeListGroups?.pinned ?? [];

  const activeId = terminals.activeTaskIdFor(selectedScopeKey);
  const setTaskPinning = (taskId: string, pinning: boolean) => {
    setPinningTaskIds((current) => {
      if (pinning && current.has(taskId)) return current;
      if (!pinning && !current.has(taskId)) return current;
      const next = new Set(current);
      if (pinning) next.add(taskId);
      else next.delete(taskId);
      return next;
    });
  };

  // Card click opens/focuses a session. Re-clicking the active card must not
  // hide the panel — only the session panel close button (or terminal.close
  // hotkey) deselects.
  const selectTerminal = (taskId: string) => {
    const task = tasks.find((t) => t.id === taskId);
    if (!task || !terminalProject) return;
    terminals.openSession(terminalProject, task, { coreId });
    // Move the caret into the session's terminal so the user can type right
    // away. Switching to an already-built (cached) surface reattaches without
    // focusing, so without this the card click selects the session but leaves
    // the terminal blurred until a second manual click. TerminalPanel consumes
    // this request and re-asserts focus across the pane remount.
    terminals.focusGridSession(taskId);
  };

  const toggleSessionPinned = async (taskId: string) => {
    if (!project) return;
    const task = tasks.find((t) => t.id === taskId);
    if (!task || task.archived) return;
    const nextPinned = !task.pinned;
    const previousPinned = task.pinned;
    const requestId = (pinRequestSeqRef.current[taskId] ?? 0) + 1;
    pinRequestSeqRef.current[taskId] = requestId;
    setTaskPinning(taskId, true);

    const tasksKey = queryKeys.tasks(project.id);
    await queryClient.cancelQueries({ queryKey: tasksKey });
    setTaskPinnedInCache(queryClient, project.id, taskId, nextPinned);

    try {
      // Task pin is Core-owned state; the mutation goes over the coreId-
      // parameterised core-link surface (ADR-0005). For a Panel-owned row
      // this replaces the previous local-HTTP `api.updateTask({pinned})`
      // path — the DB row still moves, but the write travels through the
      // in-process core-link so two Panels connected to the same Core (once
      // that lands for a Panel-owned row) see the same pin state.
      const saved = await mutateTaskForCore(coreId, {
        op: "update",
        taskId,
        pinned: nextPinned,
      });
      if (pinRequestSeqRef.current[taskId] !== requestId) return;
      if (saved) {
        queryClient.setQueryData<Task[]>(tasksKey, (current) =>
          (current ?? []).map((t) =>
            t.id === taskId
              ? {
                  ...t,
                  pinned: saved.pinned,
                  updatedAt: saved.updatedAt,
                }
              : t,
          ),
        );
      }
      void invalidateTasks();
    } catch (e: unknown) {
      if (pinRequestSeqRef.current[taskId] === requestId) {
        const currentTask = queryClient.getQueryData<Task[]>(tasksKey)?.find((t) => t.id === taskId);
        if (currentTask?.pinned === nextPinned) {
          setTaskPinnedInCache(queryClient, project.id, taskId, previousPinned);
        }
        void invalidateTasks();
        toast.error(e instanceof Error ? e.message : "Could not update pinned session");
      }
    } finally {
      if (pinRequestSeqRef.current[taskId] === requestId) {
        delete pinRequestSeqRef.current[taskId];
        setTaskPinning(taskId, false);
      }
    }
  };

  const deleteTask = (taskId: string) => {
    const task = tasks.find((t) => t.id === taskId);
    if (!task || !project) return;

    const tasksKey = queryKeys.tasks(project.id);
    void queryClient.cancelQueries({ queryKey: tasksKey });
    const previousTasks = queryClient.getQueryData<Task[]>(tasksKey);

    const isActive = terminals.activeTaskIdFor(selectedScopeKey) === taskId;
    const next = isActive
      ? pickByPriority(tasks.filter((t) => !t.archived && t.id !== taskId))
      : undefined;

    // Point the panel at the replacement session before the deleted row disappears
    // or its PTY is torn down — otherwise close() briefly clears active and the
    // panel unmounts before the auto-select effect catches up.
    if (isActive && terminalProject) {
      if (next) terminals.openSession(terminalProject, next, { coreId });
      else terminals.deselect(selectedScopeKey);
    }

    removeTaskFromCache(queryClient, project.id, taskId);

    void (async () => {
      try {
        await terminals.close(
          taskId,
          isActive ? { activateTaskId: next?.id ?? null } : undefined,
        );
        await api.deleteTask(taskId);
        void refresh();
      } catch (e: unknown) {
        if (previousTasks) {
          restoreTasksCache(queryClient, project.id, previousTasks);
        }
        toast.error(e instanceof Error ? e.message : "Could not delete session");
      } finally {
        setCleanupStatus(null);
      }
    })();
  };

  const confirmRemoveProject = async () => {
    if (!project) return;
    setConfirmRemove(false);
    try {
      await terminals.closeForProject(project.id);
      await api.deleteProject(project.id);
      router.navigate({ to: "/" });
    } finally {
      setCleanupStatus(null);
    }
  };

  const removeMissingProject = async () => {
    if (!project) return;
    setRemovingMissingProject(true);
    setProjectPathActionError(null);
    setCleanupStatus("Removing this project from Actana Control.");
    try {
      await terminals.closeForProject(project.id);
      await api.deleteProject(project.id);
      router.navigate({ to: "/" });
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Could not remove project";
      setProjectPathActionError(message);
      toast.error(message);
    } finally {
      setCleanupStatus(null);
      setRemovingMissingProject(false);
    }
  };

  const retryProjectPathCheck = async () => {
    if (!project) return;
    setRetryingProjectPath(true);
    try {
      const { status } = await api.getProjectPathStatus(project.id);
      setProjectPathCheck(status.ok ? { state: "valid" } : { state: "invalid", status });
    } catch (e: unknown) {
      setProjectPathCheck({
        state: "error",
        message: e instanceof Error ? e.message : "Could not verify this project path.",
      });
    } finally {
      setRetryingProjectPath(false);
    }
  };

  const closePathIssue = () => {
    router.navigate({ to: "/" });
  };

  // Archive one or more active sessions: kill each tty, flip the archived flag,
  // and repoint the terminal panel if the active session is being archived.
  // No confirmation — archiving is reversible via Restore.
  //
  // That last sentence holds for a Panel-owned row only. On a Core-owned
  // project the flag flips in the Core's SQLite (the data is safe), but
  // `queryTasks` selects `WHERE archived = 0` — "archived rows never cross the
  // core-link" (packages/shared/src/core-query.ts) — so the row simply stops
  // being listed: it never appears under Archived and there is nothing to
  // Restore or Delete-all-archived from. Archive is a one-way hide there until
  // the core-link can list archived rows (e.g. an `includeArchived` on
  // `tasksList`); issue #18.
  const archiveTasks = (targets: Task[]) => {
    if (!project || targets.length === 0) return;
    const ids = new Set(targets.map((t) => t.id));

    const tasksKey = queryKeys.tasks(project.id);
    void queryClient.cancelQueries({ queryKey: tasksKey });
    const previousTasks = queryClient.getQueryData<Task[]>(tasksKey);

    const activeTaskId = terminals.activeTaskIdFor(selectedScopeKey);
    const archivingActive = !!activeTaskId && ids.has(activeTaskId);
    const next = archivingActive
      ? pickByPriority(tasks.filter((t) => !t.archived && !ids.has(t.id)))
      : undefined;

    // Repoint the panel at the replacement session before the PTY is torn down,
    // mirroring deleteTask so the panel doesn't briefly unmount.
    if (archivingActive && terminalProject) {
      if (next) terminals.openSession(terminalProject, next, { coreId });
      else terminals.deselect(selectedScopeKey);
    }

    setTasksArchivedInCache(queryClient, project.id, ids, true);

    void (async () => {
      try {
        await Promise.all(
          targets.map(async (t) => {
            await terminals
              .close(
                t.id,
                t.id === activeTaskId ? { activateTaskId: next?.id ?? null } : undefined,
              )
              .catch(() => undefined);
            // Route to the Core that owns the row (ADR 0005) — the Panel's
            // own archive endpoint only knows Panel-owned rows.
            await mutateTaskForCore(coreId, {
              op: "update",
              taskId: t.id,
              archived: true,
            });
          }),
        );
        void refresh();
      } catch (e: unknown) {
        if (previousTasks) {
          restoreTasksCache(queryClient, project.id, previousTasks);
        }
        toast.error(e instanceof Error ? e.message : "Could not archive session");
      }
    })();
  };

  const archiveSession = (taskId: string) => {
    const task = tasks.find((t) => t.id === taskId);
    if (task) archiveTasks([task]);
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

  // Un-archive one session. Routed by owner like every other task mutation,
  // but reachable today only for a Panel-owned row: the Archived list is built
  // from `tasks`, and a Core never sends an archived row over the link (see
  // archiveTasks above). The routing is here so restore works the moment the
  // core-link starts listing them — not because a Core row can reach it now.
  const restoreSession = (taskId: string) => {
    if (!project) return;
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return;

    const tasksKey = queryKeys.tasks(project.id);
    void queryClient.cancelQueries({ queryKey: tasksKey });
    const previousTasks = queryClient.getQueryData<Task[]>(tasksKey);
    setTaskArchivedInCache(queryClient, project.id, taskId, false);

    void (async () => {
      try {
        await mutateTaskForCore(coreId, { op: "update", taskId, archived: false });
        void refresh();
      } catch (e: unknown) {
        if (previousTasks) {
          restoreTasksCache(queryClient, project.id, previousTasks);
        }
        toast.error(e instanceof Error ? e.message : "Could not restore session");
      }
    })();
  };

  // Refresh the stable TaskCard handler wrappers with this render's closures so
  // the memoized cards always invoke the latest logic without changing identity.
  taskCardHandlersRef.current = {
    onToggle: selectTerminal,
    onArchive: archiveSession,
    onRestore: restoreSession,
    onDelete: deleteTask,
    onTogglePinned: toggleSessionPinned,
  };

  // Delete every archived row shown for this project. Still on the Panel's own
  // delete endpoint, which is sound only because the rows it can see are
  // Panel-owned — a Core's archived rows never reach `tasks` (see
  // archiveTasks). Whoever teaches the core-link to list them owes this
  // function a `mutateTaskForCore` route too, or it will 404 the way archive did.
  const deleteAllArchived = () => {
    setConfirmDeleteArchived(false);
    if (!project) return;
    const archived = tasks.filter((t) => t.archived);
    if (archived.length === 0) return;

    const tasksKey = queryKeys.tasks(project.id);
    void queryClient.cancelQueries({ queryKey: tasksKey });
    const previousTasks = queryClient.getQueryData<Task[]>(tasksKey);
    const archivedIds = new Set(archived.map((t) => t.id));
    removeTasksFromCache(queryClient, project.id, archivedIds);

    void (async () => {
      try {
        await Promise.all(
          archived.map(async (t) => {
            await terminals.close(t.id).catch(() => undefined);
            await api.deleteTask(t.id);
          }),
        );
        void refresh();
      } catch (e: unknown) {
        if (previousTasks) {
          restoreTasksCache(queryClient, project.id, previousTasks);
        }
        toast.error(e instanceof Error ? e.message : "Could not delete archived sessions");
      } finally {
        setCleanupStatus(null);
      }
    })();
  };

  const startHarness = (data: {
    agent: Task["agent"];
    title: string;
    bareSession: boolean;
  }) => {
    setShowNewHarness(false);
    if (newHarnessTarget === "newRow") {
      // The "New row" button asked for this session to start a fresh grid row.
      terminals.requestNewRow();
    } else {
      // Default: drop the new session beside the active one, like Clone.
      const anchor = anchorSessionId();
      if (anchor) terminals.requestCloneInsertAfter(anchor);
    }
    setNewHarnessTarget("default");
    createSession(
      {
        agent: data.agent,
        bareSession: data.bareSession,
      },
      { focusOnCreate: true },
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
          outline: "none",
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
          <div ref={overflowRef} style={{ position: "relative", flex: "0 0 auto", display: "inline-flex", alignItems: "center" }}>
            <div
              role="button"
              tabIndex={0}
              onClick={() => setOverflowOpen((v) => !v)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setOverflowOpen((v) => !v);
                }
              }}
              aria-haspopup="menu"
              aria-expanded={overflowOpen}
              aria-label={`${project.name} project actions`}
              title={project.name}
              className="mc-project-header-trigger"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "6px 8px 6px 6px",
                color: "var(--text)",
                cursor: "pointer",
                borderRadius: 10,
                flexShrink: 0,
              }}
            >
              <ProjectIcon project={project} size={32} />
              <span
                style={{
                  fontFamily: "var(--mono)",
                  fontSize: 14,
                  fontWeight: 600,
                  color: "var(--text)",
                  letterSpacing: "-0.01em",
                  maxWidth: 220,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {project.name}
              </span>
              <Icon
                name="chevron-down"
                size={14}
                style={{
                  color: "var(--text-dim)",
                  flexShrink: 0,
                  transform: overflowOpen ? "rotate(180deg)" : undefined,
                  transition: "transform 120ms ease",
                }}
              />
            </div>
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
                  icon={project.pinned ? "pin-fill" : "pin"}
                  onClick={toggleProjectPin}
                  disabled={pinning}
                >
                  {pinning
                    ? project.pinned
                      ? "Unpinning..."
                      : "Pinning..."
                    : project.pinned
                      ? "Unpin project"
                      : "Pin project"}
                </DropdownMenuItem>
                {project.githubUrl ? (
                  <DropdownMenuItem
                    icon="github"
                    onClick={() => {
                      setOverflowOpen(false);
                      openExternal(project.githubUrl!);
                    }}
                  >
                    Open GitHub
                  </DropdownMenuItem>
                ) : null}
                {showGrid && gridScopeSessionCount > 0 && (
                  <>
                    <DropdownMenuSeparator />
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
                  </>
                )}
                <DropdownMenuSeparator />
                <HotkeyTooltip action="project.edit">
                  <DropdownMenuItem
                    icon="settings"
                    onClick={() => {
                      setOverflowOpen(false);
                      setShowEdit(true);
                    }}
                  >
                    Edit project
                  </DropdownMenuItem>
                </HotkeyTooltip>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  danger
                  icon="trash"
                  onClick={() => {
                    setOverflowOpen(false);
                    setConfirmRemove(true);
                  }}
                  title="Remove this project from Actana Control. The folder on disk is not touched."
                >
                  Remove project
                </DropdownMenuItem>
              </CardFrame>,
              document.body,
            )}
          </div>
          {(() => {
            if (!(settings?.showProjectHeaderGroup ?? true)) return null;
            const projectGroup = project.groupId
              ? groups.find((g) => g.id === project.groupId)
              : undefined;
            if (!projectGroup) return null;
            return (
              <button
                type="button"
                onClick={() => {
                  setActiveGroup(projectGroup.id);
                  void router.navigate({ to: "/" });
                }}
                onContextMenu={hideElementContextMenu("project-header-group")}
                title={`Group: ${projectGroup.name} — open dashboard scoped to this group`}
                aria-label={`Group ${projectGroup.name} — open dashboard scoped to this group`}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 7,
                  padding: "4px 11px",
                  borderRadius: 999,
                  border: "1px solid var(--border-strong)",
                  background: "var(--surface-1)",
                  color: "var(--text-dim)",
                  fontFamily: "var(--mono)",
                  fontSize: 11,
                  cursor: "pointer",
                  flexShrink: 0,
                  maxWidth: 160,
                }}
              >
                <span
                  aria-hidden
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: "50%",
                    background: projectGroup.color,
                    boxShadow: `0 0 6px ${projectGroup.color}66`,
                    flexShrink: 0,
                  }}
                />
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {projectGroup.name}
                </span>
              </button>
            );
          })()}
          {hideableMenu}
          {showSessionScopeToggle && (
            <SessionScopeToggle
              view={sessionView}
              activeCount={activeTasks.length}
              pinnedCount={pinnedTasks.length}
              archivedCount={archivedTasks.length}
              showArchivedTab={hasArchivedTasks || showArchived}
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
                project={project}
                onPrimary={onNewHarnessPrimary}
                onNewRow={showGrid ? onNewRowPrimary : undefined}
                disabled={!projectPathReady}
                onConfigure={() => {
                  if (projectPathReady) setShowNewHarness(true);
                }}
              />
            )}
            {showArchived && archivedTasks.length > 0 && (
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
            pinnedTaskIds={pinnedTaskIds}
            onTogglePinned={toggleSessionPinned}
            pinningTaskIds={pinningTaskIds}
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
          {tasksQuery.isLoading ? (
            <EmptyState
              title="Loading sessions"
              subtitle="Fetching the hosted task list and terminal state."
              icon="sparkles"
            />
          ) : tasksQuery.isError ? (
            <EmptyState
              title="Could not load sessions"
              subtitle="Actana Control could not load sessions for this project. Retry before starting new work."
              icon="shield"
              action={
                <Btn variant="primary" icon="refresh" onClick={() => void tasksQuery.refetch()}>
                  Retry
                </Btn>
              }
            />
          ) : showArchived && visibleTasks.length === 0 ? (
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
          ) : showPinned && visibleTasks.length === 0 ? (
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
          ) : visibleTasks.length === 0 ? (
            <EmptyState
              title="No active sessions"
              subtitle="Start a new session to begin working on this project."
              action={
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <NewHarnessButton
                    project={project}
                    onPrimary={onNewHarnessPrimary}
                    disabled={!projectPathReady}
                    onConfigure={() => {
                      if (projectPathReady) setShowNewHarness(true);
                    }}
                  />
                  {hasArchivedTasks && (
                    <Btn variant="ghost" icon="archive" onClick={() => setSessionView("archived")}>
                      View archived
                    </Btn>
                  )}
                </div>
              }
            />
          ) : (
            <>
              {pinnedListTasks.length > 0 && (
                <TaskColumn
                  key={`${id}:pinned`}
                  title="Pinned"
                  color="var(--accent)"
                  tasks={pinnedListTasks}
                  activeId={activeId}
                  onToggle={stableSelectTerminal}
                  onArchive={stableArchiveSession}
                  onTogglePinned={stableToggleSessionPinned}
                  pinningTaskIds={pinningTaskIds}
                />
              )}
              {STATUS_DISPLAY_ORDER.filter((s) => tasksByStatus[s].length > 0).map((status) => {
                const isArchivedTitleRow = showArchived && status === "finished";
                const firstArchivedStatus = showArchived
                  ? STATUS_DISPLAY_ORDER.find((s) => tasksByStatus[s].length > 0)
                  : undefined;
                // Prefer the "Archived" (finished) row; otherwise put the exit
                // control on the first visible archived status column.
                const showViewActive =
                  showArchived &&
                  (isArchivedTitleRow ||
                    (tasksByStatus.finished.length === 0 && status === firstArchivedStatus));
                return (
                <TaskColumn
                  key={`${id}:${status}`}
                  title={
                    isArchivedTitleRow
                      ? "Archived"
                      : STATUS_META[status].label
                  }
                  color={STATUS_META[status].color}
                  tasks={tasksByStatus[status]}
                  activeId={activeId}
                  onToggle={stableSelectTerminal}
                  onArchive={showArchived ? undefined : stableArchiveSession}
                  onRestore={showArchived ? stableRestoreSession : undefined}
                  onDelete={showArchived ? stableDeleteTask : undefined}
                  onTogglePinned={showArchived ? undefined : stableToggleSessionPinned}
                  pinningTaskIds={showArchived ? undefined : pinningTaskIds}
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
                    ) : !showArchived && status === "finished" && tasksByStatus.finished.length > 0 ? (
                      <Btn
                        variant="ghost"
                        icon="archive"
                        onClick={() => archiveTasks(tasksByStatus.finished)}
                        title="Archive all finished sessions"
                      >
                        Archive all
                      </Btn>
                    ) : !showArchived &&
                      status === "disconnected" &&
                      tasksByStatus.disconnected.length > 0 ? (
                      <Btn
                        variant="ghost"
                        icon="archive"
                        onClick={() => archiveTasks(tasksByStatus.disconnected)}
                        title="Archive all disconnected sessions"
                      >
                        Archive all
                      </Btn>
                    ) : undefined
                  }
                />
                );
              })}
              {!showArchived && hasArchivedTasks && (
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
                    title={`View ${archivedTasks.length} archived session${archivedTasks.length === 1 ? "" : "s"}`}
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

      <Modal
        open={!!projectPathIssue}
        onClose={closePathIssue}
        title="Project folder missing"
        width={540}
        footer={
          <>
            <StaticHotkeyTooltip hotkey="Esc">
              <Btn
                variant="ghost"
                onClick={closePathIssue}
              >
                Back to projects
              </Btn>
            </StaticHotkeyTooltip>
            <Btn
              variant="danger"
              icon="trash"
              onClick={() => void removeMissingProject()}
              disabled={removingMissingProject}
            >
              {removingMissingProject ? "Removing..." : "Remove project"}
            </Btn>
          </>
        }
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ fontSize: 13, lineHeight: 1.55, color: "var(--text)" }}>
            {projectPathIssue?.message ?? "Actana Control cannot find this project folder."}
            {" "}
            Point the project at its new location from Edit project, or remove it from Actana
            Control.
          </div>
          {projectPathActionError && (
            <div
              style={{
                border: "1px solid color-mix(in srgb, var(--status-failed) 55%, transparent)",
                borderRadius: 10,
                background: "color-mix(in srgb, var(--status-failed) 12%, transparent)",
                color: "var(--status-failed)",
                padding: "9px 11px",
                fontFamily: "var(--mono)",
                fontSize: 11.5,
                lineHeight: 1.45,
              }}
            >
              {projectPathActionError}
            </div>
          )}
          <div
            style={{
              border: "1px solid var(--border)",
              borderRadius: 10,
              background: "var(--surface-0)",
              padding: "10px 12px",
              fontFamily: "var(--mono)",
              fontSize: 11.5,
              color: "var(--text-dim)",
              lineHeight: 1.45,
              wordBreak: "break-all",
            }}
          >
            {projectPathIssue?.path}
          </div>
        </div>
      </Modal>

      <Modal
        open={projectPathCheck.state === "error"}
        onClose={closePathIssue}
        title="Could not check project folder"
        width={500}
        footer={
          <>
            <StaticHotkeyTooltip hotkey="Esc">
              <Btn variant="ghost" onClick={closePathIssue}>
                Back to projects
              </Btn>
            </StaticHotkeyTooltip>
            <Btn
              variant="primary"
              icon="refresh"
              onClick={() => void retryProjectPathCheck()}
              disabled={retryingProjectPath}
            >
              {retryingProjectPath ? "Checking..." : "Retry"}
            </Btn>
          </>
        }
      >
        <div style={{ fontSize: 13, lineHeight: 1.55, color: "var(--text)" }}>
          {projectPathCheck.state === "error"
            ? projectPathCheck.message
            : "Actana Control could not verify this project path."}
        </div>
      </Modal>

      <NewHarnessDialog
        open={showNewHarness}
        project={project}
        coreId={coreId}
        onClose={() => {
          setShowNewHarness(false);
          setNewHarnessTarget("default");
        }}
        onStart={startHarness}
        onHarnessUpdateRequired={showHarnessUpdateRequired}
        onPersistRemember={async (patch) => {
          const previous = queryClient.getQueryData<typeof project>(queryKeys.project(project.id));
          queryClient.setQueryData(queryKeys.project(project.id), (prev: typeof project | undefined) =>
            prev ? { ...prev, ...patch } : prev
          );
          try {
            if (coreId) {
              // "Remember these settings" persists to the projects row, which
              // lives on the Core that owns it (ADR 0004/0005) — so the write
              // is a `settings` mutation frame to that Core, not a PATCH that
              // would 404 on the Panel's own rows. Every Panel connected to
              // that Core converges on the result, as it does for pinning.
              const updated = await mutateProjectForCore(coreId, {
                op: "settings",
                projectId: project.id,
                rememberHarnessSettings: patch.rememberHarnessSettings,
                savedHarness: patch.savedHarness,
                savedSkipPermissions: patch.savedSkipPermissions,
                savedBareSession: patch.savedBareSession,
              });
              if (!updated) throw new Error("The Core did not save the session settings.");
            } else {
              await api.updateProject(project.id, patch);
            }
            await refresh();
          } catch (error) {
            queryClient.setQueryData(queryKeys.project(project.id), previous);
            // Callers `void` this promise (NewHarnessDialog:166,171,195), so
            // rethrowing would become an unhandled rejection. Surface it as
            // a toast and swallow.
            toast.error(
              error instanceof Error ? error.message : "Could not save agent settings",
            );
          }
        }}
      />

      <ProjectDialog
        open={showEdit}
        project={project}
        groups={groups}
        // Editing browses the folders of the Core that owns this project —
        // the dialog has no other way to know whose disk to walk.
        initialCoreId={coreId}
        onCreateGroup={createGroupForSelection}
        onClose={() => setShowEdit(false)}
        onSave={async (data) => {
          await saveProjectEdits(coreId, project, data);
          setShowEdit(false);
          await refresh();
        }}
      />

      <RemoveProjectConfirmDialog
        open={confirmRemove}
        onClose={() => setConfirmRemove(false)}
        onConfirm={confirmRemoveProject}
        projectName={project.name}
        projectPath={project.path}
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
          Permanently delete all archived sessions in &ldquo;{project.name}&rdquo;?
        </div>
        <div style={{ fontSize: 12, color: "var(--text-dim)" }}>
          {archivedTasks.length} archived session{archivedTasks.length === 1 ? "" : "s"} will be deleted. This cannot be undone. Active sessions are unaffected.
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
          {gridScopeSessionCount === 1 ? "" : "s"} in &ldquo;{project.name}&rdquo;?
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

