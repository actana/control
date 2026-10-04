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
import type { Harness } from "@actana/shared/domain";
import type { Session } from "~/db/schema";
import type { CoreLinkSessionRow } from "@actana/shared/sdk-link-frames";
import { coreScopeKey } from "./core-scope";
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
  session: Session;
  /** PTY spawn waits until the session row exists on the server. */
  awaitingCreate?: boolean;
  /** Restored from localStorage; PTY spawn waits until the session is revalidated
   *  against the server. Dead/archived sessions are dropped instead of respawning,
   *  and live ones get a fresh snapshot. */
  pendingValidation?: boolean;
  /** The Core that owns this session. Its PTY and its session row both live on
   *  that Core, so spawn/write/resize/kill/replay and revalidation all ride the
   *  panel link to it. A Session belongs to a Core and nothing narrower (ADR 0041 D1),
   *  and a Core starts every Session in its home folder, so there is no cwd. */
  coreId: string;
};

type Ctx = {
  /** All live sessions (PTYs alive in background). */
  sessions: OpenTerminal[];
  /** The session currently displayed in the panel for `coreId`, if any. */
  activeFor: (coreId: string) => OpenTerminal | null;
  /** The active sessionId persisted for `coreId` (null = explicitly closed). */
  activeSessionIdFor: (coreId: string) => string | null;
  /**
   * Select `session` in `coreId`'s scope. Navigation, not a toggle: the requested
   * session always ends up active, so calling this for the already-active session
   * keeps it selected rather than hiding the panel. See `nextActiveByCore`.
   *
   * The name is a misnomer kept on purpose — read it as "select". To hide the
   * panel, call `deselect`; nothing here will do it for you.
   */
  toggle: (coreId: string, session: Session, opts?: { awaitCreate?: boolean }) => void;
  /** Select a session and optionally attach an already-running PTY (warm pool claim). */
  openSession: (coreId: string, session: Session, opts?: { ptyId?: string | null }) => void;
  /** Deselect the active card for `coreId` and hide the panel without killing the PTY. */
  deselect: (coreId: string) => void;
  /** Mark an already-open session as the active one for its scope, without
   *  materializing or mutating the session. Focus mode uses it so switching the
   *  focused tab also moves the scope's active selection — exiting then restores
   *  the default view onto the session that was on screen while floating. */
  setActiveSession: (coreId: string, sessionId: string) => void;
  /** Materialize a session entry from a persisted sessionId after reload, if not already present. */
  rehydrate: (coreId: string, session: Session) => void;
  /** Permanently close one session and kill its PTY. */
  close: (sessionId: string, opts?: { activateSessionId?: string | null }) => Promise<void>;
  /** Swap a provisional session id (optimistic create) for the persisted session. */
  adoptSessionId: (fromSessionId: string, session: Session) => void;
  /** Permanently close every session for a Core (kills PTYs). */
  closeForCore: (coreId: string) => Promise<void>;
  setPtyId: (sessionId: string, ptyId: string | null, scopeKey?: string) => void;
  syncSession: (session: Session) => void;
  startCommandFor: (agent: Harness) => string;
  /** Run an arbitrary command in the active PTY for this session. */
  runIn: (sessionId: string, command: string) => Promise<void>;
  /** Whether the full-width "all sessions" grid view is active. */
  gridView: boolean;
  /**
   * Set the grid view. It is one global preference, persisted across reloads —
   * so `persist: false` is for callers applying a *contextual* layout that must
   * not overwrite what the operator last chose for every other Core.
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
   *  remounts across Core switches, so without this a stale request would
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
  getHasActiveSessionSnapshot: (coreId: string | null) => boolean;
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
 * Synthesize a Session-shaped row from a {@link CoreLinkSessionRow}.
 * The Panel's terminal store, TerminalPane, and grid views are all typed on
 * the Panel DB's `Session` shape, but a Core's session only travels the wire as a
 * thin snapshot (`sessionId, title, agent, status, pinned, archived, updatedAt`).
 * The missing fields take the Panel DB's defaults; when we have a prior
 * snapshot from the persisted session (`prior`), its fields (claudeSessionId,
 * ...) are preferred so continuity across a Panel reload doesn't reset the
 * agent's session id. The owning Core rides on the OpenTerminal, not on the
 * Session itself.
 */
function remoteSessionFromSnapshot(
  snapshot: CoreLinkSessionRow,
  prior?: Session,
): Session {
  const base: Session = prior ?? {
    id: snapshot.sessionId,
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
    // The row for a Core's session lives on that Core, and the Panel has no
    // write for this id: the minted id still gets baked into the launch command
    // below, so the current spawn resumes with it; only cross-Panel-restart
    // persistence is missing.
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

const ACTIVE_BY_CORE_KEY = "mc.terminalActiveByCore";
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

/**
 * The scope-to-active-session map after a request to select `requestedSessionId`.
 *
 * Selecting a session — a pin in the sidebar, a card in the list — is
 * navigation, not a toggle: the requested session always ends up active. A repeat
 * request for the already-active session keeps it selected, and a rapid
 * A -> B -> A burst lands on A. Returns `activeByCore` unchanged when the
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
 * delete/archive-with-no-replacement paths), `close` and `closeForCore`.
 * Nothing on a selection path may clear. The Core workspace route documents the
 * same rule for card clicks.
 */
export function nextActiveByCore(
  activeByCore: Record<string, string | null>,
  scopeKey: string,
  requestedSessionId: string
): Record<string, string | null> {
  return activeByCore[scopeKey] === requestedSessionId
    ? activeByCore
    : { ...activeByCore, [scopeKey]: requestedSessionId };
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
  activeByCore: Record<string, string | null>,
): string[] {
  const eligible: string[] = [];
  for (const session of sessions) {
    if (!session.session.archived) continue;
    const scopeKey = coreScopeKey(session.coreId);
    if ((activeByCore[scopeKey] ?? null) === session.sessionId) continue;
    eligible.push(session.sessionId);
  }
  return eligible;
}

function loadActiveByCore(): Record<string, string | null> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(ACTIVE_BY_CORE_KEY);
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
  "sessionId" | "startCommand" | "dangerouslySkipPermissions" | "session" | "coreId"
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
      session: s.session,
      coreId: s.coreId,
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
      if (
        !entry ||
        typeof entry.sessionId !== "string" ||
        typeof entry.coreId !== "string" ||
        !entry.session
      ) {
        continue;
      }
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
        session: entry.session,
        coreId: entry.coreId,
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

export function resolveActiveSessionIdForCore(
  activeByCore: Record<string, string | null>,
  coreId: string,
): { scopeKey: string; sessionId: string | null } {
  const scopeKey = coreScopeKey(coreId);
  return { scopeKey, sessionId: activeByCore[scopeKey] ?? null };
}

export function TerminalProvider({ children }: { children: ReactNode }) {
  const [sessions, setSessions] = useState<OpenTerminal[]>(loadPersistedSessions);
  const [activeByCore, setActiveByCore] = useState<Record<string, string | null>>(
    loadActiveByCore
  );
  const [gridView, setGridViewState] = useState<boolean>(loadGridView);
  // Read via a ref so `toggleGridView` keeps a stable identity (it lives in the
  // stable actions context) instead of re-creating on every gridView flip.
  const gridViewRef = useRef(gridView);
  gridViewRef.current = gridView;
  // Mirrors for the narrow-subscription bridge below (getSnapshot reads these).
  const activeByCoreRef = useRef(activeByCore);
  activeByCoreRef.current = activeByCore;

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
  // survives the grid unmounting/remounting across Core switches — a ref,
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
  // "on". The grid reports it on focusin; the Core workspace route reads it to anchor a
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
    const scopeKey = coreScopeKey(session.coreId);
    setActiveByCore((prev) => nextActiveByCore(prev, scopeKey, sessionId));
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
      window.localStorage.setItem(ACTIVE_BY_CORE_KEY, JSON.stringify(activeByCore));
    } catch {
      /* quota or disabled */
    }
  }, [activeByCore]);

  // Persist the full open-session set so a reload can restore every session
  // (the grid renders all of them), not just the active one per scope. Each
  // entry embeds its session, so serializing on every sessions change
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
    (coreId: string, session: Session, opts?: { awaitCreate?: boolean }) => {
      const scopeKey = coreScopeKey(coreId);
      setSessions((prev) => {
        const existing = prev.find(
          (p) => p.sessionId === session.id && coreScopeKey(p.coreId) === scopeKey,
        );
        if (existing) {
          if (!opts?.awaitCreate || existing.awaitingCreate) return prev;
          return prev.map((p) =>
            p.sessionId === session.id && coreScopeKey(p.coreId) === scopeKey
              ? { ...p, awaitingCreate: true, session }
              : p,
          );
        }
        const next: OpenTerminal = {
          sessionId: session.id,
          ptyId: null,
          startCommand: commandForSession(session),
          dangerouslySkipPermissions: harnessLaunchesWithSkipPermissions(session.agent),
          session,
          awaitingCreate: opts?.awaitCreate,
          // Tag the session with its owning Core so TerminalPane addresses
          // spawn/write/etc. to the right Core.
          coreId,
        };
        return [...prev, next];
      });
      setActiveByCore((prev) => nextActiveByCore(prev, scopeKey, session.id));
    },
    [],
  );

  const openSession = useCallback(
    (coreId: string, session: Session, opts?: { ptyId?: string | null }) => {
      const scopeKey = coreScopeKey(coreId);
      setSessions((prev) => {
        const existing = prev.find(
          (p) => p.sessionId === session.id && coreScopeKey(p.coreId) === scopeKey,
        );
        if (existing) {
          return prev.map((p) =>
            p.sessionId === session.id && coreScopeKey(p.coreId) === scopeKey
              ? {
                  ...p,
                  session,
                  ptyId: opts?.ptyId ?? p.ptyId ?? null,
                  startCommand: commandForSession(session),
                  dangerouslySkipPermissions: harnessLaunchesWithSkipPermissions(session.agent),
                  awaitingCreate: false,
                  // The caller holds a live session row — no revalidation needed.
                  pendingValidation: undefined,
                }
              : p,
          );
        }
        return [
          ...prev,
          {
            sessionId: session.id,
            ptyId: opts?.ptyId ?? null,
            startCommand: commandForSession(session),
            dangerouslySkipPermissions: harnessLaunchesWithSkipPermissions(session.agent),
            session,
            coreId,
          },
        ];
      });
      setActiveByCore((prev) => nextActiveByCore(prev, scopeKey, session.id));
    },
    [],
  );

  const rehydrate = useCallback((coreId: string, session: Session) => {
    const scopeKey = coreScopeKey(coreId);
    setSessions((prev) => {
      if (prev.some((p) => p.sessionId === session.id && coreScopeKey(p.coreId) === scopeKey)) {
        return prev;
      }
      return [
        ...prev,
        {
          sessionId: session.id,
          ptyId: null,
          startCommand: commandForSession(session),
          dangerouslySkipPermissions: harnessLaunchesWithSkipPermissions(session.agent),
          session,
          coreId,
        },
      ];
    });
  }, []);

  const deselect = useCallback((coreId: string) => {
    const scopeKey = coreScopeKey(coreId);
    setActiveByCore((prev) => {
      if (!(scopeKey in prev) || prev[scopeKey] === null) return prev;
      return { ...prev, [scopeKey]: null };
    });
  }, []);

  const setActiveSession = useCallback((coreId: string, sessionId: string) => {
    const scopeKey = coreScopeKey(coreId);
    setActiveByCore((prev) => nextActiveByCore(prev, scopeKey, sessionId));
  }, []);

  const adoptSessionId = useCallback((fromSessionId: string, session: Session) => {
    // Record the id swap so views keyed by sessionId (e.g. the grid order) can
    // follow the session in place instead of treating it as a fresh add.
    if (fromSessionId !== session.id) {
      sessionIdRenamesRef.current.push({ from: fromSessionId, to: session.id });
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
    setActiveByCore((prev) => {
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
    setSessions((prev) => {
      const target = prev.find((p) => p.sessionId === sessionId);
      if (target) {
        terminalSurfaceCache.destroy(target.sessionId);
        void killPty(target.coreId, target.ptyId);
      }
      return prev.filter((p) => p.sessionId !== sessionId);
    });
    setActiveByCore((prev) => {
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
    const eligible = new Set(archivedSessionsEligibleForReap(sessions, activeByCore));
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
  }, [sessions, activeByCore, close]);

  useEffect(() => {
    const timers = reapTimersRef.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  // Revalidate restored sessions against their Core once on startup. Sessions
  // are seeded straight from the localStorage snapshot, which can be stale: a
  // session archived or deleted while this window was closed (a second window,
  // a hand at the VM) must not resurrect as a live cell — or worse, respawn its
  // agent. Panes hold off spawning until their session's gate clears
  // (pendingValidation), so a dead session's agent never boots.
  //
  // A session's row lives on its Core, so this asks each Core touched by the
  // pending set for its rows over the panel link (`listSessionRows(coreId)`) and
  // matches on `sessionId`. Session metadata is refreshed from the returned
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
      const coreIds = new Set(pending.map((s) => s.coreId));
      // Fan out one `listSessionRows(coreId)` per Core touched by the pending set —
      // fewer round-trips than one call per session, and the result is a full
      // snapshot the closure below can look up by sessionId.
      const byCore = new Map<string, Map<string, Session> | null>();
      await Promise.all(
        [...coreIds].map(async (coreId) => {
          if (!bridge) {
            byCore.set(coreId, null);
            return;
          }
          const listed = await bridge.listSessionRows(coreId).catch(() => null);
          const sessions = listed?.sessions;
          if (!sessions) {
            byCore.set(coreId, null);
            return;
          }
          byCore.set(
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
      const checks = pending.map((entry) => {
        const snapshots = byCore.get(entry.coreId);
        if (snapshots === null || snapshots === undefined) {
          // Core unreachable — release the gate, keep the snapshot rather
          // than dropping a session whose Core is just briefly down.
          return { sessionId: entry.sessionId, session: undefined };
        }
        return { sessionId: entry.sessionId, session: snapshots.get(entry.sessionId) ?? null };
      });
      const refreshed = new Map<string, Session>();
      for (const c of checks) {
        if (!c.session || c.session.archived) continue;
        refreshed.set(c.sessionId, c.session);
      }
      for (const c of checks) {
        if (c.session === null || c.session?.archived) void close(c.sessionId);
      }
      setSessions((prev) =>
        prev.map((p) => {
          if (!p.pendingValidation) return p;
          const fresh = refreshed.get(p.sessionId);
          if (!fresh) {
            // Core unreachable: release the gate, keep the snapshot.
            return { ...p, pendingValidation: undefined };
          }
          return {
            ...p,
            session: fresh,
            dangerouslySkipPermissions: harnessLaunchesWithSkipPermissions(fresh.agent),
            pendingValidation: undefined,
          };
        }),
      );
    })();
  }, [sessions, close]);

  const closeForCore = useCallback(async (coreId: string) => {
    setSessions((prev) => {
      const remaining: OpenTerminal[] = [];
      for (const t of prev) {
        if (t.coreId === coreId) {
          markIntentionalSessionClose(t.sessionId);
          terminalSurfaceCache.destroy(t.sessionId);
          void killPty(t.coreId, t.ptyId);
        } else remaining.push(t);
      }
      return remaining;
    });
    const scopeKey = coreScopeKey(coreId);
    setActiveByCore((prev) => {
      if (!(scopeKey in prev)) return prev;
      const next = { ...prev };
      delete next[scopeKey];
      return next;
    });
  }, []);

  const setPtyId = useCallback((sessionId: string, ptyId: string | null, scopeKey?: string) => {
    setSessions((prev) => {
      let changed = false;
      const next = prev.map((p) => {
        if (p.sessionId !== sessionId) return p;
        const sessionScopeKey = coreScopeKey(p.coreId);
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
    (coreId: string): OpenTerminal | null => {
      const { scopeKey, sessionId } = resolveActiveSessionIdForCore(activeByCore, coreId);
      if (!sessionId) return null;
      return (
        sessions.find((s) => s.sessionId === sessionId && coreScopeKey(s.coreId) === scopeKey) ?? null
      );
    },
    [activeByCore, sessions],
  );

  const activeSessionIdFor = useCallback(
    (coreId: string) => resolveActiveSessionIdForCore(activeByCore, coreId).sessionId,
    [activeByCore],
  );

  // Stable slice: every dependency is a constant-identity callback, so this memo
  // computes once and the actions context never changes — pure-action consumers
  // (useTerminalActions) don't re-render when `sessions` churns.
  const actions = useMemo<TerminalActions>(
    () => ({
      toggle,
      openSession,
      deselect,
      setActiveSession,
      rehydrate,
      close,
      adoptSessionId,
      closeForCore,
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
      deselect,
      setActiveSession,
      rehydrate,
      close,
      adoptSessionId,
      closeForCore,
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
  }, [sessions, activeByCore, gridView]);
  const getGridViewSnapshot = useCallback(() => gridViewRef.current, []);
  const getHasActiveSessionSnapshot = useCallback((coreId: string | null) => {
    if (!coreId) return false;
    const { scopeKey, sessionId } = resolveActiveSessionIdForCore(activeByCoreRef.current, coreId);
    if (!sessionId) return false;
    return sessionsRef.current.some(
      (s) => s.sessionId === sessionId && coreScopeKey(s.coreId) === scopeKey,
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

/** Whether `coreId` currently has a materialized active session. Re-renders
 *  its consumer only when that boolean flips — the shell reads it to gate the
 *  expanded-terminal layout without subscribing to the churning data slice. */
export function useHasActiveSession(coreId: string | null): boolean {
  const bridge = useContext(TerminalStoreBridgeContext);
  if (!bridge) throw new Error("useHasActiveSession must be used inside TerminalProvider");
  const getSnapshot = useCallback(
    () => bridge.getHasActiveSessionSnapshot(coreId),
    [bridge, coreId],
  );
  return useSyncExternalStore(bridge.subscribe, getSnapshot, () => false);
}
