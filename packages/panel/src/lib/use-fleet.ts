import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { getPanelBridge } from "./panel-bridge";
import { mergeFleetSessions, type CoreFanOutResult, type FleetMergeResult } from "~/shared/fleet-merge";
import {
  FLEET_POLL_MS,
  SESSION_EVENT_KINDS,
  createCoalescingRunner,
  sameSnapshot,
} from "~/lib/fleet-refresh";
import { coreOrder, type CoreWithDial } from "~/shared/cores";

// The fleet, as the browser sees it.
//
// The Panel caches nothing session-shaped: every list here is a live query down a
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
 * Every Core's active sessions, merged into one Fleet view model.
 *
 * The fan-out is the browser's: one `sessionRowsList` per Core, in parallel, down the
 * one panel link. There is no server-side fan-out endpoint to keep in step with
 * it — the router already addresses frames by `coreId`, so asking N Cores is
 * N frames, not a new API.
 */
export function useFleetSessions(): {
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
            const { sessions } = await bridge.listSessionRows(core.id);
            return {
              coreId: core.id,
              coreLabel: core.label,
              ok: true,
              sessions,
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
      const merged = mergeFleetSessions(results);
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

  // Watch every Core so its session events reach this tab, and refetch when one
  // lands. This is what "without refresh" means: an agent finishing on a VM
  // moves the row here, not on the next poll.
  useEffect(() => {
    if (!bridge) return;
    const releases = coresRef.current.map((core) => bridge.watchCore(core.id));
    const offEvent = bridge.onEvent(({ event }) => {
      if (SESSION_EVENT_KINDS.test(event.kind)) void run();
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
