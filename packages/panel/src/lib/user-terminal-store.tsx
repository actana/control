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
import {
  discardUserTerminalWarmSlot,
  prepareUserTerminalWarmSlot,
  replenishUserTerminalWarmSlot,
  takeUserTerminalWarmSlot,
} from "./user-terminal-warm-pool";
import { terminalSurfaceCache } from "./terminal-surface-cache";
import type { UserTerminal } from "~/db/schema";
import { HOME_TERMINAL_PROJECT_ID } from "~/shared/home-terminal";
import { scopeKeyForProject, type ScopedProject } from "./scoped-project";
import { readJson, writeJson } from "./local-storage-json";

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
function isHomeScopeKey(key: string): boolean {
  return key.startsWith(HOME_SCOPE_PREFIX);
}

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
   * True when this session is a VM Shell Session (issue 06) — a free-form
   * shell on the Core's machine, distinct from a project-scoped or home
   * shell. In-memory only (never persisted): a VM shell reuses the
   * home-terminal row for its lifecycle, but spawns with `shellSession: true`
   * (no project-root requirement) and renders with a distinct "VM shell"
   * surface. Lost on cold reload — by design it is never auto-spawned; the
   * operator re-opens it with the explicit "New VM shell" gesture. Within a
   * renderer session it survives Panel reconnect via the core-link's PTY
   * replay (the ptyId is tracked here and reattached on WS reconnect).
   */
  shellSession?: boolean;
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
  createTerminal: (opts?: {
    name?: string;
    startCommand?: string | null;
    project?: ScopedProject;
    cwd?: string | null;
    focusOnCreate?: boolean;
    /** The Core to open the shell on. */
    coreId?: string;
  }) => Promise<UserTerminal | null>;
  /**
   * Open a VM Shell Session (issue 06) — a free-form interactive shell on the
   * Core's machine, distinct from agent workspaces and dashboard home
   * terminals. Reuses the home-terminal row for its lifecycle but spawns with
   * `shellSession: true` (no project-root requirement) and renders with a
   * distinct "VM shell" surface. Only available in the project-less dashboard
   * (home) scope — a VM shell is on the Core, not a project. NEVER
   * auto-spawned: this is the explicit open gesture the operator invokes.
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
  const loadedProjectsRef = useRef<Set<string>>(new Set());
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

  // Read through a ref from callbacks that must not re-create on every Core
  // switch (createTerminal is in a dozen dep arrays).
  const projectCoreIdRef = useRef<string | null>(null);
  projectCoreIdRef.current = projectCoreId;

  const setProject = useCallback((next: ScopedProject | null, coreId?: string | null) => {
    setProjectState((prev) => (prev?.id === next?.id ? prev : next));
    setProjectCoreId(coreId ?? null);
  }, []);

  // Lazy-load each project's persisted terminals the first time we see it.
  // Existing buckets are left alone so live PTYs survive project switches.
  useEffect(() => {
    const id = project?.id;
    const key = project ? scopeKeyForProject(project) : null;
    if (!id || !key) return;
    if (loadedProjectsRef.current.has(key)) return;
    loadedProjectsRef.current.add(key);

    let cancelled = false;
    void (async () => {
      try {
        const { terminals } = await api.listUserTerminals(id);
        if (cancelled) return;
        setSessionsByProject((prev) => {
          if (prev[key]) return prev; // a createTerminal call beat us to it
          return { ...prev, [key]: terminals.map((t) => ({ terminal: t, ptyId: null })) };
        });
        setFocusedByProject((prev) => {
          if (prev[key] !== undefined) return prev;
          return { ...prev, [key]: terminals[0]?.id ?? null };
        });
      } catch {
        loadedProjectsRef.current.delete(key);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [project]);

  // Lazy-load persisted home terminals the first time the home bucket is
  // active. Mirrors the per-project loader; home sessions then survive
  // navigation in the same sessionsByProject bucket.
  useEffect(() => {
    if (!homeActive) return;
    const key = HOME_SCOPE_KEY;
    if (loadedProjectsRef.current.has(key)) return;
    loadedProjectsRef.current.add(key);

    let cancelled = false;
    void (async () => {
      try {
        const { terminals } = await api.listHomeTerminals();
        if (cancelled) return;
        setSessionsByProject((prev) => {
          if (prev[key]) return prev; // a createTerminal call beat us to it
          return { ...prev, [key]: terminals.map((t) => ({ terminal: t, ptyId: null })) };
        });
        setFocusedByProject((prev) => {
          if (prev[key] !== undefined) return prev;
          return { ...prev, [key]: terminals[0]?.id ?? null };
        });
      } catch {
        loadedProjectsRef.current.delete(key);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [homeActive]);

  // The Core is in the key: switching Cores must tear the warm shell down, not
  // hand a shell on the old machine to the new one.
  const warmPrepareKey =
    project?.path && projectCoreId
      ? `${scopeKeyForProject(project)}:${projectCoreId}:${project.path}`
      : null;
  // Read `project` through a ref so a project-query refetch that returns a new
  // reference with identical data doesn't change the effect deps and churn the
  // warm slot (kill + respawn the shell PTY). `warmPrepareKey` already encodes
  // everything that should trigger teardown/re-prepare.
  const warmInputRef = useRef({ project, projectCoreId });
  warmInputRef.current = { project, projectCoreId };
  useEffect(() => {
    const { project, projectCoreId } = warmInputRef.current;
    if (!project?.path || !warmPrepareKey) return;
    void prefetchTerminalModules();
    void prepareUserTerminalWarmSlot({ project, coreId: projectCoreId, cwd: project.path });
    return () => {
      void discardUserTerminalWarmSlot();
    };
    // Depend only on warmPrepareKey (the stable logical key); inputs come from the ref.
  }, [warmPrepareKey]);

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

  const createTerminal = useCallback(
    async (opts?: {
      name?: string;
      startCommand?: string | null;
      project?: ScopedProject;
      cwd?: string | null;
      focusOnCreate?: boolean;
      coreId?: string;
    }) => {
      const targetProject = opts?.project ?? project;
      const focusOnCreate = opts?.focusOnCreate ?? true;
      // Home mode: no project context → create a project-less home terminal. The
      // cwd is resolved at spawn time per-runtime (host/remote home dir), so we
      // persist no host path here. Home terminals are never launch/ephemeral, so
      // startCommand and the warm-slot fast path don't apply.
      if (!targetProject && homeActive) {
        const key = HOME_SCOPE_KEY;
        const { terminal } = await api.createHomeTerminal({
          name: opts?.name,
        });
        updateSessions(key, (prev) => [...prev, { terminal, ptyId: null, coreId: opts?.coreId }]);
        if (focusOnCreate) setFocusFor(key, terminal.id);
        setPanelOpenByProject((prev) => ({ ...prev, [key]: true }));
        return terminal;
      }
      if (!targetProject) return null;
      const projectId = targetProject.id;
      const key = scopeKeyForProject(targetProject);
      const cwd = opts?.cwd ?? targetProject.path;
      const startCommand = opts?.startCommand ?? null;
      const coreId = opts?.coreId ?? projectCoreIdRef.current;
      const canUseWarmSlot = !startCommand && !!cwd && !!coreId;

      if (canUseWarmSlot) {
        const warmSlot = takeUserTerminalWarmSlot(coreId, cwd);
        if (warmSlot) {
          const draftTerminal: UserTerminal = {
            ...warmSlot.draftTerminal,
            name: opts?.name?.trim() || warmSlot.draftTerminal.name,
          };
          updateSessions(key, (prev) => [...prev, { terminal: draftTerminal, ptyId: warmSlot.ptyId }]);
          if (focusOnCreate) setFocusFor(key, draftTerminal.id);
          setPanelOpenByProject((prev) => ({ ...prev, [key]: true }));

          void (async () => {
            try {
              const { terminal } = await api.createUserTerminal(projectId, {
                id: warmSlot.clientTerminalId,
                cwd,
                name: opts?.name,
              });
              updateSessions(key, (prev) =>
                prev.map((s) =>
                  s.terminal.id === warmSlot.clientTerminalId
                    ? { terminal, ptyId: warmSlot.ptyId }
                    : s,
                ),
              );
              replenishUserTerminalWarmSlot({ project: targetProject, coreId, cwd });
            } catch {
              await getCorePtyBridge(coreId)?.kill(warmSlot.ptyId).catch(() => undefined);
              updateSessions(key, (prev) =>
                prev.filter((s) => s.terminal.id !== warmSlot.clientTerminalId),
              );
              replenishUserTerminalWarmSlot({ project: targetProject, coreId, cwd });
            }
          })();
          return draftTerminal;
        }
      }

      const { terminal } = await api.createUserTerminal(projectId, {
        cwd,
        name: opts?.name,
        startCommand,
      });
      updateSessions(key, (prev) => [...prev, { terminal, ptyId: null, coreId: opts?.coreId }]);
      if (focusOnCreate) setFocusFor(key, terminal.id);
      setPanelOpenByProject((prev) => ({ ...prev, [key]: true }));
      if (!startCommand && cwd) {
        replenishUserTerminalWarmSlot({ project: targetProject, coreId, cwd });
      }
      return terminal;
    },
    [project, homeActive, updateSessions, setFocusFor]
  );

  const createVmShellTerminal = useCallback(
    async (coreId?: string): Promise<UserTerminal | null> => {
      // A VM Shell Session lives on the Core itself, not in a project — so it
      // needs a Core in scope and nothing else. It reuses the home-terminal row
      // for persistence/lifecycle but is flagged `shellSession` in-memory so
      // the pane spawns it with `shellSession: true` (skipping project-root
      // validation) and renders the distinct "VM shell" surface. Never
      // auto-spawned — this is the explicit gesture.
      if (!coreId || !scopeKey) return null;
      const key = scopeKey;
      const { terminal } = await api.createHomeTerminal({
        name: "VM shell",
      });
      updateSessions(key, (prev) => [
        ...prev,
        { terminal, ptyId: null, shellSession: true, coreId },
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
        if (isHomeScopeKey(ownerProjectId)) await api.deleteHomeTerminal(id);
        else await api.deleteUserTerminal(id);
      } catch {
        /* swallow */
      }
      // The in-memory VM-shell `shellSession` flag lived on this session
      // object, which the filter above already removed — nothing further to
      // clean (the flag is never persisted; see createVmShellTerminal).
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
      for (const key of keys) loadedProjectsRef.current.delete(key);
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
    // Resolve home-vs-project from the latest snapshot synchronously (not inside
    // the setState updater, which can run lazily) so the persistence call routes
    // to the right endpoint. Home terminals live under any `__home__:<scope>` key.
    const isHome = Object.entries(sessionsByProjectRef.current).some(
      ([key, list]) => isHomeScopeKey(key) && list.some((s) => s.terminal.id === id)
    );
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
      if (isHome) await api.renameHomeTerminal(id, trimmed);
      else await api.renameUserTerminal(id, trimmed);
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
      createTerminal,
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
      createTerminal,
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
