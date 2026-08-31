import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api } from "~/lib/api";
import { onCoreRegistryChanged } from "~/lib/core-registry-changed";
import { readCachedCoreCount, writeCachedCoreCount } from "~/lib/shell-query-cache";
import { CORES_POLL_MS } from "~/lib/use-fleet";

// Lazy, for the same reason the settings overlay is: on every load of a Panel
// that *has* a fleet — which is every load after the first — the wizard and the
// pairing form it mounts are bytes nobody will render. The gate itself has to
// stay eager, because deciding is its whole job and it decides before anything
// paints; it is a `listCores()` and a branch, and costs the entry chunk nothing.
const FirstRunWizard = lazy(() =>
  import("~/components/views/FirstRunWizard").then((m) => ({ default: m.FirstRunWizard })),
);

/**
 * The gate (#358): a Panel that knows no Cores shows the pairing wizard, and
 * a Panel that knows one shows the app.
 *
 * **The condition is the count, not the calendar.** This is not a first-run
 * flag, not a "seen it" preference, and not something the operator can be past.
 * It is a live read of the Core registry, so a fresh Panel lands in the wizard
 * and a Panel whose last Core was forgotten goes back to it — the same rule
 * answering both, because they are the same state. There is nothing to reset
 * and nothing to migrate.
 *
 * **It replaces the shell rather than covering it.** `children` here is the
 * entire app — top bar, project rail, router outlet, settings overlay — and at
 * zero Cores none of it mounts. That is what makes this a gate rather than a
 * modal: there is no route to type, no escape key, no click-outside, and no
 * dead dashboard behind the wizard to glimpse. The only exit is a paired Core.
 *
 * The one screen this does *not* stand in front of is `/login` and `/setup`:
 * `__root.tsx` renders those outside the shell entirely, so an operator still
 * creates their account first and meets the wizard immediately after.
 */

export function FirstRunGate({ children }: { children: ReactNode }) {
  const { count, error, refresh } = useCoreRegistry();

  /**
   * The pairing form's `onPaired`, and the reason it is awaited.
   *
   * `AddCoreByPairing` holds its busy state until this resolves, so re-reading
   * the registry here — rather than optimistically counting the Core it just
   * handed us — means the form stays visibly mid-pairing right up to the moment
   * the dashboard is genuinely unlocked. The alternative flashes an empty
   * wizard between the pairing landing and the count catching up, which reads
   * as a failure of the thing that just succeeded.
   *
   * Counting the returned Core instead would also be the gate believing
   * something other than the registry, which is the one thing it must not do.
   */
  const handlePaired = useCallback(async () => {
    await refresh();
  }, [refresh]);

  // Genuinely unknown: no live answer yet *and* nothing cached to stand in for
  // one, which is the first load in this browser and no other. Drawing the
  // wizard here would flash it at every operator with a fleet, and drawing the
  // shell would flash a dashboard at operators with none — the two mistakes
  // this component exists to prevent. Every other load paints on the seed.
  if (count === null && error === null) return null;

  // A registry we could not read is not a registry with no Cores in it, but it
  // is certainly not one we can unlock a dashboard on. The wizard is the honest
  // screen for it, and it says which of the two happened.
  if (count === null || count === 0) {
    return (
      <Suspense fallback={null}>
        <FirstRunWizard onPaired={handlePaired} registryError={error} />
      </Suspense>
    );
  }

  return <>{children}</>;
}

/**
 * How many Cores this Panel is paired with, kept fresh.
 *
 * Deliberately not `useCores`. That hook is built for the Cores list: it holds
 * the rows, folds live dial pushes into them, and refreshes on a nonce. This
 * needs none of the rows and cannot use a nonce, because the gate has to be
 * able to *wait* for a re-read — `onPaired` is a promise the pairing form is
 * holding its busy state on, and a nonce cannot be awaited. What is shared is
 * the thing that matters: both ask `api.listCores()` and both pace themselves
 * off `CORES_POLL_MS`, so there is one answer about the fleet, one cadence, and
 * no second source of truth for either.
 *
 * `count` starts at whatever this browser was last told (`readCachedCoreCount`)
 * so a paired Panel paints its shell on the first client render, the same
 * bargain `installShellQueryCache` makes for projects, groups and settings. The
 * seed is never an answer: the live read lands on the same tick and corrects
 * it, and a *stale* seed can only cost one frame in either direction.
 *
 * After that it never returns to null: a poll that fails leaves the last known
 * count standing, so a Panel with a fleet is not thrown into the wizard by one
 * bad request.
 */
function useCoreRegistry(): {
  count: number | null;
  error: string | null;
  refresh: () => Promise<void>;
} {
  const [count, setCount] = useState<number | null>(() => readCachedCoreCount() ?? null);
  const [error, setError] = useState<string | null>(null);

  const mounted = useRef(true);
  // What the last settled read said, readable from inside `refresh` without
  // making it depend on — and be rebuilt by — the state it sets.
  const known = useRef<number | null>(count);
  // Monotonic, so a slow poll that lands after a fast explicit refresh cannot
  // overwrite the newer answer with its older one — which, on this component,
  // would mean re-locking a dashboard that had just been unlocked.
  const issued = useRef(0);
  const settled = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    issued.current += 1;
    const seq = issued.current;
    try {
      let next = (await api.listCores()).cores.length;
      /**
       * Tearing down a live session takes two answers, not one.
       *
       * Locking the gate unmounts the whole shell: every open terminal panel,
       * every websocket, whatever the operator was mid-way through. The gate
       * already refuses to do that on a *failed* read; an empty successful one
       * deserves the same suspicion, because a Panel server that restarts
       * against an empty or unmigrated data directory answers 200 with nothing
       * in it and would take the session down with no prompt and no undo.
       *
       * So an empty answer that would close the gate is re-asked, and only two
       * consecutive empty successes lock it. This buys exactly what it says: a
       * single anomalous 200 cannot end a session. It does not defend against a
       * registry that is genuinely and persistently empty — nothing short of
       * asking the operator could, and a Panel whose Cores are really gone
       * belongs in the wizard.
       */
      if (next === 0 && (known.current ?? 0) > 0) {
        next = (await api.listCores()).cores.length;
      }
      if (!mounted.current || seq < settled.current) return;
      settled.current = seq;
      known.current = next;
      setCount(next);
      setError(null);
      writeCachedCoreCount(next);
    } catch (err) {
      if (!mounted.current || seq < settled.current) return;
      settled.current = seq;
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // Gated means "the wizard is what is on screen": no fleet known, or none at
  // all. It decides how hard this hook works — see the two effects below.
  const gated = count === null || count === 0;

  useEffect(() => {
    void refresh();
    // Pairing or forgetting a Core anywhere in this tab is the whole reason
    // this number changes. Waiting out a poll for it would leave the gate
    // visibly wrong for up to fifteen seconds.
    return onCoreRegistryChanged(() => void refresh());
  }, [refresh]);

  /**
   * The poll runs **only while the gate is up**.
   *
   * Once unlocked there is nothing here worth a standing timer: every registry
   * change this tab makes arrives on the event above, and the shell that is now
   * mounted is already reading the same endpoint through `useCores`. A third
   * recurring `listCores()` for the life of the tab bought nothing but load.
   */
  useEffect(() => {
    if (!gated) return;
    const timer = setInterval(() => void refresh(), CORES_POLL_MS);
    return () => clearInterval(timer);
  }, [gated, refresh]);

  /**
   * What the dropped poll would have caught: a Core forgotten in *another* tab.
   *
   * The event is window-scoped, so it does not cross tabs, and the requirement
   * is about the count rather than about which tab did the forgetting. Re-asking
   * when this tab comes back to the front covers it at the only moment it
   * matters — when someone is looking at this Panel — and costs nothing while
   * they are not.
   */
  useEffect(() => {
    if (gated) return;
    const recheck = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    window.addEventListener("focus", recheck);
    document.addEventListener("visibilitychange", recheck);
    return () => {
      window.removeEventListener("focus", recheck);
      document.removeEventListener("visibilitychange", recheck);
    };
  }, [gated, refresh]);

  return { count, error, refresh };
}
