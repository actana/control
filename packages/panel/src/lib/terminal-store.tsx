import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { getCorePtyBridge, getPanelBridge } from "./panel-bridge";
import { markIntentionalSessionClose } from "./intentional-session-close";
import { terminalSurfaceCache } from "./terminal-surface-cache";
import { HARNESS_REGISTRY, harnessLaunchesWithSkipPermissions } from "@actana/shared/harnesses";
import {
  harnessLaunchMode,
  harnessUsesPersistedSession,
  buildHarnessLaunchCommand,
  newSessionId,
} from "./harness-command";
import { api, ApiError } from "./api";
import type { Harness } from "@actana/shared/domain";
import type { Task } from "~/db/schema";
import type { CoreLinkProjectSnapshot, CoreLinkTaskSnapshot } from "@actana/sdk/core-link-frames";
import { projectScopeKey, scopeKeyForProject, type ScopedProject } from "./scoped-project";
import { projectSettingsFromSnapshot } from "~/shared/projects";
import { getDefaultModelForHarness } from "./default-model-store";
import { peekPendingSessionModel } from "./session-model-overrides";

// One-shot cleanup for post-removal builds: drop the renderer-side history
// key left behind by the retired screenshot feature so old JSON payloads do
// not linger on upgraded installs. Safe to run repeatedly. Stays for one
// release, then removed by a follow-up ticket (AC-CLEANUP-01).
if (typeof window !== "undefined") {
  try {
    window.localStorage.removeItem("mc.screenshots");
  } catch {}
}

export type OpenTerminal = {
  taskId: string;
  ptyId: string | null;
  startCommand: string;
  dangerouslySkipPermissions: boolean;
  cwd: string;
  project: ScopedProject;
  task: Task;
  /** PTY spawn waits until the task row exists on the server. */
  awaitingCreate?: boolean;
  /** Restored from localStorage; PTY spawn waits until the task is revalidated
   *  against the server. Dead/archived tasks are dropped instead of respawning,
   *  and live ones get a fresh snapshot + rebuilt start command. */
  pendingValidation?: boolean;
  /** The Core that owns this session. Its PTY and its task row both live on
   *  that Core's Core, so spawn/write/resize/kill/replay and revalidation
   *  all ride the panel link to it. Null only for a Panel-local row. */
  coreId?: string | null;
};

type Ctx = {
  /** All live sessions (PTYs alive in background). */
  sessions: OpenTerminal[];
  /** The session currently displayed in the panel for `projectId`, if any. */
  activeFor: (projectId: string) => OpenTerminal | null;
  /** The active taskId persisted for `projectId` (null = explicitly closed). */
  activeTaskIdFor: (projectId: string) => string | null;
  /** Click a card: select if not active, deselect (hide panel) if already active. */
  toggle: (
    project: ScopedProject,
    task: Task,
    opts?: { awaitCreate?: boolean; coreId?: string | null },
  ) => void;
  /** Select a session and optionally attach an already-running PTY (warm pool claim). */
  openSession: (
    project: ScopedProject,
    task: Task,
    opts?: { ptyId?: string | null; coreId?: string | null },
  ) => void;
  /**
   * Open a session on a remote Core (issue 07). Synthesizes the `ScopedProject`
   * and `Task` shapes the store/pane wiring is typed on from the two Core-link
   * snapshots, tags the session with `coreId` so `TerminalPane` routes spawn/
   * write/resize/kill through `getCorePtyBridge` instead of the local pty, and
   * uses the Core's own project `path` as `cwd` (a VM path, not a Panel path).
   */
  openRemoteTask: (
    coreId: string,
    project: CoreLinkProjectSnapshot,
    task: CoreLinkTaskSnapshot,
  ) => void;
  /** Deselect the active card for `projectId` and hide the panel without killing the PTY. */
  deselect: (projectId: string) => void;
  /** Mark an already-open session as the active one for its scope, without
   *  materializing or mutating the session. Focus mode uses it so switching the
   *  focused tab also moves the scope's active selection — exiting then restores
   *  the default view onto the session that was on screen while floating. */
  setActiveSession: (project: ScopedProject, taskId: string) => void;
  /** Tell root-level panel lookup which scope is currently visible for a project. */
  setVisibleScope: (projectId: string, scopeKey: string | null) => void;
  /** Materialize a session entry from a persisted taskId after reload, if not already present. */
  rehydrate: (project: ScopedProject, task: Task, opts?: { coreId?: string | null }) => void;
  /** Permanently close one session and kill its PTY. */
  close: (taskId: string, opts?: { activateTaskId?: string | null }) => Promise<void>;
  /** Swap a provisional task id (optimistic create) for the persisted task. */
  adoptTaskId: (fromTaskId: string, task: Task) => void;
  /** Permanently close every session for a project (kills PTYs). */
  closeForProject: (projectId: string) => Promise<void>;
  setPtyId: (taskId: string, ptyId: string | null, scopeKey?: string) => void;
  syncTask: (task: Task) => void;
  startCommandFor: (agent: Harness) => string;
  /** Run an arbitrary command in the active PTY for this task. */
  runIn: (taskId: string, command: string) => Promise<void>;
  /** Whether the full-width "all sessions" grid view is active. */
  gridView: boolean;
  /**
   * Set the grid view. It is one global preference, persisted across reloads —
   * so `persist: false` is for callers applying a *contextual* layout (a
   * project's own default grid view, issue 22) that must not overwrite what the
   * operator last chose for every other project.
   */
  setGridView: (value: boolean, opts?: { persist?: boolean }) => void;
  /** Flip the grid view on/off. */
  toggleGridView: () => void;
  /** Latest request to spotlight a session cell in the grid (e.g. from a
   *  notification's "Open"). The nonce makes repeated requests for the same
   *  task retrigger the grid's focus effect. `flash` asks the grid to also
   *  play the attach pulse on the cell. */
  gridFocusRequest: { taskId: string; nonce: number; flash?: boolean } | null;
  /** Ask the grid to scroll to, highlight, and focus a session's cell.
   *  `flash` additionally pulses the cell — the "your image landed here" cue
   *  after a screenshot attach, which the static spotlight ring can't convey
   *  when the target is already the focused cell. */
  focusGridSession: (taskId: string, opts?: { flash?: boolean }) => void;
  /** Claim a spotlight request for handling. True exactly once per nonce: the
   *  request state lingers after the grid's focus effect runs, and the grid
   *  remounts across project switches, so without this a stale request would
   *  replay on mount and un-hide the session it targeted. */
  consumeGridFocusRequest: (nonce: number) => boolean;
  /** Ask the grid to drop the next newly-created session directly after this
   *  source session (used by "Clone session" so a clone lands beside its
   *  origin instead of at the end of the grid). */
  requestCloneInsertAfter: (sourceTaskId: string) => void;
  /** Consume the pending clone-insert source id (null if none is queued). */
  takeCloneInsertAfter: () => string | null;
  /** Report the grid cell whose terminal just took focus (null on blur away). */
  noteGridFocusedTask: (taskId: string | null) => void;
  /** The grid cell that most recently held focus, or null. Lets callers anchor a
   *  new session on the active pane even after a button click moved DOM focus. */
  getGridFocusedTaskId: () => string | null;
  /** Ask the grid to place the next newly-created session in a brand-new row at
   *  the bottom (used by the grid's "New row" button). */
  requestNewRow: () => void;
  /** Consume the pending new-row request (true if one is queued). */
  takeNewRowRequest: () => boolean;
  /** Consume any provisional→persisted session id renames since the last call,
   *  so views keyed by taskId can preserve position across adoption. */
  takeSessionIdRenames: () => Array<{ from: string; to: string }>;
};

// The store is split into two contexts so a session-status tick (which churns
// `sessions`) only re-renders consumers that actually read reactive data. The
// data slice changes on session/active/gridView updates; the actions slice
// keeps a constant identity for the provider's lifetime, so pure-action
// consumers (e.g. every TerminalPane, which only needs syncTask) never
// re-render when a background session updates.
type TerminalDataKeys =
  | "sessions"
  | "activeFor"
  | "activeTaskIdFor"
  | "gridView"
  | "gridFocusRequest";
type TerminalData = Pick<Ctx, TerminalDataKeys>;
type TerminalActions = Omit<Ctx, TerminalDataKeys>;

const TerminalActionsContext = createContext<TerminalActions | null>(null);
const TerminalDataContext = createContext<TerminalData | null>(null);

// Narrow subscription bridge. `useGridView` / `useHasActiveSession` read a
// single boolean off refs via useSyncExternalStore, so shell chrome that needs
// only those booleans re-renders when they FLIP instead of on every
// session-status tick (which churns the whole data slice). Kept alongside — not
// replacing — the data context.
type TerminalStoreBridge = {
  subscribe: (cb: () => void) => () => void;
  getGridViewSnapshot: () => boolean;
  getHasActiveSessionSnapshot: (projectId: string | null) => boolean;
};
const TerminalStoreBridgeContext = createContext<TerminalStoreBridge | null>(null);

function commandFor(agent: Harness): string {
  return HARNESS_REGISTRY[agent].startCommand();
}

/** Shallow field equality for two task rows. Task is a flat DB row of
 *  primitives, so comparing own-enumerable keys is both correct and robust to
 *  schema growth — used to skip `sessions` churn on no-op refetches. */
function tasksEqual(a: Task, b: Task): boolean {
  if (a === b) return true;
  const aKeys = Object.keys(a) as (keyof Task)[];
  const bKeys = Object.keys(b) as (keyof Task)[];
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

/**
 * Compute the start command for a task. Hook-capable agents embed either a
 * new-session or resume invocation so conversations survive app restarts.
 * Side effect: generates and persists a session ID when one is missing on
 * agents that require a preassigned id (defensive — task creation should
 * have populated it).
 */
export function commandForTask(task: Task): string {
  return baseCommandForTask(
    task,
    peekPendingSessionModel(task.id) ?? getDefaultModelForHarness(task.agent),
  );
}

/**
 * Synthesize a Task-shaped row from a remote-Core {@link CoreLinkTaskSnapshot}.
 * The Panel's terminal store, TerminalPane, and grid views are all typed on
 * the Panel DB's `Task` shape, but a Core's task only travels the wire as a
 * thin snapshot (`taskId, title, agent, status, pinned, archived, updatedAt`).
 * The missing fields take the Panel DB's defaults; when we have a prior
 * snapshot from the persisted session (`prior`), its fields (claudeSessionId,
 * ...) are preferred so continuity across a Panel reload doesn't reset the
 * agent's session id. Remote tasks carry `coreId` on the OpenTerminal, not on
 * the Task itself.
 */
/**
 * Synthesize a {@link ScopedProject} from a remote-Core project snapshot. The
 * store, panel, and grid are typed on the Panel DB's `Project` shape, so
 * remote-Core opens need a compatible object; missing columns default to the
 * the Panel DB's defaults. The `id` uses the Core-side projectId directly — the
 * Panel doesn't persist a separate id per remote project, and scope keys are
 * derived from it. `path` is the Core's VM path (used as the pty `cwd`).
 */
function remoteScopedProjectFromSnapshot(
  _coreId: string,
  snap: CoreLinkProjectSnapshot,
): ScopedProject {
  const now = snap.updatedAt;
  return {
    id: snap.projectId,
    name: snap.name,
    path: snap.path,
    icon: snap.icon,
    iconColor: snap.iconColor,
    imagePath: null,
    groupId: null,
    pinned: snap.pinned,
    pinnedOrder: null,
    launchUrl: null,
    // Remembered session settings are Core facts on the project row (issue 22),
    // so they come off the snapshot rather than defaulting to empty.
    ...projectSettingsFromSnapshot(snap),
    createdAt: now,
    updatedAt: now,
  };
}

function remoteTaskFromSnapshot(
  snapshot: CoreLinkTaskSnapshot,
  prior?: Task,
): Task {
  const base: Task = prior ?? {
    id: snapshot.taskId,
    projectId: snapshot.projectId,
    title: snapshot.title,
    titleManuallySet: false,
    icon: snapshot.icon,
    agent: snapshot.agent as Harness,
    status: snapshot.status as Task["status"],
    branch: "main",
    preview: "",
    lines: 0,
    archived: snapshot.archived,
    pinned: snapshot.pinned,
    claudeSessionId: null,
    claudeSkipPermissions: false,
    claudeBareSession: false,
    createdAt: snapshot.updatedAt,
    updatedAt: snapshot.updatedAt,
  };
  return {
    ...base,
    // Server-authoritative fields — always overwrite from the fresh snapshot.
    title: snapshot.title,
    agent: snapshot.agent as Harness,
    status: snapshot.status as Task["status"],
    pinned: snapshot.pinned,
    archived: snapshot.archived,
    icon: snapshot.icon,
    updatedAt: snapshot.updatedAt,
  };
}

function baseCommandForTask(task: Task, model: string | null): string {
  if (!harnessUsesPersistedSession(task.agent)) {
    return HARNESS_REGISTRY[task.agent].startCommand({
      skipPermissions: harnessLaunchesWithSkipPermissions(task.agent),
    });
  }

  let sessionId = task.claudeSessionId;
  if (!sessionId && task.agent !== "codex" && task.agent !== "opencode") {
    sessionId = newSessionId();
    // The row for a Core's task lives on that Core, so the Panel's own
    // PATCH would 404. `tasksMutate` doesn't carry claudeSessionId today
    // (protocol gap) — the minted id still gets baked into the launch
    // command below, so the current spawn resumes with it; only cross-Panel-
    // restart persistence is missing.
    if (!isRemoteTask(task.id)) {
      void api.updateTask(task.id, { claudeSessionId: sessionId }).catch(() => undefined);
    }
  }

  const mode = harnessLaunchMode({ ...task, claudeSessionId: sessionId });
  if ((task.agent === "codex" || task.agent === "opencode") && mode === "new") {
    return buildHarnessLaunchCommand(task, sessionId ?? "", mode, { model });
  }

  if (!sessionId) {
    return buildHarnessLaunchCommand(task, "", mode, { model });
  }

  return buildHarnessLaunchCommand(task, sessionId, mode, { model });
}

const ACTIVE_BY_PROJECT_KEY = "mc.terminalActiveByProject";
const GRID_VIEW_KEY = "mc.gridView";
const OPEN_SESSIONS_KEY = "mc.terminalOpenSessions";
/** Sessions change on hot paths (task sync per server event, per-pane ptyId
 *  updates while a grid boots), so open-session persistence is debounced. */
const SESSION_PERSIST_DEBOUNCE_MS = 300;

function loadGridView(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(GRID_VIEW_KEY) === "1";
  } catch {
    return false;
  }
}

// Tasks whose row lives on a Core rather than in the Panel's own DB. Populated
// by `toggle` / `openSession` when they tag an OpenTerminal with a coreId, and
// read by `baseCommandForTask` so it can skip the Panel-local
// `PATCH /api/tasks/:id` that would 404 for a Core-owned row. Stays a
// module-level Set (not React state) because `commandForTask` is a top-level
// export called from paths without access to the store's hooks.
const remoteTaskIds = new Set<string>();

function markTaskRemote(taskId: string, coreId: string | null | undefined): void {
  if (coreId) remoteTaskIds.add(taskId);
}

function unmarkTaskRemote(taskId: string): void {
  remoteTaskIds.delete(taskId);
}

function isRemoteTask(taskId: string): boolean {
  return remoteTaskIds.has(taskId);
}

export function nextActiveTaskId(
  currentTaskId: string | null,
  requestedTaskId: string,
  hasMaterializedSession: boolean
): string | null {
  return currentTaskId === requestedTaskId && hasMaterializedSession
    ? null
    : requestedTaskId;
}

/** Grace period before an un-selected archived session's PTY is reaped. */
export const ARCHIVED_SESSION_REAP_DELAY_MS = 60_000;

/**
 * Opened archived sessions whose PTY is eligible to be reaped right now.
 *
 * Clicking an archived card resumes its PTY so the user can inspect history,
 * but a left-open archived terminal leaks memory. A session qualifies once it
 * is archived AND is no longer the active selection in its scope (the user
 * closed it or switched to another card). An archived session that is still
 * selected is kept alive — reaping is deferred until they switch away.
 */
export function archivedSessionsEligibleForReap(
  sessions: OpenTerminal[],
  activeByProject: Record<string, string | null>,
): string[] {
  const eligible: string[] = [];
  for (const session of sessions) {
    if (!session.task.archived) continue;
    const scopeKey = scopeKeyForProject(session.project);
    if ((activeByProject[scopeKey] ?? null) === session.taskId) continue;
    eligible.push(session.taskId);
  }
  return eligible;
}

function loadActiveByProject(): Record<string, string | null> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(ACTIVE_BY_PROJECT_KEY);
    return raw ? (JSON.parse(raw) as Record<string, string | null>) : {};
  } catch {
    return {};
  }
}

/** Fields persisted per open session so the whole set (not just the active
 *  one) can be restored after a reload — required for the grid view, which
 *  renders every open session at once. */
type PersistedSession = Pick<
  OpenTerminal,
  "taskId" | "startCommand" | "dangerouslySkipPermissions" | "cwd" | "project" | "task" | "coreId"
>;

function serializeSessions(sessions: OpenTerminal[]): PersistedSession[] {
  return sessions
    // Skip provisional (optimistic-create) sessions whose task row isn't saved
    // yet, and archived sessions (they get reaped, so don't resurrect them).
    .filter((s) => !s.awaitingCreate && !s.task.archived)
    .map((s) => ({
      taskId: s.taskId,
      startCommand: s.startCommand,
      dangerouslySkipPermissions: s.dangerouslySkipPermissions,
      cwd: s.cwd,
      project: s.project,
      task: s.task,
      coreId: s.coreId ?? null,
    }));
}

function loadPersistedSessions(): OpenTerminal[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(OPEN_SESSIONS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const restored: OpenTerminal[] = [];
    for (const entry of parsed as PersistedSession[]) {
      if (!entry || typeof entry.taskId !== "string" || !entry.project || !entry.task) continue;
      // Dedupe by task id alone (not scope key): the same id under two scope
      // keys is the same underlying agent session. Restoring both would resume
      // one pinned session id twice and the second spawn dies with
      // "session ID is already in use".
      if (seen.has(entry.taskId)) continue;
      seen.add(entry.taskId);
      restored.push({
        taskId: entry.taskId,
        // Local PTYs are re-spawned lazily when the pane mounts.
        ptyId: null,
        startCommand: entry.startCommand,
        dangerouslySkipPermissions: entry.dangerouslySkipPermissions,
        cwd: entry.cwd,
        project: entry.project,
        task: entry.task,
        coreId: entry.coreId ?? null,
        // Gate the pane's PTY spawn until the snapshot is revalidated against
        // the server (see the validation effect in TerminalProvider).
        pendingValidation: true,
      });
    }
    return restored;
  } catch {
    return [];
  }
}

export function resolveActiveTaskIdForProject(
  activeByProject: Record<string, string | null>,
  projectId: string,
  visibleScopeByProject: Record<string, string | null> = {},
): { scopeKey: string | null; taskId: string | null } {
  if (projectId.includes(":")) {
    return { scopeKey: projectId, taskId: activeByProject[projectId] ?? null };
  }

  const visibleScopeKey = visibleScopeByProject[projectId] ?? null;
  if (visibleScopeKey) {
    return { scopeKey: visibleScopeKey, taskId: activeByProject[visibleScopeKey] ?? null };
  }

  const mainScopeKey = projectScopeKey(projectId);
  const mainTaskId = activeByProject[mainScopeKey] ?? activeByProject[projectId] ?? null;
  if (mainTaskId) return { scopeKey: mainScopeKey, taskId: mainTaskId };

  for (const [key, taskId] of Object.entries(activeByProject)) {
    if (taskId && key.startsWith(`${projectId}:`)) {
      return { scopeKey: key, taskId };
    }
  }

  return { scopeKey: null, taskId: null };
}

export function TerminalProvider({ children }: { children: ReactNode }) {
  const [sessions, setSessions] = useState<OpenTerminal[]>(loadPersistedSessions);
  const [activeByProject, setActiveByProject] = useState<Record<string, string | null>>(
    loadActiveByProject
  );
  const [visibleScopeByProject, setVisibleScopeByProject] = useState<Record<string, string>>({});
  const [gridView, setGridViewState] = useState<boolean>(loadGridView);
  // Read via a ref so `toggleGridView` keeps a stable identity (it lives in the
  // stable actions context) instead of re-creating on every gridView flip.
  const gridViewRef = useRef(gridView);
  gridViewRef.current = gridView;
  // Mirrors for the narrow-subscription bridge below (getSnapshot reads these).
  const activeByProjectRef = useRef(activeByProject);
  activeByProjectRef.current = activeByProject;
  const visibleScopeByProjectRef = useRef(visibleScopeByProject);
  visibleScopeByProjectRef.current = visibleScopeByProject;

  const setGridView = useCallback((value: boolean, opts?: { persist?: boolean }) => {
    setGridViewState(value);
    if (opts?.persist === false) return;
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(GRID_VIEW_KEY, value ? "1" : "0");
    } catch {
      /* quota or disabled */
    }
  }, []);

  const toggleGridView = useCallback(() => {
    setGridView(!gridViewRef.current);
  }, [setGridView]);

  const [gridFocusRequest, setGridFocusRequest] = useState<
    { taskId: string; nonce: number; flash?: boolean } | null
  >(null);
  const gridFocusNonceRef = useRef(0);
  const focusGridSession = useCallback((taskId: string, opts?: { flash?: boolean }) => {
    gridFocusNonceRef.current += 1;
    setGridFocusRequest({ taskId, nonce: gridFocusNonceRef.current, flash: opts?.flash });
  }, []);
  // Highest nonce the grid has handled. Kept here (not in the grid) so it
  // survives the grid unmounting/remounting across project switches — a ref,
  // not state, so consuming never re-renders (and never cancels the grid's
  // in-flight focus polling).
  const gridFocusConsumedNonceRef = useRef(0);
  const consumeGridFocusRequest = useCallback((nonce: number) => {
    if (nonce <= gridFocusConsumedNonceRef.current) return false;
    gridFocusConsumedNonceRef.current = nonce;
    return true;
  }, []);

  // Source session id for a pending clone: the grid drops the next new session
  // right after it. Refs (not state) so requesting doesn't re-render, and the
  // grid consumes the value exactly once as it reconciles its order.
  const cloneInsertAfterRef = useRef<string | null>(null);
  const requestCloneInsertAfter = useCallback((sourceTaskId: string) => {
    cloneInsertAfterRef.current = sourceTaskId;
  }, []);
  const takeCloneInsertAfter = useCallback(() => {
    const source = cloneInsertAfterRef.current;
    cloneInsertAfterRef.current = null;
    return source;
  }, []);
  // The grid cell whose terminal most recently held focus — the pane the user is
  // "on". The grid reports it on focusin; the project route reads it to anchor a
  // new session beside the active pane even when the click that created it (e.g.
  // the header "New session" button) pulled DOM focus off the grid. A ref so
  // reporting focus never re-renders the whole terminal tree.
  const gridFocusedTaskIdRef = useRef<string | null>(null);
  const noteGridFocusedTask = useCallback((taskId: string | null) => {
    gridFocusedTaskIdRef.current = taskId;
    if (!taskId) return;
    // Keep the scope's active session in step with the grid's focused cell, so
    // leaving the grid lands on the pane the user was on rather than whatever
    // was active before. The functional update returns `prev` unchanged when it
    // already matches, so this only re-renders on a real cell-to-cell focus
    // change (typing in one cell never touches it). sessionsRef is read at call
    // time — always populated by the time a focusin fires.
    const session = sessionsRef.current.find((s) => s.taskId === taskId);
    if (!session) return;
    const scopeKey = scopeKeyForProject(session.project);
    setActiveByProject((prev) =>
      prev[scopeKey] === taskId ? prev : { ...prev, [scopeKey]: taskId },
    );
  }, []);
  const getGridFocusedTaskId = useCallback(() => gridFocusedTaskIdRef.current, []);
  // Pending "New row" request: the grid drops the next new session into a fresh
  // bottom row. Ref (not state) so requesting doesn't re-render, consumed once.
  const newRowRequestRef = useRef(false);
  const requestNewRow = useCallback(() => {
    newRowRequestRef.current = true;
  }, []);
  const takeNewRowRequest = useCallback(() => {
    const pending = newRowRequestRef.current;
    newRowRequestRef.current = false;
    return pending;
  }, []);
  const sessionIdRenamesRef = useRef<Array<{ from: string; to: string }>>([]);
  const takeSessionIdRenames = useCallback(() => {
    if (sessionIdRenamesRef.current.length === 0) return [];
    const renames = sessionIdRenamesRef.current;
    sessionIdRenamesRef.current = [];
    return renames;
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(ACTIVE_BY_PROJECT_KEY, JSON.stringify(activeByProject));
    } catch {
      /* quota or disabled */
    }
  }, [activeByProject]);

  // Persist the full open-session set so a reload can restore every session
  // (the grid renders all of them), not just the active one per scope. Each
  // entry embeds its project + task, so serializing on every sessions change
  // would put a large synchronous stringify + write on hot paths — debounce
  // it, skip writes whose payload is unchanged, and flush on pagehide (and
  // provider teardown) so a quit never loses the latest set.
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastPersistedRef = useRef<string | null>(null);
  const flushPersistedSessions = useCallback(() => {
    if (persistTimerRef.current !== null) {
      clearTimeout(persistTimerRef.current);
      persistTimerRef.current = null;
    }
    const payload = JSON.stringify(serializeSessions(sessionsRef.current));
    if (payload === lastPersistedRef.current) return;
    lastPersistedRef.current = payload;
    try {
      window.localStorage.setItem(OPEN_SESSIONS_KEY, payload);
    } catch {
      /* quota or disabled */
    }
  }, []);
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (persistTimerRef.current !== null) clearTimeout(persistTimerRef.current);
    persistTimerRef.current = setTimeout(flushPersistedSessions, SESSION_PERSIST_DEBOUNCE_MS);
  }, [sessions, flushPersistedSessions]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.addEventListener("pagehide", flushPersistedSessions);
    return () => {
      window.removeEventListener("pagehide", flushPersistedSessions);
      flushPersistedSessions();
    };
  }, [flushPersistedSessions]);

  const killPty = async (coreId: string | null | undefined, id: string | null) => {
    if (!coreId || !id) return;
    await getCorePtyBridge(coreId)?.kill(id).catch(() => undefined);
  };

  const toggle = useCallback(
    (
      project: ScopedProject,
      task: Task,
      opts?: { awaitCreate?: boolean; coreId?: string | null },
    ) => {
      const scopeKey = scopeKeyForProject(project);
      const hadSession = sessionsRef.current.some(
        (p) => p.taskId === task.id && scopeKeyForProject(p.project) === scopeKey
      );
      setSessions((prev) => {
        const existing = prev.find(
          (p) => p.taskId === task.id && scopeKeyForProject(p.project) === scopeKey
        );
        if (existing) {
          if (!opts?.awaitCreate || existing.awaitingCreate) return prev;
          return prev.map((p) =>
            p.taskId === task.id && scopeKeyForProject(p.project) === scopeKey
              ? { ...p, awaitingCreate: true, task }
              : p
          );
        }
        // Register remote-Core tasks BEFORE computing the start command,
        // so `baseCommandForTask` sees the marker and skips the Panel's own
        // claudeSessionId PATCH for a Core-owned row.
        markTaskRemote(task.id, opts?.coreId);
        const next: OpenTerminal = {
          taskId: task.id,
          ptyId: null,
          startCommand: commandForTask(task),
          dangerouslySkipPermissions: harnessLaunchesWithSkipPermissions(task.agent),
          cwd: project.path,
          project,
          task,
          awaitingCreate: opts?.awaitCreate,
          // Tag the session with its owning Core so TerminalPane addresses
          // spawn/write/etc. to the right Core.
          coreId: opts?.coreId ?? null,
        };
        return [...prev, next];
      });
      setActiveByProject((prev) => {
        const curr = prev[scopeKey] ?? null;
        const next = nextActiveTaskId(curr, task.id, hadSession);
        return curr === next ? prev : { ...prev, [scopeKey]: next };
      });
    },
    []
  );

  const openSession = useCallback(
    (
      project: ScopedProject,
      task: Task,
      opts?: { ptyId?: string | null; coreId?: string | null },
    ) => {
      const scopeKey = scopeKeyForProject(project);
      const coreId = opts?.coreId ?? null;
      // Same rationale as `toggle`: register before the setState reads
      // `commandForTask` so the PATCH gate is honoured on the first spawn.
      if (opts?.coreId !== undefined) markTaskRemote(task.id, coreId);
      setSessions((prev) => {
        const existing = prev.find(
          (p) => p.taskId === task.id && scopeKeyForProject(p.project) === scopeKey
        );
        if (existing) {
          return prev.map((p) =>
            p.taskId === task.id && scopeKeyForProject(p.project) === scopeKey
              ? {
                  ...p,
                  task,
                  ptyId: opts?.ptyId ?? p.ptyId ?? null,
                  startCommand: commandForTask(task),
                  dangerouslySkipPermissions: harnessLaunchesWithSkipPermissions(task.agent),
                  awaitingCreate: false,
                  // The caller holds a live task row — no revalidation needed.
                  pendingValidation: undefined,
                  coreId: opts?.coreId !== undefined ? coreId : p.coreId,
                }
              : p
          );
        }
        return [
          ...prev,
          {
            taskId: task.id,
            ptyId: opts?.ptyId ?? null,
            startCommand: commandForTask(task),
            dangerouslySkipPermissions: harnessLaunchesWithSkipPermissions(task.agent),
            cwd: project.path,
            project,
            task,
            coreId,
          },
        ];
      });
      setActiveByProject((prev) =>
        prev[scopeKey] === task.id ? prev : { ...prev, [scopeKey]: task.id }
      );
    },
    []
  );

  const openRemoteTask = useCallback(
    (
      coreId: string,
      projectSnap: CoreLinkProjectSnapshot,
      taskSnap: CoreLinkTaskSnapshot,
    ) => {
      const project = remoteScopedProjectFromSnapshot(coreId, projectSnap);
      const task = remoteTaskFromSnapshot(taskSnap);
      openSession(project, task, { coreId });
    },
    [openSession],
  );

  const rehydrate = useCallback(
    (project: ScopedProject, task: Task, opts?: { coreId?: string | null }) => {
      const scopeKey = scopeKeyForProject(project);
      const coreId = opts?.coreId ?? null;
      if (opts?.coreId !== undefined) markTaskRemote(task.id, coreId);
      setSessions((prev) => {
        if (prev.some((p) => p.taskId === task.id && scopeKeyForProject(p.project) === scopeKey)) {
          return prev;
        }
        return [
          ...prev,
          {
            taskId: task.id,
            ptyId: null,
            startCommand: commandForTask(task),
            dangerouslySkipPermissions: harnessLaunchesWithSkipPermissions(task.agent),
            cwd: project.path,
            project,
            task,
            coreId,
          },
        ];
      });
    },
    [],
  );

  const setVisibleScope = useCallback((projectId: string, scopeKey: string | null) => {
    setVisibleScopeByProject((prev) => {
      if (scopeKey === null) {
        if (!(projectId in prev)) return prev;
        const next = { ...prev };
        delete next[projectId];
        return next;
      }
      return prev[projectId] === scopeKey ? prev : { ...prev, [projectId]: scopeKey };
    });
  }, []);

  const deselect = useCallback((projectId: string) => {
    setActiveByProject((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const key of Object.keys(next)) {
        if (key === projectId || key.startsWith(`${projectId}:`)) {
          next[key] = null;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, []);

  const setActiveSession = useCallback((project: ScopedProject, taskId: string) => {
    const scopeKey = scopeKeyForProject(project);
    setActiveByProject((prev) =>
      prev[scopeKey] === taskId ? prev : { ...prev, [scopeKey]: taskId }
    );
  }, []);

  const adoptTaskId = useCallback((fromTaskId: string, task: Task) => {
    // Record the id swap so views keyed by taskId (e.g. the grid order) can
    // follow the session in place instead of treating it as a fresh add.
    if (fromTaskId !== task.id) {
      sessionIdRenamesRef.current.push({ from: fromTaskId, to: task.id });
      // Carry the remote-task marker across the id swap so the fresh id
      // still bypasses the Panel's own claudeSessionId PATCH on subsequent
      // command builds.
      if (isRemoteTask(fromTaskId)) {
        unmarkTaskRemote(fromTaskId);
        remoteTaskIds.add(task.id);
      }
    }
    // The pane re-keys to the persisted id and remounts under it; dispose the
    // provisional-id surface so it doesn't leak (the new pane re-attaches to the
    // same PTY via replay).
    terminalSurfaceCache.destroy(fromTaskId);
    setSessions((prev) => {
      let changed = false;
      const next = prev.map((p) => {
        if (p.taskId !== fromTaskId) return p;
        changed = true;
        return {
          ...p,
          taskId: task.id,
          task,
          startCommand: commandForTask(task),
          dangerouslySkipPermissions: harnessLaunchesWithSkipPermissions(task.agent),
          awaitingCreate: false,
        };
      });
      return changed ? next : prev;
    });
    setActiveByProject((prev) => {
      let changed = false;
      const next: Record<string, string | null> = { ...prev };
      for (const [key, tid] of Object.entries(prev)) {
        if (tid === fromTaskId) {
          next[key] = task.id;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, []);

  const close = useCallback(async (taskId: string, opts?: { activateTaskId?: string | null }) => {
    markIntentionalSessionClose(taskId);
    unmarkTaskRemote(taskId);
    setSessions((prev) => {
      const target = prev.find((p) => p.taskId === taskId);
      if (target) {
        terminalSurfaceCache.destroy(target.taskId);
        void killPty(target.coreId, target.ptyId);
      }
      return prev.filter((p) => p.taskId !== taskId);
    });
    setActiveByProject((prev) => {
      const next: Record<string, string | null> = {};
      let changed = false;
      for (const [pid, tid] of Object.entries(prev)) {
        if (tid === taskId) {
          next[pid] =
            opts?.activateTaskId !== undefined ? (opts.activateTaskId ?? null) : null;
          changed = true;
        } else {
          next[pid] = tid;
        }
      }
      return changed ? next : prev;
    });
  }, []);

  // Reap opened archived sessions. Clicking an archived card resumes its PTY
  // so its history can be inspected; once the user closes it or switches to
  // another card, kill the PTY after a grace period to reclaim memory.
  // Re-selecting the session before the timer fires cancels the kill (it drops
  // out of the eligible set); switching away again reschedules it. Reaping only
  // ever targets non-active sessions, so it never disturbs the visible panel.
  const reapTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  useEffect(() => {
    const timers = reapTimersRef.current;
    const eligible = new Set(archivedSessionsEligibleForReap(sessions, activeByProject));
    for (const taskId of eligible) {
      if (timers.has(taskId)) continue;
      timers.set(
        taskId,
        setTimeout(() => {
          timers.delete(taskId);
          void close(taskId);
        }, ARCHIVED_SESSION_REAP_DELAY_MS),
      );
    }
    for (const [taskId, timer] of timers) {
      if (eligible.has(taskId)) continue;
      clearTimeout(timer);
      timers.delete(taskId);
    }
  }, [sessions, activeByProject, close]);

  useEffect(() => {
    const timers = reapTimersRef.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  // Revalidate restored sessions against the server once on startup. Sessions
  // are seeded straight from the localStorage snapshot, which can be stale: a
  // task archived or deleted while this window was closed (server cleanup, a
  // second window) must not resurrect as a live cell — or worse, respawn its
  // agent — and a live task's launch command may have changed since the
  // snapshot (agent/model/skip-permissions), so it is rebuilt from the fresh
  // row. Panes hold off spawning until their session's gate clears
  // (pendingValidation), so a dead task's agent never boots.
  //
  // A Core-owned session's `taskId` lives on that Core's Core, so
  // `api.getTask` would 404 for every one of them and drop live sessions on
  // reload. Revalidate those over the panel link with `listTasks(coreId)` and
  // match on `taskId`. Task metadata is refreshed from the returned
  // {@link CoreLinkTaskSnapshot}, but the persisted `startCommand` is kept —
  // the snapshot doesn't carry the fields (`claudeSessionId`, ...) that
  // `commandForTask` needs to rebuild it.
  const validationRanRef = useRef(false);
  useEffect(() => {
    if (validationRanRef.current) return;
    validationRanRef.current = true;
    const pending = sessions.filter((s) => s.pendingValidation);
    if (pending.length === 0) return;
    void (async () => {
      const bridge = getPanelBridge();
      const remoteCoreIds = new Set(
        pending.map((s) => s.coreId).filter((id): id is string => !!id),
      );
      // Fan out one `listTasks(coreId)` per Core touched by the pending set —
      // fewer round-trips than one call per session, and the result is a full
      // snapshot the closure below can look up by taskId.
      const remoteByCore = new Map<string, Map<string, Task> | null>();
      await Promise.all(
        [...remoteCoreIds].map(async (coreId) => {
          if (!bridge) {
            remoteByCore.set(coreId, null);
            return;
          }
          const listed = await bridge.listTasks(coreId).catch(() => null);
          const tasks = listed?.tasks;
          if (!tasks) {
            remoteByCore.set(coreId, null);
            return;
          }
          remoteByCore.set(
            coreId,
            new Map(
              tasks.map((t) => [
                t.taskId,
                remoteTaskFromSnapshot(t, pending.find((p) => p.taskId === t.taskId)?.task),
              ]),
            ),
          );
        }),
      );
      const checks = await Promise.all(
        pending.map(async (session) => {
          const coreId = session.coreId;
          if (coreId) {
            const snapshots = remoteByCore.get(coreId);
            if (snapshots === null) {
              // Core unreachable — release the gate, keep the snapshot rather
              // than dropping a session whose Core is just briefly down.
              return { taskId: session.taskId, task: undefined, remote: true as const };
            }
            const task = snapshots?.get(session.taskId) ?? null;
            return { taskId: session.taskId, task, remote: true as const };
          }
          try {
            const { task } = await api.getTask(session.taskId);
            return { taskId: session.taskId, task: task as Task | null, remote: false as const };
          } catch (err) {
            // 404 → the task is gone; drop the session. Any other failure
            // (server briefly unreachable) → release the gate and run on the
            // snapshot rather than leaving the pane blocked forever.
            const gone = err instanceof ApiError && err.status === 404;
            return {
              taskId: session.taskId,
              task: gone ? null : undefined,
              remote: false as const,
            };
          }
        }),
      );
      // Rebuild launch commands outside the state updater — commandForTask can
      // persist a missing session id, and updaters must stay side-effect free.
      // Remote-Core sessions keep their persisted startCommand (see note above).
      const refreshed = new Map<
        string,
        { task: Task; startCommand: string | null }
      >();
      for (const c of checks) {
        if (!c.task || c.task.archived) continue;
        refreshed.set(c.taskId, {
          task: c.task,
          startCommand: c.remote ? null : commandForTask(c.task),
        });
      }
      for (const c of checks) {
        if (c.task === null || c.task?.archived) void close(c.taskId);
      }
      setSessions((prev) =>
        prev.map((p) => {
          if (!p.pendingValidation) return p;
          const fresh = refreshed.get(p.taskId);
          if (!fresh) {
            // Validation errored (non-404): release the gate, keep the snapshot.
            return { ...p, pendingValidation: undefined };
          }
          return {
            ...p,
            task: fresh.task,
            startCommand: fresh.startCommand ?? p.startCommand,
            dangerouslySkipPermissions: harnessLaunchesWithSkipPermissions(fresh.task.agent),
            pendingValidation: undefined,
          };
        }),
      );
    })();
  }, [sessions, close]);

  const closeForProject = useCallback(async (projectId: string) => {
    setSessions((prev) => {
      const remaining: OpenTerminal[] = [];
      for (const t of prev) {
        if (t.project.id === projectId) {
          markIntentionalSessionClose(t.taskId);
          terminalSurfaceCache.destroy(t.taskId);
          void killPty(t.coreId, t.ptyId);
        } else remaining.push(t);
      }
      return remaining;
    });
    setActiveByProject((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const key of Object.keys(next)) {
        if (key === projectId || key.startsWith(`${projectId}:`)) {
          delete next[key];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    setVisibleScopeByProject((prev) => {
      if (!(projectId in prev)) return prev;
      const next = { ...prev };
      delete next[projectId];
      return next;
    });
  }, []);

  const setPtyId = useCallback((taskId: string, ptyId: string | null, scopeKey?: string) => {
    setSessions((prev) => {
      let changed = false;
      const next = prev.map((p) => {
        if (p.taskId !== taskId) return p;
        const sessionScopeKey = scopeKeyForProject(p.project);
        if (scopeKey && sessionScopeKey !== scopeKey) return p;
        if (p.ptyId === ptyId) return p;
        changed = true;
        return { ...p, ptyId };
      });
      return changed ? next : prev;
    });
  }, []);

  const syncTask = useCallback((task: Task) => {
    setSessions((prev) => {
      let changed = false;
      const next = prev.map((p) => {
        if (p.taskId !== task.id) return p;
        // Tasks come off the query cache as freshly-parsed rows (new refs) on
        // every refetch, so a reference check alone treats every SSE-driven
        // refetch as a change and churns `sessions` (re-rendering every
        // useTerminals() consumer) even when the row is byte-identical. Compare
        // by field so an unchanged refetch is a genuine no-op.
        if (tasksEqual(p.task, task)) return p;
        changed = true;
        return { ...p, task };
      });
      return changed ? next : prev;
    });
  }, []);

  const runIn = useCallback(
    async (taskId: string, command: string) => {
      const target = sessionsRef.current.find((p) => p.taskId === taskId);
      if (!target?.ptyId || !target.coreId) return;
      await getCorePtyBridge(target.coreId)?.write(target.ptyId, command + "\r");
    },
    []
  );

  const activeFor = useCallback(
    (projectId: string): OpenTerminal | null => {
      const { scopeKey, taskId } = resolveActiveTaskIdForProject(
        activeByProject,
        projectId,
        visibleScopeByProject,
      );
      if (!scopeKey || !taskId) return null;
      return (
        sessions.find((s) => s.taskId === taskId && scopeKeyForProject(s.project) === scopeKey) ??
        null
      );
    },
    [activeByProject, sessions, visibleScopeByProject]
  );

  const activeTaskIdFor = useCallback(
    (projectId: string) => {
      return resolveActiveTaskIdForProject(
        activeByProject,
        projectId,
        visibleScopeByProject,
      ).taskId;
    },
    [activeByProject, visibleScopeByProject]
  );

  // Stable slice: every dependency is a constant-identity callback, so this memo
  // computes once and the actions context never changes — pure-action consumers
  // (useTerminalActions) don't re-render when `sessions` churns.
  const actions = useMemo<TerminalActions>(
    () => ({
      toggle,
      openSession,
      openRemoteTask,
      deselect,
      setActiveSession,
      setVisibleScope,
      rehydrate,
      close,
      adoptTaskId,
      closeForProject,
      setPtyId,
      syncTask,
      startCommandFor: commandFor,
      runIn,
      setGridView,
      toggleGridView,
      focusGridSession,
      consumeGridFocusRequest,
      requestCloneInsertAfter,
      takeCloneInsertAfter,
      noteGridFocusedTask,
      getGridFocusedTaskId,
      requestNewRow,
      takeNewRowRequest,
      takeSessionIdRenames,
    }),
    [
      toggle,
      openSession,
      openRemoteTask,
      deselect,
      setActiveSession,
      setVisibleScope,
      rehydrate,
      close,
      adoptTaskId,
      closeForProject,
      setPtyId,
      syncTask,
      runIn,
      setGridView,
      toggleGridView,
      focusGridSession,
      consumeGridFocusRequest,
      requestCloneInsertAfter,
      takeCloneInsertAfter,
      noteGridFocusedTask,
      getGridFocusedTaskId,
      requestNewRow,
      takeNewRowRequest,
      takeSessionIdRenames,
    ]
  );

  // Narrow-subscription bridge (see TerminalStoreBridgeContext). getSnapshot
  // reads refs updated in render; a change to sessions / active selection / grid
  // state notifies listeners, and each subscriber re-renders only when its own
  // boolean snapshot flips — so the shell doesn't re-render on every tick.
  const bridgeListenersRef = useRef<Set<() => void>>(new Set());
  const bridgeSubscribe = useCallback((cb: () => void) => {
    bridgeListenersRef.current.add(cb);
    return () => {
      bridgeListenersRef.current.delete(cb);
    };
  }, []);
  useEffect(() => {
    for (const cb of bridgeListenersRef.current) cb();
  }, [sessions, activeByProject, visibleScopeByProject, gridView]);
  const getGridViewSnapshot = useCallback(() => gridViewRef.current, []);
  const getHasActiveSessionSnapshot = useCallback((projectId: string | null) => {
    if (!projectId) return false;
    const { scopeKey, taskId } = resolveActiveTaskIdForProject(
      activeByProjectRef.current,
      projectId,
      visibleScopeByProjectRef.current,
    );
    if (!scopeKey || !taskId) return false;
    return sessionsRef.current.some(
      (s) => s.taskId === taskId && scopeKeyForProject(s.project) === scopeKey,
    );
  }, []);
  const bridge = useMemo<TerminalStoreBridge>(
    () => ({
      subscribe: bridgeSubscribe,
      getGridViewSnapshot,
      getHasActiveSessionSnapshot,
    }),
    [bridgeSubscribe, getGridViewSnapshot, getHasActiveSessionSnapshot],
  );

  // Reactive slice: changes when sessions / active selection / grid state move.
  const data = useMemo<TerminalData>(
    () => ({
      sessions,
      activeFor,
      activeTaskIdFor,
      gridView,
      gridFocusRequest,
    }),
    [
      sessions,
      activeFor,
      activeTaskIdFor,
      gridView,
      gridFocusRequest,
    ]
  );

  return (
    <TerminalStoreBridgeContext.Provider value={bridge}>
      <TerminalActionsContext.Provider value={actions}>
        <TerminalDataContext.Provider value={data}>{children}</TerminalDataContext.Provider>
      </TerminalActionsContext.Provider>
    </TerminalStoreBridgeContext.Provider>
  );
}

/** Full store (actions + reactive data). Re-renders on any data change; prefer
 *  `useTerminalActions` when you only need to call methods. The merged object
 *  keeps a stable identity until actions or data actually change, so consumers
 *  that list `terminals` in a dependency array don't churn on every render. */
export function useTerminals(): Ctx {
  const actions = useContext(TerminalActionsContext);
  const data = useContext(TerminalDataContext);
  const merged = useMemo(
    () => (actions && data ? { ...actions, ...data } : null),
    [actions, data],
  );
  if (!merged) throw new Error("useTerminals must be used inside TerminalProvider");
  return merged;
}

/** Stable actions only. A component using this never re-renders when sessions
 *  or the active selection change — use it for pure command consumers. */
export function useTerminalActions(): TerminalActions {
  const actions = useContext(TerminalActionsContext);
  if (!actions) throw new Error("useTerminalActions must be used inside TerminalProvider");
  return actions;
}

/** Reactive grid-view flag that only re-renders its consumer when the boolean
 *  flips (not on every session tick, unlike reading `gridView` off
 *  `useTerminals()`). */
export function useGridView(): boolean {
  const bridge = useContext(TerminalStoreBridgeContext);
  if (!bridge) throw new Error("useGridView must be used inside TerminalProvider");
  return useSyncExternalStore(bridge.subscribe, bridge.getGridViewSnapshot, () => false);
}

/** Whether `projectId` currently has a materialized active session. Re-renders
 *  its consumer only when that boolean flips — the shell reads it to gate the
 *  expanded-terminal layout without subscribing to the churning data slice. */
export function useHasActiveSession(projectId: string | null): boolean {
  const bridge = useContext(TerminalStoreBridgeContext);
  if (!bridge) throw new Error("useHasActiveSession must be used inside TerminalProvider");
  const getSnapshot = useCallback(
    () => bridge.getHasActiveSessionSnapshot(projectId),
    [bridge, projectId],
  );
  return useSyncExternalStore(bridge.subscribe, getSnapshot, () => false);
}
