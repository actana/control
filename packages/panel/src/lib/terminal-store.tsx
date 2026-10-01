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
import type { Session } from "~/db/schema";
import type { CoreLinkProjectSnapshot, CoreLinkSessionRow } from "@actana/shared/sdk-link-frames";
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
  sessionId: string;
  ptyId: string | null;
  startCommand: string;
  dangerouslySkipPermissions: boolean;
  cwd: string;
  project: ScopedProject;
  session: Session;
  /** PTY spawn waits until the session row exists on the server. */
  awaitingCreate?: boolean;
  /** Restored from localStorage; PTY spawn waits until the session is revalidated
   *  against the server. Dead/archived sessions are dropped instead of respawning,
   *  and live ones get a fresh snapshot + rebuilt start command. */
  pendingValidation?: boolean;
  /** The Core that owns this session. Its PTY and its session row both live on
   *  that Core's Core, so spawn/write/resize/kill/replay and revalidation
   *  all ride the panel link to it. Null only for a Panel-local row. */
  coreId?: string | null;
};

type Ctx = {
  /** All live sessions (PTYs alive in background). */
  sessions: OpenTerminal[];
  /** The session currently displayed in the panel for `projectId`, if any. */
  activeFor: (projectId: string) => OpenTerminal | null;
  /** The active sessionId persisted for `projectId` (null = explicitly closed). */
  activeSessionIdFor: (projectId: string) => string | null;
  /**
   * Select `session` in `project`'s scope. Navigation, not a toggle: the requested
   * session always ends up active, so calling this for the already-active session
   * keeps it selected rather than hiding the panel. See `nextActiveByProject`.
   *
   * The name is a misnomer kept on purpose — renaming it would touch
   * `projects.$id.tsx`, which parallel tickets own. Read it as "select". To
   * hide the panel, call `deselect`; nothing here will do it for you.
   */
  toggle: (
    project: ScopedProject,
    session: Session,
    opts?: { awaitCreate?: boolean; coreId?: string | null },
  ) => void;
  /** Select a session and optionally attach an already-running PTY (warm pool claim). */
  openSession: (
    project: ScopedProject,
    session: Session,
    opts?: { ptyId?: string | null; coreId?: string | null },
  ) => void;
  /**
   * Open a session on a remote Core (issue 07). Synthesizes the `ScopedProject`
   * and `Session` shapes the store/pane wiring is typed on from the two Core-link
   * snapshots, tags the session with `coreId` so `TerminalPane` routes spawn/
   * write/resize/kill through `getCorePtyBridge` instead of the local pty, and
   * uses the Core's own project `path` as `cwd` (a VM path, not a Panel path).
   */
  openRemoteSession: (
    coreId: string,
    project: CoreLinkProjectSnapshot,
    session: CoreLinkSessionRow,
  ) => void;
  /** Deselect the active card for `projectId` and hide the panel without killing the PTY. */
  deselect: (projectId: string) => void;
  /** Mark an already-open session as the active one for its scope, without
   *  materializing or mutating the session. Focus mode uses it so switching the
   *  focused tab also moves the scope's active selection — exiting then restores
   *  the default view onto the session that was on screen while floating. */
  setActiveSession: (project: ScopedProject, sessionId: string) => void;
  /** Tell root-level panel lookup which scope is currently visible for a project. */
  setVisibleScope: (projectId: string, scopeKey: string | null) => void;
  /** Materialize a session entry from a persisted sessionId after reload, if not already present. */
  rehydrate: (project: ScopedProject, session: Session, opts?: { coreId?: string | null }) => void;
  /** Permanently close one session and kill its PTY. */
  close: (sessionId: string, opts?: { activateSessionId?: string | null }) => Promise<void>;
  /** Swap a provisional session id (optimistic create) for the persisted session. */
  adoptSessionId: (fromSessionId: string, session: Session) => void;
  /** Permanently close every session for a project (kills PTYs). */
  closeForProject: (projectId: string) => Promise<void>;
  setPtyId: (sessionId: string, ptyId: string | null, scopeKey?: string) => void;
  syncSession: (session: Session) => void;
  startCommandFor: (agent: Harness) => string;
  /** Run an arbitrary command in the active PTY for this session. */
  runIn: (sessionId: string, command: string) => Promise<void>;
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
   *  session retrigger the grid's focus effect. `flash` asks the grid to also
   *  play the attach pulse on the cell. */
  gridFocusRequest: { sessionId: string; nonce: number; flash?: boolean } | null;
  /** Ask the grid to scroll to, highlight, and focus a session's cell.
   *  `flash` additionally pulses the cell — the "your image landed here" cue
   *  after a screenshot attach, which the static spotlight ring can't convey
   *  when the target is already the focused cell. */
  focusGridSession: (sessionId: string, opts?: { flash?: boolean }) => void;
  /** Claim a spotlight request for handling. True exactly once per nonce: the
   *  request state lingers after the grid's focus effect runs, and the grid
   *  remounts across project switches, so without this a stale request would
   *  replay on mount and un-hide the session it targeted. */
  consumeGridFocusRequest: (nonce: number) => boolean;
  /** Ask the grid to drop the next newly-created session directly after this
   *  source session (used by "Clone session" so a clone lands beside its
   *  origin instead of at the end of the grid). */
  requestCloneInsertAfter: (sourceSessionId: string) => void;
  /** Consume the pending clone-insert source id (null if none is queued). */
  takeCloneInsertAfter: () => string | null;
  /** Report the grid cell whose terminal just took focus (null on blur away). */
  noteGridFocusedSession: (sessionId: string | null) => void;
  /** The grid cell that most recently held focus, or null. Lets callers anchor a
   *  new session on the active pane even after a button click moved DOM focus. */
  getGridFocusedSessionId: () => string | null;
  /** Ask the grid to place the next newly-created session in a brand-new row at
   *  the bottom (used by the grid's "New row" button). */
  requestNewRow: () => void;
  /** Consume the pending new-row request (true if one is queued). */
  takeNewRowRequest: () => boolean;
  /** Consume any provisional→persisted session id renames since the last call,
   *  so views keyed by sessionId can preserve position across adoption. */
  takeSessionIdRenames: () => Array<{ from: string; to: string }>;
};

// The store is split into two contexts so a session-status tick (which churns
// `sessions`) only re-renders consumers that actually read reactive data. The
// data slice changes on session/active/gridView updates; the actions slice
// keeps a constant identity for the provider's lifetime, so pure-action
// consumers (e.g. every TerminalPane, which only needs syncSession) never
// re-render when a background session updates.
type TerminalDataKeys =
  | "sessions"
  | "activeFor"
  | "activeSessionIdFor"
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

/** Shallow field equality for two session rows. Session is a flat DB row of
 *  primitives, so comparing own-enumerable keys is both correct and robust to
 *  schema growth — used to skip `sessions` churn on no-op refetches. */
function sessionsEqual(a: Session, b: Session): boolean {
  if (a === b) return true;
  const aKeys = Object.keys(a) as (keyof Session)[];
  const bKeys = Object.keys(b) as (keyof Session)[];
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

/**
 * Compute the start command for a session. Hook-capable agents embed either a
 * new-session or resume invocation so conversations survive app restarts.
 * Side effect: generates and persists a session ID when one is missing on
 * agents that require a preassigned id (defensive — session creation should
 * have populated it).
 */
export function commandForSession(session: Session): string {
  return baseCommandForSession(
    session,
    peekPendingSessionModel(session.id) ?? getDefaultModelForHarness(session.agent),
  );
}

/**
 * Synthesize a Session-shaped row from a remote-Core {@link CoreLinkSessionRow}.
 * The Panel's terminal store, TerminalPane, and grid views are all typed on
 * the Panel DB's `Session` shape, but a Core's session only travels the wire as a
 * thin snapshot (`sessionId, title, agent, status, pinned, archived, updatedAt`).
 * The missing fields take the Panel DB's defaults; when we have a prior
 * snapshot from the persisted session (`prior`), its fields (claudeSessionId,
 * ...) are preferred so continuity across a Panel reload doesn't reset the
 * agent's session id. Remote sessions carry `coreId` on the OpenTerminal, not on
 * the Session itself.
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

function remoteSessionFromSnapshot(
  snapshot: CoreLinkSessionRow,
  prior?: Session,
): Session {
  const base: Session = prior ?? {
    id: snapshot.sessionId,
    projectId: snapshot.projectId,
    title: snapshot.title,
    titleManuallySet: false,
    icon: snapshot.icon,
    agent: snapshot.agent as Harness,
    status: snapshot.status as Session["status"],
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
    status: snapshot.status as Session["status"],
    pinned: snapshot.pinned,
    archived: snapshot.archived,
    icon: snapshot.icon,
    updatedAt: snapshot.updatedAt,
  };
}

function baseCommandForSession(session: Session, model: string | null): string {
  if (!harnessUsesPersistedSession(session.agent)) {
    return HARNESS_REGISTRY[session.agent].startCommand({
      skipPermissions: harnessLaunchesWithSkipPermissions(session.agent),
    });
  }

  let sessionId = session.claudeSessionId;
  // Codex, OpenCode and Pi mint their own session ids and report them on a
  // capture hook (SessionStart / UserPromptSubmit). Do not invent a Panel
  // UUID for them — a fabricated id would never match the harness's, and
  // relaunch would never reach `pi --session <uuid>` (ADO #4986).
  if (!sessionId && session.agent !== "codex" && session.agent !== "opencode" && session.agent !== "pi") {
    sessionId = newSessionId();
    // The row for a Core's session lives on that Core, so the Panel's own
    // PATCH would 404. `sessionsMutate` doesn't carry claudeSessionId today
    // (protocol gap) — the minted id still gets baked into the launch
    // command below, so the current spawn resumes with it; only cross-Panel-
    // restart persistence is missing.
    if (!isRemoteSession(session.id)) {
      void api.updateSession(session.id, { claudeSessionId: sessionId }).catch(() => undefined);
    }
  }

  const mode = harnessLaunchMode({ ...session, claudeSessionId: sessionId });
  if ((session.agent === "codex" || session.agent === "opencode" || session.agent === "pi") && mode === "new") {
    return buildHarnessLaunchCommand(session, sessionId ?? "", mode, { model });
  }

  if (!sessionId) {
    return buildHarnessLaunchCommand(session, "", mode, { model });
  }

  return buildHarnessLaunchCommand(session, sessionId, mode, { model });
}

const ACTIVE_BY_PROJECT_KEY = "mc.terminalActiveByProject";
const GRID_VIEW_KEY = "mc.gridView";
const OPEN_SESSIONS_KEY = "mc.terminalOpenSessions";
/** Sessions change on hot paths (session sync per server event, per-pane ptyId
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

// Sessions whose row lives on a Core rather than in the Panel's own DB. Populated
// by `toggle` / `openSession` when they tag an OpenTerminal with a coreId, and
// read by `baseCommandForSession` so it can skip the Panel-local
// `PATCH /api/sessions/:id` that would 404 for a Core-owned row. Stays a
// module-level Set (not React state) because `commandForSession` is a top-level
// export called from paths without access to the store's hooks.
const remoteSessionIds = new Set<string>();

function markSessionRemote(sessionId: string, coreId: string | null | undefined): void {
  if (coreId) remoteSessionIds.add(sessionId);
}

function unmarkSessionRemote(sessionId: string): void {
  remoteSessionIds.delete(sessionId);
}

function isRemoteSession(sessionId: string): boolean {
  return remoteSessionIds.has(sessionId);
}

/**
 * The scope-to-active-session map after a request to select `requestedSessionId`.
 *
 * Selecting a session — a pin in the sidebar, a card in the list — is
 * navigation, not a toggle: the requested session always ends up active. A repeat
 * request for the already-active session keeps it selected, and a rapid
 * A -> B -> A burst lands on A. Returns `activeByProject` unchanged when the
 * request is a no-op, so callers can hand the result straight to `setState`
 * without forcing a re-render; the caller's own focus request still fires.
 *
 * This replaced `nextActiveSessionId`, which returned `null` — a cleared scope,
 * which is the panel close — when the requested session was already active and
 * its session was materialized. Every call site guarded that combination away,
 * so the branch was not reachable through today's callers (#443 review); it is
 * removed as a trap, before a sixth caller arrives without the guard. It is
 * *not* evidence for the operator symptom in #380, which stays open.
 *
 * Clearing a scope is a separate gesture with its own writers: `deselect`
 * (the pane's hide affordance, the `terminal.close` hotkey, and the
 * delete/archive-with-no-replacement paths), `close` and `closeForProject`.
 * Nothing on a selection path may clear. `projects.$id.tsx` documents the same
 * rule for card clicks.
 */
export function nextActiveByProject(
  activeByProject: Record<string, string | null>,
  scopeKey: string,
  requestedSessionId: string
): Record<string, string | null> {
  return activeByProject[scopeKey] === requestedSessionId
    ? activeByProject
    : { ...activeByProject, [scopeKey]: requestedSessionId };
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
    if (!session.session.archived) continue;
    const scopeKey = scopeKeyForProject(session.project);
    if ((activeByProject[scopeKey] ?? null) === session.sessionId) continue;
    eligible.push(session.sessionId);
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
  "sessionId" | "startCommand" | "dangerouslySkipPermissions" | "cwd" | "project" | "session" | "coreId"
>;

function serializeSessions(sessions: OpenTerminal[]): PersistedSession[] {
  return sessions
    // Skip provisional (optimistic-create) sessions whose session row isn't saved
    // yet, and archived sessions (they get reaped, so don't resurrect them).
    .filter((s) => !s.awaitingCreate && !s.session.archived)
    .map((s) => ({
      sessionId: s.sessionId,
      startCommand: s.startCommand,
      dangerouslySkipPermissions: s.dangerouslySkipPermissions,
      cwd: s.cwd,
      project: s.project,
      session: s.session,
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
      if (!entry || typeof entry.sessionId !== "string" || !entry.project || !entry.session) continue;
      // Dedupe by session id alone (not scope key): the same id under two scope
      // keys is the same underlying agent session. Restoring both would resume
      // one pinned session id twice and the second spawn dies with
      // "session ID is already in use".
      if (seen.has(entry.sessionId)) continue;
      seen.add(entry.sessionId);
      restored.push({
        sessionId: entry.sessionId,
        // Local PTYs are re-spawned lazily when the pane mounts.
        ptyId: null,
        startCommand: entry.startCommand,
        dangerouslySkipPermissions: entry.dangerouslySkipPermissions,
        cwd: entry.cwd,
        project: entry.project,
        session: entry.session,
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

export function resolveActiveSessionIdForProject(
  activeByProject: Record<string, string | null>,
  projectId: string,
  visibleScopeByProject: Record<string, string | null> = {},
): { scopeKey: string | null; sessionId: string | null } {
  if (projectId.includes(":")) {
    return { scopeKey: projectId, sessionId: activeByProject[projectId] ?? null };
  }

  const visibleScopeKey = visibleScopeByProject[projectId] ?? null;
  if (visibleScopeKey) {
    return { scopeKey: visibleScopeKey, sessionId: activeByProject[visibleScopeKey] ?? null };
  }

  const mainScopeKey = projectScopeKey(projectId);
  const mainSessionId = activeByProject[mainScopeKey] ?? activeByProject[projectId] ?? null;
  if (mainSessionId) return { scopeKey: mainScopeKey, sessionId: mainSessionId };

  for (const [key, sessionId] of Object.entries(activeByProject)) {
    if (sessionId && key.startsWith(`${projectId}:`)) {
      return { scopeKey: key, sessionId };
    }
  }

  return { scopeKey: null, sessionId: null };
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
    { sessionId: string; nonce: number; flash?: boolean } | null
  >(null);
  const gridFocusNonceRef = useRef(0);
  const focusGridSession = useCallback((sessionId: string, opts?: { flash?: boolean }) => {
    gridFocusNonceRef.current += 1;
    setGridFocusRequest({ sessionId, nonce: gridFocusNonceRef.current, flash: opts?.flash });
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
  const requestCloneInsertAfter = useCallback((sourceSessionId: string) => {
    cloneInsertAfterRef.current = sourceSessionId;
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
  const gridFocusedSessionIdRef = useRef<string | null>(null);
  const noteGridFocusedSession = useCallback((sessionId: string | null) => {
    gridFocusedSessionIdRef.current = sessionId;
    if (!sessionId) return;
    // Keep the scope's active session in step with the grid's focused cell, so
    // leaving the grid lands on the pane the user was on rather than whatever
    // was active before. The functional update returns `prev` unchanged when it
    // already matches, so this only re-renders on a real cell-to-cell focus
    // change (typing in one cell never touches it). sessionsRef is read at call
    // time — always populated by the time a focusin fires.
    const session = sessionsRef.current.find((s) => s.sessionId === sessionId);
    if (!session) return;
    const scopeKey = scopeKeyForProject(session.project);
    setActiveByProject((prev) => nextActiveByProject(prev, scopeKey, sessionId));
  }, []);
  const getGridFocusedSessionId = useCallback(() => gridFocusedSessionIdRef.current, []);
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
  // entry embeds its project + session, so serializing on every sessions change
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
      session: Session,
      opts?: { awaitCreate?: boolean; coreId?: string | null },
    ) => {
      const scopeKey = scopeKeyForProject(project);
      setSessions((prev) => {
        const existing = prev.find(
          (p) => p.sessionId === session.id && scopeKeyForProject(p.project) === scopeKey
        );
        if (existing) {
          if (!opts?.awaitCreate || existing.awaitingCreate) return prev;
          return prev.map((p) =>
            p.sessionId === session.id && scopeKeyForProject(p.project) === scopeKey
              ? { ...p, awaitingCreate: true, session }
              : p
          );
        }
        // Register remote-Core sessions BEFORE computing the start command,
        // so `baseCommandForSession` sees the marker and skips the Panel's own
        // claudeSessionId PATCH for a Core-owned row.
        markSessionRemote(session.id, opts?.coreId);
        const next: OpenTerminal = {
          sessionId: session.id,
          ptyId: null,
          startCommand: commandForSession(session),
          dangerouslySkipPermissions: harnessLaunchesWithSkipPermissions(session.agent),
          cwd: project.path,
          project,
          session,
          awaitingCreate: opts?.awaitCreate,
          // Tag the session with its owning Core so TerminalPane addresses
          // spawn/write/etc. to the right Core.
          coreId: opts?.coreId ?? null,
        };
        return [...prev, next];
      });
      setActiveByProject((prev) => nextActiveByProject(prev, scopeKey, session.id));
    },
    []
  );

  const openSession = useCallback(
    (
      project: ScopedProject,
      session: Session,
      opts?: { ptyId?: string | null; coreId?: string | null },
    ) => {
      const scopeKey = scopeKeyForProject(project);
      const coreId = opts?.coreId ?? null;
      // Same rationale as `toggle`: register before the setState reads
      // `commandForSession` so the PATCH gate is honoured on the first spawn.
      if (opts?.coreId !== undefined) markSessionRemote(session.id, coreId);
      setSessions((prev) => {
        const existing = prev.find(
          (p) => p.sessionId === session.id && scopeKeyForProject(p.project) === scopeKey
        );
        if (existing) {
          return prev.map((p) =>
            p.sessionId === session.id && scopeKeyForProject(p.project) === scopeKey
              ? {
                  ...p,
                  session,
                  ptyId: opts?.ptyId ?? p.ptyId ?? null,
                  startCommand: commandForSession(session),
                  dangerouslySkipPermissions: harnessLaunchesWithSkipPermissions(session.agent),
                  awaitingCreate: false,
                  // The caller holds a live session row — no revalidation needed.
                  pendingValidation: undefined,
                  coreId: opts?.coreId !== undefined ? coreId : p.coreId,
                }
              : p
          );
        }
        return [
          ...prev,
          {
            sessionId: session.id,
            ptyId: opts?.ptyId ?? null,
            startCommand: commandForSession(session),
            dangerouslySkipPermissions: harnessLaunchesWithSkipPermissions(session.agent),
            cwd: project.path,
            project,
            session,
            coreId,
          },
        ];
      });
      setActiveByProject((prev) => nextActiveByProject(prev, scopeKey, session.id));
    },
    []
  );

  const openRemoteSession = useCallback(
    (
      coreId: string,
      projectSnap: CoreLinkProjectSnapshot,
      sessionSnap: CoreLinkSessionRow,
    ) => {
      const project = remoteScopedProjectFromSnapshot(coreId, projectSnap);
      const session = remoteSessionFromSnapshot(sessionSnap);
      openSession(project, session, { coreId });
    },
    [openSession],
  );

  const rehydrate = useCallback(
    (project: ScopedProject, session: Session, opts?: { coreId?: string | null }) => {
      const scopeKey = scopeKeyForProject(project);
      const coreId = opts?.coreId ?? null;
      if (opts?.coreId !== undefined) markSessionRemote(session.id, coreId);
      setSessions((prev) => {
        if (prev.some((p) => p.sessionId === session.id && scopeKeyForProject(p.project) === scopeKey)) {
          return prev;
        }
        return [
          ...prev,
          {
            sessionId: session.id,
            ptyId: null,
            startCommand: commandForSession(session),
            dangerouslySkipPermissions: harnessLaunchesWithSkipPermissions(session.agent),
            cwd: project.path,
            project,
            session,
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

  const setActiveSession = useCallback((project: ScopedProject, sessionId: string) => {
    const scopeKey = scopeKeyForProject(project);
    setActiveByProject((prev) => nextActiveByProject(prev, scopeKey, sessionId));
  }, []);

  const adoptSessionId = useCallback((fromSessionId: string, session: Session) => {
    // Record the id swap so views keyed by sessionId (e.g. the grid order) can
    // follow the session in place instead of treating it as a fresh add.
    if (fromSessionId !== session.id) {
      sessionIdRenamesRef.current.push({ from: fromSessionId, to: session.id });
      // Carry the remote-session marker across the id swap so the fresh id
      // still bypasses the Panel's own claudeSessionId PATCH on subsequent
      // command builds.
      if (isRemoteSession(fromSessionId)) {
        unmarkSessionRemote(fromSessionId);
        remoteSessionIds.add(session.id);
      }
    }
    // The pane re-keys to the persisted id and remounts under it; dispose the
    // provisional-id surface so it doesn't leak (the new pane re-attaches to the
    // same PTY via replay).
    terminalSurfaceCache.destroy(fromSessionId);
    setSessions((prev) => {
      let changed = false;
      const next = prev.map((p) => {
        if (p.sessionId !== fromSessionId) return p;
        changed = true;
        return {
          ...p,
          sessionId: session.id,
          session,
          startCommand: commandForSession(session),
          dangerouslySkipPermissions: harnessLaunchesWithSkipPermissions(session.agent),
          awaitingCreate: false,
        };
      });
      return changed ? next : prev;
    });
    setActiveByProject((prev) => {
      let changed = false;
      const next: Record<string, string | null> = { ...prev };
      for (const [key, tid] of Object.entries(prev)) {
        if (tid === fromSessionId) {
          next[key] = session.id;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, []);

  const close = useCallback(async (sessionId: string, opts?: { activateSessionId?: string | null }) => {
    markIntentionalSessionClose(sessionId);
    unmarkSessionRemote(sessionId);
    setSessions((prev) => {
      const target = prev.find((p) => p.sessionId === sessionId);
      if (target) {
        terminalSurfaceCache.destroy(target.sessionId);
        void killPty(target.coreId, target.ptyId);
      }
      return prev.filter((p) => p.sessionId !== sessionId);
    });
    setActiveByProject((prev) => {
      const next: Record<string, string | null> = {};
      let changed = false;
      for (const [pid, tid] of Object.entries(prev)) {
        if (tid === sessionId) {
          next[pid] =
            opts?.activateSessionId !== undefined ? (opts.activateSessionId ?? null) : null;
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
    for (const sessionId of eligible) {
      if (timers.has(sessionId)) continue;
      timers.set(
        sessionId,
        setTimeout(() => {
          timers.delete(sessionId);
          void close(sessionId);
        }, ARCHIVED_SESSION_REAP_DELAY_MS),
      );
    }
    for (const [sessionId, timer] of timers) {
      if (eligible.has(sessionId)) continue;
      clearTimeout(timer);
      timers.delete(sessionId);
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
  // session archived or deleted while this window was closed (server cleanup, a
  // second window) must not resurrect as a live cell — or worse, respawn its
  // agent — and a live session's launch command may have changed since the
  // snapshot (agent/model/skip-permissions), so it is rebuilt from the fresh
  // row. Panes hold off spawning until their session's gate clears
  // (pendingValidation), so a dead session's agent never boots.
  //
  // A Core-owned session's `sessionId` lives on that Core's Core, so
  // `api.getSession` would 404 for every one of them and drop live sessions on
  // reload. Revalidate those over the panel link with `listSessionRows(coreId)` and
  // match on `sessionId`. Session metadata is refreshed from the returned
  // {@link CoreLinkSessionRow}, but the persisted `startCommand` is kept —
  // the snapshot doesn't carry the fields (`claudeSessionId`, ...) that
  // `commandForSession` needs to rebuild it.
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
      // Fan out one `listSessionRows(coreId)` per Core touched by the pending set —
      // fewer round-trips than one call per session, and the result is a full
      // snapshot the closure below can look up by sessionId.
      const remoteByCore = new Map<string, Map<string, Session> | null>();
      await Promise.all(
        [...remoteCoreIds].map(async (coreId) => {
          if (!bridge) {
            remoteByCore.set(coreId, null);
            return;
          }
          const listed = await bridge.listSessionRows(coreId).catch(() => null);
          const sessions = listed?.sessions;
          if (!sessions) {
            remoteByCore.set(coreId, null);
            return;
          }
          remoteByCore.set(
            coreId,
            new Map(
              sessions.map((t) => [
                t.sessionId,
                remoteSessionFromSnapshot(t, pending.find((p) => p.sessionId === t.sessionId)?.session),
              ]),
            ),
          );
        }),
      );
      const checks = await Promise.all(
        pending.map(async (entry) => {
          const coreId = entry.coreId;
          if (coreId) {
            const snapshots = remoteByCore.get(coreId);
            if (snapshots === null) {
              // Core unreachable — release the gate, keep the snapshot rather
              // than dropping a session whose Core is just briefly down.
              return { sessionId: entry.sessionId, session: undefined, remote: true as const };
            }
            const session = snapshots?.get(entry.sessionId) ?? null;
            return { sessionId: entry.sessionId, session, remote: true as const };
          }
          try {
            const { session } = await api.getSession(entry.sessionId);
            return { sessionId: entry.sessionId, session: session as Session | null, remote: false as const };
          } catch (err) {
            // 404 → the session is gone; drop the entry. Any other failure
            // (server briefly unreachable) → release the gate and run on the
            // snapshot rather than leaving the pane blocked forever.
            const gone = err instanceof ApiError && err.status === 404;
            return {
              sessionId: entry.sessionId,
              session: gone ? null : undefined,
              remote: false as const,
            };
          }
        }),
      );
      // Rebuild launch commands outside the state updater — commandForSession can
      // persist a missing session id, and updaters must stay side-effect free.
      // Remote-Core sessions keep their persisted startCommand (see note above).
      const refreshed = new Map<
        string,
        { session: Session; startCommand: string | null }
      >();
      for (const c of checks) {
        if (!c.session || c.session.archived) continue;
        refreshed.set(c.sessionId, {
          session: c.session,
          startCommand: c.remote ? null : commandForSession(c.session),
        });
      }
      for (const c of checks) {
        if (c.session === null || c.session?.archived) void close(c.sessionId);
      }
      setSessions((prev) =>
        prev.map((p) => {
          if (!p.pendingValidation) return p;
          const fresh = refreshed.get(p.sessionId);
          if (!fresh) {
            // Validation errored (non-404): release the gate, keep the snapshot.
            return { ...p, pendingValidation: undefined };
          }
          return {
            ...p,
            session: fresh.session,
            startCommand: fresh.startCommand ?? p.startCommand,
            dangerouslySkipPermissions: harnessLaunchesWithSkipPermissions(fresh.session.agent),
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
          markIntentionalSessionClose(t.sessionId);
          terminalSurfaceCache.destroy(t.sessionId);
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

  const setPtyId = useCallback((sessionId: string, ptyId: string | null, scopeKey?: string) => {
    setSessions((prev) => {
      let changed = false;
      const next = prev.map((p) => {
        if (p.sessionId !== sessionId) return p;
        const sessionScopeKey = scopeKeyForProject(p.project);
        if (scopeKey && sessionScopeKey !== scopeKey) return p;
        if (p.ptyId === ptyId) return p;
        changed = true;
        return { ...p, ptyId };
      });
      return changed ? next : prev;
    });
  }, []);

  const syncSession = useCallback((session: Session) => {
    setSessions((prev) => {
      let changed = false;
      const next = prev.map((p) => {
        if (p.sessionId !== session.id) return p;
        // Sessions come off the query cache as freshly-parsed rows (new refs) on
        // every refetch, so a reference check alone treats every SSE-driven
        // refetch as a change and churns `sessions` (re-rendering every
        // useTerminals() consumer) even when the row is byte-identical. Compare
        // by field so an unchanged refetch is a genuine no-op.
        if (sessionsEqual(p.session, session)) return p;
        changed = true;
        return { ...p, session };
      });
      return changed ? next : prev;
    });
  }, []);

  const runIn = useCallback(
    async (sessionId: string, command: string) => {
      const target = sessionsRef.current.find((p) => p.sessionId === sessionId);
      if (!target?.ptyId || !target.coreId) return;
      await getCorePtyBridge(target.coreId)?.write(target.ptyId, command + "\r");
    },
    []
  );

  const activeFor = useCallback(
    (projectId: string): OpenTerminal | null => {
      const { scopeKey, sessionId } = resolveActiveSessionIdForProject(
        activeByProject,
        projectId,
        visibleScopeByProject,
      );
      if (!scopeKey || !sessionId) return null;
      return (
        sessions.find((s) => s.sessionId === sessionId && scopeKeyForProject(s.project) === scopeKey) ??
        null
      );
    },
    [activeByProject, sessions, visibleScopeByProject]
  );

  const activeSessionIdFor = useCallback(
    (projectId: string) => {
      return resolveActiveSessionIdForProject(
        activeByProject,
        projectId,
        visibleScopeByProject,
      ).sessionId;
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
      openRemoteSession,
      deselect,
      setActiveSession,
      setVisibleScope,
      rehydrate,
      close,
      adoptSessionId,
      closeForProject,
      setPtyId,
      syncSession,
      startCommandFor: commandFor,
      runIn,
      setGridView,
      toggleGridView,
      focusGridSession,
      consumeGridFocusRequest,
      requestCloneInsertAfter,
      takeCloneInsertAfter,
      noteGridFocusedSession,
      getGridFocusedSessionId,
      requestNewRow,
      takeNewRowRequest,
      takeSessionIdRenames,
    }),
    [
      toggle,
      openSession,
      openRemoteSession,
      deselect,
      setActiveSession,
      setVisibleScope,
      rehydrate,
      close,
      adoptSessionId,
      closeForProject,
      setPtyId,
      syncSession,
      runIn,
      setGridView,
      toggleGridView,
      focusGridSession,
      consumeGridFocusRequest,
      requestCloneInsertAfter,
      takeCloneInsertAfter,
      noteGridFocusedSession,
      getGridFocusedSessionId,
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
    const { scopeKey, sessionId } = resolveActiveSessionIdForProject(
      activeByProjectRef.current,
      projectId,
      visibleScopeByProjectRef.current,
    );
    if (!scopeKey || !sessionId) return false;
    return sessionsRef.current.some(
      (s) => s.sessionId === sessionId && scopeKeyForProject(s.project) === scopeKey,
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
      activeSessionIdFor,
      gridView,
      gridFocusRequest,
    }),
    [
      sessions,
      activeFor,
      activeSessionIdFor,
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
