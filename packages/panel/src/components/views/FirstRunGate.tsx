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

/**
 * How often to re-ask, absent an announcement.
 *
 * The same fifteen seconds `useCores` polls on, and for the same reason: only
 * an operator changes this registry. The poll is the backstop for a change this
 * tab did not make; the announcement below is what makes the changes it *did*
 * make instant.
 */
const REGISTRY_POLL_MS = 15_000;

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

  // Not yet known, and no reason to think it is unknowable: draw nothing.
  // Rendering the wizard here would flash it at every operator with a fleet on
  // every load, and rendering the shell would flash a dashboard at operators
  // with none — the two mistakes this component exists to prevent.
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
 * the thing that matters: both ask `api.listCores()`, so there is one answer
 * about the fleet and no second source of truth for it.
 *
 * `count` is null until a read succeeds, and never returns to null afterwards:
 * a poll that fails leaves the last known count standing, so a Panel with a
 * fleet does not get thrown into the wizard by one bad request.
 */
function useCoreRegistry(): {
  count: number | null;
  error: string | null;
  refresh: () => Promise<void>;
} {
  const [count, setCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mounted = useRef(true);
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
      const { cores } = await api.listCores();
      if (!mounted.current || seq < settled.current) return;
      settled.current = seq;
      setCount(cores.length);
      setError(null);
    } catch (err) {
      if (!mounted.current || seq < settled.current) return;
      settled.current = seq;
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), REGISTRY_POLL_MS);
    // Pairing or forgetting a Core anywhere in this tab is the whole reason
    // this number changes. Waiting out the poll for it would leave the gate
    // visibly wrong for up to fifteen seconds.
    const stop = onCoreRegistryChanged(() => void refresh());
    return () => {
      clearInterval(timer);
      stop();
    };
  }, [refresh]);

  return { count, error, refresh };
}
