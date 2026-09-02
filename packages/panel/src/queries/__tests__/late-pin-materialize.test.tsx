// @vitest-environment jsdom
//
// An uncached pin answers slower than the operator clicks (issue 381).
//
// What is proven here is the shape of A then B then A: B's project and task
// reads are still in flight when the URL is back on A, and when they finally
// answer they must not paint B's sessions on A's board. And the other half of
// it — a cold pin the operator stays on still loads, because the guard is
// about who is on screen, not about how fresh the rows are.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
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

/** One gate per core-link read, opened by the test when it wants the answer. */
const gates = new Map<string, ReturnType<typeof deferred<unknown>>>();
function gate<T>(key: string): ReturnType<typeof deferred<T>> {
  let existing = gates.get(key);
  if (!existing) {
    existing = deferred<unknown>();
    gates.set(key, existing);
  }
  return existing as ReturnType<typeof deferred<T>>;
}

vi.mock("~/lib/panel-bridge", () => ({
  getPanelBridge: () => ({
    listProjects: (coreId: string) => gate<CoreLinkProjectSnapshot[]>(`projects:${coreId}`).promise,
    listTasks: (_coreId: string, projectId: string) =>
      gate<{ tasks: CoreLinkTaskSnapshot[]; archivedCount: number }>(`tasks:${projectId}`).promise,
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

  function mount(props: { id: string; coreId: string }) {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    // The real client's 30s staleTime, kept exactly as it is in router.tsx:
    // this fix must not buy its way out of the race by refetching more.
    return render(<Board {...props} />, { wrapper });
  }

  beforeEach(() => {
    gates.clear();
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
    gate<CoreLinkProjectSnapshot[]>(`projects:${CORE_B}`).resolve([
      projectSnapshot("p-b", "Bravo"),
    ]);
    gate<{ tasks: CoreLinkTaskSnapshot[]; archivedCount: number }>(`tasks:p-b`).resolve({
      tasks: [taskSnapshot("p-b", "t-b1", "bravo session")],
      archivedCount: 4,
    });
    await settle();

    // The A URL still shows A, and nothing of B's is on it.
    expect(screen.getByTestId("project").textContent).toBe("Alpha");
    expect(screen.getByTestId("sessions").textContent).toBe("alpha session");
    expect(screen.queryByText("Bravo")).toBeNull();

    // And B's late answer did not materialize behind the screen either: the
    // reads were cancelled and reverted, so nothing is parked waiting to be
    // painted the moment some other surface subscribes to B.
    expect(client.getQueryData([...queryKeys.project("p-b"), "core", CORE_B])).toBeUndefined();
    expect(client.getQueryData(tasksCacheKey("p-b", CORE_B))).toBeUndefined();
    // The archived count rides the task answer; it must not outlive the list
    // it rode in on.
    expect(client.getQueryData(queryKeys.coreArchivedTaskCount("p-b", CORE_B))).toBeUndefined();
  });

  it("still loads a cold pin the operator stays on", async () => {
    const view = mount({ id: "p-b", coreId: CORE_B });
    await settle();
    // Nothing cached: the shell, exactly as before this fix.
    expect(screen.getByTestId("shell")).toBeTruthy();

    gate<CoreLinkProjectSnapshot[]>(`projects:${CORE_B}`).resolve([
      projectSnapshot("p-b", "Bravo"),
    ]);
    gate<{ tasks: CoreLinkTaskSnapshot[]; archivedCount: number }>(`tasks:p-b`).resolve({
      tasks: [taskSnapshot("p-b", "t-b1", "bravo session")],
      archivedCount: 4,
    });
    await settle();

    expect(screen.getByTestId("project").textContent).toBe("Bravo");
    expect(screen.getByTestId("sessions").textContent).toBe("bravo session");
    expect(client.getQueryData(queryKeys.coreArchivedTaskCount("p-b", CORE_B))).toBe(4);
    view.unmount();
  });

  it("keeps a settled project's rows when the operator leaves it", async () => {
    const view = mount({ id: "p-b", coreId: CORE_B });
    await settle();
    gate<CoreLinkProjectSnapshot[]>(`projects:${CORE_B}`).resolve([
      projectSnapshot("p-b", "Bravo"),
    ]);
    gate<{ tasks: CoreLinkTaskSnapshot[]; archivedCount: number }>(`tasks:p-b`).resolve({
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
