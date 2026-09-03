// @vitest-environment jsdom
//
// An uncached pin answers slower than the operator clicks (issue 381).
//
// What is proven here is the shape of A then B then A: B's project and task
// reads are still in flight when the URL is back on A, and when they finally
// answer they must not paint B's sessions on A's board. Then the shape one
// click further — A then B then A then B — where the read that was abandoned
// on the way out lands *after* the read that replaced it, while B is on screen
// again and a "is B visible?" check would wave it through.
//
// And the other half of all of it: a cold pin the operator stays on still
// loads, because the guard is about which visit a read belongs to, not about
// how fresh the rows are.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode, type ReactNode } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  CoreLinkProjectSnapshot,
  CoreLinkTaskSnapshot,
} from "@actana/sdk/core-link-frames";

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
 * the same project answering out of order, so the second `listTasks` for B has
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
    listProjects: (coreId: string) => nextCall(`projects:${coreId}`).promise,
    listTasks: (_coreId: string, projectId: string) => nextCall(`tasks:${projectId}`).promise,
  }),
}));
vi.mock("~/lib/api", () => ({
  api: {
    listProjectPresentation: () => Promise.resolve({ presentation: [] }),
    pruneProjectPresentation: () => Promise.resolve({}),
  },
}));

const { queryKeys, tasksCacheKey, useProject, useTasks } = await import("~/queries");
const { __resetProjectScopesForTests } = await import("~/lib/visible-project-scope");

const CORE_A = "core_a";
const CORE_B = "core_b";

function projectSnapshot(projectId: string, name: string): CoreLinkProjectSnapshot {
  return {
    projectId,
    name,
    path: `/srv/${projectId}`,
    icon: "PA",
    iconColor: "#334455",
    pinned: true,
    rememberHarnessSettings: false,
    savedHarness: null,
    savedSkipPermissions: false,
    savedBareSession: false,
    defaultGridView: false,
    updatedAt: 1,
  };
}

function taskSnapshot(projectId: string, taskId: string, title: string): CoreLinkTaskSnapshot {
  return {
    taskId,
    projectId,
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

type TaskAnswer = { tasks: CoreLinkTaskSnapshot[]; archivedCount: number };

/** The project board, cut down to what this bug is about: which project's name
 *  is in the header and whose sessions are listed under it. */
function Board({ id, coreId }: { id: string; coreId: string }) {
  const project = useProject(id, { coreId });
  const tasks = useTasks(id, { coreId });
  if (!project.data) return <div data-testid="shell">Loading…</div>;
  return (
    <div data-testid="board">
      <span data-testid="project">{project.data.name}</span>
      <span data-testid="sessions">{(tasks.data ?? []).map((t) => t.title).join(",")}</span>
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

describe("a pin that materializes after you have clicked away", () => {
  let client: QueryClient;

  function mount(props: { id: string; coreId: string }, strict = false) {
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
    __resetProjectScopesForTests();
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
    client.setQueryData([...queryKeys.project("p-a"), "core", CORE_A], {
      id: "p-a",
      name: "Alpha",
    });
    client.setQueryData(tasksCacheKey("p-a", CORE_A), [
      taskSnapshot("p-a", "t-a1", "alpha session"),
    ]);

    const view = mount({ id: "p-a", coreId: CORE_A });
    await settle();
    expect(screen.getByTestId("project").textContent).toBe("Alpha");

    // Click B. It is uncached, so the board is the loading shell and both of
    // B's reads are genuinely in flight.
    view.rerender(<Board id="p-b" coreId={CORE_B} />);
    await settle();
    expect(screen.getByTestId("shell")).toBeTruthy();

    // Click back to A before B has answered.
    view.rerender(<Board id="p-a" coreId={CORE_A} />);
    await settle();
    expect(screen.getByTestId("project").textContent).toBe("Alpha");

    // Now B answers.
    call<CoreLinkProjectSnapshot[]>(`projects:${CORE_B}`).resolve([projectSnapshot("p-b", "Bravo")]);
    call<TaskAnswer>("tasks:p-b").resolve({
      tasks: [taskSnapshot("p-b", "t-b1", "bravo session")],
      archivedCount: 4,
    });
    await settle();

    // The A URL still shows A, and nothing of B's is on it. These three read
    // the screen and are the operator's own sentence — but they are NOT the
    // discriminating assertions: react-query would not paint a bucket this
    // board does not subscribe to, so they pass even with the guard reverted.
    // The cache assertions below are the ones that fail without it.
    expect(screen.getByTestId("project").textContent).toBe("Alpha");
    expect(screen.getByTestId("sessions").textContent).toBe("alpha session");
    expect(screen.queryByText("Bravo")).toBeNull();

    // B's late answer did not materialize behind the screen either: the reads
    // were cancelled and reverted, so nothing is parked waiting to be painted
    // the moment some other surface subscribes to B.
    expect(client.getQueryData([...queryKeys.project("p-b"), "core", CORE_B])).toBeUndefined();
    expect(client.getQueryData(tasksCacheKey("p-b", CORE_B))).toBeUndefined();
    // The archived count rides the task answer; it must not outlive the list
    // it rode in on.
    expect(client.getQueryData(queryKeys.coreArchivedTaskCount("p-b", CORE_B))).toBeUndefined();
  });

  it("does not let B's abandoned read overwrite the count of the read that replaced it", async () => {
    // A then B then A then B, with B's two reads answering out of order. Read
    // one is cancelled on the way out but its promise still resolves — the
    // panel link has nothing to abort — so its fetcher runs to the end and
    // reaches the line that parks the archived count, at a moment when B is on
    // screen again and looks perfectly current.
    client.setQueryData([...queryKeys.project("p-a"), "core", CORE_A], {
      id: "p-a",
      name: "Alpha",
    });
    client.setQueryData(tasksCacheKey("p-a", CORE_A), []);

    const view = mount({ id: "p-a", coreId: CORE_A });
    await settle();

    // Click B: read one starts.
    view.rerender(<Board id="p-b" coreId={CORE_B} />);
    await settle();
    expect(callCount("tasks:p-b")).toBe(1);

    // Click A: read one is cancelled and reverted, and still unanswered.
    view.rerender(<Board id="p-a" coreId={CORE_A} />);
    await settle();

    // Click B again: read two starts, a second call of its own.
    view.rerender(<Board id="p-b" coreId={CORE_B} />);
    await settle();
    expect(callCount("tasks:p-b")).toBe(2);

    // Read two lands first, with the truth: one session, seven archived.
    call<CoreLinkProjectSnapshot[]>(`projects:${CORE_B}`, 1).resolve([
      projectSnapshot("p-b", "Bravo"),
    ]);
    call<TaskAnswer>("tasks:p-b", 1).resolve({
      tasks: [taskSnapshot("p-b", "t-b2", "bravo session")],
      archivedCount: 7,
    });
    await settle();
    expect(screen.getByTestId("sessions").textContent).toBe("bravo session");
    expect(client.getQueryData(queryKeys.coreArchivedTaskCount("p-b", CORE_B))).toBe(7);

    // Now the abandoned read one answers, with a stale count nobody wants.
    call<CoreLinkProjectSnapshot[]>(`projects:${CORE_B}`, 0).resolve([
      projectSnapshot("p-b", "Stale Bravo"),
    ]);
    call<TaskAnswer>("tasks:p-b", 0).resolve({
      tasks: [taskSnapshot("p-b", "t-b1", "stale session")],
      archivedCount: 99,
    });
    await settle();

    // The list is read two's, and so is the count that labels the Archived tab
    // — nothing else ever fetches that bucket, so a 99 written here would
    // stand until an unrelated event happened to refresh B.
    expect(screen.getByTestId("project").textContent).toBe("Bravo");
    expect(screen.getByTestId("sessions").textContent).toBe("bravo session");
    expect(client.getQueryData(queryKeys.coreArchivedTaskCount("p-b", CORE_B))).toBe(7);
  });

  it("still loads a cold pin the operator stays on", async () => {
    const view = mount({ id: "p-b", coreId: CORE_B });
    await settle();
    // Nothing cached: the shell, exactly as before this fix.
    expect(screen.getByTestId("shell")).toBeTruthy();

    call<CoreLinkProjectSnapshot[]>(`projects:${CORE_B}`).resolve([projectSnapshot("p-b", "Bravo")]);
    call<TaskAnswer>("tasks:p-b").resolve({
      tasks: [taskSnapshot("p-b", "t-b1", "bravo session")],
      archivedCount: 4,
    });
    await settle();

    expect(screen.getByTestId("project").textContent).toBe("Bravo");
    expect(screen.getByTestId("sessions").textContent).toBe("bravo session");
    expect(client.getQueryData(queryKeys.coreArchivedTaskCount("p-b", CORE_B))).toBe(4);
    view.unmount();
  });

  it("still loads a cold pin through a StrictMode double-mount", async () => {
    // StrictMode tears an effect down and sets it up again, which is a visit
    // ending and another beginning. The read that spanned it is stale by
    // construction — what must not happen is the pin failing to load: the
    // re-subscribe re-reads, and that answer is the one that counts.
    const view = mount({ id: "p-b", coreId: CORE_B }, true);
    await settle();

    for (let nth = 0; nth < callCount(`projects:${CORE_B}`); nth += 1) {
      call<CoreLinkProjectSnapshot[]>(`projects:${CORE_B}`, nth).resolve([
        projectSnapshot("p-b", "Bravo"),
      ]);
    }
    for (let nth = 0; nth < callCount("tasks:p-b"); nth += 1) {
      call<TaskAnswer>("tasks:p-b", nth).resolve({
        tasks: [taskSnapshot("p-b", "t-b1", "bravo session")],
        archivedCount: 4,
      });
    }
    await settle();

    expect(screen.getByTestId("project").textContent).toBe("Bravo");
    expect(screen.getByTestId("sessions").textContent).toBe("bravo session");
    expect(client.getQueryData(queryKeys.coreArchivedTaskCount("p-b", CORE_B))).toBe(4);
    view.unmount();
  });

  it("keeps a settled project's rows when the operator leaves it", async () => {
    const view = mount({ id: "p-b", coreId: CORE_B });
    await settle();
    call<CoreLinkProjectSnapshot[]>(`projects:${CORE_B}`).resolve([projectSnapshot("p-b", "Bravo")]);
    call<TaskAnswer>("tasks:p-b").resolve({
      tasks: [taskSnapshot("p-b", "t-b1", "bravo session")],
      archivedCount: 4,
    });
    await settle();
    expect(screen.getByTestId("project").textContent).toBe("Bravo");

    // Leaving cancels what is in flight, never what has already landed — the
    // 30s staleTime still means coming back to B is instant.
    view.unmount();
    await settle();
    expect(client.getQueryData(tasksCacheKey("p-b", CORE_B))).toHaveLength(1);
  });
});
