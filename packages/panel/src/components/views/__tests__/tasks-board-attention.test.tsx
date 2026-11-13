// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { KeybindingsProvider } from "~/lib/keybindings/store";
import type { PageQuery } from "./task-board-fake";
import type { TaskDto } from "~/shared/task-wire";

// #954: the "Needs attention" chip and the badge on the board. api, sonner and the fleet are the edges.
vi.mock("~/lib/fleet-context", () => ({
  useFleet: () => ({ cores: [], fleet: { rows: [], offlineCores: [], singleCore: false }, loading: false, error: null, refresh: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
const task = (id: string, title: string, over: Partial<TaskDto> = {}): TaskDto => ({
  id, title, description: "", status: "in_progress", coreId: null, agent: null, attemptCount: 1, dispatchedAt: 1, lastError: null,
  timeoutMinutes: 60, sessionState: null, sessionStateAt: null, createdAt: 1, updatedAt: 1, ...over,
});
let tasks: TaskDto[] = [];
const api = vi.hoisted(() => ({
  getKeybindings: vi.fn(async () => ({ bindings: {} })),
  listTasksPage: vi.fn(async (q: PageQuery) => (await import("./task-board-fake")).fakeTasksPage(tasks, q)),
  getTaskCounts: vi.fn(async () => (await import("./task-board-fake")).fakeTaskCounts(tasks)),
  listCoreAgents: vi.fn(async () => ({ agents: [] })),
}));
vi.mock("~/lib/api", () => ({ api, ApiError: class extends Error {} }));
const { TasksBoard } = await import("../TasksBoard");

beforeEach(() => {
  tasks = [
    task("a", "Waiting one", { sessionState: "needs-input", sessionStateAt: 1 }),
    task("b", "Cut one", { sessionState: "interrupted", sessionStateAt: 1 }),
    task("c", "Idle one", { sessionState: "idle-no-result", sessionStateAt: 1 }),
    task("d", "Busy one", { sessionState: "working", sessionStateAt: 1 }),
    task("e", "Plain one"),
  ];
});
afterEach(cleanup);

async function mount() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <KeybindingsProvider>
        <TasksBoard />
      </KeybindingsProvider>
    </QueryClientProvider>,
  );
  await screen.findByText("Waiting one");
}

describe("Tasks board attention (#954)", () => {
  it("shows the badge from the poll's data on the card", async () => {
    await mount();
    const badges = [...document.querySelectorAll("[data-session-state]")].map((el) => el.getAttribute("data-session-state"));
    expect(badges.sort()).toEqual(["idle-no-result", "interrupted", "needs-input"]);
  });
  it("Needs attention keeps only needs-input, interrupted and idle-no-result", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Needs attention" }));
    expect(screen.queryByText("Busy one")).toBeNull();
    expect(screen.queryByText("Plain one")).toBeNull();
    for (const t of ["Waiting one", "Cut one", "Idle one"]) expect(screen.getByText(t)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Needs attention" }).getAttribute("aria-pressed")).toBe("true");
  });
  it("pressing it again shows every Task", async () => {
    await mount();
    const chip = screen.getByRole("button", { name: "Needs attention" });
    fireEvent.click(chip);
    fireEvent.click(chip);
    expect(screen.getByText("Busy one")).toBeTruthy();
  });
});
