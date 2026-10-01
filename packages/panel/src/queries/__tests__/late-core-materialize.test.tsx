// @vitest-environment jsdom
//
// An uncached Core answers slower than the operator clicks (issue 381).
//
// What is proven here is the shape of A then B then A: B's session read is
// still in flight when the URL is back on A, and when it finally answers it must
// not paint B's sessions on A's board. Then the shape one click further — A then
// B then A then B — where the read that was abandoned on the way out lands
// *after* the read that replaced it, while B is on screen again and a "is B
// visible?" check would wave it through.
//
// And the other half of all of it: a cold Core the operator stays on still
// loads, because the guard is about which visit a read belongs to, not about
// how fresh the rows are.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode, type ReactNode } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CoreLinkSessionRow } from "@actana/sdk/core";

/** A promise the test settles by hand, so an answer can land after the click. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/**
 * One gate per core-link *call*, not per key: this suite turns on two reads of
 * the same Core answering out of order, so the second `listSessionRows` for B has
 * to be a promise of its own that the test can settle first.
 */
const calls = new Map<string, ReturnType<typeof deferred<unknown>>[]>();
function nextCall(key: string): ReturnType<typeof deferred<unknown>> {
  const queue = calls.get(key) ?? [];
  const gate = deferred<unknown>();
  queue.push(gate);
  calls.set(key, queue);
  return gate;
}
/** The nth call of `key`, whether or not it has been made yet. */
function call<T>(key: string, nth = 0): ReturnType<typeof deferred<T>> {
  let queue = calls.get(key);
  if (!queue) {
    queue = [];
    calls.set(key, queue);
  }
  while (queue.length <= nth) queue.push(deferred<unknown>());
  return queue[nth] as ReturnType<typeof deferred<T>>;
}
/** How many times the Panel has asked for `key` so far. */
function callCount(key: string): number {
  return calls.get(key)?.length ?? 0;
}

vi.mock("~/lib/panel-bridge", () => ({
  getPanelBridge: () => ({
    listSessionRows: (coreId: string) => nextCall(`sessions:${coreId}`).promise,
  }),
}));

const { queryKeys, sessionsCacheKey, useSessions } = await import("~/queries");
const { __resetCoreScopesForTests } = await import("~/lib/visible-core-scope");

const CORE_A = "core_a";
const CORE_B = "core_b";

function sessionSnapshot(sessionId: string, title: string): CoreLinkSessionRow {
  return {
    sessionId,
    title,
    titleManuallySet: false,
    claudeSessionId: null,
    agent: "claude-code",
    status: "running",
    pinned: false,
    archived: false,
    icon: null,
    updatedAt: 1,
  };
}

type SessionAnswer = { sessions: CoreLinkSessionRow[]; archivedCount: number };

/** The Core's board, cut down to what this bug is about: whose sessions are
 *  listed on it. */
function Board({ coreId }: { coreId: string }) {
  const sessions = useSessions(coreId);
  if (!sessions.data) return <div data-testid="shell">Loading…</div>;
  return (
    <div data-testid="board">
      <span data-testid="sessions">{sessions.data.map((t) => t.title).join(",")}</span>
    </div>
  );
}

/** Let the settled core-link answers run and react-query notify its observers.
 *  Macrotasks, not microtasks: an answer travels a `Promise.all`, a mapper and
 *  a batched observer notification before it reaches the DOM, so give the whole
 *  chain room to finish rather than a single turn of it. */
async function settle() {
  await act(async () => {
    for (let turn = 0; turn < 8; turn += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
}

describe("a Core that materializes after you have clicked away", () => {
  let client: QueryClient;

  function mount(props: { coreId: string }, strict = false) {
    const wrapper = ({ children }: { children: ReactNode }) =>
      strict ? (
        <StrictMode>
          <QueryClientProvider client={client}>{children}</QueryClientProvider>
        </StrictMode>
      ) : (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      );
    // The real client's 30s staleTime, kept exactly as it is in router.tsx:
    // this fix must not buy its way out of the race by refetching more.
    return render(<Board {...props} />, { wrapper });
  }

  beforeEach(() => {
    calls.clear();
    __resetCoreScopesForTests();
    client = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: 30_000, gcTime: 5 * 60_000 },
      },
    });
  });

  afterEach(() => {
    cleanup();
    client.clear();
  });

  it("never leaves B's sessions painted on A's URL after A then B then A", async () => {
    // A is warm — the operator was just on it, well inside the 30s staleTime.
    client.setQueryData(sessionsCacheKey(CORE_A), [sessionSnapshot("t-a1", "alpha session")]);

    const view = mount({ coreId: CORE_A });
    await settle();
    expect(screen.getByTestId("sessions").textContent).toBe("alpha session");

    // Click B. It is uncached, so the board is the loading shell and B's read
    // is genuinely in flight.
    view.rerender(<Board coreId={CORE_B} />);
    await settle();
    expect(screen.getByTestId("shell")).toBeTruthy();

    // Click back to A before B has answered.
    view.rerender(<Board coreId={CORE_A} />);
    await settle();
    expect(screen.getByTestId("sessions").textContent).toBe("alpha session");

    // Now B answers.
    call<SessionAnswer>(`sessions:${CORE_B}`).resolve({
      sessions: [sessionSnapshot("t-b1", "bravo session")],
      archivedCount: 4,
    });
    await settle();

    // The A URL still shows A, and nothing of B's is on it. This reads the
    // screen and is the operator's own sentence — but it is NOT the
    // discriminating assertion: react-query would not paint a bucket this board
    // does not subscribe to, so it passes even with the guard reverted. The cache
    // assertions below are the ones that fail without it.
    expect(screen.getByTestId("sessions").textContent).toBe("alpha session");

    // B's late answer did not materialize behind the screen either: the read
    // was cancelled and reverted, so nothing is parked waiting to be painted
    // the moment some other surface subscribes to B.
    expect(client.getQueryData(sessionsCacheKey(CORE_B))).toBeUndefined();
    // The archived count rides the session answer; it must not outlive the list
    // it rode in on.
    expect(client.getQueryData(queryKeys.coreArchivedSessionCount(CORE_B))).toBeUndefined();
  });

  it("does not let B's abandoned read overwrite the count of the read that replaced it", async () => {
    // A then B then A then B, with B's two reads answering out of order. Read
    // one is cancelled on the way out but its promise still resolves — the
    // panel link has nothing to abort — so its fetcher runs to the end and
    // reaches the line that parks the archived count, at a moment when B is on
    // screen again and looks perfectly current.
    client.setQueryData(sessionsCacheKey(CORE_A), []);

    const view = mount({ coreId: CORE_A });
    await settle();

    // Click B: read one starts.
    view.rerender(<Board coreId={CORE_B} />);
    await settle();
    expect(callCount(`sessions:${CORE_B}`)).toBe(1);

    // Click A: read one is cancelled and reverted, and still unanswered.
    view.rerender(<Board coreId={CORE_A} />);
    await settle();

    // Click B again: read two starts, a second call of its own.
    view.rerender(<Board coreId={CORE_B} />);
    await settle();
    expect(callCount(`sessions:${CORE_B}`)).toBe(2);

    // Read two lands first, with the truth: one session, seven archived.
    call<SessionAnswer>(`sessions:${CORE_B}`, 1).resolve({
      sessions: [sessionSnapshot("t-b2", "bravo session")],
      archivedCount: 7,
    });
    await settle();
    expect(screen.getByTestId("sessions").textContent).toBe("bravo session");
    expect(client.getQueryData(queryKeys.coreArchivedSessionCount(CORE_B))).toBe(7);

    // Now the abandoned read one answers, with a stale count nobody wants.
    call<SessionAnswer>(`sessions:${CORE_B}`, 0).resolve({
      sessions: [sessionSnapshot("t-b1", "stale session")],
      archivedCount: 99,
    });
    await settle();

    // The list is read two's, and so is the count that labels the Archived tab
    // — nothing else ever fetches that bucket, so a 99 written here would
    // stand until an unrelated event happened to refresh B.
    expect(screen.getByTestId("sessions").textContent).toBe("bravo session");
    expect(client.getQueryData(queryKeys.coreArchivedSessionCount(CORE_B))).toBe(7);
  });

  it("still loads a cold Core the operator stays on", async () => {
    const view = mount({ coreId: CORE_B });
    await settle();
    // Nothing cached: the shell, exactly as before this fix.
    expect(screen.getByTestId("shell")).toBeTruthy();

    call<SessionAnswer>(`sessions:${CORE_B}`).resolve({
      sessions: [sessionSnapshot("t-b1", "bravo session")],
      archivedCount: 4,
    });
    await settle();

    expect(screen.getByTestId("sessions").textContent).toBe("bravo session");
    expect(client.getQueryData(queryKeys.coreArchivedSessionCount(CORE_B))).toBe(4);
    view.unmount();
  });

  it("still loads a cold Core through a StrictMode double-mount", async () => {
    // StrictMode tears an effect down and sets it up again, which is a visit
    // ending and another beginning. The read that spanned it is stale by
    // construction — what must not happen is the Core failing to load: the
    // re-subscribe re-reads, and that answer is the one that counts.
    const view = mount({ coreId: CORE_B }, true);
    await settle();

    for (let nth = 0; nth < callCount(`sessions:${CORE_B}`); nth += 1) {
      call<SessionAnswer>(`sessions:${CORE_B}`, nth).resolve({
        sessions: [sessionSnapshot("t-b1", "bravo session")],
        archivedCount: 4,
      });
    }
    await settle();

    expect(screen.getByTestId("sessions").textContent).toBe("bravo session");
    expect(client.getQueryData(queryKeys.coreArchivedSessionCount(CORE_B))).toBe(4);
    view.unmount();
  });

  it("keeps a settled Core's rows when the operator leaves it", async () => {
    const view = mount({ coreId: CORE_B });
    await settle();
    call<SessionAnswer>(`sessions:${CORE_B}`).resolve({
      sessions: [sessionSnapshot("t-b1", "bravo session")],
      archivedCount: 4,
    });
    await settle();
    expect(screen.getByTestId("sessions").textContent).toBe("bravo session");

    // Leaving cancels what is in flight, never what has already landed — the
    // 30s staleTime still means coming back to B is instant.
    view.unmount();
    await settle();
    expect(client.getQueryData(sessionsCacheKey(CORE_B))).toHaveLength(1);
  });
});
