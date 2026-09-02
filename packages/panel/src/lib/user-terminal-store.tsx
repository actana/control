import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api } from "./api";
import { getCorePtyBridge } from "./panel-bridge";
import { prefetchTerminalModules } from "./prefetch-terminal-modules";
import { terminalSurfaceCache } from "./terminal-surface-cache";
import type { UserTerminal } from "~/db/schema";
import { HOME_TERMINAL_PROJECT_ID } from "~/shared/home-terminal";
import { scopeKeyForProject, type ScopedProject } from "./scoped-project";
import { readJson, writeJson } from "./local-storage-json";
import {
  forgetIdentities,
  pruneIdentities,
  readIdentityMap,
  restoreUserTerminals,
  writeIdentityMap,
  type UserTerminalIdentity,
  type UserTerminalIdentityMap,
  type UserTerminalKind,
} from "./user-terminal-identity";

// Every terminal this store opens is a VM Shell Session (issue 266). The
// project-root creator — `createTerminal`, `api.createUserTerminal`, the
// `user_terminals` table behind it and the warm pool that pre-spawned a PTY on
// project navigation — is gone, so there is exactly one way in here and it is
// {@link Ctx.createVmShellTerminal}. Rows persist in `home_terminals`
// whichever scope the panel is showing, which is why every persistence call
// below routes to the home endpoints unconditionally.
//
// Scope-key namespace for project-less "home" terminals (the dashboard
// terminals). Sessions/focus/hidden/panel state live in the same per-scope
// records as project terminals, so they persist across navigation just like
// project terminals.
const HOME_SCOPE_PREFIX = `${HOME_TERMINAL_PROJECT_ID}:`;
// The "local" suffix is frozen: it was the pre-spec-10 local scope id, and
// keeping it preserves users' persisted hidden/panel localStorage buckets.
const HOME_SCOPE_KEY = `${HOME_SCOPE_PREFIX}local`;

// Persisted UI state. Hoisted so the read (init) and write (effect) of each key
// can't drift apart.
const HIDDEN_IDS_STORAGE_KEY = "mc.userTerminalHiddenIds";
const PANEL_OPEN_STORAGE_KEY = "mc.userTerminalPanelOpen";
type Session = {
  terminal: UserTerminal;
  ptyId: string | null;
  /**
   * The Core this terminal's shell runs on. Its PTY is spawned, driven and
   * killed over that Core's leg of the panel link; absent means there is no
   * Core in scope and the terminal has nowhere to run.
   */
  coreId?: string;
  /**
   * Which shell this is — the pane spawns exactly this kind and nothing else.
   * A VM Shell Session (issue 06) reuses the home-terminal row for its
   * lifecycle but spawns with `shellSession: true` (no project-root
   * requirement) and renders with a distinct "VM shell" surface.
   *
   * Persisted alongside the scope and Core in the identity map, because it was
   * being kept in memory only: after a reload the row came back with no kind
   * at all and Home re-spawned it as a plain home shell — a different shell
   * from the one the operator opened (issue 394). Within a renderer session it
   * still survives Panel reconnect via the core-link's PTY replay (the ptyId
   * is tracked here and reattached on WS reconnect).
   */
  kind: UserTerminalKind;
  /**
   * The cwd this shell opens at, as recorded when it was opened — empty for
   * kinds the Core resolves itself (a VM shell's login shell, a home shell).
   * Carried on the session so the pane's spawn does not depend on whichever
   * project happens to be in scope when the pane mounts.
   */
  cwd: string;
};

type Ctx = {
  project: ScopedProject | null;
  /** The current project and the Core its shells run on (null for a row the
   *  Panel still owns, which has no machine and so no shell). */
  setProject: (project: ScopedProject | null, coreId?: string | null) => void;
  /** Whether the project-less "home" (dashboard) terminal scope is active. */
  homeActive: boolean;
  setHomeActive: (active: boolean) => void;
  panelOpen: boolean;
  togglePanel: () => void;
  setPanelOpen: (open: boolean) => void;
  sessions: Session[];
  sessionsByScope: Record<string, Session[]>;
  runningProjectIds: Set<string>;
  focusedId: string | null;
  focusTerminal: (id: string) => void;
  /**
   * Open a VM Shell Session (issue 06) — a free-form interactive shell on the
   * Core's machine. Since issue 266 this is the store's **only** creator: the
   * project-root path it used to sit beside is gone, and "New Terminal" in
   * either place the Panel offers one lands here.
   *
   * Reuses the home-terminal row for its lifecycle but spawns with
   * `shellSession: true` (no project-root requirement) and renders with a
   * distinct "VM shell" surface. Available in whichever scope is current — a VM
   * shell is on the Core, and every route that shows this panel is on one.
   * NEVER auto-spawned: this is the explicit open gesture the operator invokes.
   */
  createVmShellTerminal: (coreId?: string) => Promise<UserTerminal | null>;
  /** Permanently close every user terminal for a project (kills PTYs). */
  closeForProject: (projectId: string) => Promise<void>;
  killTerminal: (id: string) => Promise<void>;
  hiddenIds: Set<string>;
  toggleHidden: (id: string) => void;
  renameTerminal: (id: string, name: string) => Promise<void>;
  updateLaunchUrl: (url: string) => Promise<void>;
  /**
   * A pane attached (or lost) a PTY. It reports the Core it attached on, so a
   * session restored from the API — which carries no Core of its own — can
   * still be killed on the right machine.
   */
  setPtyId: (terminalId: string, ptyId: string | null, coreId?: string) => void;
  cycleNext: () => void;
  cyclePrev: () => void;
};

const UserTerminalContext = createContext<Ctx | null>(null);

export function terminalScopeKeysForProject(
  buckets: Record<string, unknown>,
  projectId: string,
): string[] {
  return Object.keys(buckets).filter(
    (key) => key === projectId || key.startsWith(`${projectId}:`),
  );
}

/** Bucket-state updater that drops every scope key belonging to `projectId`. */
function dropProjectKeys<T>(projectId: string) {
  return (prev: Record<string, T>): Record<string, T> => {
    const keys = terminalScopeKeysForProject(prev, projectId);
    if (keys.length === 0) return prev;
    const next = { ...prev };
    for (const key of keys) delete next[key];
    return next;
  };
}

export function UserTerminalProvider({ children }: { children: ReactNode }) {
  const [project, setProjectState] = useState<ScopedProject | null>(null);
  const [projectCoreId, setProjectCoreId] = useState<string | null>(null);
  // The dashboard activates this so a project-less "home" terminal scope becomes
  // current. A real project always wins (see scopeKey) so a lingering home flag
  // can never shadow a project's terminals.
  const [homeActive, setHomeActive] = useState(false);
  // Sessions for every project visited this app run, keyed by projectId.
  // Sessions stay alive across project switches so PTYs are not killed when
  // the user navigates away and back.
  const [sessionsByProject, setSessionsByProject] = useState<Record<string, Session[]>>({});
  const [focusedByProject, setFocusedByProject] = useState<Record<string, string | null>>({});
  const [hiddenIdsByProject, setHiddenIdsByProject] = useState<Record<string, string[]>>(() =>
    readJson<Record<string, string[]>>(HIDDEN_IDS_STORAGE_KEY, {}),
  );
  useEffect(() => {
    writeJson(HIDDEN_IDS_STORAGE_KEY, hiddenIdsByProject);
  }, [hiddenIdsByProject]);
  const [panelOpenByProject, setPanelOpenByProject] = useState<Record<string, boolean>>(() =>
    readJson<Record<string, boolean>>(PANEL_OPEN_STORAGE_KEY, {}),
  );
  useEffect(() => {
    writeJson(PANEL_OPEN_STORAGE_KEY, panelOpenByProject);
  }, [panelOpenByProject]);
  // Terminal id -> the shell it is: scope, Core, kind, cwd (issue 394). The row
  // in `home_terminals` carries none of that, so without this map a reload can
  // only guess — and guessing is what put a project's VM shell on Home as a
  // home shell. See user-terminal-identity.ts.
  const [identities, setIdentities] = useState<UserTerminalIdentityMap>(() => readIdentityMap());
  useEffect(() => {
    writeIdentityMap(identities);
  }, [identities]);
  // Read by the restore effect, which must see the map as it was persisted
  // without re-running every time an open or a kill rewrites it.
  const identitiesRef = useRef<UserTerminalIdentityMap>(identities);
  useEffect(() => {
    identitiesRef.current = identities;
  }, [identities]);
  // Mirror of sessionsByProject. killTerminal reads this synchronously instead
  // of via a setState updater, since React 18 skips eager-state evaluation
  // when the fiber already has pending lanes (e.g. when the same click also
  // triggered a focus setState first), making closure mutation inside the
  // updater unreliable.
  const sessionsByProjectRef = useRef<Record<string, Session[]>>({});
  useEffect(() => {
    sessionsByProjectRef.current = sessionsByProject;
  }, [sessionsByProject]);

  // Active scope key: a real project takes precedence over the home flag, so a
  // stale homeActive can never shadow a project's terminals. Home is current only
  // when no project is selected.
  const scopeKey = project
    ? scopeKeyForProject(project)
    : homeActive
      ? HOME_SCOPE_KEY
      : null;
  const panelOpen = scopeKey ? (panelOpenByProject[scopeKey] ?? false) : false;
  const setPanelOpen = useCallback(
    (open: boolean) => {
      if (!scopeKey) return;
      setPanelOpenByProject((prev) =>
        prev[scopeKey] === open ? prev : { ...prev, [scopeKey]: open }
      );
    },
    [scopeKey]
  );
  const togglePanel = useCallback(() => {
    if (!scopeKey) return;
    setPanelOpenByProject((prev) => ({ ...prev, [scopeKey]: !(prev[scopeKey] ?? true) }));
  }, [scopeKey]);

  const setProject = useCallback((next: ScopedProject | null, coreId?: string | null) => {
    setProjectState((prev) => (prev?.id === next?.id ? prev : next));
    setProjectCoreId(coreId ?? null);
  }, []);

  // There is no per-project terminal list to lazy-load any more: the
  // `user_terminals` table and its routes went with the project-root path
  // (issue 266), so every terminal this store has ever opened is a row in the
  // one home list — whichever scope it was opened in.
  //
  // That single list is what makes restore possible at all. Once per app run,
  // as soon as any scope is current, fetch it and hand each row back to the
  // bucket its persisted identity names, as the kind of shell that identity
  // records. A row whose identity is missing is NOT restored: nothing here
  // knows which shell it was, and issue 394's rule is that a reload shows a
  // terminal gone on purpose rather than quietly spawning a different one from
  // Home. Identities for rows the server no longer has are pruned in the same
  // pass, so the bucket cannot grow forever.
  const restoreStartedRef = useRef(false);
  useEffect(() => {
    if (!scopeKey) return;
    if (restoreStartedRef.current) return;
    restoreStartedRef.current = true;

    let cancelled = false;
    void (async () => {
      try {
        const { terminals } = await api.listHomeTerminals();
        if (cancelled) return;
        const restored = restoreUserTerminals(terminals, identitiesRef.current);
        setSessionsByProject((prev) => {
          let next = prev;
          for (const [key, entries] of Object.entries(restored)) {
            if (prev[key]) continue; // an open beat us to this bucket
            next = next === prev ? { ...prev } : next;
            next[key] = entries.map(({ terminal, identity }) => ({
              terminal,
              ptyId: null,
              coreId: identity.coreId ?? undefined,
              kind: identity.kind,
              cwd: identity.cwd,
            }));
          }
          return next;
        });
        setFocusedByProject((prev) => {
          let next = prev;
          for (const [key, entries] of Object.entries(restored)) {
            if (prev[key] !== undefined) continue;
            next = next === prev ? { ...prev } : next;
            next[key] = entries[0]?.terminal.id ?? null;
          }
          return next;
        });
        const liveIds = new Set(terminals.map((t) => t.id));
        setIdentities((prev) => pruneIdentities(prev, liveIds));
      } catch {
        // Transient failure (offline, Panel restarting): let a later scope
        // change try again rather than leaving the operator with no terminals.
        restoreStartedRef.current = false;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [scopeKey]);

  // Navigating to a project pre-fetches the terminal JS chunks and **nothing
  // else** (issue 266). What used to be here also called
  // `prepareUserTerminalWarmSlot`, which spawned a real PTY on the Core in
  // anticipation of a click on a button that no longer exists — so it spawned
  // shells nothing could ever claim. That module is deleted and is deliberately
  // not reintroduced for VM shells: CONTEXT.md requires an explicit open
  // gesture, and a pre-spawn on navigation is the opposite of one. Downloading
  // a JS chunk starts no process on any machine.
  const canOpenShell = !!projectCoreId && !!project;
  useEffect(() => {
    if (!canOpenShell) return;
    void prefetchTerminalModules();
  }, [canOpenShell]);

  const sessions = scopeKey ? (sessionsByProject[scopeKey] ?? []) : [];
  const runningProjectIds = useMemo(() => {
    const ids = new Set<string>();
    for (const [key, list] of Object.entries(sessionsByProject)) {
      if (list.some((s) => s.ptyId)) ids.add(key.split(":")[0]!);
    }
    return ids;
  }, [sessionsByProject]);
  const focusedId = scopeKey ? (focusedByProject[scopeKey] ?? null) : null;
  const hiddenIds = useMemo<Set<string>>(
    () => new Set(scopeKey ? (hiddenIdsByProject[scopeKey] ?? []) : []),
    [scopeKey, hiddenIdsByProject]
  );
  const toggleHidden = useCallback(
    (id: string) => {
      if (!scopeKey) return;
      const key = scopeKey;
      const hiddenIds = hiddenIdsByProject[key] ?? [];
      const hiding = !hiddenIds.includes(id);
      setHiddenIdsByProject((prev) => {
        const cur = prev[key] ?? [];
        const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
        return { ...prev, [key]: next };
      });

      if (!hiding) {
        setPanelOpenByProject((prev) => (prev[key] === true ? prev : { ...prev, [key]: true }));
        return;
      }

      const visibleAfterHide = (sessionsByProjectRef.current[key] ?? []).filter(
        (s) => s.terminal.id !== id && !hiddenIds.includes(s.terminal.id)
      );
      if (visibleAfterHide.length === 0) {
        setPanelOpenByProject((prev) =>
          prev[key] === false ? prev : { ...prev, [key]: false }
        );
      }
    },
    [hiddenIdsByProject, scopeKey]
  );

  const updateSessions = useCallback(
    (projectId: string, fn: (prev: Session[]) => Session[]) => {
      setSessionsByProject((prev) => ({ ...prev, [projectId]: fn(prev[projectId] ?? []) }));
    },
    []
  );

  const setFocusFor = useCallback((projectId: string, id: string | null) => {
    setFocusedByProject((prev) => (prev[projectId] === id ? prev : { ...prev, [projectId]: id }));
  }, []);

  const createVmShellTerminal = useCallback(
    async (coreId?: string): Promise<UserTerminal | null> => {
      // A VM Shell Session lives on the Core itself, not in a project — so it
      // needs a Core in scope and nothing else. It reuses the home-terminal row
      // for persistence/lifecycle and is marked `kind: "vm-shell"` so the pane
      // spawns it with `shellSession: true` (skipping project-root validation)
      // and renders the distinct "VM shell" surface. Never auto-spawned — this
      // is the explicit gesture, and since issue 266 it is the only one: both
      // "New Terminal" controls call exactly this.
      if (!coreId || !scopeKey) return null;
      const key = scopeKey;
      const { terminal } = await api.createHomeTerminal({
        name: "VM shell",
      });
      // Record what this shell is before it is shown, so a reload one keystroke
      // later restores this shell and not some default (issue 394). A VM shell
      // opens at the Core's own home via a login shell, so its recorded cwd is
      // empty: the browser sends no path for it, and pinning one here would
      // make a restored pane rebuild against a cwd its spawn never used.
      const identity: UserTerminalIdentity = {
        scopeKey: key,
        coreId,
        kind: "vm-shell",
        cwd: "",
      };
      setIdentities((prev) => ({ ...prev, [terminal.id]: identity }));
      updateSessions(key, (prev) => [
        ...prev,
        { terminal, ptyId: null, coreId, kind: identity.kind, cwd: identity.cwd },
      ]);
      setFocusFor(key, terminal.id);
      setPanelOpenByProject((prev) => ({ ...prev, [key]: true }));
      return terminal;
    },
    [scopeKey, updateSessions, setFocusFor]
  );

  const killTerminal = useCallback(
    async (id: string) => {
      // Resolve owner + neighbor synchronously from the latest snapshot. Doing
      // this inside a setState updater breaks when the fiber has pending lanes
      // (the updater would run lazily, leaving the closure vars null).
      const snapshot = sessionsByProjectRef.current;
      let ownerProjectId: string | null = null;
      let killedPtyId: string | null = null;
      let killedCoreId: string | undefined;
      let neighborId: string | null = null;
      let lastTerminal = false;
      for (const [pid, list] of Object.entries(snapshot)) {
        const idx = list.findIndex((s) => s.terminal.id === id);
        if (idx === -1) continue;
        ownerProjectId = pid;
        killedPtyId = list[idx]!.ptyId;
        killedCoreId = list[idx]!.coreId;
        const filtered = list.filter((s) => s.terminal.id !== id);
        if (filtered.length > 0) {
          const pick = idx > 0 ? idx - 1 : 0;
          neighborId = filtered[pick]!.terminal.id;
        } else {
          lastTerminal = true;
        }
        break;
      }
      if (!ownerProjectId) return;

      // Dispose the cached xterm surface — a kill is a real teardown, not a
      // parkable scope switch, so the persistent subscription + Terminal go too.
      terminalSurfaceCache.destroy(id);

      setSessionsByProject((prev) => ({
        ...prev,
        [ownerProjectId!]: (prev[ownerProjectId!] ?? []).filter(
          (s) => s.terminal.id !== id
        ),
      }));
      setFocusedByProject((prev) => {
        if (prev[ownerProjectId!] !== id) return prev;
        return { ...prev, [ownerProjectId!]: neighborId };
      });
      setHiddenIdsByProject((prev) => {
        const cur = prev[ownerProjectId!];
        if (!cur || !cur.includes(id)) return prev;
        return { ...prev, [ownerProjectId!]: cur.filter((x) => x !== id) };
      });
      if (lastTerminal) {
        setPanelOpenByProject((prev) =>
          prev[ownerProjectId!] === false
            ? prev
            : { ...prev, [ownerProjectId!]: false }
        );
      }

      if (killedPtyId) {
        // Kill on the Core the shell actually runs on.
        await getCorePtyBridge(killedCoreId)?.kill(killedPtyId).catch(() => undefined);
      }
      try {
        // One endpoint, not a home-vs-project branch: every row this store
        // creates is a `home_terminals` row, whichever scope key it is bucketed
        // under (issue 266).
        await api.deleteHomeTerminal(id);
      } catch {
        /* swallow */
      }
      // A killed terminal is gone for good — drop its identity with it, so the
      // map never restores a shell whose row no longer exists.
      setIdentities((prev) => forgetIdentities(prev, [id]));
    },
    []
  );

  const closeForProject = useCallback(
    async (projectId: string) => {
      const keys = terminalScopeKeysForProject(sessionsByProjectRef.current, projectId);
      const ids = keys.flatMap((key) =>
        (sessionsByProjectRef.current[key] ?? []).map((s) => s.terminal.id),
      );
      for (const id of ids) {
        await killTerminal(id);
      }
      setIdentities((prev) => forgetIdentities(prev, ids));
      setSessionsByProject(dropProjectKeys(projectId));
      setFocusedByProject(dropProjectKeys(projectId));
      setHiddenIdsByProject(dropProjectKeys(projectId));
      setPanelOpenByProject(dropProjectKeys(projectId));
    },
    [killTerminal],
  );

  const renameTerminal = useCallback(async (id: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setSessionsByProject((prev) => {
      const next = { ...prev };
      for (const [pid, list] of Object.entries(prev)) {
        if (!list.some((s) => s.terminal.id === id)) continue;
        next[pid] = list.map((s) =>
          s.terminal.id === id ? { ...s, terminal: { ...s.terminal, name: trimmed } } : s
        );
      }
      return next;
    });
    try {
      // As in killTerminal: one row kind, so one endpoint (issue 266).
      await api.renameHomeTerminal(id, trimmed);
    } catch {
      /* swallow */
    }
  }, []);

  const updateLaunchUrl = useCallback(
    async (url: string) => {
      if (!project) return;
      const normalized = url.replace(/\[::1\]/, "localhost");
      if (project.launchUrl === normalized) return;
      setProjectState((prev) =>
        prev?.id === project.id ? { ...prev, launchUrl: normalized, updatedAt: Date.now() } : prev
      );
      try {
        // A Core-owned project has no Panel row to PATCH; its launch URL is
        // Panel-local presentation keyed to its Core instead (issue 98).
        await api.updateProjectLaunchUrl(project.id, normalized, projectCoreId);
      } catch {
        /* swallow */
      }
    },
    [project, projectCoreId]
  );

  const setPtyId = useCallback((terminalId: string, ptyId: string | null, coreId?: string) => {
    setSessionsByProject((prev) => {
      let next = prev;
      let changed = false;
      for (const [pid, list] of Object.entries(prev)) {
        if (!list.some((s) => s.terminal.id === terminalId)) continue;
        const updated = list.map((s) => {
          if (s.terminal.id !== terminalId) return s;
          const nextCoreId = coreId ?? s.coreId;
          if (s.ptyId === ptyId && s.coreId === nextCoreId) return s;
          changed = true;
          return { ...s, ptyId, coreId: nextCoreId };
        });
        if (updated !== list && changed) {
          next = next === prev ? { ...prev } : next;
          next[pid] = updated;
        }
      }
      return changed ? next : prev;
    });
  }, []);

  const focusTerminal = useCallback(
    (id: string) => {
      if (!scopeKey) return;
      setFocusFor(scopeKey, id);
    },
    [scopeKey, setFocusFor]
  );

  const cycle = useCallback(
    (delta: 1 | -1) => {
      if (!scopeKey) return;
      // No-op when the panel is closed — don't open it as a side effect of cycling.
      const key = scopeKey;
      if (!(panelOpenByProject[key] ?? false)) return;
      const list = sessionsByProject[key] ?? [];
      if (list.length === 0) return;
      const cur = focusedByProject[key] ?? null;
      const idx = cur ? list.findIndex((s) => s.terminal.id === cur) : -1;
      const nextIdx = idx === -1 ? 0 : (idx + delta + list.length) % list.length;
      setFocusFor(key, list[nextIdx]!.terminal.id);
    },
    [scopeKey, panelOpenByProject, sessionsByProject, focusedByProject, setFocusFor]
  );

  const cycleNext = useCallback(() => cycle(1), [cycle]);
  const cyclePrev = useCallback(() => cycle(-1), [cycle]);

  const value = useMemo<Ctx>(
    () => ({
      project,
      setProject,
      homeActive,
      setHomeActive,
      panelOpen,
      togglePanel,
      setPanelOpen,
      sessions,
      sessionsByScope: sessionsByProject,
      runningProjectIds,
      focusedId,
      focusTerminal,
      createVmShellTerminal,
      closeForProject,
      killTerminal,
      hiddenIds,
      toggleHidden,
      renameTerminal,
      updateLaunchUrl,
      setPtyId,
      cycleNext,
      cyclePrev,
    }),
    [
      project,
      setProject,
      homeActive,
      setHomeActive,
      panelOpen,
      togglePanel,
      sessions,
      sessionsByProject,
      runningProjectIds,
      focusedId,
      focusTerminal,
      createVmShellTerminal,
      closeForProject,
      killTerminal,
      hiddenIds,
      toggleHidden,
      renameTerminal,
      updateLaunchUrl,
      setPtyId,
      cycleNext,
      cyclePrev,
    ]
  );

  return (
    <UserTerminalContext.Provider value={value}>{children}</UserTerminalContext.Provider>
  );
}

export function useUserTerminals() {
  const ctx = useContext(UserTerminalContext);
  if (!ctx) throw new Error("useUserTerminals must be used inside UserTerminalProvider");
  return ctx;
}

/**
 * Like {@link useUserTerminals} but returns null instead of throwing when
 * there's no provider — for surfaces that render outside the main shell.
 */
export function useUserTerminalsOptional() {
  return useContext(UserTerminalContext);
}
