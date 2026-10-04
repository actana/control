// @vitest-environment jsdom
//
// Coming back to a Core shows what is true now (issue 484, symptom W2).
//
// A Session that finished while the operator was on another page read
// `running` on return, and only a browser refresh corrected it. The Core was
// right the whole time — `actana session ls` said `finished` — so this is
// entirely about what the Panel's cache is willing to ask again for.
//
// Three suspects were named on the ticket. Two of them are tested here, in the
// shape that actually failed:
//
//   1. The client defaults in `src/router.tsx` — `staleTime: 30_000` (:198)
//      with `refetchOnWindowFocus: false` (:200). `refetchOnMount` defaults to
//      refetching only a STALE query, so a remount inside those 30 seconds is
//      served the cached, pre-finish list; and a refocus never asks at all.
//      This is the one that enforces the bug, and the first two tests are it.
//   3. The scope-cancel guard from #381, which cancels an in-flight Core
//      read when the last viewer leaves. It is NOT a cause — a cancel reverts
//      the query to its pre-fetch state, invalidation included, so the return
//      path still refetches — and the last test pins that down so the guard is
//      not blamed (or "fixed") again.
//
// Suspect 2, the replay-less SSE channel, is a different transport and has its
// own suite: `src/lib/__tests__/server-events-reconnect.test.tsx`.
//
// Every client here is built with `router.tsx`'s exact defaults; a test that
// relaxed them would prove nothing about the app.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { CoreLinkSessionRow } from "@actana/sdk/core";

const CORE_ID = "core-a";

const h = vi.hoisted(() => ({
  /** What the Core would answer right now. Mutated by the tests. */
  status: "running",
  listSessionRowsCalls: 0,
  /** One entry per held `listSessionRows`, oldest first, while `hold` is set. */
  inFlight: [] as { settle: () => void }[],
  hold: false,
}));

vi.mock("~/lib/panel-bridge", () => ({
  getPanelBridge: () => ({
    watchCore: () => () => {},
    onEvent: () => () => {},
    onConnectionChange: () => () => {},
    listSessionRows: async () => {
      h.listSessionRowsCalls += 1;
      if (h.hold) await new Promise<void>((resolve) => h.inFlight.push({ settle: resolve }));
      return { sessions: [snapshot(h.status)], archivedCount: 0 };
    },
  }),
}));

const { useSessions, sessionsCacheKey } = await import("~/queries");
const { __resetCoreScopesForTests } = await import("~/lib/visible-core-scope");

function snapshot(status: string): CoreLinkSessionRow {
  return {
    sessionId: "session-1",
    title: "session-1",
    titleManuallySet: false,
    claudeSessionId: null,
    agent: "claude-code",
    status,
    pinned: false,
    archived: false,
    icon: null,
    updatedAt: Date.now(),
  };
}

/** Exactly the client `getRouter()` builds — see `src/router.tsx`. */
function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        refetchOnWindowFocus: false,
      },
    },
  });
}

function wrapperFor(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

const renderBoard = (wrapper: ReturnType<typeof wrapperFor>) =>
  renderHook(() => useSessions(CORE_ID), { wrapper });

/** Let a mount-triggered refetch start, run and paint. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

describe("returning to a Core reads the Session's current status (issue 484)", () => {
  beforeEach(() => {
    __resetCoreScopesForTests();
    h.status = "running";
    h.listSessionRowsCalls = 0;
    h.inFlight = [];
    h.hold = false;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows the finish after a remount well inside the 30s stale window", async () => {
    const client = makeClient();
    const wrapper = wrapperFor(client);

    const board = renderBoard(wrapper);
    await waitFor(() => expect(board.result.current.data?.[0]?.status).toBe("running"));
    // The operator walks away. Nothing on screen is reading this Core now.
    board.unmount();

    // The Session finishes on the Core. No route is mounted to hear it, and
    // the Panel is not even watching this Core any more.
    h.status = "finished";

    // Back within seconds — the window in which the cached answer used to win.
    const again = renderBoard(wrapper);
    await settle();

    expect(again.result.current.data?.[0]?.status).toBe("finished");
    expect(h.listSessionRowsCalls).toBe(2);
  });

  it("re-reads when the tab is refocused, with the client default off", async () => {
    const client = makeClient();
    const board = renderBoard(wrapperFor(client));
    await waitFor(() => expect(board.result.current.data?.[0]?.status).toBe("running"));
    expect(h.listSessionRowsCalls).toBe(1);

    // Backgrounded, finished while hidden, refocused. The tab never unmounted,
    // so nothing above the query gets a chance to ask on its behalf.
    h.status = "finished";
    await act(async () => {
      window.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    await waitFor(() => expect(board.result.current.data?.[0]?.status).toBe("finished"));
    expect(h.listSessionRowsCalls).toBeGreaterThan(1);
  });

  it("still re-reads when the leave cancelled a read in flight (#381 is not the cause)", async () => {
    const client = makeClient();
    const wrapper = wrapperFor(client);
    const board = renderBoard(wrapper);
    await waitFor(() => expect(board.result.current.data?.[0]?.status).toBe("running"));

    // A Core event lands, its refetch is still in flight, and the operator
    // leaves — which is precisely when the scope guard cancels.
    h.hold = true;
    await act(async () => {
      void client.invalidateQueries({ queryKey: sessionsCacheKey(CORE_ID) });
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    await waitFor(() => expect(h.inFlight.length).toBe(1));
    board.unmount();
    // The cancelled read's promise still resolves; the panel link has nothing
    // to abort. React-query drops the answer.
    await act(async () => {
      for (const held of h.inFlight) held.settle();
      h.inFlight = [];
      h.hold = false;
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    h.status = "finished";
    const again = renderBoard(wrapper);
    await settle();

    expect(again.result.current.data?.[0]?.status).toBe("finished");
  });
});
