import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { getPanelBridge } from "./panel-bridge";
import { mergeFleetTasks, type CoreFanOutResult, type FleetMergeResult } from "~/shared/fleet-merge";
import type { CoreLinkProjectSnapshot, CoreLinkTaskSnapshot } from "@actana/shared/core-link-frames";
import type { Harness } from "@actana/shared/domain";
import { coreOrder, type CoreWithDial } from "~/shared/cores";
import { subscribeCoreProjectEvents } from "~/lib/subscribe-core-project-events";
import {
  projectPresentationById,
  projectRowFromSnapshot,
  type ProjectWithCounts,
} from "~/shared/projects";

// The fleet, as the browser sees it.
//
// The Panel caches nothing task-shaped: every list here is a live query down a
// core-link, fanned out over the tab's single panel link. A Core the service
// cannot reach contributes no rows at all — an unreachable Core is honestly
// blank, with a last-seen time, rather than quietly stale.
//
// Nothing polls for *reachability*: the service is the one dialing, so it
// pushes dial-status changes and these hooks act on them. The poll that remains
// is for Core-side content the event stream doesn't cover.

const FLEET_POLL_MS = 15_000;
const CORES_POLL_MS = 15_000;

/** Event kinds that change what a `tasksList` would return. */
const TASK_EVENT_KINDS = /^(task:|session:|pty:)/;

function emptyFleet(): FleetMergeResult {
  return { rows: [], offlineCores: [], singleCore: false };
}

/**
 * The registered fleet with each Core's live link state.
 *
 * The list itself comes over HTTP — it is Panel state, it changes only when the
 * operator pairs or forgets a Core, and it has no business on the live link.
 * The `dial` half is the opposite: it changes on its own, so the service pushes
 * it and this hook folds each push into the row it belongs to. A Core going
 * down reaches every open tab without anyone asking.
 */
export function useCores(nonce = 0): { cores: CoreWithDial[]; loading: boolean; error: string | null } {
  const bridge = getPanelBridge();
  const [cores, setCores] = useState<CoreWithDial[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const { cores: list } = await api.listCores();
      setCores([...list].sort(coreOrder));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    // A second tab (or this one, on a Core it just added) changes the registry
    // without an event to carry it; a slow poll keeps every tab converging.
    const id = setInterval(() => void load(), CORES_POLL_MS);
    return () => clearInterval(id);
  }, [load, nonce]);

  useEffect(() => {
    if (!bridge) return;
    return bridge.onDialStatus((status) => {
      setCores((prev) =>
        prev.map((core) => (core.id === status.coreId ? { ...core, dial: status } : core)),
      );
    });
  }, [bridge]);

  return { cores, loading, error };
}

/**
 * Every Core's active tasks, merged into one Fleet view model.
 *
 * The fan-out is the browser's: one `tasksList` per Core, in parallel, down the
 * one panel link. There is no server-side fan-out endpoint to keep in step with
 * it — the router already addresses frames by `coreId`, so asking N Cores is
 * N frames, not a new API.
 */
export function useFleetTasks(): {
  fleet: FleetMergeResult;
  /** The registry behind the fan-out, with each Core's live link state. */
  cores: CoreWithDial[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
} {
  const bridge = getPanelBridge();
  const { cores, error: coresError } = useCores();
  const [fleet, setFleet] = useState<FleetMergeResult>(emptyFleet);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const refreshing = useRef(false);
  const coresRef = useRef<CoreWithDial[]>(cores);
  coresRef.current = cores;
  // Which Cores exist, and whether each is reachable — the two things a change
  // in should re-run the fan-out. Every dial push replaces the `cores` array,
  // so depending on the array itself would refetch the whole fleet on a blink.
  const coreSignature = useMemo(
    () => cores.map((c) => `${c.id}:${c.dial.state}`).join(","),
    [cores],
  );
  const coreIds = useMemo(() => cores.map((c) => c.id).join(","), [cores]);

  const run = useCallback(async () => {
    if (!bridge || refreshing.current) return;
    refreshing.current = true;
    try {
      const results = await Promise.all(
        coresRef.current.map(async (core): Promise<CoreFanOutResult> => {
          const offline: CoreFanOutResult = {
            coreId: core.id,
            coreLabel: core.label,
            ok: false,
            lastSeenAt: core.dial.lastSeenAt,
          };
          // A Core the service knows it cannot reach is not worth a query the
          // router would only answer with an error.
          if (core.dial.state !== "connected") return offline;
          try {
            const { tasks } = await bridge.listTasks(core.id);
            return {
              coreId: core.id,
              coreLabel: core.label,
              ok: true,
              tasks,
              lastSeenAt: core.dial.lastSeenAt ?? Date.now(),
            };
          } catch {
            return offline;
          }
        }),
      );
      setFleet(mergeFleetTasks(results));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      refreshing.current = false;
    }
  }, [bridge]);

  // Watch every Core so its task events reach this tab, and refetch when one
  // lands. This is what "without refresh" means: an agent finishing on a VM
  // moves the row here, not on the next poll.
  useEffect(() => {
    if (!bridge) return;
    const releases = coresRef.current.map((core) => bridge.watchCore(core.id));
    const offEvent = bridge.onEvent(({ event }) => {
      if (TASK_EVENT_KINDS.test(event.kind)) void run();
    });
    // A reconnect means a gap; whatever the replay says, refetch the lists.
    const offConnection = bridge.onConnectionChange((connected) => {
      if (connected) void run();
    });
    return () => {
      for (const release of releases) release();
      offEvent();
      offConnection();
    };
  }, [bridge, coreIds, run]);

  useEffect(() => {
    void run();
    const id = setInterval(() => void run(), FLEET_POLL_MS);
    return () => clearInterval(id);
  }, [run, coreSignature]);

  return { fleet, cores, loading, error: error ?? coresError, refresh: () => void run() };
}

/**
 * One Core's projects, live. Refetches when that Core reports a project-list-
 * affecting event, so a project created on the Core — by another Panel, or
 * by a hand at the VM's own keyboard — appears here without a reload.
 */
export function useCoreProjects(coreId: string | null): {
  projects: CoreLinkProjectSnapshot[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
} {
  const bridge = getPanelBridge();
  const [projects, setProjects] = useState<CoreLinkProjectSnapshot[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async () => {
    if (!coreId || !bridge) {
      setProjects([]);
      return;
    }
    setLoading(true);
    try {
      setProjects(await bridge.listProjects(coreId));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setProjects([]);
    } finally {
      setLoading(false);
    }
  }, [coreId, bridge]);

  useEffect(() => {
    void run();
  }, [run]);

  useEffect(() => {
    if (!bridge || !coreId) return;
    const release = bridge.watchCore(coreId);
    const off = subscribeCoreProjectEvents(bridge, coreId, () => void run());
    return () => {
      off();
      release();
    };
  }, [bridge, coreId, run]);

  return { projects, loading, error, refresh: () => void run() };
}

/** One Core's tasks for one project — the per-Core navigation's second level. */
export function useCoreTasks(
  coreId: string | null,
  projectId: string | null,
): {
  tasks: CoreLinkTaskSnapshot[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
} {
  const bridge = getPanelBridge();
  const [tasks, setTasks] = useState<CoreLinkTaskSnapshot[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!coreId || !projectId || !bridge) {
      setTasks([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const result = await bridge.listTasks(coreId, projectId);
        if (!cancelled) {
          setTasks(result.tasks);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setTasks([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [coreId, projectId, bridge, nonce]);

  return { tasks, loading, error, refresh: () => setNonce((n) => n + 1) };
}

/**
 * The pinned projects across the fleet, for the project rail. Pin state is a
 * Core fact, so this is a live read per Core rather than anything the Panel
 * remembers — and it re-reads when a Core says a pin changed, so two Panels on
 * one Core agree.
 */
export function useRemotePinnedProjects(): {
  projects: ProjectWithCounts[];
  refresh: () => void;
} {
  const bridge = getPanelBridge();
  const { cores } = useCores();
  const [pinned, setPinned] = useState<ProjectWithCounts[]>([]);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const refresh = useCallback(() => setRefreshNonce((n) => n + 1), []);
  const coreIds = useMemo(() => cores.map((c) => c.id).join(","), [cores]);

  useEffect(() => {
    if (!bridge || cores.length === 0) {
      setPinned([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      // The rail clusters by group and draws card images, and both are
      // Panel-local presentation for a Core-owned project (issue 98) — read
      // once for the whole fan-out rather than per Core. A failed read only
      // costs the filing, so the pins still render.
      const presentation = projectPresentationById(
        await api
          .listProjectPresentation()
          .then((r) => r.presentation)
          .catch(() => []),
      );
      const perCore = await Promise.all(
        cores.map(async (core) => {
          try {
            const projects = await bridge.listProjects(core.id);
            return projects
              .filter((p) => p.pinned)
              .map((p) => ({
                ...projectRowFromSnapshot(p, presentation.get(p.projectId)),
                coreId: core.id,
              }));
          } catch {
            return [] as ProjectWithCounts[];
          }
        }),
      );
      if (!cancelled) setPinned(perCore.flat());
    })();
    return () => {
      cancelled = true;
    };
    // `coreIds` rather than `cores`: a dial-status push replaces the array
    // without changing which Cores exist, and re-running the fan-out on every
    // status blink would put the rail into a fetch loop.
  }, [bridge, coreIds, refreshNonce]);

  useEffect(() => {
    if (!bridge || cores.length === 0) return;
    const unsubs = cores.map((core) => {
      const release = bridge.watchCore(core.id);
      const off = subscribeCoreProjectEvents(bridge, core.id, () => setRefreshNonce((n) => n + 1));
      return () => {
        off();
        release();
      };
    });
    return () => {
      for (const u of unsubs) u();
    };
  }, [bridge, coreIds]);

  return { projects: pinned, refresh };
}

