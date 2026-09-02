// @vitest-environment jsdom
//
// The active group is written optimistically and confirmed by a PATCH, and two
// PATCHes in flight are not ordered (#384). What is proven here is that the
// *newest local selection* owns the rail: an older answer landing last is
// dropped, and a failure hands the rail back to the last group the server
// acknowledged rather than to whatever happened to be on screen before.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { AppSettings } from "~/lib/api";
import type { Group } from "~/db/schema";

const updateSettings = vi.fn();
const getSettings = vi.fn();

vi.mock("~/lib/api", () => ({
  api: {
    updateSettings: (body: unknown) => updateSettings(body),
    getSettings: () => getSettings(),
    listGroups: () => Promise.reject(new Error("groups must be primed in these tests")),
  },
}));

const {
  ACTIVE_GROUP_ALL,
  createActiveGroupWriteLedger,
  useActiveGroup,
  __resetActiveGroupWritesForTests,
} = await import("~/lib/active-group");
const { queryKeys } = await import("~/queries");
const { ACTIVE_PROJECT_GROUP_STORAGE_KEY } = await import("~/lib/ui-preference-cache");

function settingsWith(activeProjectGroup: string | null): AppSettings {
  return { activeProjectGroup } as AppSettings;
}

const GROUPS = [
  { id: "g-a", name: "A" },
  { id: "g-b", name: "B" },
  { id: "g-c", name: "C" },
] as Group[];

/** A promise the test resolves by hand, so answers can land out of order. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // Nothing awaits a rejection until the test does; keep node quiet meanwhile.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

/**
 * A client whose settings query really fetches — no primed row, so the first
 * GET is genuinely in flight and can be cancelled (or not) for real.
 */
function mountLive() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, refetchOnWindowFocus: false } },
  });
  client.setQueryData(queryKeys.groups, GROUPS);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, ...renderHook(() => useActiveGroup(), { wrapper }) };
}

/** `initial` is what the server holds; `undefined` leaves settings unhydrated. */
function mount(initial: string | null | undefined) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity, refetchOnMount: false, refetchOnWindowFocus: false },
    },
  });
  if (initial !== undefined) client.setQueryData(queryKeys.settings, settingsWith(initial));
  client.setQueryData(queryKeys.groups, GROUPS);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, ...renderHook(() => useActiveGroup(), { wrapper }) };
}

/**
 * Let the settled PATCH handlers run and the hook re-render on their writes.
 * A macrotask, not a microtask: react-query batches its observer notifications
 * onto a `setTimeout`, so a flushed promise chain alone leaves `result.current`
 * on the previous render.
 */
async function settle() {
  await act(async () => {
    // Several rounds: the PATCH handler runs on a microtask, its cache write
    // schedules the notification on the *next* timer, and the render lands
    // after that. One round would read the state before its own effect.
    for (let round = 0; round < 3; round += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
}

beforeEach(() => {
  updateSettings.mockReset();
  getSettings.mockReset();
  getSettings.mockRejectedValue(new Error("settings must be primed in these tests"));
  window.localStorage.clear();
  __resetActiveGroupWritesForTests();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the active-group write ledger", () => {
  it("only reports the newest write as current", () => {
    const ledger = createActiveGroupWriteLedger(ACTIVE_GROUP_ALL);
    const first = ledger.beginWrite("g-b");
    const second = ledger.beginWrite("g-c");
    expect(ledger.settleWrite(first)).toBe(false);
    expect(ledger.settleWrite(second)).toBe(true);
  });

  it("keeps the acknowledged group until a newer answer confirms one", () => {
    const ledger = createActiveGroupWriteLedger("g-a");
    expect(ledger.lastAcknowledged()).toBe("g-a");
    ledger.acknowledge(ledger.beginWrite("g-b"), "g-b");
    expect(ledger.lastAcknowledged()).toBe("g-b");
  });

  it("refuses an acknowledgement older than the one already recorded", () => {
    const ledger = createActiveGroupWriteLedger("g-a");
    const first = ledger.beginWrite("g-b");
    const second = ledger.beginWrite("g-c");
    ledger.acknowledge(second, "g-c");
    // The older PATCH answers last; its group is the server's older truth.
    ledger.acknowledge(first, "g-b");
    expect(ledger.lastAcknowledged()).toBe("g-c");
  });

  it("records a superseded answer that the server did confirm", () => {
    const ledger = createActiveGroupWriteLedger("g-a");
    const first = ledger.beginWrite("g-b");
    ledger.beginWrite("g-c");
    // The older write is no longer the one that may paint...
    expect(ledger.settleWrite(first)).toBe(false);
    // ...but the server took it, so it is the group a later failure returns to.
    ledger.acknowledge(first, "g-b");
    expect(ledger.lastAcknowledged()).toBe("g-b");
  });

  it("seeds once, and never over something already known", () => {
    const ledger = createActiveGroupWriteLedger();
    ledger.seed("g-a");
    expect(ledger.lastAcknowledged()).toBe("g-a");
    ledger.seed("g-b");
    expect(ledger.lastAcknowledged()).toBe("g-a");
    ledger.observe("g-c");
    ledger.seed("g-d");
    expect(ledger.lastAcknowledged()).toBe("g-c");
  });

  it("ignores a settings read taken while a local write is in flight", () => {
    const ledger = createActiveGroupWriteLedger("g-a");
    const generation = ledger.beginWrite("g-b");
    // The optimistic value is this tab's own, not the server's word.
    ledger.observe("g-b");
    expect(ledger.lastAcknowledged()).toBe("g-a");
    ledger.settleWrite(generation);
    ledger.observe("g-b");
    expect(ledger.lastAcknowledged()).toBe("g-b");
  });

  it("lets an observed answer outrank every write older than the newest", () => {
    const ledger = createActiveGroupWriteLedger("g-a");
    const first = ledger.beginWrite("g-b");
    const second = ledger.beginWrite("g-c");
    ledger.settleWrite(first);
    ledger.settleWrite(second);
    // A refetch answered while nothing was in flight: it is the server's word
    // on every write issued so far.
    ledger.observe("g-b");
    ledger.acknowledge(first, "g-c");
    expect(ledger.lastAcknowledged()).toBe("g-b");
  });
});

describe("useActiveGroup under racing PATCHes", () => {
  it("leaves B selected when the A answer returns last", async () => {
    const a = deferred<AppSettings>();
    const b = deferred<AppSettings>();
    updateSettings.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);

    const { result } = mount(null);

    act(() => result.current.setActiveGroup("g-a"));
    act(() => result.current.setActiveGroup("g-b"));
    await settle();
    expect(result.current.activeGroup).toBe("g-b");

    // B's answer lands first and is the newest write: it is applied.
    b.resolve(settingsWith("g-b"));
    await settle();
    expect(result.current.activeGroup).toBe("g-b");

    // A's answer lands last carrying the older group — and is dropped.
    a.resolve(settingsWith("g-a"));
    await settle();
    expect(result.current.activeGroup).toBe("g-b");
    expect(window.localStorage.getItem(ACTIVE_PROJECT_GROUP_STORAGE_KEY)).toBe("g-b");
  });

  it("restores the last acknowledged group when a PATCH fails", async () => {
    const ok = deferred<AppSettings>();
    const bad = deferred<AppSettings>();
    updateSettings.mockReturnValueOnce(ok.promise).mockReturnValueOnce(bad.promise);

    // "g-a" is what the server has; "g-b" then becomes the acknowledged group.
    const { result } = mount("g-a");
    act(() => result.current.setActiveGroup("g-b"));
    ok.resolve(settingsWith("g-b"));
    await settle();
    expect(result.current.activeGroup).toBe("g-b");

    act(() => result.current.setActiveGroup("g-c"));
    await settle();
    expect(result.current.activeGroup).toBe("g-c");
    bad.reject(new Error("PATCH /api/settings failed"));
    await settle();

    // Back to the acknowledged group — not "g-a", which the rail last showed
    // before the successful write.
    expect(result.current.activeGroup).toBe("g-b");
    expect(window.localStorage.getItem(ACTIVE_PROJECT_GROUP_STORAGE_KEY)).toBe("g-b");
  });

  it("lets a newer selection stand when an older PATCH fails last", async () => {
    const a = deferred<AppSettings>();
    const b = deferred<AppSettings>();
    updateSettings.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);

    const { result } = mount(null);
    act(() => result.current.setActiveGroup("g-a"));
    act(() => result.current.setActiveGroup("g-b"));

    b.resolve(settingsWith("g-b"));
    await settle();
    a.reject(new Error("PATCH /api/settings failed"));
    await settle();

    // A superseded failure rolls nothing back.
    expect(result.current.activeGroup).toBe("g-b");
  });

  // The interleaving the review found: the older write is the one the server
  // took, so the failure of the newer one must land there — not on the value
  // from before either click.
  it("rolls back to the group an older, superseded PATCH confirmed", async () => {
    const b = deferred<AppSettings>();
    const c = deferred<AppSettings>();
    updateSettings.mockReturnValueOnce(b.promise).mockReturnValueOnce(c.promise);

    // The server holds "g-a"; the operator clicks "g-b" then "g-c".
    const { result } = mount("g-a");
    act(() => result.current.setActiveGroup("g-b"));
    act(() => result.current.setActiveGroup("g-c"));
    await settle();
    expect(result.current.activeGroup).toBe("g-c");

    // "g-b" is superseded and paints nothing, but the server did take it.
    b.resolve(settingsWith("g-b"));
    await settle();
    expect(result.current.activeGroup).toBe("g-c");

    c.reject(new Error("PATCH /api/settings failed"));
    await settle();
    expect(result.current.activeGroup).toBe("g-b");
    expect(window.localStorage.getItem(ACTIVE_PROJECT_GROUP_STORAGE_KEY)).toBe("g-b");
  });

  // Same root cause, one step earlier: with no settings answer yet, the ledger
  // has to be seeded from the value the rail is running off.
  it("rolls a failed first click back to the cached group, not to All projects", async () => {
    window.localStorage.setItem(ACTIVE_PROJECT_GROUP_STORAGE_KEY, "g-a");
    const first = deferred<AppSettings>();
    updateSettings.mockReturnValueOnce(first.promise);

    // Settings are unhydrated, so there is no cached row for the optimistic
    // write to land in — localStorage is where the rollback is observable.
    const { result } = mount(undefined);
    expect(result.current.activeGroup).toBe("g-a");

    act(() => result.current.setActiveGroup("g-b"));
    await settle();
    expect(window.localStorage.getItem(ACTIVE_PROJECT_GROUP_STORAGE_KEY)).toBe("g-b");

    first.reject(new Error("PATCH /api/settings failed"));
    await settle();
    expect(window.localStorage.getItem(ACTIVE_PROJECT_GROUP_STORAGE_KEY)).toBe("g-a");
  });

  // The GET half of the race: a settings read already in flight would answer
  // with the pre-PATCH row and paint it over the optimistic write.
  it("cancels an in-flight settings read before writing", async () => {
    const only = deferred<AppSettings>();
    updateSettings.mockReturnValueOnce(only.promise);

    const { client, result } = mount("g-a");
    const cancelQueries = vi.spyOn(client, "cancelQueries");

    act(() => result.current.setActiveGroup("g-b"));
    await settle();

    expect(cancelQueries).toHaveBeenCalledWith({ queryKey: queryKeys.settings });
    expect(cancelQueries.mock.invocationCallOrder[0]).toBeLessThan(
      updateSettings.mock.invocationCallOrder[0]!,
    );
  });

  it("keeps a neighbouring setting a concurrent edit changed mid-flight", async () => {
    const only = deferred<AppSettings>();
    updateSettings.mockReturnValueOnce(only.promise);

    const { client, result } = mount("g-a");
    act(() => result.current.setActiveGroup("g-b"));
    await settle();

    // Something else writes the settings row while the PATCH is out.
    act(() => {
      client.setQueryData<AppSettings>(queryKeys.settings, (current) =>
        current ? { ...current, collapsedProjectGroups: ["pinned"] } : current,
      );
    });

    // The answer carries that key at its pre-edit value; merging keeps the edit.
    only.resolve({ activeProjectGroup: "g-b", collapsedProjectGroups: null } as AppSettings);
    await settle();
    expect(result.current.activeGroup).toBe("g-b");
    expect(client.getQueryData<AppSettings>(queryKeys.settings)?.collapsedProjectGroups).toEqual([
      "pinned",
    ]);
  });

  // The self-heal effect PATCHes "all" whenever the stored group is missing from
  // the group list. Restoring that group on failure re-arms it: one request per
  // round trip, for as long as the server keeps saying no.
  it("does not restore a deleted group when the self-heal PATCH fails", async () => {
    updateSettings.mockImplementation(() => Promise.reject(new Error("offline")));
    window.localStorage.setItem(ACTIVE_PROJECT_GROUP_STORAGE_KEY, "g-gone");

    // Settings hold a group this Panel's group list no longer has.
    const { client, result } = mount("g-gone");
    await settle();
    await settle();
    await settle();

    expect(result.current.activeGroup).toBe(ACTIVE_GROUP_ALL);
    // Exactly one PATCH: the self-heal ran once and stayed run.
    expect(updateSettings).toHaveBeenCalledTimes(1);
    // And the deleted id is not written back anywhere it could outlive the tab.
    expect(window.localStorage.getItem(ACTIVE_PROJECT_GROUP_STORAGE_KEY)).toBe(ACTIVE_GROUP_ALL);
    expect(client.getQueryData<AppSettings>(queryKeys.settings)?.activeProjectGroup).toBeNull();
  });

  // The rail is live and clickable during boot, painted from `placeholderData`
  // while the first settings GET is still out. Cancelling that read would leave
  // the query pending and idle with nothing scheduled to retry it, and nothing
  // in the Panel refetches this key — so the row must be allowed to land.
  it("lets the first settings GET finish, and the click still wins", async () => {
    const boot = deferred<AppSettings>();
    const patch = deferred<AppSettings>();
    getSettings.mockReturnValueOnce(boot.promise);
    updateSettings.mockReturnValueOnce(patch.promise);

    const { client, result } = mountLive();
    await settle();
    expect(client.getQueryState(queryKeys.settings)?.fetchStatus).toBe("fetching");

    act(() => result.current.setActiveGroup("g-b"));
    await settle();
    // The boot read was not cancelled, and it is the only one there will be.
    expect(client.getQueryState(queryKeys.settings)?.fetchStatus).toBe("fetching");
    expect(getSettings).toHaveBeenCalledTimes(1);

    // It answers with the pre-click row...
    boot.resolve(settingsWith("g-a"));
    await settle();
    expect(client.getQueryData<AppSettings>(queryKeys.settings)).toBeDefined();
    expect(client.getQueryState(queryKeys.settings)?.status).toBe("success");
    // ...and the click, which is newer than that read, stands on top of it.
    expect(result.current.activeGroup).toBe("g-b");

    patch.resolve(settingsWith("g-b"));
    await settle();
    expect(result.current.activeGroup).toBe("g-b");
    // The rail still responds: the cache is populated, so writes land.
    expect(client.getQueryData<AppSettings>(queryKeys.settings)?.activeProjectGroup).toBe("g-b");
  });

  it("still applies a lone answer, and stores 'all' as null", async () => {
    const only = deferred<AppSettings>();
    updateSettings.mockReturnValueOnce(only.promise);

    const { result } = mount("g-a");
    act(() => result.current.setActiveGroup(ACTIVE_GROUP_ALL));
    // The PATCH goes out behind `cancelQueries`, so it is not synchronous.
    await settle();
    expect(updateSettings).toHaveBeenCalledWith({ activeProjectGroup: null });

    only.resolve(settingsWith(null));
    await settle();
    expect(result.current.activeGroup).toBe(ACTIVE_GROUP_ALL);
  });
});
