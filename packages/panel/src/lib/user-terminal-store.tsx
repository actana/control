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
import { coreScopeKey } from "./core-scope";
import { readJson, writeJson } from "./local-storage-json";
import {
  commitIdentityChange,
  forgetIdentities,
  pruneIdentities,
  readIdentityMap,
  restoreUserTerminals,
  type UserTerminalIdentity,
  type UserTerminalIdentityMap,
} from "./user-terminal-identity";

// Every terminal this store opens is a VM Shell Session (issue 266): a login
// shell as `core` in the Core's home folder, opened by an explicit gesture and
// never auto-spawned. There is exactly one way in here and it is
// {@link Ctx.createVmShellTerminal}. Rows persist in `home_terminals` whichever
// Core the drawer is showing, which is why every persistence call below routes
// to the home endpoints unconditionally. The drawer's state — which terminals
// are open, hidden, focused — is kept per Core, so it persists across
// navigation between Cores.

// Persisted UI state. Hoisted so the read (init) and write (effect) of each key
// can't drift apart.
const HIDDEN_IDS_STORAGE_KEY = "mc.userTerminalHiddenIds";
const PANEL_OPEN_STORAGE_KEY = "mc.userTerminalPanelOpen";
type Session = {
  terminal: UserTerminal;
  ptyId: string | null;
  /**
   * The Core this terminal's shell runs on. Its PTY is spawned, driven and
   * killed over that Core's leg of the panel link. Persisted alongside the
   * terminal in the identity map, because it was being kept in memory only:
   * after a reload the row came back with no Core at all (issue 394). Within a
   * renderer session it still survives Panel reconnect via the core-link's PTY
   * replay (the ptyId is tracked here and reattached on WS reconnect).
   */
  coreId: string;
};

type Ctx = {
  /** The Core the drawer is showing, or null where there is no Core in scope (the Fleet home). */
  coreId: string | null;
  setCore: (coreId: string | null) => void;
  panelOpen: boolean;
  togglePanel: () => void;
  setPanelOpen: (open: boolean) => void;
  sessions: Session[];
  sessionsByScope: Record<string, Session[]>;
  focusedId: string | null;
  focusTerminal: (id: string) => void;
  /**
   * Open a VM Shell Session (issue 06) — a free-form interactive shell on the
   * Core's machine. Since issue 266 this is the store's **only** creator, and
   * "New Terminal" in either place the Panel offers one lands here.
   *
   * Reuses the home-terminal row for its lifecycle but spawns with
   * `shellSession: true` and renders with a distinct "VM shell" surface. Opens
   * on the Core in scope. NEVER auto-spawned: this is the explicit open gesture
   * the operator invokes.
   */
  createVmShellTerminal: (coreId?: string) => Promise<UserTerminal | null>;
  /** Permanently close every user terminal for a Core (kills PTYs). */
  closeForCore: (coreId: string) => Promise<void>;
  killTerminal: (id: string) => Promise<void>;
  hiddenIds: Set<string>;
  toggleHidden: (id: string) => void;
  renameTerminal: (id: string, name: string) => Promise<void>;
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

/** The terminal-store bucket keys that belong to `coreId`. */
export function terminalScopeKeysForCore(
  buckets: Record<string, unknown>,
  coreId: string,
): string[] {
  return Object.keys(buckets).filter((key) => key === coreId || key.startsWith(`${coreId}:`));
}

/** Bucket-state updater that drops every scope key belonging to `coreId`. */
function dropCoreKeys<T>(coreId: string) {
  return (prev: Record<string, T>): Record<string, T> => {
    const keys = terminalScopeKeysForCore(prev, coreId);
    if (keys.length === 0) return prev;
    const next = { ...prev };
    for (const key of keys) delete next[key];
    return next;
  };
}

export function UserTerminalProvider({ children }: { children: ReactNode }) {
  // The Core the routes are on. Every Core page sets it, and the Fleet home
  // clears it: with no Core there is no machine to open a shell on.
  const [coreId, setCoreState] = useState<string | null>(null);
  // Sessions for every Core visited this app run, keyed by scope key.
  // Sessions stay alive across Core switches so PTYs are not killed when
  // the user navigates away and back.
  const [sessionsByCore, setSessionsByCore] = useState<Record<string, Session[]>>({});
  const [focusedByCore, setFocusedByCore] = useState<Record<string, string | null>>({});
  const [hiddenIdsByCore, setHiddenIdsByCore] = useState<Record<string, string[]>>(() =>
    readJson<Record<string, string[]>>(HIDDEN_IDS_STORAGE_KEY, {}),
  );
  useEffect(() => {
    writeJson(HIDDEN_IDS_STORAGE_KEY, hiddenIdsByCore);
  }, [hiddenIdsByCore]);
  const [panelOpenByCore, setPanelOpenByCore] = useState<Record<string, boolean>>(() =>
    readJson<Record<string, boolean>>(PANEL_OPEN_STORAGE_KEY, {}),
  );
  useEffect(() => {
    writeJson(PANEL_OPEN_STORAGE_KEY, panelOpenByCore);
  }, [panelOpenByCore]);
  // Terminal id -> the Core its shell runs on (issue 394). The row in
  // `home_terminals` carries none of that, so without this map a reload can only
  // guess. See user-terminal-identity.ts.
  const [identities, setIdentities] = useState<UserTerminalIdentityMap>(() => readIdentityMap());
  // What this tab last wrote. The persisted map is shared with every other tab
  // on this Panel, so the write applies this tab's delta against it rather than
  // overwriting it with this tab's snapshot — losing an identity costs a
  // terminal that can never be restored, not a preference.
  const committedIdentitiesRef = useRef<UserTerminalIdentityMap>(identities);
  useEffect(() => {
    if (identities === committedIdentitiesRef.current) return;
    commitIdentityChange(committedIdentitiesRef.current, identities);
    committedIdentitiesRef.current = identities;
  }, [identities]);
  // Mirror of sessionsByCore. killTerminal reads this synchronously instead
  // of via a setState updater, since React 18 skips eager-state evaluation
  // when the fiber already has pending lanes (e.g. when the same click also
  // triggered a focus setState first), making closure mutation inside the
  // updater unreliable.
  const sessionsByCoreRef = useRef<Record<string, Session[]>>({});
  useEffect(() => {
    sessionsByCoreRef.current = sessionsByCore;
  }, [sessionsByCore]);

  // Active scope key: the Core in scope, or none.
  const scopeKey = coreId ? coreScopeKey(coreId) : null;
  const panelOpen = scopeKey ? (panelOpenByCore[scopeKey] ?? false) : false;
  const setPanelOpen = useCallback(
    (open: boolean) => {
      if (!scopeKey) return;
      setPanelOpenByCore((prev) =>
        prev[scopeKey] === open ? prev : { ...prev, [scopeKey]: open }
      );
    },
    [scopeKey]
  );
  const togglePanel = useCallback(() => {
    if (!scopeKey) return;
    setPanelOpenByCore((prev) => ({ ...prev, [scopeKey]: !(prev[scopeKey] ?? true) }));
  }, [scopeKey]);

  const setCore = useCallback((next: string | null) => {
    setCoreState(next);
  }, []);

  // There is one terminal list: the `user_terminals` table and its routes went
  // with the project-root path (issue 266), so every terminal this store has
  // ever opened is a row in the one home list — whichever Core it was opened on.
  //
  // That single list is what makes restore possible at all. Once per app run,
  // as soon as any scope is current, fetch it and hand each row back to the
  // bucket of the Core its persisted identity names. A row whose identity is
  // missing is NOT restored: nothing here knows which Core it ran on, and issue
  // 394's rule is that a reload shows a terminal gone on purpose rather than
  // quietly spawning a different one somewhere else. Identities for rows the server no longer has are pruned in the same
  // pass, so the bucket cannot grow forever.
  //
  // **The run is deliberately not cancellable.** What it restores is decided by
  // each row's identity, not by whichever scope happened to be current when the
  // request went out, so a navigation mid-flight changes nothing about the
  // right answer. Gating the writes on a cleanup flag made navigating during
  // the fetch — landing on a Core on a cold Panel and clicking another one
  // before the list answers — throw the answer away while the once-per-run
  // guard stayed latched: no terminals in any scope, no retry, for the rest of
  // the app run, which is the very symptom this restore exists to remove. The
  // three setters below are idempotent under their own guards and a setState
  // after unmount is a no-op, so there is nothing for a cancel to protect.
  const restoreStartedRef = useRef(false);
  useEffect(() => {
    if (!scopeKey) return;
    if (restoreStartedRef.current) return;
    restoreStartedRef.current = true;

    // Only identities that already existed when the request went out may be
    // pruned by its answer. One opened while the list is in flight is absent
    // from that answer for a reason that is not "the row is gone".
    const prunable = new Set(Object.keys(readIdentityMap()));

    void (async () => {
      try {
        const { terminals } = await api.listHomeTerminals();
        // Re-read rather than close over the mount-time map: another tab may
        // have opened a terminal since, and its row is in this answer.
        const restored = restoreUserTerminals(terminals, readIdentityMap(), coreScopeKey);
        setSessionsByCore((prev) => {
          let next = prev;
          for (const [key, entries] of Object.entries(restored)) {
            const current = prev[key] ?? [];
            const alreadyOpen = new Set(current.map((s) => s.terminal.id));
            // Merge by terminal id, never by bucket: opening one terminal in a
            // scope before the list answers must not drop every terminal that
            // scope had before the reload.
            const additions = entries
              .filter(({ terminal }) => !alreadyOpen.has(terminal.id))
              .map(({ terminal, identity }) => ({
                terminal,
                ptyId: null,
                coreId: identity.coreId,
              }));
            if (additions.length === 0) continue;
            next = next === prev ? { ...prev } : next;
            // Restored terminals predate anything opened this run.
            next[key] = [...additions, ...current];
          }
          return next;
        });
        setFocusedByCore((prev) => {
          let next = prev;
          for (const [key, entries] of Object.entries(restored)) {
            if (prev[key] !== undefined) continue;
            next = next === prev ? { ...prev } : next;
            next[key] = entries[0]?.terminal.id ?? null;
          }
          return next;
        });
        const liveIds = new Set(terminals.map((t) => t.id));
        setIdentities((prev) => pruneIdentities(prev, liveIds, prunable));
      } catch {
        // Transient failure (offline, Panel restarting): let a later scope
        // change try again rather than leaving the operator with no terminals.
        restoreStartedRef.current = false;
      }
    })();
  }, [scopeKey]);

  // Navigating to a Core pre-fetches the terminal JS chunks and **nothing
  // else** (issue 266). What used to be here also called
  // `prepareUserTerminalWarmSlot`, which spawned a real PTY on the Core in
  // anticipation of a click on a button that no longer exists — so it spawned
  // shells nothing could ever claim. That module is deleted and is deliberately
  // not reintroduced for VM shells: CONTEXT.md requires an explicit open
  // gesture, and a pre-spawn on navigation is the opposite of one. Downloading
  // a JS chunk starts no process on any machine.
  const canOpenShell = !!coreId;
  useEffect(() => {
    if (!canOpenShell) return;
    void prefetchTerminalModules();
  }, [canOpenShell]);

  const sessions = scopeKey ? (sessionsByCore[scopeKey] ?? []) : [];
  const focusedId = scopeKey ? (focusedByCore[scopeKey] ?? null) : null;
  const hiddenIds = useMemo<Set<string>>(
    () => new Set(scopeKey ? (hiddenIdsByCore[scopeKey] ?? []) : []),
    [scopeKey, hiddenIdsByCore]
  );
  const toggleHidden = useCallback(
    (id: string) => {
      if (!scopeKey) return;
      const key = scopeKey;
      const hiddenIds = hiddenIdsByCore[key] ?? [];
      const hiding = !hiddenIds.includes(id);
      setHiddenIdsByCore((prev) => {
        const cur = prev[key] ?? [];
        const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
        return { ...prev, [key]: next };
      });

      if (!hiding) {
        setPanelOpenByCore((prev) => (prev[key] === true ? prev : { ...prev, [key]: true }));
        return;
      }

      const visibleAfterHide = (sessionsByCoreRef.current[key] ?? []).filter(
        (s) => s.terminal.id !== id && !hiddenIds.includes(s.terminal.id)
      );
      if (visibleAfterHide.length === 0) {
        setPanelOpenByCore((prev) =>
          prev[key] === false ? prev : { ...prev, [key]: false }
        );
      }
    },
    [hiddenIdsByCore, scopeKey]
  );

  const updateSessions = useCallback(
    (key: string, fn: (prev: Session[]) => Session[]) => {
      setSessionsByCore((prev) => ({ ...prev, [key]: fn(prev[key] ?? []) }));
    },
    []
  );

  const setFocusFor = useCallback((key: string, id: string | null) => {
    setFocusedByCore((prev) => (prev[key] === id ? prev : { ...prev, [key]: id }));
  }, []);

  const createVmShellTerminal = useCallback(
    async (openOn?: string): Promise<UserTerminal | null> => {
      // A VM Shell Session lives on the Core itself, so it needs a Core in
      // scope and nothing else. It reuses the home-terminal row for
      // persistence/lifecycle, spawns with `shellSession: true`, and renders the
      // distinct "VM shell" surface. Never auto-spawned — this is the explicit
      // gesture, and since issue 266 it is the only one: both "New Terminal"
      // controls call exactly this.
      if (!openOn || !scopeKey) return null;
      const key = scopeKey;
      const { terminal } = await api.createHomeTerminal({
        name: "VM shell",
      });
      // Record which Core this shell runs on before it is shown, so a reload one
      // keystroke later restores it there (issue 394). A VM shell opens at the
      // Core's own home via a login shell, so there is no path to record.
      const identity: UserTerminalIdentity = { coreId: openOn };
      setIdentities((prev) => ({ ...prev, [terminal.id]: identity }));
      updateSessions(key, (prev) => [...prev, { terminal, ptyId: null, coreId: openOn }]);
      setFocusFor(key, terminal.id);
      setPanelOpenByCore((prev) => ({ ...prev, [key]: true }));
      return terminal;
    },
    [scopeKey, updateSessions, setFocusFor]
  );

  const killTerminal = useCallback(
    async (id: string) => {
      // Resolve owner + neighbor synchronously from the latest snapshot. Doing
      // this inside a setState updater breaks when the fiber has pending lanes
      // (the updater would run lazily, leaving the closure vars null).
      const snapshot = sessionsByCoreRef.current;
      let ownerKey: string | null = null;
      let killedPtyId: string | null = null;
      let killedCoreId: string | undefined;
      let neighborId: string | null = null;
      let lastTerminal = false;
      for (const [pid, list] of Object.entries(snapshot)) {
        const idx = list.findIndex((s) => s.terminal.id === id);
        if (idx === -1) continue;
        ownerKey = pid;
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
      if (!ownerKey) return;

      // Dispose the cached xterm surface — a kill is a real teardown, not a
      // parkable scope switch, so the persistent subscription + Terminal go too.
      terminalSurfaceCache.destroy(id);

      setSessionsByCore((prev) => ({
        ...prev,
        [ownerKey!]: (prev[ownerKey!] ?? []).filter(
          (s) => s.terminal.id !== id
        ),
      }));
      setFocusedByCore((prev) => {
        if (prev[ownerKey!] !== id) return prev;
        return { ...prev, [ownerKey!]: neighborId };
      });
      setHiddenIdsByCore((prev) => {
        const cur = prev[ownerKey!];
        if (!cur || !cur.includes(id)) return prev;
        return { ...prev, [ownerKey!]: cur.filter((x) => x !== id) };
      });
      if (lastTerminal) {
        setPanelOpenByCore((prev) =>
          prev[ownerKey!] === false
            ? prev
            : { ...prev, [ownerKey!]: false }
        );
      }

      if (killedPtyId) {
        // Kill on the Core the shell actually runs on.
        await getCorePtyBridge(killedCoreId)?.kill(killedPtyId).catch(() => undefined);
      }
      try {
        // One endpoint: every row this store creates is a `home_terminals` row,
        // whichever scope key it is bucketed under (issue 266).
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

  const closeForCore = useCallback(
    async (closing: string) => {
      const keys = terminalScopeKeysForCore(sessionsByCoreRef.current, closing);
      const ids = keys.flatMap((key) =>
        (sessionsByCoreRef.current[key] ?? []).map((s) => s.terminal.id),
      );
      for (const id of ids) {
        await killTerminal(id);
      }
      setIdentities((prev) => forgetIdentities(prev, ids));
      setSessionsByCore(dropCoreKeys(closing));
      setFocusedByCore(dropCoreKeys(closing));
      setHiddenIdsByCore(dropCoreKeys(closing));
      setPanelOpenByCore(dropCoreKeys(closing));
    },
    [killTerminal],
  );

  const renameTerminal = useCallback(async (id: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setSessionsByCore((prev) => {
      const next = { ...prev };
      for (const [key, list] of Object.entries(prev)) {
        if (!list.some((s) => s.terminal.id === id)) continue;
        next[key] = list.map((s) =>
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

  const setPtyId = useCallback((terminalId: string, ptyId: string | null, coreId?: string) => {
    setSessionsByCore((prev) => {
      let next = prev;
      let changed = false;
      for (const [key, list] of Object.entries(prev)) {
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
          next[key] = updated;
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
      if (!(panelOpenByCore[key] ?? false)) return;
      const list = sessionsByCore[key] ?? [];
      if (list.length === 0) return;
      const cur = focusedByCore[key] ?? null;
      const idx = cur ? list.findIndex((s) => s.terminal.id === cur) : -1;
      const nextIdx = idx === -1 ? 0 : (idx + delta + list.length) % list.length;
      setFocusFor(key, list[nextIdx]!.terminal.id);
    },
    [scopeKey, panelOpenByCore, sessionsByCore, focusedByCore, setFocusFor]
  );

  const cycleNext = useCallback(() => cycle(1), [cycle]);
  const cyclePrev = useCallback(() => cycle(-1), [cycle]);

  const value = useMemo<Ctx>(
    () => ({
      coreId,
      setCore,
      panelOpen,
      togglePanel,
      setPanelOpen,
      sessions,
      sessionsByScope: sessionsByCore,
      focusedId,
      focusTerminal,
      createVmShellTerminal,
      closeForCore,
      killTerminal,
      hiddenIds,
      toggleHidden,
      renameTerminal,
      setPtyId,
      cycleNext,
      cyclePrev,
    }),
    [
      coreId,
      setCore,
      panelOpen,
      togglePanel,
      sessions,
      sessionsByCore,
      focusedId,
      focusTerminal,
      createVmShellTerminal,
      closeForCore,
      killTerminal,
      hiddenIds,
      toggleHidden,
      renameTerminal,
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
