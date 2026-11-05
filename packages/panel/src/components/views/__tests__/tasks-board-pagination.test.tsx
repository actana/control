// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { KeybindingsProvider } from "~/lib/keybindings/store";
import type { CoreWithDial } from "~/shared/cores";
import type { TaskDto } from "~/shared/task-wire";
import type { PageQuery } from "./task-board-fake";

// The Tasks board loads 10 Tasks per column and a Load more button brings the
// next 10 (#896). Counts come from the counts endpoint, not from what is loaded.
// The network edge (api) is faked from the Tasks a test holds.

function core(id: string, label: string): CoreWithDial {
  return { id, endpoint: "wss://x", label, lastEventId: 0, createdAt: 0, updatedAt: 0, dial: { coreId: id, state: "connected", lastSeenAt: 1 } };
}
const cores = [core("c1", "workstation-berlin"), core("c2", "build-box-01")];
vi.mock("~/lib/fleet-context", () => ({
  useFleet: () => ({ cores, fleet: { rows: [], offlineCores: [], singleCore: false }, loading: false, error: null, refresh: vi.fn() }),
}));
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const task = (id: string, title: string, status: TaskDto["status"], coreId: string | null, updatedAt: number): TaskDto => ({
  id, title, description: "", status, coreId, agent: coreId ? `ag-${coreId}` : null, attemptCount: 0, dispatchedAt: null, lastError: null, timeoutMinutes: 60, createdAt: 1, updatedAt,
});

let tasks: TaskDto[] = [];
const api = vi.hoisted(() => ({
  getKeybindings: vi.fn(async () => ({ bindings: {} })),
  listTasksPage: vi.fn(async (q: PageQuery) => (await import("./task-board-fake")).fakeTasksPage(tasks, q)),
  getTaskCounts: vi.fn(async () => (await import("./task-board-fake")).fakeTaskCounts(tasks)),
  getTask: vi.fn(async (id: string) => ({ task: tasks.find((t) => t.id === id)!, comments: [] })),
  listCoreAgents: vi.fn(async () => ({ agents: [] })),
  createTask: vi.fn(async () => ({})),
  commentOnTask: vi.fn(async () => ({})),
  setTaskStatus: vi.fn(async (id: string, status: TaskDto["status"]) => {
    tasks = tasks.map((t) => (t.id === id ? { ...t, status } : t));
    return {};
  }),
}));
vi.mock("~/lib/api", () => ({ api, ApiError: class extends Error {} }));

const { TasksBoard } = await import("../TasksBoard");

function mount(coreId?: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <KeybindingsProvider>
        <TasksBoard coreId={coreId ?? null} />
      </KeybindingsProvider>
    </QueryClientProvider>,
  );
}

type Col = "draft" | "assigned" | "in_progress" | "finished";
const ORDER: Col[] = ["draft", "assigned", "in_progress", "finished"];
const column = (id: Col) => document.querySelector(`[data-board-column="${id}"]`) as HTMLElement;
const card = (id: string) => document.querySelector(`[data-task-card="${id}"]`) as HTMLElement;
const columnOfCard = (id: string) => card(id)?.closest("[data-board-column]")?.getAttribute("data-board-column");
const cardsIn = (id: Col) => column(id).querySelectorAll("[data-task-card]").length;
const headerCount = (id: Col) => column(id).querySelector("header")!.textContent;
const pageCalls = () => api.listTasksPage.mock.calls.map(([q]) => q as PageQuery);

// 12 finished (f01 newest ... f12 oldest, mixed done/failed/partial), 3 drafts, 1 assigned.
beforeEach(() => {
  const statuses: TaskDto["status"][] = ["done", "failed", "partial"];
  tasks = [
    ...Array.from({ length: 12 }, (_, i) => task(`f${String(i + 1).padStart(2, "0")}`, `Finished ${i + 1}`, statuses[i % 3]!, i % 2 ? "c2" : "c1", 100 - i)),
    task("d1", "Draft 1", "draft", "c1", 50),
    task("d2", "Draft 2", "draft", "c2", 49),
    task("d3", "Draft 3", "draft", null, 48),
    task("a1", "Assigned 1", "assigned", "c1", 40),
  ];
  for (const fn of Object.values(api)) fn.mockClear();
  toast.error.mockClear();
  document.elementFromPoint = ((x: number) => (x < 400 ? column(ORDER[Math.floor(x / 100)]!) : document.body)) as typeof document.elementFromPoint;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Tasks board pages", () => {
  it("asks for 10 Tasks per column, one request per column, and shows 10 of 12 finished", async () => {
    mount();
    await screen.findByText("Finished 1");
    expect(cardsIn("finished")).toBe(10);
    expect(card("f11")).toBeNull();
    expect(pageCalls().map((q) => q.column).sort()).toEqual(["assigned", "draft", "finished", "in_progress"]);
    for (const q of pageCalls()) expect(q).toMatchObject({ limit: 10 });
    for (const q of pageCalls()) expect(q.cursor ?? null).toBeNull();
  });

  it("offers Load more only on a column that has another page", async () => {
    mount();
    await screen.findByText("Finished 1");
    expect(within(column("finished")).getByRole("button", { name: "Load more" })).toBeTruthy();
    expect(within(column("draft")).queryByRole("button", { name: "Load more" })).toBeNull();
    expect(within(column("assigned")).queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("appends the next page when Load more is pressed, then drops the button", async () => {
    mount();
    await screen.findByText("Finished 1");
    fireEvent.click(within(column("finished")).getByRole("button", { name: "Load more" }));
    await screen.findByText("Finished 12");
    expect(cardsIn("finished")).toBe(12);
    expect(card("f01")).not.toBeNull();
    expect(within(column("finished")).queryByRole("button", { name: "Load more" })).toBeNull();
    const next = pageCalls().filter((q) => q.cursor);
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ column: "finished", limit: 10, cursor: "10" });
  });

  it("takes the column and chip counts from the counts endpoint, not from what is loaded", async () => {
    mount();
    await screen.findByText("Finished 1");
    await waitFor(() => expect(headerCount("finished")).toContain("12"));
    expect(cardsIn("finished")).toBe(10);
    expect(headerCount("draft")).toContain("3");
    const chips = screen.getByRole("group", { name: "Filter by Core" });
    expect(within(chips).getByRole("button", { name: /All Cores/ }).textContent).toContain("16");
    // c1: f01 f03 f05 f07 f09 f11, d1, a1
    expect(within(chips).getByRole("button", { name: /workstation-berlin/ }).textContent).toContain("8");
    expect(api.getTaskCounts).toHaveBeenCalled();
  });

  it("pages one Core's board with that Core's id and counts that Core's Tasks", async () => {
    mount("c1");
    await screen.findByText("Finished 1");
    expect(pageCalls().every((q) => q.coreId === "c1")).toBe(true);
    await waitFor(() => expect(headerCount("finished")).toContain("6"));
    expect(headerCount("draft")).toContain("1");
  });

  it("filters by a Core chip with a fresh first page for that Core", async () => {
    mount();
    await screen.findByText("Finished 1");
    api.listTasksPage.mockClear();
    fireEvent.click(within(screen.getByRole("group", { name: "Filter by Core" })).getByRole("button", { name: /build-box-01/ }));
    await waitFor(() => expect(cardsIn("finished")).toBe(6));
    expect(pageCalls().filter((q) => q.coreId === "c2")).toHaveLength(4);
    expect(card("f01")).toBeNull();
  });

  it("only polls the first page: a poll does not re-request the pages Load more brought in", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    mount();
    await screen.findByText("Finished 1");
    fireEvent.click(within(column("finished")).getByRole("button", { name: "Load more" }));
    await screen.findByText("Finished 12");
    const cursorCallsBefore = pageCalls().filter((q) => q.cursor).length;
    const firstPageCallsBefore = pageCalls().filter((q) => !q.cursor).length;
    await vi.advanceTimersByTimeAsync(5_100);
    expect(pageCalls().filter((q) => !q.cursor).length).toBeGreaterThan(firstPageCallsBefore);
    expect(pageCalls().filter((q) => q.cursor).length).toBe(cursorCallsBefore);
    expect(cardsIn("finished")).toBe(12);
  });
});

describe("a Task leaving a column it was paged into", () => {
  it("is not left on screen in two columns when it moves out of page 2", async () => {
    tasks = Array.from({ length: 12 }, (_, i) => task(`s${String(i + 1).padStart(2, "0")}`, `Slot ${i + 1}`, "assigned", "c1", 100 - i));
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    mount();
    await screen.findByText("Slot 1");
    fireEvent.click(within(column("assigned")).getByRole("button", { name: "Load more" }));
    await screen.findByText("Slot 12");
    expect(cardsIn("assigned")).toBe(12);
    // The dispatcher claims the oldest, which sits on page 2.
    tasks = tasks.map((t) => (t.id === "s12" ? { ...t, status: "in_progress", updatedAt: 500 } : t));
    await vi.advanceTimersByTimeAsync(5_100);
    await waitFor(() => expect(headerCount("assigned")).toContain("11"));
    expect(document.querySelectorAll('[data-task-card="s12"]')).toHaveLength(1);
    expect(columnOfCard("s12")).toBe("in_progress");
    expect(cardsIn("assigned")).toBe(11);
  });
});

describe("switching the Core chip", () => {
  it("keeps the board mounted while the new Core's Tasks are on their way", async () => {
    mount();
    await screen.findByText("Finished 1");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const impl = api.listTasksPage.getMockImplementation()!;
    api.listTasksPage.mockImplementation(async (q: PageQuery) => {
      if (q.coreId === "c2") await gate;
      return impl(q);
    });
    fireEvent.click(within(screen.getByRole("group", { name: "Filter by Core" })).getByRole("button", { name: /build-box-01/ }));
    await waitFor(() => expect(pageCalls().some((q) => q.coreId === "c2")).toBe(true));
    expect(document.querySelectorAll("[data-board-column]")).toHaveLength(4);
    release();
    await waitFor(() => expect(cardsIn("finished")).toBe(6));
    api.listTasksPage.mockImplementation(impl);
  });

  it("asks once for the new Core's column when the old Core had two pages loaded", async () => {
    mount();
    await screen.findByText("Finished 1");
    fireEvent.click(within(column("finished")).getByRole("button", { name: "Load more" }));
    await screen.findByText("Finished 12");
    api.listTasksPage.mockClear();
    fireEvent.click(within(screen.getByRole("group", { name: "Filter by Core" })).getByRole("button", { name: /build-box-01/ }));
    await waitFor(() => expect(cardsIn("finished")).toBe(6));
    await waitFor(() => expect(headerCount("finished")).toContain("6"));
    expect(pageCalls().filter((q) => q.coreId === "c2" && q.column === "finished")).toHaveLength(1);
  });
});

/** A mouse drag from a card to a column, ending in the click a browser sends after it. */
function drag(id: string, to: Col) {
  const from = columnOfCard(id) as Col;
  const el = card(id);
  const X = (c: Col) => ORDER.indexOf(c) * 100 + 50;
  fireEvent.pointerDown(el, { pointerId: 1, button: 0, pointerType: "mouse", isPrimary: true, clientX: X(from), clientY: 20 });
  fireEvent.pointerMove(window, { pointerId: 1, clientX: X(to), clientY: 50 });
  fireEvent.pointerUp(window, { pointerId: 1, clientX: X(to), clientY: 20 });
  fireEvent.click(el);
}

describe("dragging across pages", () => {
  it("moves a Task that came with Load more to another column, and the columns and counts follow the server", async () => {
    mount();
    await screen.findByText("Finished 1");
    fireEvent.click(within(column("finished")).getByRole("button", { name: "Load more" }));
    await screen.findByText("Finished 12");
    // f12 is a failed/partial/done Task from the second page: re-assign it.
    drag("f12", "assigned");
    await waitFor(() => expect(columnOfCard("f12")).toBe("assigned"));
    expect(api.setTaskStatus).toHaveBeenCalledWith("f12", "assigned");
    expect(toast.error).not.toHaveBeenCalled();
    // After the server answers, the refetch lists it where it went and the rest of Finished stays.
    await waitFor(() => expect(headerCount("finished")).toContain("11"));
    expect(headerCount("assigned")).toContain("2");
    expect(columnOfCard("f12")).toBe("assigned");
    expect(cardsIn("finished")).toBe(11);
    expect(card("f11")).not.toBeNull();
  });

  it("does not reload a two-page column for the count an optimistic move changed, before the server answers", async () => {
    mount();
    await screen.findByText("Finished 1");
    fireEvent.click(within(column("finished")).getByRole("button", { name: "Load more" }));
    await screen.findByText("Finished 12");
    await waitFor(() => expect(headerCount("finished")).toContain("12"));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    api.setTaskStatus.mockImplementationOnce(async (id: string, status: TaskDto["status"]) => {
      await gate;
      tasks = tasks.map((t) => (t.id === id ? { ...t, status } : t));
      return {};
    });
    api.listTasksPage.mockClear();
    drag("f12", "assigned");
    await waitFor(() => expect(headerCount("finished")).toContain("11"));
    await new Promise((r) => setTimeout(r, 50));
    expect(pageCalls().filter((q) => q.column === "finished")).toHaveLength(0);
    expect(columnOfCard("f12")).toBe("assigned");
    release();
    await waitFor(() => expect(api.setTaskStatus).toHaveBeenCalled());
    await waitFor(() => expect(cardsIn("finished")).toBe(11));
    expect(columnOfCard("f12")).toBe("assigned");
  });

  it("shows the card in the target column before the server answers, and puts it back if the server says no", async () => {
    mount();
    await screen.findByText("Finished 1");
    api.setTaskStatus.mockRejectedValueOnce(new Error("nope"));
    drag("d1", "assigned");
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("nope"));
    await waitFor(() => expect(columnOfCard("d1")).toBe("draft"));
    expect(headerCount("draft")).toContain("3");
  });
});
