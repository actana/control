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

vi.mock("~/lib/api", () => ({
  api: {
    updateSettings: (body: unknown) => updateSettings(body),
    getSettings: () => Promise.reject(new Error("settings must be primed in these tests")),
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

function mount(initial: string | null) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity, refetchOnMount: false, refetchOnWindowFocus: false },
    },
  });
  client.setQueryData(queryKeys.settings, settingsWith(initial));
  client.setQueryData(queryKeys.groups, GROUPS);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(() => useActiveGroup(), { wrapper });
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
  window.localStorage.clear();
  __resetActiveGroupWritesForTests();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the active-group write ledger", () => {
  it("only calls the newest write current", () => {
    const ledger = createActiveGroupWriteLedger(ACTIVE_GROUP_ALL);
    const first = ledger.beginWrite();
    const second = ledger.beginWrite();
    expect(ledger.settleWrite(first)).toBe(false);
    expect(ledger.settleWrite(second)).toBe(true);
  });

  it("keeps the acknowledged group until a newer answer confirms one", () => {
    const ledger = createActiveGroupWriteLedger("g-a");
    expect(ledger.lastAcknowledged()).toBe("g-a");
    ledger.acknowledge("g-b");
    expect(ledger.lastAcknowledged()).toBe("g-b");
  });

  it("ignores a settings read taken while a local write is in flight", () => {
    const ledger = createActiveGroupWriteLedger("g-a");
    const generation = ledger.beginWrite();
    // The optimistic value is this tab's own, not the server's word.
    ledger.observe("g-b");
    expect(ledger.lastAcknowledged()).toBe("g-a");
    ledger.settleWrite(generation);
    ledger.observe("g-b");
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

  it("still applies a lone answer, and stores 'all' as null", async () => {
    const only = deferred<AppSettings>();
    updateSettings.mockReturnValueOnce(only.promise);

    const { result } = mount("g-a");
    act(() => result.current.setActiveGroup(ACTIVE_GROUP_ALL));
    expect(updateSettings).toHaveBeenCalledWith({ activeProjectGroup: null });

    only.resolve(settingsWith(null));
    await settle();
    expect(result.current.activeGroup).toBe(ACTIVE_GROUP_ALL);
  });
});
