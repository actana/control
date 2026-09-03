import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { api } from "./api";
import { getPanelBridge } from "./panel-bridge";
import { mergeFleetTasks, type CoreFanOutResult, type FleetMergeResult } from "~/shared/fleet-merge";
import {
  FLEET_POLL_MS,
  TASK_EVENT_KINDS,
  createCoalescingRunner,
  sameSnapshot,
} from "~/lib/fleet-refresh";
import {
  getCorePinsSnapshot,
  refreshCorePins,
  setCorePinsCores,
  subscribeCorePins,
} from "~/lib/core-pins-engine";
import type { CoreLinkProjectSnapshot, CoreLinkTaskSnapshot } from "@actana/sdk/core-link-frames";
import type { Harness } from "@actana/shared/domain";
import { coreOrder, type CoreWithDial } from "~/shared/cores";
import { subscribeCoreProjectEvents } from "~/lib/subscribe-core-project-events";
import {
  projectPresentationById,
  projectRowFromSnapshot,
  type ProjectWithCounts,
} from "~/shared/projects";
import type { ProjectPresentation } from "~/db/schema";

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

/**
 * How often the registry is re-read, absent something saying it changed.
 *
 * Exported because the first-run gate polls the same registry for the same
 * reason and had hand-copied the number (#358 review): one cadence, one place
 * to change it, and no comment claiming two constants agree.
 */
export const CORES_POLL_MS = 15_000;

function emptyFleet(): FleetMergeResult {
  return { rows: [], offlineCores: [], singleCore: false };
}

/**
 * "Nothing filed yet", shared by identity so a re-read that finds no filing
 * doesn't re-join every row. Read-only — nothing ever writes into it.
 */
const NO_PRESENTATION: ReadonlyMap<string, ProjectPresentation> = new Map();

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

  const fanOut = useCallback(async (): Promise<boolean> => {
    // Unreachable through `run`, which guards the same thing; false is the
    // safe answer either way — no link, nothing to re-read.
    if (!bridge) return false;
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
      // Keep the previous object when the fan-out settled on the same answer.
      // `fleet.rows` is a dependency of memos and effects several layers up,
      // and a fresh array on every event would tear those down for nothing —
      // the merge is already O(rows), so comparing it costs the same order.
      const merged = mergeFleetTasks(results);
      setFleet((prev) => (sameSnapshot(prev, merged) ? prev : merged));
      setError(null);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setLoading(false);
    }
  }, [bridge]);

  // The coalescing loop is `createCoalescingRunner` (see `lib/fleet-refresh`):
  // one trailing pass per burst, so a `session:finished` that lands while a
  // fan-out is in flight is not dropped (#389). It is built once and reads the
  // current pass through a ref, so rebuilding `fanOut` cannot reset the loop's
  // flags mid-burst — and `run` stays stable, so an event subscription is not
  // torn down and re-armed on every rebuild.
  const fanOutRef = useRef(fanOut);
  fanOutRef.current = fanOut;
  const runnerRef = useRef<(() => Promise<void>) | null>(null);
  runnerRef.current ??= createCoalescingRunner(() => fanOutRef.current());
  const run = useCallback(async () => {
    if (!bridge) return;
    await runnerRef.current?.();
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
  // A Core we are about to ask is loading, not empty. Seeding `false` made the
  // first paint of every caller indistinguishable from "this Core has no
  // projects" — a blank list that then filled in.
  const [loading, setLoading] = useState(coreId !== null);
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

/**
 * One Core's projects as the row shape every project surface renders.
 *
 * The rows themselves are `useCoreProjects` — the same core-link read, not a
 * second one — joined onto the Panel's own filing for each project (its group,
 * card image and launch URL, ADR-0022), which has no frame to travel in and so
 * is read Panel-side and merged here. Callers that render a project (the
 * top-bar switcher) want this; callers that want raw Core facts want
 * `useCoreProjects`.
 *
 * A failed filing read costs the operator's grouping, not the list: the rows
 * still render, unfiled — the same degradation `useRemotePinnedProjects` and
 * `projectQueryOptions` already make.
 *
 * `projects` is `undefined` until the first list read settles, so a caller can
 * tell "still asking" from "this Core owns none".
 */
export function useCoreProjectRows(coreId: string | null): {
  projects: ProjectWithCounts[] | undefined;
  error: string | null;
} {
  const { projects: snapshots, loading, error } = useCoreProjects(coreId);
  const [presentation, setPresentation] =
    useState<ReadonlyMap<string, ProjectPresentation>>(NO_PRESENTATION);
  // Which projects the Core is reporting. The poll replaces the snapshot array
  // on every tick; only a change in *which* projects exist can bring filing we
  // have not read yet, so that is what re-reads it.
  const projectIds = useMemo(() => snapshots.map((s) => s.projectId).join(","), [snapshots]);

  useEffect(() => {
    if (!coreId) {
      setPresentation(NO_PRESENTATION);
      return;
    }
    let cancelled = false;
    void api
      .listProjectPresentation()
      .then(({ presentation: rows }) => {
        if (!cancelled) setPresentation(projectPresentationById(rows));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [coreId, projectIds]);

  const projects = useMemo(
    () => snapshots.map((s) => ({ ...projectRowFromSnapshot(s, presentation.get(s.projectId)), coreId })),
    [snapshots, presentation, coreId],
  );

  return { projects: loading && projects.length === 0 ? undefined : projects, error };
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
 * The pinned projects across the fleet, for the project rail.
 *
 * Pin state is a Core fact, so this is a live read per Core rather than
 * anything the Panel remembers — and it re-reads when a Core says a pin
 * changed, so two Panels on one Core agree. The rail's activity dots are the
 * same kind of fact and come from the same read: each row's `taskCounts` is
 * derived from that Core's own `tasksList` snapshots, the rows the grid renders
 * from, so a running Session lights its pin's dot and a finish clears it on the
 * event rather than on a reload (#377).
 *
 * The reads themselves live in `lib/core-pins-engine` — one fan-out for the
 * whole tab, shared by every mount of this hook, because there are two or three
 * of them on screen at once and an event must not cost one fan-out each. This
 * hook is the subscription to it; see that module for what the sharing costs
 * and saves.
 */
export function useRemotePinnedProjects(): {
  projects: ProjectWithCounts[];
  refresh: () => void;
} {
  const { cores } = useCores();
  const projects = useSyncExternalStore(
    subscribeCorePins,
    getCorePinsSnapshot,
    // The engine only ever runs in a browser; on the server there are no Cores
    // to ask and the rail renders the Panel's own rows alone.
    getCorePinsSnapshot,
  );

  // Every mount pushes the registry it read; the engine acts only when the
  // Cores or their link states actually differ, so N mounts pushing the same
  // answer is N comparisons, not N fan-outs.
  useEffect(() => {
    setCorePinsCores(cores);
  }, [cores]);

  // A pin toggle has to move the dots as well as the tiles: the same pass
  // re-reads both, so the toggled tile does not land with the counts of the
  // Core's previous answer.
  return { projects, refresh: refreshCorePins };
}
